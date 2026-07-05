/*
 * grace-board — local kanban dispatch board for the grace-feature-dev pipeline.
 *
 * Zero-dependency Node HTTP server: serves the static UI and a small JSON API,
 * persists to data/board.json. Bound to 127.0.0.1 (local-only by design).
 *
 * A task is composed in Backlog (project · theme · description · links ·
 * attachments). Dragging it across the launch LEVER dispatches it: the server
 * seeds a grace-feature-dev board.json and spawns a headless run. The card then
 * rides the stations on its own:
 *
 *   backlog → todo → asking → implementing → verifying → reviewing → ready   · blocked
 *
 * "asking" is a two-block HITL gate: block 1 collects FUNCTIONAL answers, block 2
 * presents ARCHITECTURE decisions (variant options the agent proposes, the human
 * picks). Only after both does the build run go to "ready" (for deploy).
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

// Minimal zero-dependency .env loader: KEY=VALUE lines in ./.env seed process.env as
// defaults (an already-exported environment variable always wins). Optional convenience.
(function loadDotEnv() {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) {
      if (line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const key = m[1], val = m[2].replace(/^["']|["']$/g, "");
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch { /* no .env — env vars / built-in defaults are used */ }
})();

const HOST = "127.0.0.1";
const PORT = Number(process.env.GRACE_BOARD_PORT) || 4317;
const PROJECTS_ROOT = process.env.GRACE_PROJECTS_ROOT || path.join(os.homedir(), "Projects");

// ── auto-launch config ───────────────────────────────────────────────────────
// On dispatch, the server spawns a headless `claude -p "/grace-feature-dev …"` run
// in the target project — this is what makes "drag right → the team starts working"
// real. Tunable / disengageable via env:
const AUTORUN = process.env.GRACE_AUTORUN !== "0";                       // set 0 to disable auto-launch
const CLAUDE_BIN = process.env.GRACE_CLAUDE_BIN || path.join(os.homedir(), ".local/bin/claude");
// claude/node often aren't on a GUI-launched server's PATH — prepend likely bin dirs.
// Override wholesale with GRACE_BIN_PATH (":"-separated) if your install differs.
const BIN_PATH_HINT = process.env.GRACE_BIN_PATH || [
  path.dirname(CLAUDE_BIN),
  path.join(os.homedir(), ".local/node/bin"),
  "/usr/local/bin",
  "/opt/homebrew/bin",
].join(path.delimiter);

// ── per-task settings ────────────────────────────────────────────────────────
// We run on a Claude subscription: no per-$ billing, so no budget cap. Models are
// pinned per-agent in the gfd-* files; the orchestrator uses the session default.
const RIGORS = ["grace", "off"];          // GRACE semantic markup on/off

// ── run supervision: a launched run is watched, not fire-and-forget (issue #1) ─
// A run that dies WITHOUT reaching `ready`, or stalls in one phase past this
// wall-clock budget, is moved to `blocked` so the board never lies.
const STALL_MS = Number(process.env.GRACE_STALL_MIN || 120) * 60 * 1000;
const LIVENESS_GRACE_MS = 15 * 1000;       // don't judge a run dead in its first seconds
// Work-in-flight stations the supervisor watches. `asking` is excluded — there the
// run has exited by design and we wait on the human, so a dead pid is expected.
const ACTIVE_COLUMNS = new Set(["todo", "implementing", "verifying", "reviewing"]);
// A card "occupies" its project's single work slot from dispatch until it reaches a
// terminal/blocked state — this is what serializes the shared project cwd (WIP=1 per
// project, roadmap §5.1). `asking` IS occupying (the run owns the branch mid-clarify),
// unlike ACTIVE_COLUMNS above which is only about liveness supervision. A `queued` card
// is NOT occupying — it hasn't spawned a run (dispatchedAt is null).
const OCCUPYING_COLUMNS = new Set(["todo", "asking", "implementing", "verifying", "reviewing"]);

const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const BOARD_FILE = path.join(DATA_DIR, "board.json");
const DISPATCH_LOG = path.join(DATA_DIR, "dispatch-log.ndjson");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

// Stations, left → right. The terminal is `ready` (for deploy).
const COLUMNS = ["backlog", "todo", "asking", "implementing", "verifying", "reviewing", "ready", "blocked"];
const TERMINAL = "ready";
// older seeds / persisted cards / pipeline writes used these names — map them forward.
const LEGACY_COLUMN = { clarifying: "asking", done: "ready", "ready-for-deploy": "ready" };
const normalizeColumn = (col) => LEGACY_COLUMN[col] || col;

const MAX_DESC = 2000;                 // task description hard cap (chars)
const MAX_UPLOAD = 8 * 1024 * 1024;    // 8 MB per attachment
const MAX_BODY = 16 * 1024 * 1024;     // request-body hard cap (covers a base64 upload)

// ── storage ────────────────────────────────────────────────────────────────
function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  if (!fs.existsSync(BOARD_FILE)) fs.writeFileSync(BOARD_FILE, JSON.stringify({ updatedAt: null, cards: [] }, null, 2));
}
function readBoard() {
  ensureData();
  try {
    const b = JSON.parse(fs.readFileSync(BOARD_FILE, "utf8"));
    for (const c of b.cards || []) if (c.column) c.column = normalizeColumn(c.column);
    return b;
  } catch { return { updatedAt: null, cards: [] }; }
}
function writeBoard(board) {
  board.updatedAt = new Date().toISOString();
  fs.writeFileSync(BOARD_FILE, JSON.stringify(board, null, 2));
}
// Unicode-aware slug (keeps Cyrillic etc.); falls back to a short id when empty.
function slugify(s, fallback) {
  const out = String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return out || fallback || "task";
}
// A card's project may be an absolute path or a folder name under PROJECTS_ROOT.
// Always resolved and confined to PROJECTS_ROOT — no `..` escape, no absolute path
// outside the root (issue #4: path traversal → autonomous run on an arbitrary dir).
const PROJECTS_ROOT_ABS = path.resolve(PROJECTS_ROOT);
function resolveProjectDir(project) {
  return path.resolve(path.isAbsolute(project) ? project : path.join(PROJECTS_ROOT_ABS, project));
}
function isInsideRoot(dir) {
  return dir === PROJECTS_ROOT_ABS || dir.startsWith(PROJECTS_ROOT_ABS + path.sep);
}

// The headline the pipeline builds against = the task theme; the detail (long
// description, links, attached files) is compiled into the requirements context.
const featureLine = (card) => card.theme || card.description || "task";
function compiledRequirements(card) {
  const parts = [];
  if (card.description) parts.push(card.description);
  if (card.requirements) parts.push(card.requirements);
  if (card.requirementsLink) parts.push("Требования (ссылка): " + card.requirementsLink);
  if (card.designLink) parts.push("Макеты (ссылка): " + card.designLink);
  if (Array.isArray(card.attachments) && card.attachments.length)
    parts.push("Вложения с требованиями: " + card.attachments.map((a) => a.name).join(", "));
  return parts.join("\n\n") || null;
}

// region FUNC_detectDirectives — pull build-METHOD directives out of the task text
// The task body mixes WHAT to build (functional) with HOW to build it (use skill X,
// a theme, a stack). Requirements-synthesis legitimately drops the HOW — so we extract
// it here, keep it first-class and verbatim, and inject it into every phase prompt under
// a heading that forbids normalizing it away. This is what stops "use skill frontend-design"
// from silently degrading into "responsive design".
const SKILL_ALIASES = [
  { canon: "frontend-design", re: /(frontend[\s-]?design|фронт[а-яё]*[\s-]?дизайн|фронтендизайн)/i, hint: "для UI/визуала — вызвать в фазе реализации фронтенда" },
  { canon: "taste-frontend",  re: /taste[\s-]?frontend/i, hint: "анти-slop фронтенд" },
  { canon: "redesign-skill",  re: /redesign/i, hint: "редизайн существующего UI" },
  { canon: "brandkit",        re: /brandkit|бренд[\s-]?кит/i, hint: "бренд-айдентика" },
];
function detectDirectives(text) {
  if (!text) return [];
  const out = [];
  for (const s of SKILL_ALIASES) if (s.re.test(text)) out.push(`Скил «${s.canon}» — ОБЯЗАТЕЛЬНО применить (${s.hint}).`);
  // generic "скил <name>" / "skill <name>" not matched above
  const m = text.match(/скил[аеоуы]?\s+["«]?([a-zа-яё][\wа-яё-]{2,})/i) || text.match(/skill\s+["']?([a-z][\w-]{2,})/i);
  if (m && !out.some((o) => o.toLowerCase().includes(String(m[1]).toLowerCase().slice(0, 4))))
    out.push(`Пользователь просил применить скил, похожий на «${m[1]}» — найди ближайший доступный Skill и примени его через инструмент Skill.`);
  return out;
}
function directivesBlock(card) {
  const d = detectDirectives([card.description, card.requirements].filter(Boolean).join("\n"));
  if (!d.length) return "";
  return [
    `ДИРЕКТИВЫ ПО СПОСОБУ ВЫПОЛНЕНИЯ (исполнять БУКВАЛЬНО; НЕ нормализовать и НЕ выбрасывать при синтезе требований):`,
    ...d.map((x) => `• ${x}`),
    `Если директива называет Skill — ВЫЗОВИ его через инструмент Skill в соответствующей фазе, а не имитируй вручную. Отрази выполнение директивы в requirements.md отдельным разделом «Директивы».`,
  ].join("\n");
}
// endregion FUNC_detectDirectives

// ── attachments ──────────────────────────────────────────────────────────────
// Stored on disk under data/uploads/<cardId>/; metadata lives on the card. Files
// are accepted as base64 (data-URL or raw) over JSON — no multipart parser needed.
function saveAttachment(card, body) {
  const name = String(body.name || "file").replace(/[/\\]/g, "_").slice(0, 120);
  let b64 = String(body.data || "");
  const comma = b64.indexOf(",");
  if (b64.startsWith("data:") && comma !== -1) b64 = b64.slice(comma + 1);
  const buf = Buffer.from(b64, "base64");
  if (!buf.length) throw new Error("empty attachment");
  if (buf.length > MAX_UPLOAD) throw new Error("attachment exceeds 8 MB");
  const id = crypto.randomUUID().slice(0, 8);
  const dir = path.join(UPLOADS_DIR, card.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + "__" + name), buf);
  const att = { id, name, size: buf.length, type: String(body.type || "application/octet-stream"),
    url: `/api/tasks/${card.id}/attachments/${id}/raw` };
  if (!Array.isArray(card.attachments)) card.attachments = [];
  card.attachments.push(att);
  return att;
}
function removeAttachment(card, attId) {
  const i = (card.attachments || []).findIndex((a) => a.id === attId);
  if (i === -1) return false;
  const att = card.attachments[i];
  try { fs.unlinkSync(path.join(UPLOADS_DIR, card.id, att.id + "__" + att.name)); } catch {}
  card.attachments.splice(i, 1);
  return true;
}
function serveAttachment(res, card, attId) {
  const att = (card.attachments || []).find((a) => a.id === attId);
  if (!att) { res.writeHead(404); return res.end("not found"); }
  const file = path.join(UPLOADS_DIR, card.id, att.id + "__" + att.name);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": att.type || "application/octet-stream" });
    res.end(buf);
  });
}
function purgeUploads(cardId) {
  try { fs.rmSync(path.join(UPLOADS_DIR, cardId), { recursive: true, force: true }); } catch {}
}

// region FUNC_scheduleQueued — per-project WIP=1 serialization (roadmap §5.1/§5.2)
// ## @purpose Close the shared-cwd git race (server.js spawns every run in the SAME
// ##   projectDir): only ONE card per project may hold a live run at a time. A card
// ##   leaving Backlog while its project is busy is QUEUED (a flag, not a run) and the
// ##   tick dispatches it once the slot frees — so two cards never checkout/commit in
// ##   one working dir concurrently, and there is no intra-project git conflict to solve.
// ## @io (board) -> mutates board (dispatches ≤1 queued card per free project)
// ## @invariants
// ## - Single-card / free-project path dispatches IMMEDIATELY — one-off tasks are untouched.
// ## - A queued card never spawns a run until canDispatchNow() is true (slot free; S1: deps ready).
// ## - queued cards carry dispatchedAt=null, so they never count as "active" themselves.
// ## @rationale Q: new station column vs a flag? A: a `queued` flag keeps the card in
// ##   `todo` — zero column-model migration across UI/legacy maps, and the flag is only
// ##   ever set when the project is busy, so the existing single-card flow is byte-identical.
// ## @modulemap
// ## FUNC 3[guard]   => hasActiveForProject   — is the project's slot taken?
// ## FUNC 3[guard]   => canDispatchNow        — S0: slot free (S1 extends: + deps + files)
// ## FUNC 6[persist] => dispatchNow           — mark live + seed + spawn (shared by PATCH & tick)
// ## FUNC 5[persist] => scheduleQueued        — tick pass: feed each free project its next card
// GREP_SUMMARY: queue, WIP1, per-project serialization, shared cwd race, dispatchNow, scheduleQueued
// STRUCTURE: ▶ hasActiveForProject → ⊕ canDispatchNow → ⚡ dispatchNow → ⎋ scheduleQueued(tick)

// Does another card already hold this project's work slot? Queued cards don't count
// (dispatchedAt is null); the card itself is excluded via exceptId.
function hasActiveForProject(board, project, exceptId) {
  return board.cards.some((c) =>
    c.id !== exceptId && c.project === project && c.dispatchedAt && !c.queued && OCCUPYING_COLUMNS.has(c.column));
}
// May this card start its run right now? S0: only the per-project slot gate.
// (S1 extends this with dependsOn readiness + files[] conflict — see FUNC_dagGates.)
function canDispatchNow(board, card) {
  return !hasActiveForProject(board, card.project, card.id);
}
// Actually start the card's run: clear the queued flag, stamp it live, seed + spawn.
// Shared by the PATCH (lever) path and the tick scheduler so both dispatch identically.
function dispatchNow(board, card, via) {
  card.queued = false;
  card.dispatchedAt = new Date().toISOString();
  card.dispatch = dispatch(card);
  card.lastColumnChangeAt = card.dispatchedAt;
  card.history.push({ column: card.column, ts: card.dispatchedAt, via: via || "dispatch" });
}
// Tick pass: give each free project its next eligible queued card. Dispatching one flips
// hasActiveForProject() true for that project, so the next same-project queued card waits
// this pass — natural WIP=1 without a lock. FIFO by board array order (= creation order).
function scheduleQueued(board) {
  let changed = false;
  for (const card of board.cards) {
    if (!card.queued) continue;
    if (!canDispatchNow(board, card)) continue;
    dispatchNow(board, card, "queue-dispatch");
    try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: card.dispatchedAt, event: "queue-dispatch", cardId: card.id, project: card.project }) + "\n"); } catch {}
    changed = true;
  }
  return changed;
}
// endregion FUNC_scheduleQueued

// ── dispatch: write a grace-feature-dev-compatible seed into the project ─────
function dispatch(card) {
  const projectDir = resolveProjectDir(card.project);
  const rigor = card.rigor === "grace" ? "grace" : "off";
  const runDir = path.join(projectDir, ".grace-feature-dev", card.slug);
  const event = { ts: new Date().toISOString(), event: "dispatch", cardId: card.id, project: card.project, slug: card.slug, rigor };

  try {
    fs.mkdirSync(runDir, { recursive: true });
    const seed = {
      feature: featureLine(card),
      slug: card.slug,
      createdAt: card.createdAt,
      phase: "asking",
      column: "todo",                  // pipeline updates this; grace-board mirrors it onto the kanban card
      askStage: "functional",          // functional → architecture → done
      rigor,
      gates: { functional: "pending", architecture: "pending" },
      antiLoop: { max: 3 },
      source: { tool: "grace-board", cardId: card.id, designLink: card.designLink || null, requirementsLink: card.requirementsLink || null },
      requirements: compiledRequirements(card),
      milestones: [],
      cards: [],
    };
    fs.writeFileSync(path.join(runDir, "board.json"), JSON.stringify(seed, null, 2));
    event.seed = path.join(runDir, "board.json");
  } catch (e) {
    event.seedError = String(e.message || e);
  }

  // Asking · block 1 — ask the FUNCTIONAL questions, then stop.
  event.launch = launchAskFunctional(card, projectDir, runDir);
  recordLaunch(card, event.launch, "ask-functional");
  try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify(event) + "\n"); } catch {}
  return event;
}

// Remember the live run on the card so the supervisor (syncFromPipeline) can watch
// it: pid for liveness, start time for the grace window, log path for the UI viewer.
function recordLaunch(card, launch, kind) {
  if (launch && launch.launched) {
    card.runPid = launch.pid;
    card.runKind = kind;
    card.runLog = launch.log;
    card.runStartedAt = new Date().toISOString();
  }
}

// region FUNC_spawnRun — detached headless Claude run (dir-scoped, logged)
function spawnRun(projectDir, runDir, prompt, logName) {
  if (!AUTORUN) return { launched: false, reason: "GRACE_AUTORUN=0" };
  if (!fs.existsSync(CLAUDE_BIN)) return { launched: false, error: "claude bin not found: " + CLAUDE_BIN };
  try {
    const out = fs.openSync(path.join(runDir, logName), "a");
    const env = { ...process.env, PATH: `${BIN_PATH_HINT}:${process.env.PATH || ""}` };
    const args = ["-p", prompt, "--permission-mode", "bypassPermissions", "--add-dir", projectDir];
    const child = spawn(CLAUDE_BIN, args, { cwd: projectDir, env, detached: true, stdio: ["ignore", out, out] });
    child.unref();
    return { launched: true, pid: child.pid, log: path.join(runDir, logName) };
  } catch (e) {
    return { launched: false, error: String(e.message || e) };
  }
}

// Asking · block 1 (FUNCTIONAL) — ask up to 8 questions about WHAT to build, then stop.
function launchAskFunctional(card, projectDir, runDir) {
  const reqs = compiledRequirements(card);
  const dirs = directivesBlock(card);
  const prompt = [
    `/grace-feature-dev ${featureLine(card)}`, ``,
    reqs ? `Контекст задачи:\n${reqs}\n` : ``,
    dirs ? `${dirs}\n` : ``,
    `AUTONOMOUS HEADLESS — ЭТАП ASKING, БЛОК 1 (ФУНКЦИОНАЛ). Сделай discovery + краткую разведку, затем ОСТАНОВИСЬ.`,
    `ПОРОГ ЭСКАЛАЦИИ — спрашивать человека МОЖНО ТОЛЬКО если решение: (а) меняет ПОВЕДЕНИЕ продукта или объём`,
    `(что система делает/не делает для пользователя), ЛИБО (б) это настоящая развилка с внешними последствиями`,
    `(стоимость, vendor lock-in, юридика/комплаенс, необратимость, форма данных в контракте), ЛИБО (в) по нему`,
    `у НЕ-разработчика (продукт/юрист/владелец) реально может быть мнение. НЕ спрашивай про «как»: расположение`,
    `кода, имена ролей/переменных/GUC, паттерн (mixin vs helper), где ставить SET LOCAL, структуру файлов,`,
    `глубину/способ тестирования, формат логов — всё системное/имплементационное решай САМ по best-practice и`,
    `инвариантам проекта (CLAUDE.md/ARCHITECTURE.md) и записывай принятое решение с кратким обоснованием в "answers".`,
    ``,
    `• ЕСТЬ что спросить человека → сформулируй 3–8 конкретных вопросов ПО ФУНКЦИОНАЛУ И СМЫСЛУ (поведение,`,
    `  сценарии, данные, роли/доступ, граничные случаи, что НЕ входит в объём). Запиши top-level массив`,
    `  "questions" (короткие строки), выставь "column":"asking", "askStage":"functional", перезапиши board.json`,
    `  и ВЫЙДИ — человек ответит. НЕ проектируй архитектуру и НЕ пиши код.`,
    `• НЕЧЕГО спрашивать (типично для фундаментальных core/infra-этапов — норма 0 вопросов) → выставь`,
    `  "questions":[], сам заполни top-level "answers":[{"q":"…","a":"… + обоснование"}] принятыми решениями,`,
    `  выставь "askStage":"functional-done", "column":"asking", перезапиши board.json и ВЫЙДИ. Человека НЕ ждём —`,
    `  диспетчер сам запустит блок 2 (архитектуру).`,
    `Твой board.json: ${path.join(runDir, "board.json")}.`,
  ].join("\n");
  return spawnRun(projectDir, runDir, prompt, "ask-functional.log");
}

// Asking · block 2 (ARCHITECTURE) — launched after functional answers. EITHER propose
// architecture DECISIONS (variant options with pros/cons) and stop, OR (if none are
// needed) proceed straight to the full build.
function launchAskArchitecture(card, projectDir, runDir, funcQA, rigor) {
  const qa = (funcQA || []).map((p) => `Q: ${p.q}\nA: ${p.a || "(нет ответа)"}`).join("\n");
  const reqs = compiledRequirements(card);
  const dirs = directivesBlock(card);
  const prompt = [
    `/grace-feature-dev ${featureLine(card)}`, ``,
    reqs ? `Контекст задачи:\n${reqs}\n` : ``,
    `Ответы по функционалу (блок 1):\n${qa}\n`,
    dirs ? `${dirs}\n` : ``,
    `AUTONOMOUS HEADLESS — ЭТАП ASKING, БЛОК 2 (АРХИТЕКТУРА). На основе функциональных ответов реши, нужны ли`,
    `АРХИТЕКТУРНЫЕ развилки. ТОЛЬКО классифицируй и выйди — НЕ пиши код и НЕ строй build здесь (его запустит диспетчер).`,
    `ПОРОГ ЭСКАЛАЦИИ — развилка идёт человеку ТОЛЬКО если это настоящий выбор с внешними последствиями (стоимость,`,
    `vendor lock-in, юридика/комплаенс/резидентность/провайдер, необратимость, форма модели данных, влияющая на`,
    `контракт) ЛИБО по нему может быть мнение у НЕ-разработчика. Системно-имплементационное («как»: детали стека,`,
    `имена, паттерны, структура файлов, глубина тестов, формат логов) — это НЕ развилка: решай САМ.`,
    ``,
    `• ЕСЛИ есть настоящие развилки — для КАЖДОЙ предложи 2–4 варианта. Запиши top-level массив "archQuestions",`,
    `  каждый элемент: { "id":"d1", "q":"<вопрос>", "options":[ { "id":"o1", "title":"<краткий заголовок>",`,
    `  "desc":"<1–2 фразы>", "pros":["<плюс>", ...], "cons":["<минус>", ...], "recommended":true|false } , ... ] }.`,
    `  Ровно ОДИН вариант в каждой развилке помечай "recommended":true. Затем выставь "askStage":"architecture",`,
    `  оставь "column":"asking", перезапиши board.json и ВЫЙДИ (человек выберет решения).`,
    `• ЕСЛИ настоящих развилок нет — выставь "archQuestions":[] и "archDecisions":[] (ПУСТОЙ массив = маркер`,
    `  «гейт пройден, выбирать нечего»; недостающие системные решения фиксируй сам отдельными элементами вида`,
    `  {"q":"…","chosenTitle":"…","ownText":"<обоснование>"}), выставь "askStage":"done", оставь "column":"asking",`,
    `  перезапиши board.json и ВЫЙДИ. Полный build до "ready" диспетчер запустит САМ — НЕ строй его здесь.`,
    `Твой board.json: ${path.join(runDir, "board.json")}.`,
  ].join("\n");
  return spawnRun(projectDir, runDir, prompt, "ask-architecture.log");
}

// BUILD — launched after the architecture decisions are chosen. Architect honors them.
function launchBuild(card, projectDir, runDir, funcQA, archDecisions, rigor, recovery) {
  const fq = (funcQA || []).map((p) => `Q: ${p.q}\nA: ${p.a || "(нет ответа)"}`).join("\n");
  const ad = (archDecisions || []).map((d) => `• ${d.q}\n  → ВЫБРАНО: ${d.chosenTitle || d.choice}${d.ownText ? " — " + d.ownText : ""}`).join("\n");
  const rigorLine = `Rigor: ${rigor || "off"}. Apply markup per grace-feature-dev SKILL §3 — grace = full semantic exoskeleton (MODULE/FUNCTION_CONTRACT) + LDD [IMP:N] logs; off = the repo's own idiom, no GRACE markers.`;
  const reqs = compiledRequirements(card);
  const dirs = directivesBlock(card);
  const prompt = [
    `/grace-feature-dev ${featureLine(card)}`, ``,
    reqs ? `Контекст задачи:\n${reqs}\n` : ``,
    fq ? `Ответы по функционалу:\n${fq}\n` : ``,
    ad ? `Принятые архитектурные решения (человек выбрал — СОБЛЮДАЙ их):\n${ad}\n` : ``,
    dirs ? `${dirs}\n` : ``,
    rigorLine,
    recovery ? `${recovery}\n` : ``,
    `AUTONOMOUS HEADLESS BUILD. Resume from board.json. Запусти полный процесс: architecture (СОБЛЮДАЯ выбранные`,
    `решения выше; недостающие детали выбирает архитектор и обосновывает) → decompose → implement → verify → review.`,
    `BOARD SYNC IS MANDATORY AND HAPPENS AT THE *START* OF EACH PHASE, NOT THE END — the kanban mirrors`,
    `board.json's top-level "column", so writing it late makes the board lie. Write it FIRST, then do the work:`,
    `BEFORE implementing set "column":"implementing"; BEFORE verifying set "column":"verifying"; BEFORE reviewing`,
    `set "column":"reviewing"; only once all gates are green set "column":"ready". If you get stuck, set`,
    `"column":"blocked" with a short top-level "blockReason" string.`,
    `PER-CARD STATUS IS ALSO MIRRORED LIVE: as you work each decomposed card, keep its "cards[].column"`,
    `(todo→implementing→verifying→reviewing→done) and the parent "milestones[].status" (todo→in-progress→done)`,
    `current in board.json, and write a one-line "cards[].verdict" when a card reaches done. The board now`,
    `renders this decomposition, so stale per-card columns make it lie. Update them at each card phase boundary.`,
    `GREEN-CHECKPOINT (LA4 «вечно зелёный билд» + точки отката): КАЖДЫЙ раз, когда декомпозированная карточка`,
    `проходит verify И review зелёными и ты переводишь её "cards[].column" в "done" — сделай на ветке`,
    `"autodev/${card.slug}" микро-коммит: сначала "git add" СТРОГО по файлам из card.files[] ЭТОЙ карточки`,
    `(НИКОГДА не "git add ." и не "-A" — чекпоинт атомарный, чужие изменения не тянем), затем`,
    `"git commit -m 'green(<cardId>): <краткий title карточки>'". Коммить ТОЛЬКО на зелёной карточке. Провал`,
    `verify/review (карточка вернулась в implementing или ушла в blocked по Anti-Loop) → НЕ коммить; последний`,
    `зелёный чекпоинт оставляем нетронутым, человек продолжит от него. Эти green-коммиты — атомарные точки`,
    `отката ("git restore --source=<sha> -- <файл>"); финальный push перед "ready" (см. BRANCH & HANDOFF) идёт`,
    `в ту же ветку "autodev/${card.slug}" и эти коммиты НЕ заменяет.`,
    `DEFINITION OF DONE (гейт перед "ready" — НЕ помечай карточку/слайс done, пока не выполнено):`,
    `карточка НЕ уходит в done/ready, если в её файлах остались TODO/FIXME/HACK/XXX/NotImplementedError/`,
    `заглушки (placeholder-возвраты, выброшенные значения), КРОМЕ случая, когда строка покрыта проходящим`,
    `тестом из её acceptance ЛИБО явно вынесена в "deferred" (см. ниже). Каждый acceptance-критерий обязан`,
    `иметь прогоняемый тест; недостижимый код (напр. токен сгенерирован, но никуда не присвоен) = НЕ done.`,
    `Сомнительную «незаметную» недоделку чини сразу или выноси в deferred — не прячь под комментарий.`,
    `MIGRATION GATE (если карточка трогает схему БД — модели/schema.prisma/SQLAlchemy): ОБЯЗАТЕЛЬНО сгенерируй`,
    `файл миграции (Prisma: "prisma migrate dev --create-only"; Alembic: "alembic revision --autogenerate"),`,
    `НИКОГДА не "db push"/ручной DDL на прод-пути. Миграция forward-only и backward-compatible (аддитивная;`,
    `без деструктивных DROP без two-step). Запиши путь файла в top-level "migration" и в "finishNote".`,
    `Только db push без файла миграции = НЕ done.`,
    `BRANCH & HANDOFF (ОБЯЗАТЕЛЬНО, не коммить в main напрямую): работай в выделенной ветке`,
    `"autodev/${card.slug}" — ответви её от свежего main в начале. Когда все гейты зелёные и до того как ставишь`,
    `"column":"ready": закоммить, "git push -u origin autodev/${card.slug}", и запиши в board.json top-level`,
    `"branchLink" — URL ветки/compare на GitHub (origin remote), который человек должен проревьюить и подлить в main.`,
    `Если push невозможен (нет remote/доступа) — оставь имя ветки в "branchLink" и опиши это в "finishNote".`,
    `ИТОГИ КАРТОЧКИ: всегда заполняй top-level "finishNote" коротким резюме сделанного. ОТЛОЖЕННОЕ указывай ЯВНО`,
    `и СТРУКТУРНО: top-level "deferred" — массив объектов {"title":"кратко что не сделано","reason":"почему/куда`,
    `вынесено"}. Эти пункты доска автоматически заведёт карточками в backlog. Продублируй их разделом "Отложенное:"`,
    `в "finishNote" (или "Отложенное: нет", если deferred пуст). Не прячь отложенное внутри TODO в коде done-карточки.`,
    `Твой board.json: ${path.join(runDir, "board.json")}.`,
  ].join("\n");
  return spawnRun(projectDir, runDir, prompt, "build.log");
}
// endregion FUNC_spawnRun

// ── pipeline → board sync + run supervision ──────────────────────────────────
function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; } // ESRCH = gone; EPERM = alive but not ours
}
function blockCard(card, reason) {
  card.column = "blocked";
  card.blockReason = reason;
  card.lastColumnChangeAt = new Date().toISOString();
  card.history.push({ column: "blocked", ts: card.lastColumnChangeAt, via: "supervisor", reason });
  try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: card.lastColumnChangeAt, event: "blocked", cardId: card.id, reason }) + "\n"); } catch {}
}

// Read the last `maxLines` lines of a log file (last 64 KB only, so a huge log is cheap).
function tailLog(file, maxLines) {
  try {
    const size = fs.statSync(file).size;
    const readBytes = Math.min(size, 64 * 1024);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(readBytes);
    fs.readSync(fd, buf, 0, readBytes, size - readBytes);
    fs.closeSync(fd);
    return buf.toString("utf8").split("\n").slice(-maxLines).join("\n");
  } catch { return ""; }
}

// Resume a stuck/blocked card from the furthest-reached point, reusing the exact
// gate-choice logic the /relaunch endpoint and the watchdog auto-heal both rely on.
// `recovery` (optional) is a RECOVERY-context block injected into the build prompt so
// the resumed run self-diagnoses from the dead run's log — no extra model call.
// Returns { target, launch, kind }; mutates the card's *Launched flags. The caller
// owns card.column / history / recordLaunch / dispatch-log so it can tag the `via`.
function resumeRun(card, projectDir, runDir, rigor, recovery) {
  const pf = path.join(runDir, "board.json");
  let pip = {};
  try { pip = JSON.parse(fs.readFileSync(pf, "utf8")); } catch {}
  const askStage = pip.askStage || card.askStage || "";
  const answers = (Array.isArray(pip.answers) && pip.answers.length) ? pip.answers : (card.answers || []);
  const archDecisions = (Array.isArray(pip.archDecisions) && pip.archDecisions.length)
    ? pip.archDecisions : (Array.isArray(card.archDecisions) ? card.archDecisions : []);
  // Furthest-reached point: forks chosen OR architecture gate passed (askStage "done",
  // incl. no-fork archDecisions:[]) → build; functional passed but architecture not
  // yet → ask-architecture; else → ask-functional. Recovery only feeds the build prompt.
  let target = "asking", launch, kind;
  if (archDecisions.length || askStage === "done") {
    target = "implementing"; kind = "build";
    launch = launchBuild(card, projectDir, runDir, answers, archDecisions, rigor, recovery);
    card.buildLaunched = true;
  } else if (askStage === "functional-done" || (Array.isArray(answers) && answers.length)) {
    target = "asking"; kind = "ask-architecture";
    launch = launchAskArchitecture(card, projectDir, runDir, answers, rigor);
    card.autoArchLaunched = true; card.buildLaunched = false;
  } else {
    target = "asking"; kind = "ask-functional";
    launch = launchAskFunctional(card, projectDir, runDir);
    card.autoArchLaunched = false; card.buildLaunched = false;
  }
  try {
    pip.column = target; delete pip.blockReason;
    fs.writeFileSync(pf, JSON.stringify(pip, null, 2));
  } catch { /* a missing/broken seed is fine — the run rewrites it */ }
  return { target, launch, kind };
}

function syncFromPipeline() {
  let board, changed = false;
  try { board = readBoard(); } catch { return; }
  const now = Date.now();
  for (const card of board.cards) {
    if (!card.dispatchedAt || card.column === TERMINAL || card.column === "blocked") continue;
    const projectDir = resolveProjectDir(card.project);
    const runDir = path.join(projectDir, ".grace-feature-dev", card.slug);
    const pipFile = path.join(runDir, "board.json");
    let pip = null;
    // 1) mirror the pipeline's column / questions / archQuestions / askStage / blockReason
    try {
      if (fs.existsSync(pipFile)) {
        pip = JSON.parse(fs.readFileSync(pipFile, "utf8"));
        const col = normalizeColumn(pip.column);
        if (col && COLUMNS.includes(col) && col !== "backlog" && col !== card.column) {
          card.column = col;
          card.lastColumnChangeAt = new Date().toISOString();
          if (col === "blocked" && pip.blockReason) card.blockReason = String(pip.blockReason);
          card.history.push({ column: col, ts: card.lastColumnChangeAt, via: "pipeline" });
          try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: card.lastColumnChangeAt, event: "sync", cardId: card.id, column: col }) + "\n"); } catch {}
          changed = true;
        }
        if (Array.isArray(pip.questions) && JSON.stringify(pip.questions) !== JSON.stringify(card.questions || [])) {
          card.questions = pip.questions; changed = true;
        }
        if (Array.isArray(pip.archQuestions) && JSON.stringify(pip.archQuestions) !== JSON.stringify(card.archQuestions || [])) {
          card.archQuestions = pip.archQuestions; changed = true;
        }
        if (pip.askStage && pip.askStage !== card.askStage) { card.askStage = pip.askStage; changed = true; }
        if (pip.branchLink && pip.branchLink !== card.branchLink) { card.branchLink = String(pip.branchLink); changed = true; }
        if (pip.finishNote && pip.finishNote !== card.finishNote) { card.finishNote = String(pip.finishNote); changed = true; }
        if (pip.migration && JSON.stringify(pip.migration) !== JSON.stringify(card.migration)) { card.migration = pip.migration; changed = true; }
        // B9: structured deferred[] → auto-spawn backlog cards (once per title, idempotent)
        if (Array.isArray(pip.deferred) && pip.deferred.length) {
          card.deferredSpawned = card.deferredSpawned || [];
          for (const item of pip.deferred) {
            const title = String((item && (item.title || item)) || "").trim();
            if (!title || card.deferredSpawned.includes(title)) continue;
            const reason = String((item && item.reason) || "").trim();
            const nid = crypto.randomUUID();
            const theme = title.slice(0, 200);
            board.cards.push({
              id: nid, project: card.project,
              slug: slugify(theme, "task-" + nid.slice(0, 8)),
              theme,
              description: (`Отложено из карточки «${card.theme}».` + (reason ? `\nПричина/куда: ${reason}` : "")).slice(0, MAX_DESC),
              designLink: null, requirementsLink: card.requirementsLink || null, requirements: null,
              attachments: [], rigor: card.rigor || "off",
              column: "backlog", createdAt: new Date().toISOString(), dispatchedAt: null,
              history: [{ column: "backlog", ts: new Date().toISOString() }],
              spawnedFrom: card.id,
            });
            card.deferredSpawned.push(title);
            changed = true;
            try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: new Date().toISOString(), event: "deferred-spawn", cardId: card.id, newCardId: nid, title }) + "\n"); } catch {}
          }
        }
      }
    } catch { pip = null; /* ignore a single unreadable pipeline board */ }

    // 1.5) AUTO-ADVANCE the asking gate when there is NOTHING to ask the human.
    //   The asking run exits by design once it has classified; if a gate found no
    //   human questions, the dispatcher launches the next gate / the real build
    //   itself — no human round-trip. Build ALWAYS goes through launchBuild (the
    //   single source of the build prompt: mandatory board-sync, per-card status,
    //   "run to ready") so a no-fork stage finishes instead of dying as a stub.
    //   Each transition fires at most once per card (idempotent via the *Launched
    //   flags), so the watchdog below ends up guarding the NEW build pid, not a dead ask.
    if (pip && card.column === "asking" && !card.buildLaunched) {
      const rigor = pip.rigor || (card.rigor && card.rigor !== "auto" ? card.rigor : "off");
      const archEmpty = !Array.isArray(pip.archQuestions) || pip.archQuestions.length === 0;
      if (pip.askStage === "done" && archEmpty) {
        // architecture gate passed, no forks → launch the full build (exactly once)
        try { pip.column = "implementing"; fs.writeFileSync(pipFile, JSON.stringify(pip, null, 2)); } catch {}
        const launch = launchBuild(card, projectDir, runDir, pip.answers || card.answers || [], pip.archDecisions || card.archDecisions || [], rigor);
        recordLaunch(card, launch, "build");
        card.buildLaunched = true;
        card.column = "implementing";
        card.blockReason = null;
        card.lastColumnChangeAt = new Date().toISOString();
        card.history.push({ column: "implementing", ts: card.lastColumnChangeAt, via: "auto-build" });
        try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: card.lastColumnChangeAt, event: "auto-build", cardId: card.id, launch }) + "\n"); } catch {}
        changed = true;
      } else if (pip.askStage === "functional-done" && !card.autoArchLaunched) {
        // functional gate produced no human questions → launch architecture classification (once)
        try { pip.askStage = "architecture-pending"; fs.writeFileSync(pipFile, JSON.stringify(pip, null, 2)); } catch {}
        const launch = launchAskArchitecture(card, projectDir, runDir, pip.answers || card.answers || [], rigor);
        recordLaunch(card, launch, "ask-architecture");
        card.autoArchLaunched = true;
        card.askStage = "architecture-pending";
        card.lastColumnChangeAt = new Date().toISOString();
        card.history.push({ column: "asking", ts: card.lastColumnChangeAt, via: "auto-architecture" });
        try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: card.lastColumnChangeAt, event: "auto-architecture", cardId: card.id, launch }) + "\n"); } catch {}
        changed = true;
      }
    }

    // 2) supervise the launched run (issue #1) — only while work is in-flight.
    //    LA4 self-heal: a dead/stalled run gets exactly ONE auto-relaunch (seeded with a
    //    RECOVERY context built from the run's log tail) before we escalate to the human.
    //    `autoHealCount` is the hard fuse: a second consecutive failure → blockCard.
    if (card.runPid && ACTIVE_COLUMNS.has(card.column)) {
      const startedMs = Date.parse(card.runStartedAt || "") || 0;
      const lastMoveMs = Date.parse(card.lastColumnChangeAt || card.runStartedAt || "") || 0;
      const alive = isAlive(card.runPid);
      const died = !alive && now - startedMs > LIVENESS_GRACE_MS;
      const stalled = alive && lastMoveMs && now - lastMoveMs > STALL_MS;
      if (died || stalled) {
        if (stalled) { try { process.kill(card.runPid, "SIGTERM"); } catch {} }
        const fromCol = card.column;
        const how = stalled ? "ЗАВИС" : "УМЕР";
        const humanTail = stalled
          ? `Зависание: станция «${fromCol}» не менялась > ${Math.round(STALL_MS / 60000)} мин; процесс остановлен.`
          : `Прогон завершился, не достигнув ready (процесс ${card.runPid} мёртв, станция «${fromCol}»).`;
        if ((card.autoHealCount || 0) < 1 && isInsideRoot(projectDir)) {
          // ── first failure in this run: auto-heal once ──
          const tail = tailLog(card.runLog || "", 150);
          const recovery = [
            `RECOVERY-КОНТЕКСТ (авто-исцеление LA4): ПРЕДЫДУЩИЙ прогон ${how} на станции «${fromCol}».`,
            `Хвост его лога (последние ~150 строк):`,
            `----- log tail -----`,
            tail || "(лог пуст/недоступен)",
            `----- /log tail -----`,
            `Диагностируй причину по этому хвосту САМ (отдельный вызов модели не нужен) и продолжи с самого`,
            `дальнего ЗЕЛЁНОГО чекпоинта: "git log --oneline" в ветке "autodev/${card.slug}" → коммиты`,
            `"green(<cardId>): …"; при необходимости "git restore --source=<sha> -- <файл>". Фичу заново НЕ начинай.`,
          ].join("\n");
          const rigor = (card.rigor && card.rigor !== "auto") ? card.rigor : "off";
          const { target, launch, kind } = resumeRun(card, projectDir, runDir, rigor, recovery);
          if (launch && launch.launched) {
            card.autoHealCount = (card.autoHealCount || 0) + 1;
            card.column = target;
            card.blockReason = null;
            card.lastColumnChangeAt = new Date().toISOString();
            recordLaunch(card, launch, kind);
            card.history.push({ column: target, ts: card.lastColumnChangeAt, via: "autoheal" });
            try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: card.lastColumnChangeAt, event: "autoheal", cardId: card.id, how, from: fromCol, kind, launch, autoHealCount: card.autoHealCount }) + "\n"); } catch {}
            changed = true;
          } else {
            // the auto-relaunch itself failed to spawn → escalate now
            blockCard(card, `${humanTail} Авто-исцеление не помогло — перезапуск не стартовал${launch && launch.error ? ": " + launch.error : ""}. Открой лог и перезапусти вручную.`);
            changed = true;
          }
        } else {
          // second consecutive failure (or an unsafe project path) → escalate
          const healed = (card.autoHealCount || 0) >= 1 ? " Авто-исцеление уже применялось и не помогло." : "";
          blockCard(card, `${humanTail}${healed} Открой лог и перезапусти.`);
          changed = true;
        }
      }
    }
  }
  // WIP=1 scheduler (§5.1/§5.2): after mirroring, feed each now-free project its next
  // queued card. Runs last so it sees this pass's ready/blocked transitions (a card that
  // just reached `ready` frees the slot for its successor in the same tick).
  if (scheduleQueued(board)) changed = true;
  if (changed) writeBoard(board);
}

// ── http helpers ─────────────────────────────────────────────────────────────
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = "", over = false;
    req.on("data", (c) => {
      if (over) return;
      data += c;
      if (data.length > MAX_BODY) { over = true; resolve({ __tooLarge: true }); req.destroy(); }
    });
    req.on("end", () => { if (over) return; try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
function serveStatic(res, urlPath) {
  let rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath.replace(/^\/+/, ""));
  const full = path.join(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
    res.end(buf);
  });
}

// ── api ──────────────────────────────────────────────────────────────────────
// CSRF / DNS-rebinding guard (issue #3): a mutating request must target this loopback
// host and, if it carries an Origin, that Origin must be this host too. GET stays open.
function sameOrigin(req) {
  const okHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
  if (!okHosts.has(req.headers.host || "")) return false;
  const origin = req.headers.origin;
  if (origin) { try { if (!okHosts.has(new URL(origin).host)) return false; } catch { return false; } }
  return true;
}

async function handleApi(req, res, urlPath) {
  if (req.method !== "GET" && !sameOrigin(req)) return sendJSON(res, 403, { error: "forbidden origin" });

  // GET /api/board
  if (req.method === "GET" && urlPath === "/api/board") {
    return sendJSON(res, 200, readBoard());
  }

  // POST /api/tasks  -> create in backlog
  if (req.method === "POST" && urlPath === "/api/tasks") {
    const b = await readBody(req);
    const project = String(b.project || "").trim();
    const theme = String(b.theme || "").trim();
    if (!project || !theme) return sendJSON(res, 400, { error: "project and theme are required" });
    if (!isInsideRoot(resolveProjectDir(project))) {
      return sendJSON(res, 400, { error: `project must resolve inside ${PROJECTS_ROOT}` });
    }
    const board = readBoard();
    const id = crypto.randomUUID();
    const card = {
      id, project,
      slug: slugify(theme, "task-" + id.slice(0, 8)),
      theme,
      description: String(b.description || "").trim().slice(0, MAX_DESC) || null,
      designLink: String(b.designLink || "").trim() || null,
      requirementsLink: String(b.requirementsLink || "").trim() || null,
      requirements: String(b.requirements || "").trim() || null,
      attachments: [],
      rigor: RIGORS.includes(b.rigor) ? b.rigor : "off",
      // Plan Run scaffold (additive; null = single card = today's behaviour, §1).
      // The integration branch / final-PR mechanics land with the Plan entity (S4);
      // here the field is just carried so a card can belong to a plan.
      planId: (typeof b.planId === "string" && b.planId.trim()) ? b.planId.trim() : null,
      column: "backlog",
      createdAt: new Date().toISOString(),
      dispatchedAt: null,
      history: [{ column: "backlog", ts: new Date().toISOString() }],
    };
    board.cards.push(card);
    writeBoard(board);
    return sendJSON(res, 201, { card });
  }

  // POST /api/tasks/:id/attachments  -> attach a screenshot / requirements file (base64)
  const matt = urlPath.match(/^\/api\/tasks\/([^/]+)\/attachments$/);
  if (matt && req.method === "POST") {
    const body = await readBody(req);
    if (body.__tooLarge) return sendJSON(res, 413, { error: "attachment too large" });
    const board = readBoard();
    const card = board.cards.find((c) => c.id === matt[1]);
    if (!card) return sendJSON(res, 404, { error: "card not found" });
    try { const att = saveAttachment(card, body); writeBoard(board); return sendJSON(res, 201, { card, attachment: att }); }
    catch (e) { return sendJSON(res, 400, { error: String(e.message || e) }); }
  }
  // GET /api/tasks/:id/attachments/:attId/raw  -> serve the file (thumbnails / links)
  const mraw = urlPath.match(/^\/api\/tasks\/([^/]+)\/attachments\/([^/]+)\/raw$/);
  if (mraw && req.method === "GET") {
    const board = readBoard();
    const card = board.cards.find((c) => c.id === mraw[1]);
    if (!card) { res.writeHead(404); return res.end("not found"); }
    return serveAttachment(res, card, mraw[2]);
  }
  // DELETE /api/tasks/:id/attachments/:attId
  const mattd = urlPath.match(/^\/api\/tasks\/([^/]+)\/attachments\/([^/]+)$/);
  if (mattd && req.method === "DELETE") {
    const board = readBoard();
    const card = board.cards.find((c) => c.id === mattd[1]);
    if (!card) return sendJSON(res, 404, { error: "card not found" });
    const ok = removeAttachment(card, mattd[2]);
    if (ok) writeBoard(board);
    return sendJSON(res, ok ? 200 : 404, ok ? { card } : { error: "attachment not found" });
  }

  // POST /api/tasks/:id/answers  -> answer an Asking block; advance the gate
  //   { stage:"functional", answers:[ "<text>", ... ] }
  //   { stage:"architecture", answers:[ { decisionId, choice, ownText, chosenTitle }, ... ] }
  const ma = urlPath.match(/^\/api\/tasks\/([^/]+)\/answers$/);
  if (ma && req.method === "POST") {
    const body = await readBody(req);
    const stage = body.stage === "architecture" ? "architecture" : "functional";
    const answers = Array.isArray(body.answers) ? body.answers : [];
    const board = readBoard();
    const card = board.cards.find((c) => c.id === ma[1]);
    if (!card) return sendJSON(res, 404, { error: "card not found" });
    const projectDir = resolveProjectDir(card.project);
    const runDir = path.join(projectDir, ".grace-feature-dev", card.slug);
    const pf = path.join(runDir, "board.json");
    let pip = {};
    try { pip = JSON.parse(fs.readFileSync(pf, "utf8")); } catch {}
    const rigor = pip.rigor || (card.rigor && card.rigor !== "auto" ? card.rigor : "off");
    let launch;

    if (stage === "functional") {
      const qs = pip.questions || card.questions || [];
      const qa = qs.map((q, i) => ({ q: typeof q === "string" ? q : q.q, a: answers[i] || "" }));
      card.answers = qa;
      try { pip.answers = qa; pip.askStage = "architecture-pending"; fs.writeFileSync(pf, JSON.stringify(pip, null, 2)); } catch {}
      // launch block 2 (architecture); card stays in `asking`
      launch = launchAskArchitecture(card, projectDir, runDir, qa, rigor);
      recordLaunch(card, launch, "ask-architecture");
      card.askStage = "architecture-pending";
      card.lastColumnChangeAt = new Date().toISOString();
      card.history.push({ column: "asking", ts: card.lastColumnChangeAt, via: "answers:functional" });
    } else {
      // architecture: human picked one option per decision (+ optional own text)
      const decisions = (pip.archQuestions || card.archQuestions || []).map((d, i) => {
        const pick = answers.find((a) => a && a.decisionId === d.id) || answers[i] || {};
        const opt = (d.options || []).find((o) => o.id === pick.choice);
        return { id: d.id, q: d.q, choice: pick.choice || "own", chosenTitle: opt ? opt.title : (pick.chosenTitle || "свой вариант"), ownText: pick.ownText || null };
      });
      card.archDecisions = decisions;
      try { pip.archDecisions = decisions; pip.askStage = "done"; pip.column = "implementing"; fs.writeFileSync(pf, JSON.stringify(pip, null, 2)); } catch {}
      launch = launchBuild(card, projectDir, runDir, card.answers || [], decisions, rigor);
      recordLaunch(card, launch, "build");
      card.buildLaunched = true;          // human-chosen build launched here — keep the supervisor from re-spawning it
      card.askStage = "done";
      card.column = "implementing";
      card.blockReason = null;
      card.lastColumnChangeAt = new Date().toISOString();
      card.history.push({ column: "implementing", ts: card.lastColumnChangeAt, via: "answers:architecture" });
    }
    writeBoard(board);
    try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: new Date().toISOString(), event: "answers", stage, cardId: card.id, launch }) + "\n"); } catch {}
    return sendJSON(res, 200, { card, launch });
  }

  // GET /api/tasks/:id/log  -> tail of the run's log (issue #8)
  const mlog = urlPath.match(/^\/api\/tasks\/([^/]+)\/log$/);
  if (mlog && req.method === "GET") {
    const board = readBoard();
    const card = board.cards.find((c) => c.id === mlog[1]);
    if (!card) return sendJSON(res, 404, { error: "card not found" });
    const runDir = path.join(resolveProjectDir(card.project), ".grace-feature-dev", card.slug);
    const candidates = ["build.log", "ask-architecture.log", "ask-functional.log", "clarify.log", "run.log"]
      .map((n) => path.join(runDir, n))
      .filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
    if (card.runLog && fs.existsSync(card.runLog) && !candidates.includes(card.runLog)) candidates.unshift(card.runLog);
    if (!candidates.length) return sendJSON(res, 200, { log: "(лог ещё не создан)", file: null, column: card.column, pidAlive: false });
    const file = candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    let text = "";
    try { text = fs.readFileSync(file, "utf8").slice(-20000); }
    catch (e) { text = "(не удалось прочитать лог: " + (e.message || e) + ")"; }
    return sendJSON(res, 200, { log: text, file: path.basename(file), column: card.column, blockReason: card.blockReason || null, pidAlive: isAlive(card.runPid) });
  }

  // GET /api/tasks/:id/plan  -> the run's DevelopmentPlan + live decomposition status (read-only mirror)
  const mplan = urlPath.match(/^\/api\/tasks\/([^/]+)\/plan$/);
  if (mplan && req.method === "GET") {
    const board = readBoard();
    const card = board.cards.find((c) => c.id === mplan[1]);
    if (!card) return sendJSON(res, 404, { error: "card not found" });
    const runDir = path.join(resolveProjectDir(card.project), ".grace-feature-dev", card.slug);
    const readIf = (name) => { try { return fs.readFileSync(path.join(runDir, name), "utf8"); } catch { return null; } };
    let inner = null;
    try { inner = JSON.parse(fs.readFileSync(path.join(runDir, "board.json"), "utf8")); } catch {}
    const cards = inner && Array.isArray(inner.cards)
      ? inner.cards.map((c) => ({
          id: c.id, title: c.title, column: c.column || "todo", wave: c.wave ?? null, milestone: c.milestone || null,
          verdict: typeof c.verdict === "string" ? c.verdict : (c.verdict && c.verdict.summary) || null,
        }))
      : [];
    return sendJSON(res, 200, {
      developmentPlan: readIf("DevelopmentPlan.md"),
      requirements: readIf("requirements.md"),
      phase: inner ? inner.phase : null,
      column: card.column,
      milestones: inner && Array.isArray(inner.milestones) ? inner.milestones : [],
      cards,
      pidAlive: isAlive(card.runPid),
    });
  }

  // POST /api/tasks/:id/relaunch  -> re-spawn the run for a stuck/blocked card (issue #8)
  const mre = urlPath.match(/^\/api\/tasks\/([^/]+)\/relaunch$/);
  if (mre && req.method === "POST") {
    const board = readBoard();
    const card = board.cards.find((c) => c.id === mre[1]);
    if (!card) return sendJSON(res, 404, { error: "card not found" });
    const projectDir = resolveProjectDir(card.project);
    if (!isInsideRoot(projectDir)) return sendJSON(res, 400, { error: "project resolves outside the projects root" });
    const runDir = path.join(projectDir, ".grace-feature-dev", card.slug);
    try { fs.mkdirSync(runDir, { recursive: true }); } catch {}
    const rigor = (card.rigor && card.rigor !== "auto") ? card.rigor : "off";
    // Resume from the furthest-reached point (shared with the watchdog auto-heal).
    const { target, launch, kind } = resumeRun(card, projectDir, runDir, rigor);
    card.column = target;
    card.blockReason = null;
    card.lastColumnChangeAt = new Date().toISOString();
    recordLaunch(card, launch, kind);
    card.history.push({ column: target, ts: card.lastColumnChangeAt, via: "relaunch" });
    writeBoard(board);
    try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: card.lastColumnChangeAt, event: "relaunch", cardId: card.id, kind, launch }) + "\n"); } catch {}
    return sendJSON(res, 200, { card, launch });
  }

  // PATCH /api/tasks/:id  -> move station (body.column) OR edit fields (Backlog only)
  const m = urlPath.match(/^\/api\/tasks\/([^/]+)$/);
  if (m && req.method === "PATCH") {
    const b = await readBody(req);
    const board = readBoard();
    const card = board.cards.find((c) => c.id === m[1]);
    if (!card) return sendJSON(res, 404, { error: "card not found" });

    if (b.column !== undefined) {
      const column = String(b.column || "");
      if (!COLUMNS.includes(column)) return sendJSON(res, 400, { error: "unknown column" });
      const from = card.column;
      let dispatched = false, queued = false;
      if (from === "backlog" && column !== "backlog" && !card.dispatchedAt) {
        // Leaving Backlog = request to run. Serialize per project (§5.1): dispatch now
        // only if the project's work slot is free; else QUEUE it (no spawn → the shared
        // project cwd is never touched by two runs at once). A fresh card always enters
        // at `todo`, whether it dispatches live or waits.
        card.column = "todo";
        if (canDispatchNow(board, card)) {
          dispatchNow(board, card, "lever");
          dispatched = true;
        } else {
          card.queued = true;
          card.queuedAt = new Date().toISOString();
          card.lastColumnChangeAt = card.queuedAt;
          card.history.push({ column: "todo", ts: card.queuedAt, via: "queued" });
          try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: card.queuedAt, event: "queued", cardId: card.id, project: card.project }) + "\n"); } catch {}
          queued = true;
        }
        writeBoard(board);
        return sendJSON(res, 200, { card, dispatched, queued });
      }
      // any other move (manual station change on an already-dispatched card, etc.)
      card.column = column;
      card.lastColumnChangeAt = new Date().toISOString();
      card.history.push({ column, ts: card.lastColumnChangeAt });
      writeBoard(board);
      return sendJSON(res, 200, { card, dispatched });
    }

    // field edit — only on a not-yet-dispatched (Backlog) card; slug stays stable
    if (card.column !== "backlog" || card.dispatchedAt) {
      return sendJSON(res, 409, { error: "only a Backlog task can be edited" });
    }
    if (b.theme !== undefined) card.theme = String(b.theme).trim() || card.theme;
    if (b.description !== undefined) card.description = String(b.description).trim().slice(0, MAX_DESC) || null;
    if (b.designLink !== undefined) card.designLink = String(b.designLink).trim() || null;
    if (b.requirementsLink !== undefined) card.requirementsLink = String(b.requirementsLink).trim() || null;
    if (b.rigor !== undefined && RIGORS.includes(b.rigor)) card.rigor = b.rigor;
    writeBoard(board);
    return sendJSON(res, 200, { card });
  }

  // DELETE /api/tasks/:id
  if (m && req.method === "DELETE") {
    const board = readBoard();
    const i = board.cards.findIndex((c) => c.id === m[1]);
    if (i === -1) return sendJSON(res, 404, { error: "card not found" });
    board.cards.splice(i, 1);
    writeBoard(board);
    purgeUploads(m[1]);
    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 404, { error: "no such endpoint" });
}

const server = http.createServer((req, res) => {
  const urlPath = req.url.split("?")[0];
  if (urlPath.startsWith("/api/")) return handleApi(req, res, urlPath).catch((e) => sendJSON(res, 500, { error: String(e) }));
  return serveStatic(res, urlPath);
});

ensureData();
server.listen(PORT, HOST, () => {
  console.log(`grace-board → http://${HOST}:${PORT}`);
  console.log(`projects root: ${PROJECTS_ROOT}  (override with GRACE_PROJECTS_ROOT)`);
  setInterval(syncFromPipeline, 2000); // mirror pipeline phase onto the board
});
