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
const AUTONOMIES = ["ask", "auto"];       // Plan Run §5.3: ask = human picks forks · auto = agent picks, hard-floor still stops
// v4 Ш0: the board-level brake. Three positions differ ONLY in what is allowed to finish
// playing. "now" is deliberately NOT a stored value — it is an ACTION (SIGTERM + pause)
// that leaves the board in "after-stage"; see FUNC_hold.
const HOLDS = ["off", "after-stage", "after-run"];
const HOLD_RETRY_MIN = 2;                 // backoff between failed relaunch attempts after a hold is lifted
// Global autonomy default (board.autonomy), overridable per card (card.autonomy). Cached in a
// module var so the prompt builders resolve effAutonomy() without threading `board` everywhere;
// readBoard() refreshes it from disk on every read, PATCH /api/settings persists it.
let GLOBAL_AUTONOMY = "ask";

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

const MAX_DESC = 50000;                // task description hard cap (chars). Was 2000 — too tight for a full
                                       // task brief, and the excess was sliced off silently. A card in a column
                                       // clamps the text to 2 lines (CSS), the drawer renders it in full, so a
                                       // long description costs nothing visually.
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
    if (AUTONOMIES.includes(b.autonomy)) GLOBAL_AUTONOMY = b.autonomy; // refresh the cached global default
    return b;
  } catch { return { updatedAt: null, cards: [] }; }
}
// Atomic: write a sibling temp file, then rename over the target. board.json is ~200 KB and is
// read by OTHER processes (the metrics child, gb.mjs, a human with jq) — a plain writeFileSync
// let one of them see a half-written file, which is exactly how the first metrics run died
// («Unterminated string in JSON at position 193101»). rename(2) inside one directory is atomic.
function writeBoard(board) {
  board.updatedAt = new Date().toISOString();
  const tmp = BOARD_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(board, null, 2));
  fs.renameSync(tmp, BOARD_FILE);
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

// region FUNC_projectConfig — .grace/project.md (+ local.md) merged into every run (design §3)
// ## @purpose A run starts headless in the target project and knows nothing about its
// ##   environment constants (vault path, digest time, role/category enums, stand, release
// ##   policy) — so it ASKS, and the card stalls waiting for a human. The project now carries
// ##   that answer in-repo: `.grace/project.md` (committed: safe to publish) + `.grace/local.md`
// ##   (gitignored: stand URLs, deploy commands, chat ids, absolute paths). Both are read here
// ##   and injected into every phase prompt as CONSTANTS — "don't re-ask, don't invent".
// ## @io (projectDir) -> { cfg, text, files[] } | null   ·  (card) -> prompt block | ""
// ## @invariants
// ## - NO config (no .grace/, unreadable, empty) → returns null → compiledRequirements is
// ##   byte-identical to before. Every existing card of every existing project is untouched.
// ## - local.md OVERRIDES same-named keys of project.md — front-matter deep-merged key by key,
// ##   body merged by "## heading" (local's section replaces project's of the same title).
// ##   A missing local.md is NOT an error (design §3): the run proceeds, deploy data is absent.
// ## - Truncation is never silent (the MAX_DESC lesson): an over-long merge is cut with a
// ##   visible marker naming the dropped char count.
// ## @rationale Q: a real YAML parser? A: zero-dependency is a project invariant, and the
// ##   config schema (§3.2/§3.3) is a small subset — scalars, one nesting level, inline flow
// ##   maps, "- " lists. Parsing that subset is ~40 lines; anything richer is out of contract
// ##   and lands in the body as prose, which is where an LLM reads it just as well.
// ## @modulemap
// ## FUNC 3[calc]  => parseYamlish       — front-matter subset → object
// ## FUNC 3[calc]  => renderYamlish      — object → deterministic yaml-ish text
// ## FUNC 4[calc]  => mergeBodySections  — "## heading" merge, local wins
// ## FUNC 5[io]    => readProjectConfig  — read + merge both files
// ## FUNC 3[calc]  => projectConfigBlock — the prompt block glued into compiledRequirements
// GREP_SUMMARY: .grace/project.md, .grace/local.md, project config, constants, deploy_policy, plan_approval
// STRUCTURE: ▶ parseYamlish → ⊕ deepMerge → ⚡ readProjectConfig(projectDir) → ⎋ projectConfigBlock(card)

const GRACE_CFG_DIR = ".grace";
const MAX_PROJECT_CFG = 8000;          // merged config hard cap (chars) — see the truncation invariant

// Strip a trailing `# comment` outside quotes ("http://h:1#x" and "a: 'b # c'" survive).
function stripYamlComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}
const unquote = (s) => String(s).trim().replace(/^["']|["']$/g, "");
// `{ a: b, c: d }` → { a: "b", c: "d" } (flat flow map only — the schema has no nested flow).
function parseFlowMap(s) {
  const out = {};
  for (const pair of s.slice(1, -1).split(",")) {
    const i = pair.indexOf(":");
    if (i === -1) continue;
    out[pair.slice(0, i).trim()] = unquote(pair.slice(i + 1));
  }
  return out;
}
// Front-matter subset → object: `key: scalar`, `key: { flow map }`, `key:` + indented block,
// `- item` lists. Anything else is ignored (it belongs in the markdown body, not the schema).
function parseYamlish(text) {
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  let listKey = null, listOwner = null;
  for (const raw of String(text).split("\n")) {
    const line = stripYamlComment(raw).replace(/\s+$/, "");
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const t = line.trim();
    if (t.startsWith("- ")) {                       // list item under the last seen key
      if (listOwner && listKey) (listOwner[listKey] = listOwner[listKey] || []).push(unquote(t.slice(2)));
      continue;
    }
    const m = t.match(/^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    const [, key, rest] = m;
    const val = rest.trim();
    if (!val) {                                     // `key:` → nested block OR a list
      parent[key] = {};
      stack.push({ indent, obj: parent[key] });
      listOwner = parent; listKey = key;
    } else if (val.startsWith("{") && val.endsWith("}")) {
      parent[key] = parseFlowMap(val);
      listOwner = null; listKey = null;
    } else {
      parent[key] = unquote(val);
      listOwner = null; listKey = null;
    }
  }
  // `key:` that never got children and never got list items is an empty value, not an empty map
  // — "checked, nothing here" (§3.1 rule 7). Collapse it so the render shows `key:`.
  const collapse = (o) => { for (const k of Object.keys(o)) {
    const v = o[k];
    if (v && typeof v === "object" && !Array.isArray(v)) { Object.keys(v).length ? collapse(v) : (o[k] = ""); }
  } };
  collapse(root);
  return root;
}
// local.md wins key by key; a nested map merges, a scalar/list replaces wholesale.
function deepMerge(base, over) {
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    const a = out[k], b = over[k];
    out[k] = (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b))
      ? deepMerge(a, b) : b;
  }
  return out;
}
function renderYamlish(obj, indent) {
  const pad = " ".repeat(indent || 0);
  return Object.keys(obj).map((k) => {
    const v = obj[k];
    if (Array.isArray(v)) return `${pad}${k}:\n` + v.map((x) => `${pad}  - ${x}`).join("\n");
    if (v && typeof v === "object") return `${pad}${k}:\n` + renderYamlish(v, (indent || 0) + 2);
    return `${pad}${k}: ${v}`;
  }).join("\n");
}
// Split a markdown body into a preamble + ordered "## heading" sections.
function splitSections(body) {
  const pre = [], sections = new Map();
  let cur = null;
  for (const line of String(body || "").split("\n")) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { cur = h[1]; sections.set(cur, sections.get(cur) || []); continue; }
    (cur ? sections.get(cur) : pre).push(line);
  }
  return { pre: pre.join("\n").trim(), sections };
}
// Merge two bodies by heading: local's section REPLACES the project's of the same title,
// its extra sections are appended in order. Same rule as the front-matter merge, one level up.
function mergeBodySections(bodyA, bodyB) {
  const A = splitSections(bodyA), B = splitSections(bodyB);
  const merged = new Map(A.sections);
  for (const [h, lines] of B.sections) merged.set(h, lines);
  const pre = [A.pre, B.pre].filter(Boolean).join("\n\n");
  const out = [...merged].map(([h, lines]) => `## ${h}\n${lines.join("\n").trim()}`).join("\n\n");
  return [pre, out].filter(Boolean).join("\n\n").trim();
}
// `---\n<front matter>\n---\n<body>` → { fm, body }. No front matter → all body.
function splitFrontMatter(text) {
  const m = String(text).match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  return m ? { fm: m[1], body: m[2] } : { fm: "", body: String(text) };
}
const readIfFile = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };

// Read + merge the project's config pair. Returns null when the project carries no config
// at all — the caller then behaves exactly as it did before this existed.
function readProjectConfig(projectDir) {
  if (!isInsideRoot(projectDir)) return null;
  const files = [];
  const pRaw = readIfFile(path.join(projectDir, GRACE_CFG_DIR, "project.md"));
  const lRaw = readIfFile(path.join(projectDir, GRACE_CFG_DIR, "local.md"));   // absent is NOT an error (§3)
  if (pRaw === null && lRaw === null) return null;
  if (pRaw !== null) files.push(`${GRACE_CFG_DIR}/project.md`);
  if (lRaw !== null) files.push(`${GRACE_CFG_DIR}/local.md`);
  const P = splitFrontMatter(pRaw || ""), L = splitFrontMatter(lRaw || "");
  const cfg = deepMerge(parseYamlish(P.fm), parseYamlish(L.fm));
  const body = mergeBodySections(P.body, L.body);
  const head = Object.keys(cfg).length ? renderYamlish(cfg, 0) : "";
  let text = [head, body].filter(Boolean).join("\n\n").trim();
  if (!text) return null;
  if (text.length > MAX_PROJECT_CFG) {
    const dropped = text.length - MAX_PROJECT_CFG;
    text = text.slice(0, MAX_PROJECT_CFG) + `\n… (конфиг обрезан: отброшено ${dropped} симв.; лимит §3.1 — 4000 на файл)`;
  }
  return { cfg, text, files };
}
// The prompt block. Framed as CONSTANTS, because the whole point is that the run stops
// asking about them (design §1.5 / §3): an answer that is a project constant lives here.
function projectConfigBlock(card) {
  const conf = readProjectConfig(resolveProjectDir(card.project));
  if (!conf) return "";
  return [
    `КОНФИГ ПРОЕКТА (${conf.files.join(" + ")}) — КОНСТАНТЫ ОКРУЖЕНИЯ, заданные владельцем проекта.`,
    `Считай их данностью: НЕ переспрашивай их у человека, НЕ выдумывай альтернативы, НЕ ищи их заново в коде.`,
    `Если нужной константы здесь НЕТ — это пробел конфига: реши по коду и отметь в finishNote, что константа отсутствует.`,
    `----- начало конфига -----`,
    conf.text,
    `----- конец конфига -----`,
  ].join("\n");
}
// endregion FUNC_projectConfig

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
  // S1 · project config (§3): environment constants of the TARGET project ride every prompt.
  const cfg = projectConfigBlock(card);
  if (cfg) parts.push(cfg);
  return parts.join("\n\n") || null;
}

// region FUNC_cardBrief — statement-of-work fields + strictness by author (design §4)
// ## @purpose The two most expensive stalls of a run are «is X in scope?» (8 h idle on two
// ##   such questions) and «which fields does entity Y have?». Both are answerable at
// ##   composition time. So a card now carries the answers as first-class fields —
// ##   outOfScope · acceptance · contract · sources — and STRICTNESS depends on WHO wrote it
// ##   (`origin`), not on text length: an agent must fill them, a human owes nothing.
// ## @io (card) -> prompt block · (card) -> dispatch veto · (board,card) -> inherited contracts
// ## @invariants
// ## - `origin` defaults to "human" for every card that lacks the field → ZERO requirements →
// ##   every one of the 86 live cards keeps dispatching exactly as before. No migration needed.
// ## - Only `skill`/`agent` are gated. `deferred` is gated by the draft flag instead (§4.2),
// ##   because a tail inherits its parent's fields and is not a fresh statement of work.
// ## - contract has THREE states: filled (follow verbatim) · "TBD" (design it here, publish it
// ##   to result.contract) · empty (a defect only for skill/agent). Never invent a 4th.
// ## - DAG inheritance is stamped AT DISPATCH (dispatchNow), not read live: the prompt builders
// ##   stay pure over the card, and what the run was told stays visible on the card afterwards.
// ## @rationale Q: why not "description must be ≥ N chars"? A: rejected in the design — a human
// ##   writes short on purpose and drives the task home through the ask gate; that is his mode
// ##   of work, not a defect. The agent has no such excuse.
// ## @modulemap
// ## FUNC 3[calc] => normalizeBrief     — request body → the 5 fields, coerced + capped
// ## FUNC 2[guard]=> briefGaps          — which required fields are missing (strict origins only)
// ## FUNC 2[guard]=> dispatchBlock      — the single dispatch veto (draft OR gaps)
// ## FUNC 4[calc] => briefBlock         — the prompt block ("это решено, не спрашивай")
// ## FUNC 3[calc] => inheritContracts   — pull dep cards' published contracts onto this card
// GREP_SUMMARY: outOfScope, acceptance, contract, sources, origin, draft, deferred, strictness, §4
// STRUCTURE: ▶ normalizeBrief → ⊕ briefGaps → ⚡ dispatchBlock(lever/tick) → ⎋ briefBlock(prompt)

const ORIGINS = ["human", "skill", "agent", "deferred"];
const STRICT_ORIGINS = new Set(["skill", "agent"]);       // §4.2 — the board demands a full brief
const MAX_SOURCES = 20, MAX_SOURCE_LEN = 500;             // §4.3
const MAX_ACCEPTANCE = 50, MAX_ACCEPTANCE_LEN = 2000;
const cardOrigin = (card) => (card && ORIGINS.includes(card.origin)) ? card.origin : "human";

// A list field accepts an array OR a newline/«- »-separated block (what a textarea and a CLI
// heredoc both produce). Empty entries are dropped; the cap is applied, never silently — the
// caller reports it back, same rule as MAX_DESC.
function toLines(v, maxItems, maxLen) {
  const arr = Array.isArray(v) ? v : (typeof v === "string" ? v.split("\n") : []);
  return arr.map((x) => String(x).replace(/^\s*[-•*]\s*/, "").trim()).filter(Boolean)
    .slice(0, maxItems).map((x) => x.slice(0, maxLen));
}
// Coerce the statement-of-work half of a create/edit body. `base` supplies the current values
// so PATCH can send a subset. Returns only the keys present in the body (undefined = untouched).
function normalizeBrief(b, base) {
  const out = {};
  if (b.outOfScope !== undefined) out.outOfScope = String(b.outOfScope).trim().slice(0, MAX_DESC) || null;
  if (b.contract !== undefined) out.contract = String(b.contract).trim().slice(0, MAX_DESC) || null;
  if (b.acceptance !== undefined) out.acceptance = toLines(b.acceptance, MAX_ACCEPTANCE, MAX_ACCEPTANCE_LEN);
  if (b.sources !== undefined) out.sources = toLines(b.sources, MAX_SOURCES, MAX_SOURCE_LEN);
  if (b.origin !== undefined) out.origin = ORIGINS.includes(b.origin) ? b.origin : (base ? cardOrigin(base) : "human");
  if (b.draft !== undefined) out.draft = !!b.draft;
  return out;
}
// Which required fields are missing? Empty for `human`/`deferred` — by design, not by omission.
function briefGaps(card) {
  if (!STRICT_ORIGINS.has(cardOrigin(card))) return [];
  const gaps = [];
  if (!String(card.outOfScope || "").trim()) gaps.push("outOfScope");
  if (!(Array.isArray(card.acceptance) && card.acceptance.length)) gaps.push("acceptance");
  if (!(Array.isArray(card.sources) && card.sources.length)) gaps.push("sources");
  if (!String(card.contract || "").trim()) gaps.push("contract (текст или TBD)");
  return gaps;
}
// The ONE dispatch veto, shared by the lever, the queue tick and plan assembly, so a card can
// never start a run through one door that the other door would have refused.
function dispatchBlock(card) {
  if (card.draft) return { error: "черновик: проверь унаследованные поля и сними пометку черновика", draft: true, missing: [] };
  const missing = briefGaps(card);
  if (missing.length) return { error: `постановка неполна для origin=${cardOrigin(card)}: не заполнено — ${missing.join(", ")}`, missing };
  return null;
}
// Contracts published by this card's dependencies (§4.1): stamped at dispatch so the run gets
// them ready instead of asking the human what the previous stage decided.
function inheritContracts(board, card) {
  const deps = Array.isArray(card.dependsOn) ? card.dependsOn : [];
  const got = [];
  for (const id of deps) {
    const dep = board.cards.find((c) => c.id === id);
    const text = dep && ((dep.result && dep.result.contract) || dep.contractResult);
    if (text) got.push({ from: dep.id, theme: dep.theme || null, contract: String(text).slice(0, MAX_DESC) });
  }
  card.inheritedContracts = got;
}
// The prompt block. Each field gets its own heading with an explicit instruction — a scope
// boundary buried in prose is exactly how «is X in scope?» reached the human in the first place.
function briefBlock(card) {
  const out = [];
  if (String(card.outOfScope || "").trim()) out.push(
    `НЕ ВХОДИТ В ОБЪЁМ — ЭТО УЖЕ РЕШЕНО НА ЭТАПЕ ПОСТАНОВКИ. НЕ спрашивай про это, НЕ делай это,`,
    `НЕ выноси это в deferred как «обнаруженное»:`, card.outOfScope, ``);
  if (Array.isArray(card.acceptance) && card.acceptance.length) out.push(
    `ПРИЁМКА (Definition of Done карточки — каждый пункт обязан иметь прогоняемую проверку;`,
    `из этих же пунктов собирается приёмка всего прогона):`,
    ...card.acceptance.map((a, i) => `${i + 1}) ${a}`), ``);
  const contract = String(card.contract || "").trim();
  if (contract && /^tbd$/i.test(contract)) out.push(
    `КОНТРАКТ ДАННЫХ: TBD — его проектируешь ТЫ в этой карточке (это и есть часть задачи).`,
    `Перед "ready" запиши получившийся контракт (модели, поля, эндпоинты — дословно) в top-level`,
    `"contract" своего board.json: зависимые этапы получат его готовым и не будут переспрашивать.`, ``);
  else if (contract) out.push(
    `КОНТРАКТ ДАННЫХ — СЛЕДУЙ ДОСЛОВНО, не синтезируй свой и не переспрашивай:`, contract, ``);
  if (Array.isArray(card.sources) && card.sources.length) out.push(
    `ИСТОЧНИКИ ТРЕБОВАНИЙ (в порядке приоритета; помеченное как устаревшее — не использовать):`,
    ...card.sources.map((s) => `• ${s}`), ``);
  const inh = Array.isArray(card.inheritedContracts) ? card.inheritedContracts : [];
  if (inh.length) out.push(
    `КОНТРАКТ ОТ ПРЕДЫДУЩИХ ЭТАПОВ ПРОГОНА (уже спроектирован — бери как есть, НЕ переспрашивай`,
    `и НЕ переопределяй; расхождение с ним — повод остановиться, а не «улучшить»):`,
    ...inh.map((x) => `• этап «${x.theme || x.from}»:\n${x.contract}`), ``);
  return out.length ? out.join("\n").trim() : "";
}
// endregion FUNC_cardBrief

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

// region FUNC_hold — the board-level brake: let it finish playing, then stand still (v4 Ш0)
// ## @purpose Give the human a way to STOP the conveyor without killing it. Until now the
// ##   only stop was pausing one card; "let the current run finish and don't start the next"
// ##   was impossible short of killing the server. The three positions differ solely in what
// ##   is allowed to finish playing — that difference is the whole feature, so it is modelled
// ##   as data (board.hold) and not as a kill switch.
// ## @io (board) -> holdMode/runningPlanIds are pure reads · stopNow/resumeHeld mutate cards
// ## @invariants
// ## - The hold lives in board.json: it survives a server restart and is lifted ONLY by a human.
// ## - Closing a run is NOT new work: planCloseTick is never gated by the hold, so a run held
// ##   with "after-run" still reaches its PR by its own policy.
// ## - "now" never persists as a hold value: it kills the live run and leaves "after-stage",
// ##   so the queue behind it cannot roll forward while the human decides.
// ## - A card stopped by the brake keeps its queue place (paused, like the quota stop) and is
// ##   relaunched from the furthest RECORDED point — the process context survives nothing.
// ## @rationale Q: why is "the current run" computed as started-and-unfinished instead of
// ##   "whoever holds the project slot right now"? A: between two stages a plan holds no slot
// ##   at all. Keying on the live card would make "after-run" freeze the very run it promised
// ##   to let finish, the moment it was armed in that gap.
// ## @modulemap
// ## FUNC 2[read]    => holdMode        — normalize board.hold, unknown value reads as "off"
// ## FUNC 4[read]    => runningPlanIds  — plans already started and not yet finished
// ## FUNC 6[persist] => stopNow         — SIGTERM the live run + park the card + arm after-stage
// ## FUNC 7[persist] => resumeHeld      — hold lifted → relaunch what the brake stopped
// GREP_SUMMARY: hold, brake, stop conveyor, after-stage, after-run, SIGTERM, resumeHeld, pausedKind stop
// STRUCTURE: ▶ holdMode → ⊕ runningPlanIds → ⚡ stopNow(SIGTERM+pause) → ⎋ resumeHeld(tick)

// Unknown / missing value reads as "off" — a corrupted field must never freeze the board.
function holdMode(board) { return HOLDS.includes(board.hold) ? board.hold : "off"; }

// Which plans count as "the current run" for `after-run`: started (some card was dispatched)
// and not finished (some card is still short of terminal). Deliberately independent of who
// holds the project slot this second — see @rationale.
function runningPlanIds(board) {
  const ids = new Set();
  for (const plan of board.plans || []) {
    const cards = (plan.cardIds || []).map((id) => board.cards.find((c) => c.id === id)).filter(Boolean);
    if (!cards.length) continue;
    if (cards.some((c) => c.dispatchedAt) && cards.some((c) => c.column !== TERMINAL && c.column !== "blocked"))
      ids.add(plan.id);
  }
  return ids;
}

// "Оборвать этап сейчас": the pause flag alone does NOT stop work — nobody kills the process
// and syncFromPipeline merely stops mirroring the card, so the agent keeps writing code while
// the board claims it is paused. So the stop is a real SIGTERM, and only then the pause.
// Returns the ids it actually stopped.
function stopNow(board) {
  const ts = new Date().toISOString();
  const stopped = [];
  for (const card of board.cards) {
    if (!card.dispatchedAt || card.queued || card.paused) continue;
    // ACTIVE_COLUMNS, not OCCUPYING_COLUMNS: in `asking` the run has already exited by design and
    // the board is waiting on the human. There is no work there to cut short — parking such a card
    // would only cost it a relaunch later for nothing.
    if (!ACTIVE_COLUMNS.has(card.column)) continue;
    if (card.runPid && isAlive(card.runPid)) { try { process.kill(card.runPid, "SIGTERM"); } catch { /* already gone */ } }
    card.paused = true;
    card.pausedKind = "stop";
    card.pausedReason = "остановлено человеком";
    card.pausedUntil = null;          // this pause has no clock: only a human lifts it
    card.pausedAt = ts;
    card.wardenPending = null;
    card.notes = (card.notes || []).slice(-19);
    card.notes.push({ ts, by: "board", class: "stop", text:
      `Этап оборван стоп-краном на станции «${card.column}». Место в очереди сохранено; когда снимешь ` +
      `удержание, прогон продолжится с самой дальней записанной точки — контекст процесса не переживает обрыв, ` +
      `переживают ответы, решения и зелёные коммиты.` });
    stopped.push(card.id);
    try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts, event: "hold-stop", cardId: card.id, column: card.column, pid: card.runPid || null }) + "\n"); } catch {}
  }
  return stopped;
}

// The hold is lifted → put back what the brake stopped. Mirror image of quotaResumeTick:
// same resumeRun, same "furthest recorded point" rule, different reason in the RECOVERY block.
function resumeHeld(board) {
  if (holdMode(board) !== "off") return false;
  const now = Date.now();
  let changed = false;
  for (const card of board.cards) {
    if (!card.paused || card.pausedKind !== "stop") continue;
    // Back off between failed relaunch attempts. Without this the tick retries every 2 s and
    // writes a journal line each time — a card that cannot spawn would drown DISPATCH_LOG.
    if (card.holdRetryAt && Date.parse(card.holdRetryAt) > now) continue;
    const unpause = () => { card.paused = false; card.pausedKind = null; card.pausedReason = null; card.pausedUntil = null; card.pausedAt = null; };
    if (!card.dispatchedAt || card.queued || card.column === TERMINAL || card.column === "backlog") {
      unpause(); changed = true; continue;
    }
    const projectDir = resolveProjectDir(card.project);
    if (!isInsideRoot(projectDir)) { unpause(); changed = true; continue; }
    if (hasActiveForProject(board, card.project, card.id)) continue;   // WIP=1 outlives the brake
    const runDir = path.join(projectDir, ".grace-feature-dev", card.slug);
    const rigor = (card.rigor && card.rigor !== "auto") ? card.rigor : "off";
    const recovery = [
      `RECOVERY-КОНТЕКСТ (этап был оборван человеком стоп-краном): ПРЕДЫДУЩИЙ прогон убит сигналом на станции`,
      `«${card.column}» — это НЕ дефект кода и НЕ причина переделывать фичу. Удержание снято, продолжай работу.`,
      `Продолжи с самого дальнего ЗЕЛЁНОГО чекпоинта: "git log --oneline" в ветке "${branchFor(card)}" → коммиты`,
      `"green(<cardId>): …"; при необходимости "git restore --source=<sha> -- <файл>". Фичу заново НЕ начинай.`,
    ].join("\n");
    const { target, launch, kind } = resumeRun(card, projectDir, runDir, rigor, recovery);
    if (launch && launch.launched) {
      unpause();
      card.holdRetryAt = null;
      card.column = target;
      card.blockReason = null;
      card.lastColumnChangeAt = new Date().toISOString();
      recordLaunch(card, launch, kind);
      card.history.push({ column: target, ts: card.lastColumnChangeAt, via: "hold-resume" });
      card.notes = (card.notes || []).slice(-19);
      card.notes.push({ ts: card.lastColumnChangeAt, by: "board", class: "stop",
        text: `Удержание снято — прогон продолжен со станции «${target}» (${kind}), с последнего зелёного чекпоинта.` });
      try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: card.lastColumnChangeAt, event: "hold-resume", cardId: card.id, kind }) + "\n"); } catch {}
      changed = true;
    } else {
      // Could not spawn (bin missing, AUTORUN=0…): stay parked rather than silently die, and probe
      // again later. The card is visibly stopped, which is the honest state.
      card.holdRetryAt = new Date(now + HOLD_RETRY_MIN * 60000).toISOString();
      changed = true;
      try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: new Date(now).toISOString(), event: "hold-resume-failed",
        cardId: card.id, error: (launch && launch.error) || (launch && launch.reason) || "spawn failed", retryAt: card.holdRetryAt }) + "\n"); } catch {}
    }
  }
  return changed;
}
// endregion FUNC_hold

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
// May this card start its run right now, and if not — WHICH gate holds it? Returns null when
// every gate is open. The named reason is what lets the queue say «ждёт предыдущий прогон»
// instead of silently standing still (A2).
//   1) the per-project WIP=1 slot is free (S0), 2) every dependsOn card is `ready` (S1),
//   3) no files[] conflict with an active sibling (S1 — subsumed by WIP=1, forward-compat),
//   4) A2: no EARLIER plan of the same project whose code is not yet in `main`.
function dispatchGate(board, card) {
  if (card.paused) return { gate: "paused" };                  // S4 §2.2: paused keeps its place in the queue
  const veto = dispatchBlock(card);                            // S3 §4.2: draft / incomplete brief never starts
  if (veto) return { gate: "brief", ...veto };
  if (hasActiveForProject(board, card.project, card.id)) return { gate: "wip" };
  if (!depsSatisfied(board, card)) return { gate: "deps" };
  if (filesConflict(board, card)) return { gate: "files" };
  const order = planOrderHold(board, card);
  if (order) return { gate: "plan-order", ...order };
  return null;
}
const canDispatchNow = (board, card) => dispatchGate(board, card) === null;
// Actually start the card's run: clear the queued flag, stamp it live, seed + spawn.
// Shared by the PATCH (lever) path and the tick scheduler so both dispatch identically.
function dispatchNow(board, card, via) {
  card.queued = false;
  card.orderHold = null;                          // A2: whatever it was waiting for has arrived
  inheritContracts(board, card);   // S3 §4.1: dep contracts are frozen onto the card at dispatch
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
  // S6: a subscription limit hits the ACCOUNT, so a freshly dispatched card would die on spawn
  // and burn its fuse. While the window is open the queue simply holds — order is preserved.
  if (quotaOpen(board)) return false;
  // v4 Ш0: a human hold is the same early exit, just by a flag instead of a clock. "after-stage"
  // starts nothing at all; "after-run" still feeds the stages of runs already under way.
  const hold = holdMode(board);
  if (hold === "after-stage") return false;
  const holding = hold === "after-run" ? runningPlanIds(board) : null;
  for (const card of board.cards) {
    if (!card.queued) continue;
    if (holding && !(card.planId && holding.has(card.planId))) continue;
    const gate = dispatchGate(board, card);
    if (gate) {
      // A2: the plan-order gate is the only one that is invisible on the board — WIP, deps and
      // files all show as a live sibling card. Write it down once per blocking plan.
      if (gate.gate === "plan-order" && noteOrderHold(card, gate)) changed = true;
      continue;
    }
    dispatchNow(board, card, "queue-dispatch");
    try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: card.dispatchedAt, event: "queue-dispatch", cardId: card.id, project: card.project }) + "\n"); } catch {}
    changed = true;
  }
  return changed;
}
// endregion FUNC_scheduleQueued

// region FUNC_dagGates — dependsOn[] DAG readiness + files[] disjointness (roadmap §5.2)
// ## @purpose Order stages of a plan by dependency, not just by project slot. A card
// ##   with dependsOn[] stays queued until EVERY dep card is `ready`; files[] keeps
// ##   file-overlapping stages strictly one-after-another (already true under WIP=1, so
// ##   this is a forward-compat guard for a future parallel/fanout mode, never the
// ##   deciding gate today — logged as such, no silent cap).
// ## @invariants
// ## - No dependsOn (single card, planId:null) → depsSatisfied is TRUE → immediate (backward-compat).
// ## - A missing/deleted dep id is treated as UNSATISFIED (safe: the card waits, the chip shows it),
// ##   never silently skipped — a broken DAG edge must be visible, not auto-passed.
// GREP_SUMMARY: dependsOn, DAG, files disjoint, depsSatisfied, filesConflict, wave ordering

// Every dependsOn card must be `ready` (TERMINAL). Empty deps → trivially satisfied.
function depsSatisfied(board, card) {
  const deps = Array.isArray(card.dependsOn) ? card.dependsOn : [];
  if (!deps.length) return true;
  return deps.every((depId) => {
    const dep = board.cards.find((c) => c.id === depId);
    return dep && dep.column === TERMINAL;
  });
}
// Does this card share a file with an active sibling of the SAME project? Under WIP=1
// there is at most one active card per project, so canDispatchNow's slot gate already
// blocks any overlap — this can only fire in a future >1-per-project mode. Kept explicit
// so the files[] contract is enforced by code, not by assumption.
function filesConflict(board, card) {
  const files = Array.isArray(card.files) ? card.files : [];
  if (!files.length) return false;
  const mine = new Set(files);
  return board.cards.some((c) =>
    c.id !== card.id && c.project === card.project && c.dispatchedAt && !c.queued &&
    OCCUPYING_COLUMNS.has(c.column) && Array.isArray(c.files) && c.files.some((f) => mine.has(f)));
}
// endregion FUNC_dagGates

// region FUNC_planOrderGate — a plan does not start until the PREVIOUS one is in `main` (A2)
// ## @purpose Between two PLANS of one project there was no link at all: WIP=1 serializes cards,
// ##   `dependsOn` serializes stages inside a run — but the moment the last stage of run N hit
// ##   `ready`, run N+1 was free to start against a working tree whose code had never been
// ##   merged. It happened twice (06.08 A/B/C and 07.08 D/E): the next run branched off a tree
// ##   still carrying the previous run's unmerged work, and its stages wrote into the wrong branch.
// ## ## @io (board, card) -> null | {planId, branch, state} · plus a detached `git` probe per branch
// ## @invariants
// ## - The check is FACTUAL, not a flag: `git merge-base --is-ancestor <branch> origin/main`
// ##   after a fetch. A plan marked «done» whose PR was never merged still holds the queue.
// ## - UNKNOWN (probe not finished yet) reads as NOT-in-main: the safe side is to wait.
// ## - A blocked plan does NOT fall into `blocked` — it waits exactly like the WIP=1 queue, so
// ##   the moment the PR lands the next run starts by itself, with no human kick.
// ## - Single cards (planId: null) are NEVER held: a fixup card (C3) must be able to overtake a
// ##   stuck plan — otherwise the very thing that unblocks the queue is blocked by the queue.
// ## - Escape hatches for a plan that will never merge: `archived` (dismissed by hand) or an
// ##   explicit `orderGateWaived: true`. Without them an abandoned run would hold the project
// ##   forever — and it would do so LOUDLY, via plan-order-hold in the journal.
// ## @rationale Q: why a detached probe with a TTL cache instead of a sync `git` call?
// ##   A: dispatchGate runs inside the 2 s tick and inside PATCH; a `git fetch` there would
// ##   block the whole board (and the UI) for seconds at a time.
// GREP_SUMMARY: A2, plan order, previous plan, merge-base, is-ancestor, origin/main, order hold
const ANCESTRY_DIR = path.join(DATA_DIR, "ancestry");
const ANCESTRY_TTL_MS = Number(process.env.GRACE_ANCESTRY_TTL_SEC || 120) * 1000;
const ANCESTRY_PROBE_MS = 5 * 60 * 1000;          // a probe stuck longer than this may be re-armed
const ancestryCache = new Map();                  // key → { state, at, probing, startedAt }
// "in-main" | "not-in-main" | "no-ref" (branch exists nowhere → nothing to wait for) | "unknown"
function branchInMain(projectDir, branch) {
  if (!branch) return "no-ref";
  const key = crypto.createHash("sha1").update(projectDir + "\n" + branch).digest("hex").slice(0, 16);
  const file = path.join(ANCESTRY_DIR, key + ".out");
  const e = ancestryCache.get(key) || {};
  const now = Date.now();
  if (e.probing) {
    const r = readStep(file);
    if (r) {
      const state = /IN-MAIN/.test(r.text) ? "in-main" : /NOT-IN-MAIN/.test(r.text) ? "not-in-main"
        : /NO-REF/.test(r.text) ? "no-ref" : "unknown";
      ancestryCache.set(key, { state, at: now, probing: false });
      return state;
    }
    if (now - (e.startedAt || 0) > ANCESTRY_PROBE_MS) ancestryCache.set(key, { ...e, probing: false });
    return e.state || "unknown";
  }
  if (e.at && now - e.at < ANCESTRY_TTL_MS) return e.state;
  try { fs.mkdirSync(ANCESTRY_DIR, { recursive: true }); } catch {}
  const sh = `git fetch -q origin 2>/dev/null; for r in ${shq("origin/" + branch)} ${shq(branch)}; do `
    + `if git rev-parse --verify -q "$r" >/dev/null 2>&1; then `
    + `git merge-base --is-ancestor "$r" origin/main && echo IN-MAIN || echo NOT-IN-MAIN; exit 0; fi; done; echo NO-REF`;
  const st = spawnStep(projectDir, sh, file);
  ancestryCache.set(key, { state: e.state || "unknown", at: e.at || 0, probing: !!st.started, startedAt: now });
  return e.state || "unknown";
}
// Which EARLIER plan of this project still holds the queue, if any.
function planOrderHold(board, card) {
  if (!card || !card.planId) return null;                       // одиночная карточка не ждёт никого
  const mine = planById(board, card.planId);
  if (!mine) return null;
  const projectDir = resolveProjectDir(card.project);
  if (!isInsideRoot(projectDir)) return null;
  const mineAt = Date.parse(mine.createdAt || "") || 0;
  for (const p of board.plans || []) {
    if (p.id === mine.id || p.project !== card.project) continue;
    if (!(p.cardIds || []).length) continue;
    if (p.archived || p.orderGateWaived) continue;
    if ((Date.parse(p.createdAt || "") || 0) >= mineAt) continue;   // только СТАРШИЕ прогоны
    const state = branchInMain(projectDir, p.integrationBranch);
    if (state === "in-main" || state === "no-ref") continue;
    return { planId: p.id, branch: p.integrationBranch, state, goal: p.goal || null };
  }
  return null;
}
// One journal line per (card → blocking plan), not per tick: the hold can last hours.
function noteOrderHold(card, hold) {
  if (card.orderHold && card.orderHold.planId === hold.planId) return false;
  card.orderHold = { planId: hold.planId, branch: hold.branch, state: hold.state, since: new Date().toISOString() };
  try {
    fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: card.orderHold.since, event: "plan-order-hold",
      cardId: card.id, planId: card.planId, waitsFor: hold.planId, branch: hold.branch, state: hold.state,
      note: "предыдущий прогон проекта ещё не доехал до main" }) + "\n");
  } catch {}
  return true;
}
// endregion FUNC_planOrderGate

// region FUNC_releaseManifest — «Результат» aggregate + 5-section release manifest (roadmap §6/§6.1)
// ## @purpose Turn what a card ALREADY reports (branchLink, finishNote, blockReason,
// ##   archDecisions, the deploy{} block the build writes at `ready`) into two derived
// ##   artifacts: (a) card.result — the single "Результат" aggregate + git link, and
// ##   (b) a 5-section RELEASE MANIFEST {migrations,env,services,seed,manualChecks}.
// ##   A single card (planId:null) → its own manifest = task.result.releaseManifest,
// ##   attached to its PR. A plan (planId set) → per-section accumulation of its stages'
// ##   manifests (planReleaseManifest), attached to the final integration-branch PR.
// ## @io (card | board,planId) -> result aggregate | plan-level accumulated manifest
// ## @invariants
// ## - ALL 5 keys are always present in a normalized manifest: [] = "checked, empty",
// ##   a MISSING key = "forgot" → surfaced as manifestMissing (never silently defaulted away),
// ##   so "correctly empty" is distinguishable from "omitted" (§6.1).
// ## - Additive/forward-only: absent deploy{} → result carries no manifest, single-card
// ##   path unchanged. No Plan entity is required here (it lands in S4) — accumulation is
// ##   keyed by the planId field the card already carries since S0.
// ## - Per-section merge (§6.1): env by variable NAME (value clash → warn); migrations/seed
// ##   by path/id, EXACT-dup collapse only, DAG order preserved (order stages reached ready);
// ##   services/manualChecks by identity, first-seen. NEVER content-dedup or re-sort migrations.
// ## @modulemap
// ## FUNC 3[calc] => normalizeManifest          — coerce deploy{} to 5 arrays + list missing keys
// ## FUNC 4[calc] => buildResult                 — assemble card.result aggregate (git+forks+outcome+manifest)
// ## FUNC 6[calc] => accumulateReleaseManifest   — per-section merge across ordered stages
// ## FUNC 3[calc] => planReleaseManifest         — group a plan's cards (by planId), order, accumulate
// GREP_SUMMARY: releaseManifest, deploy, result, manifest accumulation, migrations env services seed manualChecks, Plan Run §6.1
// STRUCTURE: ▶ normalizeManifest → ⊕ buildResult(card) → ⚡ accumulateReleaseManifest(stages) → ⎋ planReleaseManifest(planId)

const MANIFEST_SECTIONS = ["migrations", "env", "services", "seed", "manualChecks"];
const hasDeploy = (deploy) => !!deploy && typeof deploy === "object" && MANIFEST_SECTIONS.some((s) => s in deploy);

// Flatten one manifest item to a searchable string (for the mechanical floor / display).
function itemStr(item) {
  if (item && typeof item === "object") return [item.name, item.value, item.note, item.path, item.file, item.id, item.text, item.desc].filter(Boolean).join(" ");
  return String(item);
}
// S3 · MECHANICAL FLOOR (roadmap §5.3, source 1 — deterministic, no agent). Reads ONLY the
// deploy{} manifest a card already writes (SR) and flags objectively-visible irreversible
// classes that ALWAYS stop for a human, even under autonomy=auto: destructive migration,
// data deletion in a seed/backfill, a new secret env var. AUTO never merges main (git-floor),
// so a flagged card's items just surface for human sign-off on the final PR — they don't auto-clear.
const FLOOR_DESTRUCTIVE_RE = /\b(DROP\s+(TABLE|COLUMN|DATABASE|SCHEMA|INDEX|CONSTRAINT)|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE\b[\s\S]*\bDROP\b)/i;
const FLOOR_SECRET_RE = /(^|_)(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE)\b/i;
function mechanicalFloor(deploy) {
  if (!hasDeploy(deploy)) return [];
  const { manifest } = normalizeManifest(deploy);
  const flags = [];
  for (const m of manifest.migrations) { const s = itemStr(m); if (FLOOR_DESTRUCTIVE_RE.test(s)) flags.push({ class: "destructive-migration", detail: s }); }
  for (const sd of manifest.seed) { const s = itemStr(sd); if (FLOOR_DESTRUCTIVE_RE.test(s)) flags.push({ class: "data-deletion", detail: s }); }
  for (const e of manifest.env) { const name = manifestItemKey("env", e); if (FLOOR_SECRET_RE.test(name)) flags.push({ class: "new-secret", detail: name }); }
  return flags;
}

// Coerce a raw deploy{} block into exactly the 5 array sections, and report which keys
// were absent (missing ≠ empty: [] means "checked, nothing to do"; absent means "forgot").
function normalizeManifest(deploy) {
  const manifest = {}, missing = [];
  const src = deploy && typeof deploy === "object" ? deploy : {};
  for (const s of MANIFEST_SECTIONS) {
    if (Array.isArray(src[s])) manifest[s] = src[s];
    else { manifest[s] = []; if (!(s in src)) missing.push(s); }
  }
  return { manifest, missing };
}

// The "Результат" aggregate (§6): git link + AUTO-taken forks + outcome + block reason +
// this unit's own release manifest. Pure over fields the card already holds — no new data.
function buildResult(card) {
  const auto = (Array.isArray(card.archDecisions) ? card.archDecisions : []).filter((d) => d && d.ownText);
  const { manifest, missing } = normalizeManifest(card.deploy);
  const present = hasDeploy(card.deploy);
  return {
    branchLink: card.branchLink || null,
    finishNote: card.finishNote || null,
    blockReason: card.column === "blocked" ? (card.blockReason || null) : null,
    autoDecisions: auto,
    // S3 §4.1: the contract this card DESIGNED (card.contract === "TBD" → the run publishes it
    // as top-level "contract"). Dependents inherit it at dispatch — see inheritContracts().
    contract: card.contractResult || null,
    releaseManifest: present ? manifest : null,
    manifestMissing: present ? missing : [],
    floor: present ? mechanicalFloor(card.deploy) : [],   // S3: hard-floor flags (human sign-off), §5.3
  };
}

// The § merge key for one manifest item (strings or {name/path/id} objects both tolerated).
function manifestItemKey(section, item) {
  if (item && typeof item === "object")
    return section === "env"
      ? String(item.name || item.key || JSON.stringify(item))
      : String(item.path || item.file || item.id || item.name || JSON.stringify(item));
  const s = String(item);
  return section === "env" ? s.split("=")[0].trim() : s;
}
function envValue(item) {
  if (item && typeof item === "object") return item.value != null ? String(item.value) : null;
  const s = String(item), i = s.indexOf("=");
  return i === -1 ? null : s.slice(i + 1).trim();
}

// Per-section accumulation across an ORDERED list of stage cards (§6.1). Order is the
// caller's contract (= order stages reached `ready`) so migrations/seed stay topological.
// Returns { manifest{5 keys}, warnings[] } — first-seen wins, only exact/same-name collapse.
function accumulateReleaseManifest(orderedCards) {
  const acc = {}, seen = {};
  for (const s of MANIFEST_SECTIONS) { acc[s] = []; seen[s] = new Map(); }
  const warnings = [];
  for (const card of orderedCards) {
    if (!hasDeploy(card.deploy)) continue;
    const { manifest } = normalizeManifest(card.deploy);
    for (const section of MANIFEST_SECTIONS) {
      for (const item of manifest[section]) {
        const key = manifestItemKey(section, item);
        if (seen[section].has(key)) {
          if (section === "env") {
            const pv = envValue(seen[section].get(key)), nv = envValue(item);
            if (pv != null && nv != null && pv !== nv)
              warnings.push(`env ${key}: «${pv}» (ранее) ≠ «${nv}» (этап ${card.id})`);
          }
          continue; // same-name / exact-dup collapse; DAG order preserved by push-once
        }
        seen[section].set(key, item);
        acc[section].push(item);
      }
    }
  }
  return { manifest: acc, warnings };
}

// The ts a card reached `ready` — for topological ordering of a plan's manifests. Falls
// back to lastColumnChangeAt, then creation, so the ordering is always total & stable.
function readyAt(card) {
  const h = (card.history || []).find((e) => e.column === TERMINAL);
  return Date.parse((h && h.ts) || card.lastColumnChangeAt || card.createdAt || "") || 0;
}
// plan.result.releaseManifest (§6.1): accumulate a plan's cards (by planId), ordered by
// when they reached `ready`. Computed on demand from cards the plan already owns — no Plan
// entity needed until S4, which will render the plan-rail on top of this shape.
function planReleaseManifest(board, planId) {
  const cards = board.cards
    .filter((c) => c.planId === planId)
    .sort((a, b) => readyAt(a) - readyAt(b));
  const { manifest, warnings } = accumulateReleaseManifest(cards);
  const floor = cards.flatMap((c) => mechanicalFloor(c.deploy).map((f) => ({ ...f, stage: c.id })));
  return {
    planId,
    stageCount: cards.length,
    releaseManifest: manifest,
    warnings,
    floor, // S3 §5.3: mechanical hard-floor flags across the plan → human sign-off on the final PR
    stages: cards.map((c) => ({ id: c.id, theme: c.theme, column: c.column, manifestMissing: buildResult(c).manifestMissing })),
  };
}
// endregion FUNC_releaseManifest

// region FUNC_plans — Plan entity: assemble a run from EXISTING board cards (roadmap §1/§2, v2)
// ## @purpose A Plan is NOT generated from a goal by LLM decomposition — it is ASSEMBLED from
// ##   unfinished cards the user already has on the board (Backlog + To do of one project).
// ##   createPlan wires the chosen cards into a DAG (planId + dependsOn), hands them the plan's
// ##   SHARED integration branch, sets their autonomy from the plan mode, and enqueues them
// ##   (WIP=1 + deps decide order). The goal is only context for the final PR.
// ## @invariants
// ## - Only Backlog / To do cards of the plan's project, not yet dispatched and not already in a
// ##   plan, may be assembled — the run creates NO cards from scratch (v2 model).
// ## - integrationBranch = autodev/plan-<id>; every stage commits there (base = its tip, §4).
// ## - status is DERIVED from the stage columns — never a stale stored value.
// ## - A single card (planId:null) is byte-for-byte untouched by any of this.
// GREP_SUMMARY: Plan, plan run, assemble from cards, planId, integrationBranch, plan-rail, §1 §2
const PLAN_ASSEMBLABLE = new Set(["backlog", "todo"]);
const planById = (board, id) => (board.plans || []).find((p) => p.id === id) || null;
// A cyclic dependsOn graph would queue every stage forever (depsSatisfied never true) with no
// dispatch and no error — a silent deadlock. Reject it at assembly. DFS over deps restricted to
// the plan's own stages (self-edges ignored, matching how they're wired below).
function stagesHaveCycle(stages) {
  const inSet = new Set(stages.map((s) => s.cardId));
  const dep = new Map(stages.map((s) => [s.cardId, (Array.isArray(s.dependsOn) ? s.dependsOn : []).filter((d) => d !== s.cardId && inSet.has(d))]));
  const state = new Map(); // 0/undefined = unseen · 1 = on stack · 2 = done
  const dfs = (id) => {
    state.set(id, 1);
    for (const d of dep.get(id) || []) {
      const st = state.get(d) || 0;
      if (st === 1) return true;                 // back-edge → cycle
      if (st === 0 && dfs(d)) return true;
    }
    state.set(id, 2);
    return false;
  };
  for (const s of stages) if ((state.get(s.cardId) || 0) === 0 && dfs(s.cardId)) return true;
  return false;
}
// Derived status from the plan's stage columns (§2 lifecycle) — the cards are the truth.
function planStatus(board, plan) {
  // S5 §5.6: once the closing phase starts it OWNS the status — running → verifying → done|failed.
  // Before that the stage columns are still the truth.
  if (plan.closeStatus) return plan.closeStatus;
  const cards = (plan.cardIds || []).map((id) => board.cards.find((c) => c.id === id)).filter(Boolean);
  if (!cards.length) return "empty";
  if (cards.every((c) => c.column === TERMINAL)) return "done";
  if (cards.some((c) => c.column === "blocked")) return "blocked";
  if (cards.some((c) => c.dispatchedAt || c.queued)) return "running";
  return "planning";
}
// Read projection for the rail: derived status + accumulated release manifest (§6.1).
// The stored result (frozen at close: acceptance, PR, merge, deploy) rides on top of the live
// manifest — before closing there is no stored half, so this is the S4 projection unchanged.
const planView = (board, plan) => ({ ...plan, status: planStatus(board, plan),
  result: { releaseManifest: planReleaseManifest(board, plan.id), ...(plan.result || {}) } });

// S5 · SUMMARY GATE preflight (roadmap §2 Фаза 1). Surfaces PLAN-LEVEL items the human
// resolves ONCE before launch — deduped across stages — so individual stages don't re-ask:
//   • blockers: objectively detectable pre-run gaps (today: the project's design source, §3.1);
//   • floor: the mechanical hard-floor over any manifests already present (§5.3);
//   • forks: plan-level architecture forks are surfaced by the stages' arch runs at runtime
//     (LLM), not fabricated here — pre-run this is []. The human's answers ride each stage seed.
function preflightPlan(board, project, cardIds) {
  const blockers = [];
  // §3.1 — the project must declare its design source; if CLAUDE.md doesn't, block once.
  let hasDesign = false;
  try { hasDesign = /(^|\n)\s*##\s+(Дизайн|Design)/i.test(fs.readFileSync(path.join(resolveProjectDir(project), "CLAUDE.md"), "utf8")); } catch {}
  if (!hasDesign) blockers.push({
    id: "design-source", type: "blocker",
    q: "Источник дизайна проекта не задан (§3.1). Как объявить?",
    options: [
      { id: "html", title: "html · public/ (self-heal)", recommended: true },
      { id: "figma", title: "figma · указать ссылку" },
      { id: "none", title: "none · дизайн не нужен" },
    ],
  });
  const cards = (cardIds || []).map((id) => board.cards.find((c) => c.id === id)).filter(Boolean);
  const floor = cards.flatMap((c) => mechanicalFloor(c.deploy).map((f) => ({ ...f, stage: c.id })));
  return { blockers, floor, forks: [] };
}
// endregion FUNC_plans

// region FUNC_planClose — closing a run: manifest → acceptance → PR → policy (design §5)
// ## @purpose 6 plans out of 6 ended with `status: "running"`, `result: null`, four archived by
// ##   hand — the result of a run simply evaporated. Closing is now an AUTOMATIC phase that
// ##   starts itself when every stage reaches `ready`, and it ends with the one artefact a human
// ##   can actually read: a PR carrying the release manifest, the acceptance evidence, the auto
// ##   decisions and the list of tails. This CHANGES roadmap §4 («мерж делает человек»): the PR
// ##   is always opened, the merge follows the policy, the deploy stays behind a floor.
// ## @io (board) -> plan.closeStatus/closeStep transitions + up to one spawned child per tick
// ## @invariants
// ## - A single card (planId:null) never enters here. Closing is a PLAN-level phase.
// ## - RED ACCEPTANCE → NO DEPLOY, under any policy, ever. The PR goes to draft, plan → failed.
// ## - stand.is_production:true → the deploy needs a human REGARDLESS of autonomy (§5.1, the
// ##   mechanical floor): policy `after-merge` is demoted to `ask`, never executed silently.
// ## - Every external step (gh, deploy) is a PLAIN child process, not a model call: deterministic,
// ##   free, and its stdout is the evidence. Only the acceptance itself needs judgement.
// ## - Each step writes ONE file and the next tick reads it — the tick never blocks on a child.
// ## - No `gh`/no remote is NOT a silent failure: the composed PR body stays on disk and its path
// ##   is reported in plan.result.pr.error, so a human can open the PR by hand.
// ## @modulemap
// ## FUNC 3[calc]    => policyFor            — plan.policy → .grace/project.md → always/manual/off
// ## FUNC 4[calc]    => acceptanceScenarios  — every stage's acceptance[] + manifest manualChecks
// ## FUNC 5[io]      => launchPlanAcceptance — the ONE model run of the closing phase (§5.3)
// ## FUNC 6[calc]    => prBody               — the 7-section PR body (§5.4)
// ## FUNC 8[persist] => planCloseTick        — the state machine + the §5.5 branching table
// GREP_SUMMARY: plan close, acceptance, release manifest, PR, merge, deploy policy, §5, gh
// STRUCTURE: ▶ all stages ready → ⊕ acceptance run → ⚡ PR (draft if red) → ⎋ merge/deploy by policy

const DEPLOY_POLICY_DEFAULT = { pr: "always", merge: "manual", deploy: "off" };
const PR_MODES = ["always", "never"], MERGE_MODES = ["manual", "auto"], DEPLOY_MODES = ["off", "after-merge", "ask"];
const GH_BIN = process.env.GRACE_GH_BIN || "gh";
const ACCEPT_GRACE_MS = 60 * 1000;   // don't judge the acceptance run dead in its first minute
// v4 Ш1: closing steps that must NOT be collapsed into "closed". Two of them say what is still
// owed by the human (`awaiting-*`), two say HOW the run ended (`pr-ready` = closed, the merge is
// yours by policy · `merge-failed` = the board promised to merge and could not). Collapsing any
// of them loses the only difference the human acts on.
const CLOSE_KEEP_STEPS = new Set(["awaiting-merge", "awaiting-deploy", "pr-ready", "merge-failed"]);

// Release policy of a run: what was passed at assembly wins, then the project's
// `deploy_policy`, then the built-in default (§5.1).
function policyFor(board, plan) {
  const cfg = readProjectConfig(resolveProjectDir(plan.project));
  const fromCfg = (cfg && cfg.cfg && cfg.cfg.deploy_policy) || {};
  const p = plan.policy || {};
  const pick = (k, allowed) => [p[k], fromCfg[k], DEPLOY_POLICY_DEFAULT[k]].find((v) => allowed.includes(v));
  return { pr: pick("pr", PR_MODES), merge: pick("merge", MERGE_MODES), deploy: pick("deploy", DEPLOY_MODES) };
}
const planDir = (plan) => path.join(resolveProjectDir(plan.project), ".grace-feature-dev", "plan-" + plan.id);
const planCards = (board, plan) => (plan.cardIds || []).map((id) => board.cards.find((c) => c.id === id)).filter(Boolean);
// Tails a run left behind (§5.4): deferred cards spawned by its stages. Presented as a package,
// which is the point — 30 tails discovered one by one is what made a run look endless.
const planTails = (board, plan) => {
  const ids = new Set(plan.cardIds || []);
  return board.cards.filter((c) => ids.has(c.spawnedFrom)).map((c) => ({ id: c.id, theme: c.theme, draft: !!c.draft, from: c.spawnedFrom }));
};
// What the acceptance actually checks: every stage's acceptance[] + the manifest's manualChecks.
// This is why acceptance is mandatory for an agent-authored card (§4.1) — without it there is
// nothing to verify and the run would close «на слово».
function acceptanceScenarios(board, plan) {
  const out = [];
  for (const c of planCards(board, plan))
    for (const a of (c.acceptance || [])) out.push({ from: c.theme || c.id, kind: "функционал", text: a });
  const man = planReleaseManifest(board, plan.id).releaseManifest || {};
  for (const m of (man.manualChecks || [])) out.push({ from: "манифест релиза", kind: "ручная проверка", text: itemStr(m) });
  return out;
}
// The one model run of the closing phase (§5.3): a CLEAN checkout, the deterministic commands
// from the project config, then the functional scenarios. Not a code review — «работает ли оно».
function launchPlanAcceptance(board, plan) {
  const projectDir = resolveProjectDir(plan.project);
  const runDir = planDir(plan);
  try { fs.mkdirSync(runDir, { recursive: true }); } catch {}
  const cfg = readProjectConfig(projectDir);
  const cmds = (cfg && cfg.cfg && cfg.cfg.commands) || {};
  const scen = acceptanceScenarios(board, plan);
  const cmdLine = (k, label) => cmds[k] ? `• ${label}: ${cmds[k]}` : `• ${label}: не задана в .grace/project.md → пропусти, отметь check со status:"skip"`;
  const prompt = [
    `ПРИЁМКА ПРОГОНА «${plan.goal || plan.id}» — проверь, что оно РАБОТАЕТ. Это НЕ код-ревью: код уже прошёл`,
    `verify и review на каждом этапе. Твоя задача — предъявить работающий результат целиком.`, ``,
    `1) ЧИСТЫЙ ЧЕКАУТ. Не трогай рабочий каталог проекта (в нём могут идти другие карточки):`,
    `   git worktree add "${path.join(runDir, "wt")}" "${plan.integrationBranch}"`,
    `   Дальше работай ТОЛЬКО в этом каталоге. В конце убери за собой: git worktree remove --force.`, ``,
    `2) ДЕТЕРМИНИРОВАННАЯ ЧАСТЬ (без интерпретаций — только код возврата):`,
    cmdLine("typecheck", "typecheck"), cmdLine("test", "test"), cmdLine("build", "build"), ``,
    `3) ФУНКЦИОНАЛЬНАЯ ЧАСТЬ. Подними приложение${cmds.dev ? ` командой: ${cmds.dev}` : " (команда dev не задана — подними как принято в проекте)"}`,
    `   и пройди сценарии ниже браузером/curl. Для КАЖДОГО собери доказательство: код ответа, кусок вывода,`,
    `   путь к скриншоту. «Похоже, работает» без доказательства = status:"fail".`,
    scen.length ? scen.map((s, i) => `   ${i + 1}) [${s.kind}] ${s.text}   ← из «${s.from}»`).join("\n")
      : `   (сценариев нет — ни у одного этапа не заполнено acceptance. Отметь это отдельным check со status:"fail":`
        + `\n    прогон нельзя принять «на слово».)`, ``,
    `4) РЕЗУЛЬТАТ — строго в ${path.join(runDir, "acceptance.json")}, СТРОГО в этом формате:`,
    `   {"checks":[{"id":"c1","title":"…","kind":"deterministic|functional","status":"pass|fail|skip",`,
    `   "output":"хвост вывода/код ответа","evidence":"путь к скриншоту или пусто"}],`,
    `   "passed":true|false,"failed":["id",…],"notes":"кратко о рисках"}`,
    `   passed:true ТОЛЬКО если ни одного "fail". Пиши файл ДАЖЕ если всё упало — молчание = провал приёмки.`, ``,
    `ЗАПРЕТЫ: не мержь, не деплой, не правь код и не коммить в интеграционную ветку. Приёмка только читает.`,
  ].join("\n");
  return spawnRun(projectDir, runDir, prompt, "plan-acceptance.log", { model: modelFor(plan) });
}
// A plain child process for the deterministic steps (gh / deploy): stdout+stderr into one file the
// next tick reads. No model, no tokens, and the output IS the evidence.
function spawnStep(cwd, cmd, outFile) {
  try {
    const out = fs.openSync(outFile, "w");
    const env = { ...process.env, PATH: `${BIN_PATH_HINT}:${process.env.PATH || ""}` };
    const child = spawn("/bin/sh", ["-lc", `${cmd}; echo "__EXIT__:$?"`], { cwd, env, detached: true, stdio: ["ignore", out, out] });
    child.unref();
    return { started: true, pid: child.pid };
  } catch (e) { return { started: false, error: String(e.message || e) }; }
}
// Read a step's output file once the child has written its exit marker.
function readStep(outFile) {
  let text = "";
  try { text = fs.readFileSync(outFile, "utf8"); } catch { return null; }
  const m = text.match(/__EXIT__:(\d+)\s*$/);
  if (!m) return null;                       // still running
  return { code: Number(m[1]), text: text.replace(/__EXIT__:\d+\s*$/, "").trim() };
}

// v4 Ш1.1: «лимит — это часы, а не поломка» — распространено с карточек на фазу закрытия.
// Наблюдено вживую: прогон довёл семь этапов до ready и получил closeStatus:"failed" с одной
// проверкой «Ран приёмки не отчитался: You've hit your limit» — то есть был помечен проваленным
// из-за подписки, а не из-за кода, причём терминально. Здесь окно лимита пишется в тот же
// board.quota, что и для карточек: planCloseTick уже стоит под `quotaOpen`, поэтому фаза просто
// ждёт и переигрывает шаг после сброса. `retryStep` — то, что надо занулить, чтобы шаг собрался
// заново, а не был перечитан из старого вывода.
function planQuotaHold(board, plan, stop, where, retryStep) {
  const ts = new Date().toISOString();
  if (!board.quota || Date.parse(board.quota.until || 0) < Date.parse(stop.until))
    board.quota = { since: (board.quota && quotaOpen(board)) ? board.quota.since : ts, until: stop.until,
      exact: stop.exact, raw: stop.raw, planId: plan.id };
  if (retryStep) plan[retryStep] = null;   // вызывающий уже вернул closeStep на шаг, который переиграется
  planNotice(plan, `Лимит подписки Claude на шаге «${where}» — это не провал прогона. Сделанное сохранено, `
    + `шаг переиграется сам после сброса в ${hhmm(stop.until)}. Из лога: ${stop.raw}`, "warn");
  logPlan(plan, "plan-quota-hold", { step: where, until: stop.until, exact: stop.exact });
  try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts, event: "plan-quota-hold", planId: plan.id, step: where, until: stop.until }) + "\n"); } catch {}
}

// The PR body (§5.4). Assembled from what the board already knows — this is the single
// human-readable trace of a run, and it is written whether the merge is manual or auto.
function prBody(board, plan, pol) {
  const cards = planCards(board, plan);
  const rm = planReleaseManifest(board, plan.id);
  const acc = (plan.result && plan.result.acceptance) || null;
  const tails = planTails(board, plan);
  const L = [];
  L.push(`## Цель прогона`, plan.goal || `Прогон ${plan.id}`, ``);
  L.push(`Ветка: \`${plan.integrationBranch}\` · режим: ${plan.mode} · политика: pr=${pol.pr} merge=${pol.merge} deploy=${pol.deploy}`, ``);
  L.push(`## Этапы (${cards.length})`);
  for (const c of cards) L.push(`- **${c.theme || c.id}** — ${c.column}${c.branchLink ? ` · [ветка](${c.branchLink})` : ""}${c.finishNote ? `\n  ${String(c.finishNote).split("\n")[0]}` : ""}`);
  L.push(``, `## Манифест релиза`);
  for (const s of MANIFEST_SECTIONS) {
    const items = (rm.releaseManifest && rm.releaseManifest[s]) || [];
    L.push(`**${s}** — ${items.length ? "" : "_проверял, пусто_"}`);
    for (const it of items) L.push(`- ${itemStr(it)}`);
  }
  const miss = rm.stages.filter((s) => (s.manifestMissing || []).length);
  if (miss.length) L.push(``, `> ⚠ этапы с ПРОПУЩЕННЫМИ ключами манифеста (не «пусто», а «забыл»): ` + miss.map((s) => `${s.theme || s.id}: ${s.manifestMissing.join(", ")}`).join(" · "));
  if ((rm.warnings || []).length) L.push(``, `> ⚠ конфликты слияния манифеста: ` + rm.warnings.join(" · "));
  L.push(``, `## Приёмка`);
  if (!acc) L.push(`_не проводилась_`);
  else {
    L.push(acc.passed ? `✅ **зелёная** — все проверки прошли` : `❌ **красная** — провалено: ${(acc.failed || []).join(", ") || "см. ниже"}`);
    for (const c of (acc.checks || [])) L.push(`- ${c.status === "pass" ? "✅" : c.status === "skip" ? "⏭" : "❌"} [${c.kind || "?"}] ${c.title || c.id}${c.output ? ` — \`${String(c.output).slice(0, 200).replace(/\n/g, " ")}\`` : ""}${c.evidence ? ` · доказательство: ${c.evidence}` : ""}`);
    if (acc.notes) L.push(``, `Риски по итогам приёмки: ${acc.notes}`);
  }
  const auto = cards.flatMap((c) => ((c.result && c.result.autoDecisions) || []).map((d) => ({ c, d })));
  L.push(``, `## Решения, принятые без человека (AUTO)`);
  if (!auto.length) L.push(`_нет — все развилки прошли через человека_`);
  for (const { c, d } of auto) L.push(`- **${d.chosenTitle || d.choice}** — ${d.q}${d.ownText ? ` · _${d.ownText}_` : ""} (этап «${c.theme || c.id}»)`);
  L.push(``, `## Хвосты (${tails.length})`);
  if (!tails.length) L.push(`_нет_`);
  for (const t of tails) L.push(`- ${t.theme}${t.draft ? " _(черновик — ждёт проверки человеком)_" : ""}`);
  const floor = rm.floor || [];
  L.push(``, `## Открытые риски`);
  if (floor.length) for (const f of floor) L.push(`- ⚠ жёсткий пол: **${f.class}** — ${f.detail} (этап ${f.stage})`);
  const blocked = cards.filter((c) => c.column === "blocked");
  for (const c of blocked) L.push(`- ⚠ этап «${c.theme}» остался заблокированным: ${c.blockReason || ""}`);
  if (!floor.length && !blocked.length) L.push(`_не обнаружены_`);
  L.push(``, `---`, `_собрано доской автоматически при закрытии прогона \`${plan.id}\`_`);
  return L.join("\n");
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
function planNotice(plan, text, level) {
  plan.result = plan.result || {};
  plan.result.notice = { ts: new Date().toISOString(), level: level || "info", text };
  try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: plan.result.notice.ts, event: "plan-notice", planId: plan.id, level: plan.result.notice.level, text }) + "\n"); } catch {}
}
function logPlan(plan, event, extra) {
  try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: new Date().toISOString(), event, planId: plan.id, ...extra }) + "\n"); } catch {}
}
// Coerce whatever the acceptance run wrote into the §5.3 shape. A malformed file is a FAILED
// acceptance, never an assumed-green one — «passed» must be earned, not defaulted.
function normalizeAcceptance(raw) {
  const checks = Array.isArray(raw && raw.checks) ? raw.checks.map((c, i) => ({
    id: String((c && c.id) || "c" + (i + 1)), title: String((c && c.title) || "проверка"),
    kind: (c && c.kind) === "deterministic" ? "deterministic" : (c && c.kind) === "functional" ? "functional" : "functional",
    status: ["pass", "fail", "skip"].includes(c && c.status) ? c.status : "fail",
    output: c && c.output ? String(c.output).slice(0, 4000) : null,
    evidence: c && c.evidence ? String(c.evidence).slice(0, 500) : null,
  })) : [];
  const failed = checks.filter((c) => c.status === "fail").map((c) => c.id);
  return { ranAt: new Date().toISOString(), checks, failed,
    passed: checks.length > 0 && failed.length === 0 && raw.passed !== false,
    notes: raw && raw.notes ? String(raw.notes).slice(0, 2000) : null,
    evidence: checks.filter((c) => c.evidence).map((c) => c.evidence) };
}

// region FUNC_ciGate — `merge=auto` means «смержить, КОГДА CI зелёный», not «смержить» (A1)
// ## @purpose 08.08 at 05:05 the CI of PR #17 was red; at 05:14 the board merged it — because the
// ##   closing phase ran `gh pr merge` the moment the acceptance turned green and never looked at
// ##   a single check. Red `main` then lived unnoticed until the morning. The gate makes the CI
// ##   status a PRECONDITION of the merge and a FIELD of plan.result, so the board can say why it
// ##   did not merge instead of merging blind.
// ## @io (text of `gh pr view --json …`) -> {status, checks[], failed[], mergeStateStatus}
// ## @invariants
// ## - The board merges ONLY on `green` or `none` (a repo with no checks at all — nothing to
// ##   gate on). EVERY other outcome, including an unreadable answer from `gh`, does NOT merge.
// ## - `pending` is a CLOCK, not a failure — the same shape as the quota hold: re-poll every
// ##   CI_POLL_MS until CI_BUDGET_MS runs out, then stop with `ci-timeout` and hand the merge over.
// ## - `--json` is used instead of `gh pr checks --watch`: gh 2.45 on the box has no `--json` for
// ##   `pr checks`, exit codes there are ambiguous (8 = pending, 1 = failed AND 1 = no checks),
// ##   and a `--watch` child would hold the step open for the whole CI run with no visible state.
// ## - `mergeStateStatus: DIRTY` (a conflict) is reported as such — that is exactly what the
// ##   silent «мерж не прошёл (код 1)» of PR #21 was, and a conflict is not a red CI.
// ## @rationale Q: why not `gh pr merge --auto`? A: it needs branch protection (unavailable on
// ##   Free+private here) and would leave the board with no status of its own to report.
// GREP_SUMMARY: CI gate, merge auto, statusCheckRollup, ci-red, ci-timeout, conflict, A1
const CI_POLL_MS = Number(process.env.GRACE_CI_POLL_SEC || 60) * 1000;
const CI_BUDGET_MS = Number(process.env.GRACE_CI_WAIT_MIN || 90) * 60 * 1000;
const CI_FAIL = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
function ciClassify(text) {
  let j = null;
  try { j = JSON.parse((String(text).match(/\{[\s\S]*\}/) || [""])[0]); } catch {}
  if (!j || typeof j !== "object") return { status: "unreadable", checks: [], failed: [], pending: [], raw: String(text).slice(-400) };
  const rollup = Array.isArray(j.statusCheckRollup) ? j.statusCheckRollup : [];
  const checks = rollup.map((c) => {
    const done = c.status ? String(c.status).toUpperCase() === "COMPLETED"
      : !["PENDING", "EXPECTED"].includes(String(c.state || "").toUpperCase());
    return { name: c.name || c.context || "проверка", done,
      verdict: String(c.conclusion || c.state || "").toUpperCase(), url: c.detailsUrl || c.targetUrl || null };
  });
  const failed = checks.filter((c) => c.done && CI_FAIL.has(c.verdict));
  const pending = checks.filter((c) => !c.done);
  const mergeState = String(j.mergeStateStatus || "").toUpperCase() || null;
  const status = failed.length ? "red"
    : mergeState === "DIRTY" ? "conflict"
    : (pending.length || mergeState === "UNKNOWN") ? "pending"
    : checks.length ? "green" : "none";
  return { status, checks, mergeStateStatus: mergeState,
    failed: failed.map((f) => f.name), pending: pending.map((p) => p.name),
    failedUrls: failed.map((f) => f.url).filter(Boolean) };
}
// The workflow run behind a failed check — the only thing that makes `ci-red` actionable is the
// tail of THAT job's log, and it is one `gh run view` away.
const ciRunIdOf = (urls) => {
  for (const u of urls || []) { const m = String(u).match(/\/actions\/runs\/(\d+)/); if (m) return m[1]; }
  return null;
};
// endregion FUNC_ciGate

// region FUNC_planMetrics — во что обошёлся прогон, машинно и без ручного разбора (A5)
// ## @purpose Стоимость и время прогона восстанавливались только ручным разбором 77 МБ
// ##   транскриптов. Метрика, которую снимают руками, снимается один раз и больше никогда —
// ##   а без неё нечем измерить эффект B3′/B7/B2. Поэтому по закрытии прогона доска сама
// ##   считает токены/деньги/время и кладёт их в plan.result.metrics.
// ## @io (board) -> spawns ≤1 child per tick · reads its metrics.json on a later tick
// ## @invariants
// ## - Считает ОТДЕЛЬНЫЙ процесс (lib/plan-metrics.js): разбор транскриптов — это десятки
// ##   мегабайт JSON.parse, в 2-секундном тике он заморозил бы очередь и UI.
// ## - Запускается для ЛЮБОГО прогона с терминальным закрытием, включая `merge-failed` и
// ##   `awaiting-*`: прогон, который не смержился, стоил денег ровно так же.
// ## - Две попытки, потом честная запись об ошибке — молчание хуже пустых метрик.
// ## - Прайс лежит в config/model-prices.json, не в коде (GRACE_PRICES переопределяет).
// GREP_SUMMARY: A5, метрики прогона, plan.result.metrics, стоимость, токены, транскрипты
const METRICS_STEPS = new Set(["closed", "pr-ready", "merge-failed", "awaiting-merge", "awaiting-deploy"]);
const METRICS_SCRIPT = path.join(__dirname, "lib", "plan-metrics.js");
const NODE_BIN = process.execPath;
function planMetricsTick(board) {
  let changed = false;
  let spawned = 0;                 // ≤1 разбор транскриптов за тик: 13 закрытых прогонов разом
  for (const plan of (board.plans || [])) {   // подняли бы 13 процессов по сотне мегабайт каждый
    if (!METRICS_STEPS.has(plan.closeStep || "")) continue;
    if (plan.result && plan.result.metrics) continue;
    if (!(plan.cardIds || []).length) continue;
    const dir = planDir(plan), outFile = path.join(dir, "metrics.json");
    const run = plan.metricsRun || null;
    if (!run) {
      if (!fs.existsSync(METRICS_SCRIPT) || spawned) continue;
      spawned++;
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      const cmd = `${shq(NODE_BIN)} ${shq(METRICS_SCRIPT)} --plan ${shq(plan.id)} --board ${shq(BOARD_FILE)} `
        + `--dispatch ${shq(DISPATCH_LOG)} --projects-root ${shq(PROJECTS_ROOT_ABS)} --out ${shq(outFile)}`;
      const st = spawnStep(__dirname, cmd, path.join(dir, "metrics.out"));
      plan.metricsRun = { ...st, startedAt: new Date().toISOString(), attempts: 1 };
      changed = true;
      continue;
    }
    const r = readStep(path.join(dir, "metrics.out"));
    const started = Date.parse(run.startedAt || "") || 0;
    if (!r && Date.now() - started < 10 * 60 * 1000 && run.started) continue;
    let m = null;
    try { m = JSON.parse(fs.readFileSync(outFile, "utf8")); } catch {}
    if (m && typeof m === "object") {
      plan.result = plan.result || {};
      plan.result.metrics = m;
      logPlan(plan, "plan-metrics", { costUsd: m.costUsd, sessions: m.sessions, wallSeconds: m.wallSeconds, loops: m.loops });
      changed = true;
      continue;
    }
    if ((run.attempts || 1) < 2) {
      plan.metricsRun = { ...run, attempts: (run.attempts || 1) + 1, startedAt: null, started: false };
      // следующая итерация сочтёт `!run.started` истёкшей и пересоберёт шаг
      plan.metricsRun.startedAt = new Date(0).toISOString();
      changed = true;
      continue;
    }
    plan.result = plan.result || {};
    plan.result.metrics = { error: "не удалось посчитать метрики прогона",
      output: r ? String(r.text).slice(-400) : "процесс метрик не отчитался", computedAt: new Date().toISOString() };
    logPlan(plan, "plan-metrics-failed", {});
    changed = true;
  }
  return changed;
}
// endregion FUNC_planMetrics

// The closing state machine. ONE step per plan per tick: every step either spawns a child and
// parks, or reads that child's output file. The tick itself never waits on anything.
function planCloseTick(board) {
  let changed = false;
  // S6: acceptance spawns a model run like any other — under an open quota window it would die
  // on spawn and paint the run red for a reason that has nothing to do with the code. Hold.
  if (quotaOpen(board)) return false;
  for (const plan of (board.plans || [])) {
    if (plan.closeStep === "closed") continue;
    const cards = planCards(board, plan);
    if (!cards.length) continue;
    const pol = policyFor(board, plan);
    const dir = planDir(plan), projectDir = resolveProjectDir(plan.project);
    const acc = () => (plan.result && plan.result.acceptance) || null;

    // ── start: every stage reached `ready` → the closing phase begins by itself (§5.2) ──
    if (!plan.closeStatus) {
      if (plan.archived) continue;                       // a run dismissed by hand is not closed
      // A run assembled BEFORE this feature existed carries no `policy` — and its stages have
      // long been `ready`. Closing it now would spawn an acceptance run over finished work in a
      // live project (it did, on two runs, during this very step). The closing phase applies to
      // runs launched with a policy, i.e. from this version on; older runs stay as they are.
      if (!plan.policy) continue;
      if (!cards.every((c) => c.column === TERMINAL)) continue;
      plan.closeStatus = "verifying";
      plan.closeStep = "acceptance";
      plan.policy = pol;
      plan.result = { ...(plan.result || {}), releaseManifest: planReleaseManifest(board, plan.id),
        tails: planTails(board, plan), closingStartedAt: new Date().toISOString() };
      const launch = launchPlanAcceptance(board, plan);
      plan.acceptanceRun = { pid: launch.pid || null, log: launch.log || null, launched: !!launch.launched,
        error: launch.error || null, startedAt: new Date().toISOString() };
      logPlan(plan, "plan-closing", { stages: cards.length, policy: pol, launched: !!launch.launched });
      changed = true;
      continue;
    }
    // Terminal statuses stop the machine — but the steps in CLOSE_KEEP_STEPS carry the one thing
    // the human acts on (what is still owed, or how the run actually ended), so they survive.
    if (plan.closeStatus === "done" || plan.closeStatus === "failed") {
      if (plan.closeStep !== "closed" && !CLOSE_KEEP_STEPS.has(plan.closeStep)) { plan.closeStep = "closed"; changed = true; }
      continue;
    }

    // ── acceptance (§5.3): wait for acceptance.json; a silent/dead run is a RED acceptance ──
    if (plan.closeStep === "acceptance") {
      // v4 Ш1.1: приёмка без рана — это приёмка, которую сняли лимитом (или ручкой /reopen).
      // Запускаем заново; окно лимита уже закрылось, иначе тик сюда не дошёл бы.
      if (!plan.acceptanceRun) {
        try { fs.unlinkSync(path.join(dir, "acceptance.json")); } catch {}
        const relaunch = launchPlanAcceptance(board, plan);
        plan.acceptanceRun = { pid: relaunch.pid || null, log: relaunch.log || null, launched: !!relaunch.launched,
          error: relaunch.error || null, startedAt: new Date().toISOString() };
        logPlan(plan, "plan-acceptance-relaunch", { launched: !!relaunch.launched });
        changed = true; continue;
      }
      let raw = null;
      try { raw = JSON.parse(fs.readFileSync(path.join(dir, "acceptance.json"), "utf8")); } catch {}
      if (raw && typeof raw === "object") {
        plan.result.acceptance = normalizeAcceptance(raw);
        plan.closeStep = "pr";
        logPlan(plan, "plan-acceptance", { passed: plan.result.acceptance.passed, failed: plan.result.acceptance.failed.length });
        changed = true;
      } else {
        const started = Date.parse((plan.acceptanceRun || {}).startedAt || "") || 0;
        const dead = !plan.acceptanceRun || !plan.acceptanceRun.launched
          || (!isAlive(plan.acceptanceRun.pid) && Date.now() - started > ACCEPT_GRACE_MS);
        const tooLong = Date.now() - started > STALL_MS;
        // Прежде чем назвать молчание провалом — прочитать, ПОЧЕМУ ран замолчал. Лимит подписки
        // выглядит точно так же, как сдохший ран, и красит прогон красным ни за что.
        if (dead || tooLong) {
          const stop = detectQuotaStop((plan.acceptanceRun || {}).log, Date.now(), 0);
          if (stop) { planQuotaHold(board, plan, stop, "приёмка", "acceptanceRun"); changed = true; continue; }
        }
        if (dead || tooLong) {
          plan.result.acceptance = normalizeAcceptance({ passed: false, checks: [{ id: "run", title: "Ран приёмки не отчитался", kind: "deterministic", status: "fail",
            output: tailLog((plan.acceptanceRun || {}).log || "", 40) || ((plan.acceptanceRun || {}).error || "") }],
            notes: dead ? "процесс приёмки умер, не записав acceptance.json" : "приёмка превысила бюджет времени" });
          plan.closeStep = "pr";
          logPlan(plan, "plan-acceptance", { passed: false, reason: dead ? "dead" : "timeout" });
          changed = true;
        }
      }
      continue;
    }

    // ── PR — ВСЕГДА (§5.4). Red acceptance opens it as a draft: a run that did not pass must
    //    still leave its trace, just not look mergeable.
    if (plan.closeStep === "pr") {
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      const bodyFile = path.join(dir, "pr-body.md");
      try { fs.writeFileSync(bodyFile, prBody(board, plan, pol)); } catch {}
      plan.result.prBodyFile = bodyFile;
      if (pol.pr === "never") {
        plan.result.pr = { url: null, draft: false, ok: false, skipped: true, error: `pr=never — PR не создавался; тело собрано в ${bodyFile}` };
        plan.closeStep = "post-pr"; changed = true; continue;
      }
      const draft = !(acc() && acc().passed);
      const title = (plan.goal || `Прогон ${plan.id}`).slice(0, 160);
      const cmd = `${GH_BIN} pr create --base main --head ${shq(plan.integrationBranch)} --title ${shq(title)} --body-file ${shq(bodyFile)}${draft ? " --draft" : ""}`;
      const st = spawnStep(projectDir, cmd, path.join(dir, "pr.out"));
      plan.prRun = { ...st, draft, startedAt: new Date().toISOString() };
      plan.closeStep = "pr-wait"; changed = true;
      logPlan(plan, "plan-pr", { draft, started: st.started });
      continue;
    }
    if (plan.closeStep === "pr-wait") {
      const r = readStep(path.join(dir, "pr.out"));
      const started = Date.parse((plan.prRun || {}).startedAt || "") || 0;
      if (!r && Date.now() - started < 3 * 60 * 1000 && (plan.prRun || {}).started) continue;
      // v4 Ш1.1: шаг детерминированный (`gh`), но команду задаёт проект — если внутри окажется
      // модельный вызов, его отказ по лимиту не должен читаться как «PR не создан».
      if (r) { const stop = parseQuotaStop(r.text, Date.now());
        if (stop) { plan.closeStep = "pr"; planQuotaHold(board, plan, stop, "создание PR", "prRun"); changed = true; continue; } }
      const draft = !!(plan.prRun || {}).draft;
      const url = r ? (r.text.match(/https?:\/\/\S+/) || [])[0] || null : null;
      plan.result.pr = { url, draft, ok: !!(r && r.code === 0),
        error: r && r.code === 0 ? null : `PR не создан (${r ? "gh код " + r.code : "gh не ответил"}): ${r ? r.text.slice(-400) : (plan.prRun || {}).error || ""} · тело PR лежит в ${plan.result.prBodyFile}` };
      plan.closeStep = "post-pr"; changed = true;
      logPlan(plan, "plan-pr-done", { ok: plan.result.pr.ok, draft, url });
      continue;
    }

    // ── §5.5 branching table ────────────────────────────────────────────────────────────
    if (plan.closeStep === "post-pr") {
      const a = acc();
      if (!a || !a.passed) {                       // красная приёмка · любой merge · любой deploy
        plan.closeStatus = "failed"; plan.closeStep = "closed";
        planNotice(plan, `Приёмка красная — PR оставлен черновиком, деплоя не было. Провалено: ${(a && a.failed || []).join(", ") || "см. PR"}`, "error");
        logPlan(plan, "plan-failed", { failed: (a && a.failed) || [] });
        changed = true; continue;
      }
      // v4 Ш1 · зелёная · manual → ФИНАЛ, а не ожидание. Доска сделала всё, что обещала: собрала
      // PR. Мерж — политика прогона, а не задолженность доски, поэтому она не ждёт, не опрашивает
      // GitHub и не показывает гейт. Ждать имеет смысл только там, где доска обещала сама и не смогла.
      if (pol.merge === "manual") {
        plan.closeStatus = "done"; plan.closeStep = "pr-ready";
        planNotice(plan, `Прогон закрыт: PR собран, мерж за тобой (политика прогона).${plan.result.pr && plan.result.pr.url ? " PR: " + plan.result.pr.url : ""}`, "ok");
        logPlan(plan, "plan-pr-ready", {});
        changed = true; continue;
      }
      if (!(plan.result.pr && plan.result.pr.ok && plan.result.pr.url)) {
        // merge:auto без PR мержить нечем — и мержить в обход PR нельзя: PR это единственный след.
        // Это уже задолженность доски: обещала смержить сама и не может.
        plan.closeStatus = "done"; plan.closeStep = "merge-failed";
        planNotice(plan, `Автомерж не прошёл: PR не создан, мержить нечего. ${plan.result.pr ? plan.result.pr.error : ""}`, "warn");
        logPlan(plan, "plan-merge-failed", { reason: "no-pr" });
        changed = true; continue;
      }
      // A1: merge=auto is a promise to merge WHEN CI IS GREEN. The gate runs first and owns
      // the branch to `merge`; nothing else in this machine calls `gh pr merge`.
      plan.closeStep = "ci";
      plan.ciSince = new Date().toISOString();
      plan.ciNextAt = null; plan.ciRun = null;
      changed = true;
      continue;
    }

    // ── A1 · the CI gate: poll → classify → merge only on green ───────────────────────
    if (plan.closeStep === "ci") {
      if (plan.ciNextAt && Date.parse(plan.ciNextAt) > Date.now()) continue;   // waiting out the poll interval
      const cmd = `${GH_BIN} pr view ${shq(plan.result.pr.url)} --json state,mergeStateStatus,statusCheckRollup`;
      const st = spawnStep(projectDir, cmd, path.join(dir, "ci.out"));
      plan.ciRun = { ...st, startedAt: new Date().toISOString() };
      plan.closeStep = "ci-wait"; changed = true;
      continue;
    }
    if (plan.closeStep === "ci-wait") {
      const r = readStep(path.join(dir, "ci.out"));
      const started = Date.parse((plan.ciRun || {}).startedAt || "") || 0;
      if (!r && Date.now() - started < 3 * 60 * 1000 && (plan.ciRun || {}).started) continue;
      const ci = r ? ciClassify(r.text) : { status: "unreadable", checks: [], failed: [], pending: [], raw: "gh не ответил" };
      const sinceMs = Date.now() - (Date.parse(plan.ciSince || "") || Date.now());
      plan.result.ci = { ...ci, checkedAt: new Date().toISOString(), waitedSec: Math.round(sinceMs / 1000) };
      const stopMerge = (reason, text) => {
        plan.closeStatus = "done"; plan.closeStep = "merge-failed";
        plan.result.merge = { ok: false, error: reason, ci: plan.result.ci };
        planNotice(plan, text, "error");
        logPlan(plan, "plan-merge-failed", { reason, ci: ci.status, failed: ci.failed });
      };
      if (ci.status === "green" || ci.status === "none") {
        logPlan(plan, "plan-ci-green", { checks: ci.checks.length, waitedSec: plan.result.ci.waitedSec });
        plan.closeStep = "merge"; changed = true; continue;
      }
      if (ci.status === "red") {
        const runId = ciRunIdOf(ci.failedUrls);
        if (runId) {   // fetch the tail of the failing job — a bare «CI красный» is not actionable
          const st = spawnStep(projectDir, `${GH_BIN} run view ${runId} --log-failed 2>&1 | tail -n 40`, path.join(dir, "ci-log.out"));
          plan.ciLogRun = { ...st, runId, startedAt: new Date().toISOString() };
          plan.closeStep = "ci-log"; changed = true; continue;
        }
        stopMerge("ci-red", `CI красный — доска НЕ мержит. Упало: ${ci.failed.join(", ")}. Мерж за человеком после починки.`);
        changed = true; continue;
      }
      if (ci.status === "conflict") {
        stopMerge("conflict", `Ветка прогона конфликтует с main (mergeStateStatus: DIRTY) — доска не мержит. Нужно свести руками или карточкой-починкой.`);
        changed = true; continue;
      }
      // pending / unreadable → это часы, а не провал: ждём и переспрашиваем, пока есть бюджет
      if (sinceMs > CI_BUDGET_MS) {
        stopMerge("ci-timeout", `CI не завершился за ${Math.round(CI_BUDGET_MS / 60000)} мин (${ci.status === "unreadable" ? "gh отвечал нечитаемо" : "в ожидании: " + ci.pending.join(", ")}) — мерж за человеком.`);
        changed = true; continue;
      }
      plan.ciNextAt = new Date(Date.now() + CI_POLL_MS).toISOString();
      plan.closeStep = "ci"; changed = true;
      logPlan(plan, "plan-ci-hold", { status: ci.status, pending: ci.pending, waitedSec: plan.result.ci.waitedSec });
      continue;
    }
    if (plan.closeStep === "ci-log") {
      const r = readStep(path.join(dir, "ci-log.out"));
      const started = Date.parse((plan.ciLogRun || {}).startedAt || "") || 0;
      if (!r && Date.now() - started < 3 * 60 * 1000 && (plan.ciLogRun || {}).started) continue;
      const tail = r ? r.text.slice(-2000) : "(лог упавшего job получить не удалось)";
      plan.result.ci = { ...(plan.result.ci || {}), logTail: tail, runId: (plan.ciLogRun || {}).runId || null };
      plan.closeStatus = "done"; plan.closeStep = "merge-failed";
      plan.result.merge = { ok: false, error: "ci-red", ci: plan.result.ci };
      planNotice(plan, `CI красный — доска НЕ мержит. Упало: ${(plan.result.ci.failed || []).join(", ")}. Хвост лога job'а — в результате прогона.`, "error");
      logPlan(plan, "plan-merge-failed", { reason: "ci-red", runId: plan.result.ci.runId, failed: plan.result.ci.failed });
      changed = true; continue;
    }
    if (plan.closeStep === "merge") {
      const st = spawnStep(projectDir, `${GH_BIN} pr merge ${shq(plan.result.pr.url)} --merge --delete-branch=false`, path.join(dir, "merge.out"));
      plan.mergeRun = { ...st, startedAt: new Date().toISOString() };
      plan.closeStep = "merge-wait"; changed = true;
      logPlan(plan, "plan-merge", { started: st.started, ci: (plan.result.ci || {}).status || null });
      continue;
    }
    if (plan.closeStep === "merge-wait") {
      const r = readStep(path.join(dir, "merge.out"));
      const started = Date.parse((plan.mergeRun || {}).startedAt || "") || 0;
      if (!r && Date.now() - started < 5 * 60 * 1000 && (plan.mergeRun || {}).started) continue;
      if (r) { const stop = parseQuotaStop(r.text, Date.now());
        if (stop) { plan.closeStep = "post-pr"; planQuotaHold(board, plan, stop, "мерж", "mergeRun"); changed = true; continue; } }
      plan.result.merge = { ok: !!(r && r.code === 0), output: r ? r.text.slice(-600) : null,
        error: r && r.code === 0 ? null : `мерж не прошёл (${r ? "код " + r.code : "gh не ответил"})` };
      if (!plan.result.merge.ok) {
        plan.closeStatus = "done"; plan.closeStep = "merge-failed";
        planNotice(plan, `Автомерж не прошёл: ${plan.result.merge.error}. Мерж за человеком.`, "warn");
        logPlan(plan, "plan-merge-failed", { reason: "gh" });
        changed = true; continue;
      }
      plan.closeStep = "deploy"; changed = true;
      logPlan(plan, "plan-merged", {});
      continue;
    }

    // ── deploy: the mechanical floor sits BEFORE the policy, not after it ──────────────
    if (plan.closeStep === "deploy") {
      const cfg = readProjectConfig(projectDir);
      const stand = (cfg && cfg.cfg && cfg.cfg.stand) || {};
      const isProd = String(stand.is_production) === "true";
      const deployCmd = stand.deploy_cmd || null;    // lives in .grace/local.md (not in git)
      const finish = (text, level) => { plan.closeStatus = "done"; plan.closeStep = "closed"; planNotice(plan, text, level || "ok"); plan.archived = true; changed = true; };
      if (pol.deploy === "off") { finish(`Прогон закрыт: смержено, деплой выключен политикой.`); continue; }
      if (pol.deploy === "ask" || isProd) {
        plan.closeStatus = "done"; plan.closeStep = "awaiting-deploy";
        plan.result.deploy = { status: "awaiting-human", reason: isProd && pol.deploy !== "ask"
          ? "stand.is_production: true — деплой требует человека независимо от autonomy (жёсткий пол §5.1)"
          : "политика deploy=ask" };
        planNotice(plan, `Смержено. Деплой ждёт человека: ${plan.result.deploy.reason}`, "warn");
        logPlan(plan, "plan-deploy-hold", { reason: plan.result.deploy.reason });
        changed = true; continue;
      }
      if (!deployCmd) {
        plan.result.deploy = { status: "no-command", reason: "stand.deploy_cmd не задан в .grace/local.md" };
        finish(`Смержено. Деплой не выполнен: команда выкатки не задана (.grace/local.md → stand.deploy_cmd).`, "warn");
        continue;
      }
      const st = spawnStep(projectDir, deployCmd, path.join(dir, "deploy.out"));
      plan.deployRun = { ...st, startedAt: new Date().toISOString() };
      plan.result.deploy = { status: "running", cmd: deployCmd };
      plan.closeStep = "deploy-wait"; changed = true;
      logPlan(plan, "plan-deploy", { started: st.started });
      continue;
    }
    if (plan.closeStep === "deploy-wait") {
      const r = readStep(path.join(dir, "deploy.out"));
      const started = Date.parse((plan.deployRun || {}).startedAt || "") || 0;
      if (!r && Date.now() - started < STALL_MS && (plan.deployRun || {}).started) continue;
      // Команда выкатки — произвольная строка из .grace/local.md: она вполне может звать модель.
      if (r) { const stop = parseQuotaStop(r.text, Date.now());
        if (stop) { plan.closeStep = "deploy"; planQuotaHold(board, plan, stop, "деплой", "deployRun"); changed = true; continue; } }
      const ok = !!(r && r.code === 0);
      plan.result.deploy = { status: ok ? "done" : "failed", output: r ? r.text.slice(-600) : null,
        cmd: (plan.result.deploy || {}).cmd || null };
      plan.closeStatus = "done"; plan.closeStep = "closed";
      plan.archived = ok;
      planNotice(plan, ok ? `Прогон закрыт: смержено и раскатано.`
        : `Смержено, НО деплой упал — нужен человек (пост-деплой smoke и автооткат — отдельная карточка бэклога).`, ok ? "ok" : "error");
      logPlan(plan, "plan-deployed", { ok });
      changed = true;
      continue;
    }
  }
  return changed;
}
// endregion FUNC_planClose

// ── dispatch: write a grace-feature-dev-compatible seed into the project ─────
function dispatch(card) {
  const projectDir = resolveProjectDir(card.project);
  const rigor = card.rigor === "grace" ? "grace" : "off";
  const runDir = path.join(projectDir, ".grace-feature-dev", card.slug);
  // B2: with nobody waiting for answers the ask stage is a paid no-op — merge it into build.
  const merged = effAutonomy(card) === "auto";
  const event = { ts: new Date().toISOString(), event: "dispatch", cardId: card.id, project: card.project, slug: card.slug,
    rigor, buildMode: buildModeFor(card), model: modelFor(card) || null, merged };

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

  // Asking · block 1 — ask the FUNCTIONAL questions, then stop. In AUTO (B2) the same session
  // classifies both gates AND builds: `askBuildMerged` tells the supervisor to keep its hands
  // off the build launch while that one process is alive.
  if (merged) {
    card.askBuildMerged = true;
    event.launch = launchAskBuild(card, projectDir, runDir, rigor);
    recordLaunch(card, event.launch, "ask-build");
  } else {
    card.askBuildMerged = false;
    event.launch = launchAskFunctional(card, projectDir, runDir, rigor);
    recordLaunch(card, event.launch, "ask-functional");
  }
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
    card.runLogFrom = launch.from || 0;   // S6: read only THIS run's output, never a stale tail
    card.runStartedAt = new Date().toISOString();
  }
}

// region FUNC_autonomy — effective autonomy + the AUTO escalation-threshold override (§5.3)
// ## @purpose Resolve a card's effective autonomy (own override → global default) and, when
// ##   it's `auto`, emit the prompt block that FLIPS the ask-gate escalation threshold: don't
// ##   escalate reversible forks — pick the strongest option, justify it, continue. The HARD
// ##   FLOOR (irreversibility, cost, legal, provider, contract-shaping data model) still stops
// ##   for a human even in AUTO; such a fork is tagged floor:true and left for the human.
// ## @invariants ask (default) = byte-identical to today's behaviour — the block is empty.
const effAutonomy = (card) => (card && AUTONOMIES.includes(card.autonomy)) ? card.autonomy : GLOBAL_AUTONOMY;
// S4: the git branch a card commits to — a plan stage shares the plan's integration branch
// (set at plan creation), a single card keeps its own autodev/<slug>.
const branchFor = (card) => card.integrationBranch || ("autodev/" + card.slug);
function autonomyBlock(card) {
  if (effAutonomy(card) !== "auto") return "";
  return [
    `РЕЖИМ AUTO (autonomy=auto) — НЕ эскалируй ОБРАТИМЫЕ решения человеку: по каждой развилке ВЫБЕРИ`,
    `сильнейший вариант, зафиксируй краткое обоснование в "ownText" и ПРОДОЛЖАЙ без остановки.`,
    `ЖЁСТКИЙ ПОЛ (стоп к человеку ДАЖЕ в AUTO — не выбирай сам): необратимость (деструктивная миграция,`,
    `удаление данных), стоимость, юридика/резидентность/выбор провайдера, форма модели данных, влияющая`,
    `на контракт. Развилку из пола помечай "floor":true в её объекте archQuestions и оставляй человеку.`,
    `Мержить в main САМ НЕ имеешь права (git-пол) — доводи до "ready" в ветку, финальный PR утверждает человек.`,
  ].join("\n");
}
// S5: plan-level decisions taken ONCE at the summary gate ride every stage seed so a stage
// never re-asks what the plan already settled (roadmap §2 Фаза 1). Empty for single cards.
function planDecisionsBlock(card) {
  const d = Array.isArray(card.planDecisions) ? card.planDecisions.filter((x) => x && x.q) : [];
  if (!d.length) return "";
  return [
    `ПЛАН-УРОВНЕВЫЕ РЕШЕНИЯ (приняты человеком на сводном гейте прогона — СОБЛЮДАЙ, НЕ переспрашивай):`,
    ...d.map((x) => `• ${x.q} → ${x.chosenTitle || x.a || x.choice || "(решено)"}${x.ownText ? " — " + x.ownText : ""}`),
    `Эти решения уже сделаны на уровне прогона: не выноси их снова в questions/archQuestions.`,
  ].join("\n");
}
// endregion FUNC_autonomy

// region FUNC_leanContext — drop the user-level harness from every headless run
// ## @purpose EVERY spawned run pays for its start context TWICE: once as a cache write, and then
// ##   again as a cache read on every single turn of that session. Measured on this machine with
// ##   three identical probe runs (`claude -p "ответь одним словом"`, DocsInside2):
// ##     as-is                                    34 659 tokens
// ##     + --strict-mcp-config                    33 458   (−1 201 — MCP is NOT the problem,
// ##                                                        its tools load lazily by name)
// ##     + --setting-sources project              22 598   (−12 061, −35%)
// ##   The 12k is the USER-level harness a build agent never needs: 23 personal skills
// ##   (brandkit, caveman, logo-design…), 8 global subagents (post-writer, wave-trading-agent…),
// ##   the global CLAUDE.md and personal hooks. On run 13dc2476 that is 41 sessions × 12k of
// ##   cache write PLUS 766 turns × 12k of cache read ≈ 13% of the whole run.
// ## @io (projectDir) -> string[] of extra CLI flags (empty = today's behaviour, byte-identical)
// ## @invariants
// ## - NEVER trims a project that isn't prepared. `--setting-sources project` also hides the
// ##   USER-level copies of the pipeline's own skill, its gfd-* agents AND the /grace-feature-dev
// ##   COMMAND, so the flags are added only when the project carries all three of its own —
// ##   otherwise the run would start without the very thing it is invoked with.
// ## - The COMMAND check is not decoration: measured on the dev box 08.08 with a probe command,
// ##   `claude -p "/probe-cmd" --setting-sources project` answers «Unknown command: /probe-cmd»
// ##   while the same call without the flag answers the command body. A project trimmed without
// ##   its own commands/ would get the dispatch prompt's first line as PLAIN TEXT — the B6 bug,
// ##   just caused by us instead of by a missing install. See scripts/prepare-project.sh.
// ## - GRACE_LEAN=0 turns it off wholesale — one env var to roll back without a code change.
// ## - Probe existence per spawn, not once at boot: a project can be prepared mid-session.
// ## @rationale Q: inject the agents with --agents JSON instead, so no project prep is needed?
// ##   A: five agent bodies on the command line is unreadable in logs and in `ps`; the file
// ##   check degrades safely and costs one stat() per spawn.
// GREP_SUMMARY: lean context, start context, setting-sources, strict-mcp-config, harness trim
const LEAN = process.env.GRACE_LEAN !== "0";
function leanFlags(projectDir) {
  if (!LEAN) return [];
  const has = (...p) => fs.existsSync(path.join(projectDir, ".claude", ...p));
  const prepared = has("skills", "grace-feature-dev") && has("agents", "gfd-coder.md") && has("commands", `${GRACE_COMMAND}.md`);
  return prepared ? ["--setting-sources", "project", "--strict-mcp-config"] : [];
}
// endregion FUNC_leanContext

// region FUNC_runModel — which model the MAIN thread of a run gets (B3′)
// ## @purpose The board spawned every run without `--model`, i.e. on the account default (Opus).
// ##   The main thread is not an architect here — it is the implementer (measured over the
// ##   health-intelligence batch: 1 201 file edits, 1 678 Bash calls, 52 delegations), and it
// ##   accounted for $963 of $1 026. The model must therefore be a SETTING of the run, not an
// ##   accident of the account.
// ## @io (card|plan) -> string|null · null means «pass no --model», i.e. today's behaviour
// ## @invariants
// ## - Nothing configured ⇒ null ⇒ byte-identical to the pre-B3′ command line.
// ## - Per-run override wins over the global env: a heavy domain stage can stay on Opus while
// ##   screens/configs/tails ride Sonnet (the escape hatch the plan explicitly asks for).
// ## - Plan-level `model` is stamped onto every stage card at assembly (see POST /api/plans),
// ##   so the prompt builders need only the card.
// GREP_SUMMARY: model, --model, GRACE_CLAUDE_MODEL, sonnet, opus, main thread cost
const CLAUDE_MODEL_DEFAULT = (process.env.GRACE_CLAUDE_MODEL || "").trim() || null;
const modelFor = (owner) => (owner && typeof owner.model === "string" && owner.model.trim()) || CLAUDE_MODEL_DEFAULT;
// endregion FUNC_runModel

// region FUNC_buildMode — how the pipeline's build loop executes its cards (B7)
// ## @purpose The dispatch prompt hard-coded nothing about `--mode`, so the agent guessed —
// ##   over the whole batch it guessed `inline` every single time (0 gfd-coder spawns against
// ##   45 gfd-reviewer spawns), which is why the main thread wrote all the code itself.
// ## @invariants
// ## - Default stays `inline`: the pre-B7 behaviour, chosen by the command's own default.
// ## - hybrid/fanout hand cards to gfd-coder, but ALL of them share ONE working tree (the board
// ##   spawns every run in the same projectDir), and a concurrent checkout was already observed
// ##   flipping that tree to `main` mid-run. So a non-inline mode ships with a hard prompt
// ##   constraint: one coder at a time, never switch the working tree's branch.
const BUILD_MODES = ["inline", "hybrid", "fanout"];
const BUILD_MODE_DEFAULT = BUILD_MODES.includes((process.env.GRACE_BUILD_MODE || "").trim()) ? process.env.GRACE_BUILD_MODE.trim() : "inline";
// NB: `plan.mode` is the AUTONOMY of a run (ask|auto) and predates this — hence `buildMode`.
const buildModeFor = (card) => (card && BUILD_MODES.includes(card.buildMode)) ? card.buildMode : BUILD_MODE_DEFAULT;
function buildModeBlock(card, branch) {
  const mode = buildModeFor(card);
  if (mode === "inline") return "";
  return [
    `РЕЖИМ СБОРКИ «${mode}»: декомпозированные карточки отдавай субагенту gfd-coder (свежий контекст), сам`,
    `не пиши их код. ЖЁСТКОЕ ОГРАНИЧЕНИЕ ПАРАЛЛЕЛИЗМА: рабочее дерево проекта ОДНО и общее — спавни`,
    `СТРОГО ОДНОГО кодера за раз и дожидайся его возврата, прежде чем брать следующую карточку. НИКОГДА не`,
    `переключай ветку рабочего каталога (никаких "git checkout main"/"switch") — работай только в "${branch}".`,
    `Кодеру передавай ТОЛЬКО файлы из его card.files[]; пересечение файлов между одновременными карточками`,
    `запрещено (инвариант §2.2 скилла).`,
  ].join("\n");
}
// endregion FUNC_buildMode

// region FUNC_spawnRun — detached headless Claude run (dir-scoped, logged)
function spawnRun(projectDir, runDir, prompt, logName, opts) {
  if (!AUTORUN) return { launched: false, reason: "GRACE_AUTORUN=0" };
  if (!fs.existsSync(CLAUDE_BIN)) return { launched: false, error: "claude bin not found: " + CLAUDE_BIN };
  try {
    // Where THIS run's output starts. Logs are appended across relaunches, so without the offset
    // a stale «hit your limit» from an earlier attempt would keep re-arming the quota wait (S6).
    let from = 0; try { from = fs.statSync(path.join(runDir, logName)).size; } catch {}
    const out = fs.openSync(path.join(runDir, logName), "a");
    const env = { ...process.env, PATH: `${BIN_PATH_HINT}:${process.env.PATH || ""}` };
    const lean = leanFlags(projectDir);
    const model = (opts && opts.model) || null;      // B3′: null ⇒ no --model ⇒ account default
    const args = ["-p", prompt, "--permission-mode", "bypassPermissions", "--add-dir", projectDir,
      ...(model ? ["--model", model] : []), ...lean];
    const child = spawn(CLAUDE_BIN, args, { cwd: projectDir, env, detached: true, stdio: ["ignore", out, out] });
    child.unref();
    return { launched: true, pid: child.pid, log: path.join(runDir, logName), from, lean: lean.length > 0, model };
  } catch (e) {
    return { launched: false, error: String(e.message || e) };
  }
}
// region FUNC_graceCommand — the first line of every dispatch prompt (B6 + B7)
// ## @purpose Two separate defects lived in this one line.
// ##   B7: the board wrote only the feature text, so `--rigor` and `--mode` were GUESSED by the
// ##   agent — over the whole batch it guessed mode=inline every time (0 gfd-coder spawns).
// ##   B6: `/grace-feature-dev` never reached the COMMAND at all. A SKILL of the same name wins
// ##   the `/name` resolution — verified on the box with a deliberate collision probe
// ##   (command says FROM-COMMAND, skill says FROM-SKILL → the answer was FROM-SKILL). So the
// ##   agent was handed the format spec and never the orchestration control flow. Hence a
// ##   distinct name, `/grace-run`, which nothing shadows.
// ## @invariants
// ## - An UNKNOWN slash command kills the whole run: `claude -p "/nope тема …"` answers
// ##   «Unknown command: /nope» and never reads the rest of the prompt (measured). So the name
// ##   is emitted ONLY when the file actually exists where this run will look for it, and the
// ##   fallback is the old line — degradation to «команда резолвится в скилл», never a dead run.
// ## - Under lean flags the run sees ONLY the project's commands (`--setting-sources project`),
// ##   so the probe looks in the project first and at user level only for a non-lean run.
// GREP_SUMMARY: grace-run, slash command, command vs skill collision, unknown command, rigor, mode
const GRACE_COMMAND = (process.env.GRACE_COMMAND_NAME || "grace-run").trim();
function commandInstalled(projectDir) {
  const inProject = fs.existsSync(path.join(projectDir, ".claude", "commands", `${GRACE_COMMAND}.md`));
  if (leanFlags(projectDir).length) return inProject;                 // lean: user level is invisible
  return inProject || fs.existsSync(path.join(os.homedir(), ".claude", "commands", `${GRACE_COMMAND}.md`));
}
function graceCommand(card, rigor, projectDir) {
  const r = rigor === "grace" ? "grace" : "off";
  const name = commandInstalled(projectDir) ? GRACE_COMMAND : "grace-feature-dev";
  return `/${name} ${featureLine(card)} --rigor ${r} --mode ${buildModeFor(card)}`;
}
// endregion FUNC_graceCommand

// Asking · block 1 (FUNCTIONAL) — ask up to 8 questions about WHAT to build, then stop.
// ## @purpose Block 1 ALSO classifies the architecture gate, so a card with nothing to ask
// ##   goes asking→build in ONE session instead of two. Measured on run 13dc2476 (7 cards):
// ##   the separate arch pass burned 663k cache-write + 1.63M cache-read + 7.2 min of
// ##   wall-clock to answer «архитектурных развилок нет» 7 times out of 7 — a fresh process
// ##   re-warms ~115k of system prompt to re-read the same brief this session already has.
// ## @invariants
// ## - The gate is NOT skipped, it MOVES: the same escalation threshold as launchAskArchitecture.
// ## - Priority is strict — functional questions WIN. `questions` non-empty ⇒ archQuestions is
// ##   left empty and block 2 runs later (POST /answers), because architecture must be classified
// ##   AFTER the human's functional answers, not against a guess about them.
// ## - launchAskArchitecture stays and is still reached two ways: POST /api/tasks/:id/answers
// ##   (human answered block 1) and the supervisor's `functional-done` branch (older cards
// ##   mid-flight, whose runDir board.json predates this prompt).
// ## @rationale Q: why not delete block 2 outright? A: the human-answered path genuinely needs a
// ##   second session — its input (the answers) does not exist when block 1 runs.
function launchAskFunctional(card, projectDir, runDir, rigor) {
  const reqs = compiledRequirements(card);
  const dirs = directivesBlock(card);
  const auto = autonomyBlock(card);
  const planDec = planDecisionsBlock(card);
  const brief = briefBlock(card);
  const prompt = [
    graceCommand(card, rigor, projectDir), ``,
    reqs ? `Контекст задачи:\n${reqs}\n` : ``,
    brief ? `${brief}\n` : ``,
    dirs ? `${dirs}\n` : ``,
    auto ? `${auto}\n` : ``,
    planDec ? `${planDec}\n` : ``,
    `AUTONOMOUS HEADLESS — ЭТАП ASKING. Сделай discovery + краткую разведку, классифицируй ОБА гейта`,
    `(функционал и архитектуру) в ЭТОЙ сессии, затем ОСТАНОВИСЬ. НЕ пиши код — build запустит диспетчер.`,
    `ПОРОГ ЭСКАЛАЦИИ — спрашивать человека МОЖНО ТОЛЬКО если решение: (а) меняет ПОВЕДЕНИЕ продукта или объём`,
    `(что система делает/не делает для пользователя), ЛИБО (б) это настоящая развилка с внешними последствиями`,
    `(стоимость, vendor lock-in, юридика/комплаенс, необратимость, форма данных в контракте), ЛИБО (в) по нему`,
    `у НЕ-разработчика (продукт/юрист/владелец) реально может быть мнение. НЕ спрашивай про «как»: расположение`,
    `кода, имена ролей/переменных/GUC, паттерн (mixin vs helper), где ставить SET LOCAL, структуру файлов,`,
    `глубину/способ тестирования, формат логов — всё системное/имплементационное решай САМ по best-practice и`,
    `инвариантам проекта (CLAUDE.md/ARCHITECTURE.md) и записывай принятое решение с кратким обоснованием в "answers".`,
    ``,
    `Тот же порог применяется и к АРХИТЕКТУРНОЙ развилке: она идёт человеку, только если это настоящий выбор`,
    `с внешними последствиями (стоимость, vendor lock-in, юридика/комплаенс/резидентность/провайдер,`,
    `необратимость, форма модели данных, влияющая на контракт). Детали стека, имена, паттерны, структура`,
    `файлов, глубина тестов, формат логов — НЕ развилка: решай САМ.`,
    ``,
    `Выбери РОВНО ОДИН из трёх исходов, перезапиши board.json и ВЫЙДИ:`,
    `• ЕСТЬ что спросить человека ПО ФУНКЦИОНАЛУ → сформулируй 3–8 конкретных вопросов (поведение, сценарии,`,
    `  данные, роли/доступ, граничные случаи, что НЕ входит в объём). Запиши top-level массив "questions"`,
    `  (короткие строки), выставь "column":"asking", "askStage":"functional". Архитектуру в этом случае НЕ`,
    `  классифицируй и "archQuestions" НЕ пиши — её оценит блок 2 ПОСЛЕ ответов человека (они могут её изменить).`,
    `• Функциональных вопросов нет, но ЕСТЬ настоящая АРХИТЕКТУРНАЯ развилка → заполни "answers", а для КАЖДОЙ`,
    `  развилки предложи 2–4 варианта: top-level "archQuestions", элемент { "id":"d1", "q":"<вопрос>",`,
    `  "options":[ { "id":"o1", "title":"<краткий заголовок>", "desc":"<1–2 фразы>", "pros":["<плюс>", ...],`,
    `  "cons":["<минус>", ...], "recommended":true|false } , ... ] }. Ровно ОДИН вариант в развилке помечай`,
    `  "recommended":true. Выставь "askStage":"architecture", "column":"asking" — человек выберет решения.`,
    `• НЕТ НИ ТОГО, НИ ДРУГОГО (типично для фундаментальных core/infra-этапов — норма 0 вопросов) → выставь`,
    `  "questions":[], сам заполни top-level "answers":[{"q":"…","a":"… + обоснование"}] принятыми решениями,`,
    `  выставь "archQuestions":[] и "archDecisions":[] (ПУСТОЙ массив = маркер «гейт пройден, выбирать нечего»;`,
    `  принятые тобой системные решения фиксируй элементами вида {"q":"…","chosenTitle":"…","ownText":"<обоснование>"}),`,
    `  затем "askStage":"done", "column":"asking". Человека НЕ ждём — полный build до "ready" диспетчер запустит`,
    `  САМ, НЕ строй его здесь.`,
    `Твой board.json: ${path.join(runDir, "board.json")}.`,
  ].join("\n");
  return spawnRun(projectDir, runDir, prompt, "ask-functional.log", { model: modelFor(card) });
}

// region FUNC_askBuildMerged — one session for the whole card when nobody is waiting (B2)
// ## @purpose With autonomy=auto the asking stage asks NOBODY: over the batch it cost 31 extra
// ##   sessions × ~$4 = $114 to answer «нечего спрашивать» and exit, after which a SECOND process
// ##   re-warmed ~44k of start context to read the same brief and start building. The gate is not
// ##   removed — it MOVES inside the build session, which is what the comment above already
// ##   promised («asking→build in ONE session») but the dispatcher never delivered.
// ## @io (card, projectDir, runDir, rigor) -> spawnRun result · sets nothing on the card itself
// ## @invariants
// ## - autonomy=ask is untouched: there the ask stage genuinely waits for a human.
// ## - The classification still happens FIRST and is still written to board.json (`answers`,
// ##   `archDecisions`), so «Результат» and the PR keep showing what was decided without a human.
// ## - A REAL fork (functional question, or a hard-floor architecture fork) still stops the
// ##   session — it writes the questions, stays in `asking` and exits. The dispatcher then walks
// ##   the ordinary two-block path, so nothing is lost, it just isn't paid for by default.
// ## - The session writes `column:"implementing"` and `askStage:"done"` in ONE board.json write
// ##   before it starts building, so a tick can never see «done + asking» and launch a duplicate
// ##   build. The dispatcher additionally holds off while a merged run is alive (syncFromPipeline).
// GREP_SUMMARY: B2, merged ask build, one session, autonomy auto, askBuildMerged, ask gate inline
function launchAskBuild(card, projectDir, runDir, rigor) {
  const reqs = compiledRequirements(card);
  const dirs = directivesBlock(card);
  const auto = autonomyBlock(card);
  const planDec = planDecisionsBlock(card);
  const brief = briefBlock(card);
  const prompt = [
    graceCommand(card, rigor, projectDir), ``,
    reqs ? `Контекст задачи:\n${reqs}\n` : ``,
    brief ? `${brief}\n` : ``,
    dirs ? `${dirs}\n` : ``,
    auto ? `${auto}\n` : ``,
    planDec ? `${planDec}\n` : ``,
    `AUTONOMOUS HEADLESS — ОДНА СЕССИЯ НА ВСЮ КАРТОЧКУ (autonomy=auto: человека, который ждал бы ответов,`,
    `здесь нет). Сначала гейты, потом сразу сборка — БЕЗ второго процесса.`,
    ``,
    `ШАГ 1. Discovery + краткая разведка, классифицируй ОБА гейта (функционал и архитектура).`,
    `ПОРОГ ЭСКАЛАЦИИ — человека беспокоим ТОЛЬКО если решение: (а) меняет ПОВЕДЕНИЕ продукта или объём,`,
    `ЛИБО (б) это настоящая развилка с внешними последствиями (стоимость, vendor lock-in, юридика/комплаенс/`,
    `резидентность/провайдер, необратимость, форма модели данных, влияющая на контракт), ЛИБО (в) по нему`,
    `реально может быть мнение у НЕ-разработчика. «Как» (расположение кода, имена, паттерн, структура файлов,`,
    `глубина тестов, формат логов) — НЕ развилка: решай САМ и записывай решение с обоснованием.`,
    ``,
    `ШАГ 2 — РАЗВИЛКА ИСПОЛНЕНИЯ, выбери РОВНО ОДИН исход:`,
    `• ЕСТЬ что спросить человека (функциональный вопрос ЛИБО развилка из ЖЁСТКОГО ПОЛА) → запиши top-level`,
    `  "questions" (3–8 строк) и/или "archQuestions" (элемент { "id","q","options":[{ "id","title","desc",`,
    `  "pros":[],"cons":[],"recommended":true|false }] }, ровно один вариант recommended; развилку из пола`,
    `  помечай "floor":true), выставь "column":"asking" и соответствующий "askStage", перезапиши board.json`,
    `  и ВЫЙДИ. Код НЕ пиши — дальше решает человек.`,
    `• СПРАШИВАТЬ НЕЧЕГО (типичный случай для core/infra-этапов — норма 0 вопросов) → ОДНОЙ записью в`,
    `  board.json зафиксируй: "answers":[{"q":"…","a":"… + обоснование"}] (принятые тобой решения),`,
    `  "questions":[], "archQuestions":[], "archDecisions":[{"q":"…","chosenTitle":"…","ownText":"<обоснование>"}]`,
    `  (пустой массив = «выбирать было нечего»), "askStage":"done" И СРАЗУ "column":"implementing" —`,
    `  ИМЕННО ОДНИМ записыванием файла, не двумя. После этого ПРОДОЛЖАЙ В ЭТОЙ ЖЕ СЕССИИ и выполни`,
    `  полный build по правилам ниже. НЕ выходи после гейта: второй процесс на эту карточку не придёт.`,
    ``,
    ...buildDirectives(card, runDir, rigor),
  ].join("\n");
  return spawnRun(projectDir, runDir, prompt, "ask-build.log", { model: modelFor(card) });
}
// endregion FUNC_askBuildMerged

// Asking · block 2 (ARCHITECTURE) — launched after functional answers. EITHER propose
// architecture DECISIONS (variant options with pros/cons) and stop, OR (if none are
// needed) proceed straight to the full build.
function launchAskArchitecture(card, projectDir, runDir, funcQA, rigor) {
  const qa = (funcQA || []).map((p) => `Q: ${p.q}\nA: ${p.a || "(нет ответа)"}`).join("\n");
  const reqs = compiledRequirements(card);
  const dirs = directivesBlock(card);
  const auto = autonomyBlock(card);
  const planDec = planDecisionsBlock(card);
  const brief = briefBlock(card);
  const prompt = [
    graceCommand(card, rigor, projectDir), ``,
    reqs ? `Контекст задачи:\n${reqs}\n` : ``,
    brief ? `${brief}\n` : ``,
    `Ответы по функционалу (блок 1):\n${qa}\n`,
    dirs ? `${dirs}\n` : ``,
    auto ? `${auto}\n` : ``,
    planDec ? `${planDec}\n` : ``,
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
  return spawnRun(projectDir, runDir, prompt, "ask-architecture.log", { model: modelFor(card) });
}

// The build half of the dispatch prompt — the rules a run must follow from `implementing` to
// `ready`. Extracted so the merged ask+build session (B2) issues EXACTLY the same instructions
// as the two-session path: one prompt body, two entry points, no drift between them.
function buildDirectives(card, runDir, rigor) {
  const rigorLine = `Rigor: ${rigor || "off"}. Apply markup per grace-feature-dev SKILL §3 — grace = full semantic exoskeleton (MODULE/FUNCTION_CONTRACT) + LDD [IMP:N] logs; off = the repo's own idiom, no GRACE markers.`;
  // S4: a plan stage commits to the plan's SHARED integration branch (base = its tip → sees
  // predecessors' commits, §4); a single card keeps its own autodev/<slug>. branchFor() is the
  // single source of the branch name across green-checkpoints, the final push, and resume.
  const branch = branchFor(card);
  const modeBlock = buildModeBlock(card, branch);
  const baseLine = card.integrationBranch
    ? `ЭТАП ПРОГОНА: работай в ОБЩЕЙ интеграционной ветке "${branch}" (одна на весь прогон). Если её нет — создай от свежего main; иначе checkout и продолжай С ЕЁ TIP — ты ВИДИШЬ коммиты предыдущих этапов (§4). НЕ ответвляй заново от main на каждом этапе.`
    : `работай в выделенной ветке "${branch}" — ответви её от свежего main в начале.`;
  return [
    rigorLine,
    modeBlock ? `${modeBlock}\n` : ``,
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
    `"${branch}" микро-коммит: сначала "git add" СТРОГО по файлам из card.files[] ЭТОЙ карточки`,
    `(НИКОГДА не "git add ." и не "-A" — чекпоинт атомарный, чужие изменения не тянем), затем`,
    `"git commit -m 'green(<cardId>): <краткий title карточки>'". Коммить ТОЛЬКО на зелёной карточке. Провал`,
    `verify/review (карточка вернулась в implementing или ушла в blocked по Anti-Loop) → НЕ коммить; последний`,
    `зелёный чекпоинт оставляем нетронутым, человек продолжит от него. Эти green-коммиты — атомарные точки`,
    `отката ("git restore --source=<sha> -- <файл>"); финальный push перед "ready" (см. BRANCH & HANDOFF) идёт`,
    `в ту же ветку "${branch}" и эти коммиты НЕ заменяет.`,
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
    `МАНИФЕСТ РЕЛИЗА (§6.1, ОБЯЗАТЕЛЬНО перед "ready"): запиши top-level "deploy" — объект РОВНО с 5`,
    `ключами-массивами {"migrations":[],"env":[],"services":[],"seed":[],"manualChecks":[]}. Это ран-бук`,
    `раскатки ЭТОЙ единицы: migrations — новые файлы миграций (forward-only) в порядке применения;`,
    `env — новые/изменённые переменные окружения (строка "KEY=зачем" или {"name","value","note"}); services —`,
    `новые/изменённые сервисы/воркеры/systemd-юниты/cron-таймеры; seed — сиды и разовые backfill-скрипты в`,
    `порядке прогона; manualChecks — что прокликать руками после раскатки. ВСЕ 5 ключей ОБЯЗАТЕЛЬНЫ: пустой`,
    `массив [] = «проверял, пусто», ОТСУТСТВИЕ ключа = «забыл» → карточка НЕ done. Одиночное поле "migration"`,
    `продолжай писать для совместимости, но тот же путь ОБЯЗАН быть и в "deploy".migrations.`,
    `BRANCH & HANDOFF (ОБЯЗАТЕЛЬНО, не коммить в main напрямую): ${baseLine} Когда все гейты зелёные и до того`,
    `как ставишь "column":"ready": закоммить, "git push -u origin ${branch}", и запиши в board.json top-level`,
    `"branchLink" — URL ветки/compare на GitHub (origin remote), который человек должен проревьюить и подлить в main.`,
    `Если push невозможен (нет remote/доступа) — оставь имя ветки в "branchLink" и опиши это в "finishNote".`,
    card.integrationBranch ? `main САМ НЕ мержь — финальный PR прогона в main утверждает человек (git-пол, §4/§5.3).` : ``,
    `ИТОГИ КАРТОЧКИ: всегда заполняй top-level "finishNote" коротким резюме сделанного. ОТЛОЖЕННОЕ указывай ЯВНО`,
    `и СТРУКТУРНО: top-level "deferred" — массив объектов {"title":"кратко что не сделано","reason":"почему/куда`,
    `вынесено"}. Эти пункты доска автоматически заведёт карточками в backlog. Продублируй их разделом "Отложенное:"`,
    `в "finishNote" (или "Отложенное: нет", если deferred пуст). Не прячь отложенное внутри TODO в коде done-карточки.`,
    `Твой board.json: ${path.join(runDir, "board.json")}.`,
  ];
}

// BUILD — launched after the architecture decisions are chosen. Architect honors them.
function launchBuild(card, projectDir, runDir, funcQA, archDecisions, rigor, recovery) {
  const fq = (funcQA || []).map((p) => `Q: ${p.q}\nA: ${p.a || "(нет ответа)"}`).join("\n");
  const ad = (archDecisions || []).map((d) => `• ${d.q}\n  → ВЫБРАНО: ${d.chosenTitle || d.choice}${d.ownText ? " — " + d.ownText : ""}`).join("\n");
  const reqs = compiledRequirements(card);
  const dirs = directivesBlock(card);
  const auto = autonomyBlock(card);
  const planDec = planDecisionsBlock(card);
  const brief = briefBlock(card);
  const prompt = [
    graceCommand(card, rigor, projectDir), ``,
    reqs ? `Контекст задачи:\n${reqs}\n` : ``,
    brief ? `${brief}\n` : ``,
    fq ? `Ответы по функционалу:\n${fq}\n` : ``,
    ad ? `Принятые архитектурные решения (человек выбрал — СОБЛЮДАЙ их):\n${ad}\n` : ``,
    dirs ? `${dirs}\n` : ``,
    auto ? `${auto}\n` : ``,
    planDec ? `${planDec}\n` : ``,
    recovery ? `${recovery}\n` : ``,
    ...buildDirectives(card, runDir, rigor),
  ].join("\n");
  return spawnRun(projectDir, runDir, prompt, "build.log", { model: modelFor(card) });
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
  card.result = buildResult(card); // SR: freeze the block reason into «Результат» (this card is skipped by the next sync pass)
  card.history.push({ column: "blocked", ts: card.lastColumnChangeAt, via: "supervisor", reason });
  try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: card.lastColumnChangeAt, event: "blocked", cardId: card.id, reason }) + "\n"); } catch {}
}

// region FUNC_warden — the board CALLS the agent; the agent never polls the board (design §2)
// ## @purpose 3.6 h of a single run were lost to token-limit deaths: autoheal fires its one
// ##   retry, the global limit kills that too, the card lands in `blocked` and waits for a
// ##   human to relaunch it by hand. A stuck card needs a JUDGEMENT (temporary limit? crashed
// ##   before writing its questions? environment broken?) and that judgement needs a model —
// ##   but a model called every 30 s is pure waste. So: the supervisor stays a free timer, and
// ##   the model is invoked ONLY on an event — «about to block», «asking too long», «stalled».
// ## @io (board,card,meta) -> spawn/POST one warden run + card.wardenPending
// ##     HTTP: GET /api/health · POST /api/tasks/:id/pause|resume|note · POST /api/hooks/warden
// ## @invariants
// ## - NO hook registered → escalate() === blockCard(), i.e. today's behaviour byte for byte.
// ##   The warden is an addition, never a dependency: a broken/absent agent must not strand a card.
// ## - Deferred block: when a hook IS registered the supervisor does NOT block immediately — it
// ##   hands the card to the warden and blocks only if no answer comes within WARDEN_TIMEOUT_MS.
// ##   That is what lets a quota death end in `paused` instead of `blocked`.
// ## - `asking` events NEVER auto-block: there the human is legitimately being waited on.
// ## - The agent touches state through HTTP only (no board.json write), so local and VPS run the
// ##   SAME contract — only BOARD_URL and the notify channel differ (§2.5).
// ## - Budget: WARDEN_BUDGET state-changing actions per card per rolling 24 h (§2.4). Notes are
// ##   NOT counted — they are diagnosis, and the budget exists to stop ACTION loops.
// ## @rationale Q: why does the board not classify quota itself? A: §2.3 gives the classifier to
// ##   the agent. The board only supplies DETERMINISTIC signals (pid alive, questions empty, log
// ##   tail, how many runs died in the last 60 s) — cheap, honest, and no model call.
// ## @modulemap
// ## FUNC 2[calc]   => wardenHook        — registered handler (board.json → env fallback)
// ## FUNC 3[calc]   => wardenBudget      — interventions used / left in the rolling day
// ## FUNC 4[calc]   => cardSignals       — deterministic evidence for the classifier
// ## FUNC 6[io]     => fireWardenEvent   — spawn a command / POST a webhook, once per card
// ## FUNC 4[persist]=> escalate          — the ONE «something is wrong» exit of the supervisor
// ## FUNC 3[calc]   => healthReport      — GET /api/health projection
// GREP_SUMMARY: warden, board-warden, health, pause, resume, note, hooks, quota, crash-before-write, §2
// STRUCTURE: ▶ supervisor → ⊕ escalate → ⚡ fireWardenEvent(hook) → ⎋ agent → HTTP pause/relaunch/note

const ASK_STALL_MS = Number(process.env.GRACE_ASK_STALL_MIN || 30) * 60 * 1000;
const WARDEN_TIMEOUT_MS = Number(process.env.GRACE_WARDEN_TIMEOUT_MIN || 10) * 60 * 1000;
const WARDEN_BUDGET = Number(process.env.GRACE_WARDEN_BUDGET || 5);   // state-changing actions / card / 24 h
const WARDEN_ACTIONS = new Set(["pause", "resume", "relaunch"]);      // what the budget counts
const DEATH_WINDOW_MS = 60 * 1000;                                    // §2.3 «несколько ранов умерли в окне < 60 с»
const WARDEN_LOG_DIR = path.join(DATA_DIR, "warden");

// The registered handler. board.wardenHook wins; GRACE_WARDEN_CMD is the zero-config fallback
// (a fresh VPS install can arm the warden without an API call).
function wardenHook(board) {
  const h = board && board.wardenHook;
  if (h && h.kind === "command" && h.cmd) return h;
  if (h && h.kind === "http" && h.url) return h;
  if (h && h.kind === "off") return null;
  return process.env.GRACE_WARDEN_CMD ? { kind: "command", cmd: process.env.GRACE_WARDEN_CMD, notify: "desktop" } : null;
}
function wardenBudget(card) {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const acts = (card.wardenActions || []).filter((a) => Date.parse(a.ts || "") > since);
  return { used: acts.length, left: Math.max(0, WARDEN_BUDGET - acts.length), window: "24h" };
}
function recordWardenAction(card, action) {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  card.wardenActions = (card.wardenActions || []).filter((a) => Date.parse(a.ts || "") > since);
  card.wardenActions.push({ ts: new Date().toISOString(), action });
}
// Deterministic evidence the classifier runs on — no model, no guessing. `deathsInWindow` is the
// §2.3 «global event» signal: several runs dying inside a minute is a limit, not N card bugs.
function cardSignals(board, card) {
  const runDir = path.join(resolveProjectDir(card.project), ".grace-feature-dev", card.slug);
  const now = Date.now();
  const deaths = (board.recentDeaths || []).filter((d) => now - (Date.parse(d.ts || "") || 0) < DEATH_WINDOW_MS);
  const logFile = card.runLog || path.join(runDir, "build.log");
  return {
    pidAlive: isAlive(card.runPid),
    runPid: card.runPid || null,
    runKind: card.runKind || null,
    askStage: card.askStage || null,
    questions: (card.questions || []).length,
    archQuestions: (card.archQuestions || []).length,
    minutesInColumn: Math.round((now - (Date.parse(card.lastColumnChangeAt || card.createdAt || "") || now)) / 60000),
    autoHealCount: card.autoHealCount || 0,
    deathsInWindow: deaths.length,
    runDir, logFile,
    logTail: tailLog(logFile, 60),
    budget: wardenBudget(card),
  };
}
// Hand ONE event to the warden. Fire-and-forget by design: the supervisor tick must never wait
// on a model. `blockOnTimeout` decides what happens if the agent stays silent.
//
// The event is QUEUED here and dispatched by flushWardenQueue() only AFTER the tick has written
// board.json. Otherwise the agent (which answers over HTTP within milliseconds) would write the
// card while this tick still holds an older in-memory copy, and the tick's trailing write would
// silently erase the pause it just asked for.
const WARDEN_QUEUE = [];
function fireWardenEvent(board, card, meta) {
  const hook = wardenHook(board);
  if (!hook) return false;
  const event = {
    ts: new Date().toISOString(),
    kind: meta.kind,                       // about-to-block | asking-stalled | crash-before-write
    hint: meta.hint || null,               // the board's non-binding guess; the agent decides
    reason: meta.reason || null,
    boardUrl: `http://${HOST}:${PORT}`,
    notify: hook.notify || "desktop",
    card: { id: card.id, theme: card.theme, project: card.project, slug: card.slug, column: card.column,
            planId: card.planId || null, paused: !!card.paused },
    signals: cardSignals(board, card),
  };
  card.wardenPending = { ts: event.ts, kind: meta.kind, reason: meta.reason || null, blockOnTimeout: !!meta.blockOnTimeout };
  WARDEN_QUEUE.push({ hook, event, projectDir: resolveProjectDir(card.project) });
  return true;
}
// Deliver every queued event: spawn the command (local) or POST the webhook (VPS). Same JSON body
// either way — that is what makes «один контракт, различаются BOARD_URL и канал» true (§2.5).
function flushWardenQueue() {
  while (WARDEN_QUEUE.length) {
    const { hook, event, projectDir } = WARDEN_QUEUE.shift();
    const json = JSON.stringify(event);
    try {
      if (hook.kind === "command") {
        fs.mkdirSync(WARDEN_LOG_DIR, { recursive: true });
        const out = fs.openSync(path.join(WARDEN_LOG_DIR, `${event.card.id}.log`), "a");
        const env = { ...process.env, PATH: `${BIN_PATH_HINT}:${process.env.PATH || ""}`,
          GRACE_WARDEN_EVENT: json, GRACE_BOARD_URL: event.boardUrl, GRACE_CARD_ID: event.card.id };
        const child = spawn("/bin/sh", ["-lc", hook.cmd], { cwd: projectDir, env, detached: true, stdio: ["ignore", out, out] });
        child.unref();
      } else {
        const u = new URL(hook.url);
        const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) } }, (r) => r.resume());
        req.on("error", () => {});
        req.setTimeout(5000, () => req.destroy());
        req.end(json);
      }
      fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: event.ts, event: "warden-call", cardId: event.card.id, kind: event.kind, hint: event.hint, via: hook.kind }) + "\n");
    } catch (e) {
      try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: new Date().toISOString(), event: "warden-call-failed", cardId: event.card.id, error: String(e.message || e) }) + "\n"); } catch {}
    }
  }
}
// The single «something is wrong» exit of the supervisor. With a warden armed the block is
// DEFERRED — that is the whole mechanism behind «quota ends in paused, not blocked».
function escalate(board, card, reason, meta) {
  const budget = wardenBudget(card);
  if (!card.wardenPending && budget.left > 0 && fireWardenEvent(board, card, { ...meta, reason, blockOnTimeout: true })) return;
  const exhausted = budget.left <= 0 ? " Бюджет стража на сутки исчерпан — решает человек." : "";
  blockCard(card, reason + exhausted);
}
// GET /api/health — every card standing longer than `minutes`, with the evidence a classifier
// needs. Read-only: the warden looks here first, then acts through the write endpoints.
function healthReport(board, minutes) {
  const now = Date.now(), cutMs = minutes * 60 * 1000;
  const cards = board.cards.filter((c) => {
    if (c.column === TERMINAL || c.column === "backlog") return false;
    if (!c.dispatchedAt && !c.queued) return false;
    return now - (Date.parse(c.lastColumnChangeAt || c.dispatchedAt || "") || now) >= cutMs;
  }).map((c) => ({
    id: c.id, theme: c.theme, project: c.project, column: c.column, planId: c.planId || null,
    queued: !!c.queued, paused: !!c.paused, pausedReason: c.pausedReason || null, pausedUntil: c.pausedUntil || null,
    blockReason: c.blockReason || null, since: c.lastColumnChangeAt || c.dispatchedAt || null,
    wardenPending: c.wardenPending || null, lastNote: (c.notes || []).slice(-1)[0] || null,
    signals: cardSignals(board, c),
  }));
  return { ts: new Date().toISOString(), minutes, stallMinutes: Math.round(STALL_MS / 60000),
    askStallMinutes: Math.round(ASK_STALL_MS / 60000), hook: wardenHook(board) ? "armed" : "none", cards };
}
// endregion FUNC_warden

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

// region FUNC_quotaStop — a subscription limit is a CLOCK, not a crash (S6)
// ## @purpose 30.07: the 5-hour limit ran out mid-run and killed three runs inside 32 s. The
// ##   board read every death as «the run broke»: autoheal spent its one retry INSIDE the dead
// ##   window, the card landed in `blocked` with «открой лог и перезапусти», the WIP=1 slot
// ##   stayed occupied and the whole plan stood still for 3 h — although the limit had already
// ##   reset at 18:10. A quota stop is not a defect: nothing is broken, the clock simply has to
// ##   run out. So the board reads the reset time OUT OF THE RUN'S OWN LOG, pauses until then
// ##   (a promise with a deadline, not an error), and resumes itself when the clock is up.
// ## @io (log tail | board) -> { until, exact, raw } · card.paused/pausedKind/pausedUntil · board.quota
// ## @invariants
// ## - The wait is READ, never assumed: the window is 5 h but may expire 4:50 from now or in
// ##   10 min, so only the «resets 6:10pm» stamp in the log decides. No stamp → short fallback
// ##   probe (GRACE_QUOTA_FALLBACK_MIN), never a blind 5-hour sleep.
// ## - A quota pause costs NO autoHealCount and never blocks: the fuse exists for broken code,
// ##   and this card is not broken. It keeps its station, its place in the queue and its work.
// ## - Board-wide by nature: a limit hits the ACCOUNT, so while `board.quota` is open nothing
// ##   new is dispatched and no run is closed — otherwise the queue just feeds fresh corpses.
// ## - Self-resuming: the ONLY exit is the clock. Resume re-enters through resumeRun() from the
// ##   furthest green checkpoint, so a paused build continues instead of starting over.
// ## @rationale Q: why not hand it to the warden? A: classification needs a model only when the
// ##   evidence is ambiguous. «You've hit your limit · resets 6:10pm» is unambiguous and free to
// ##   read — the warden stays for the cases that genuinely need judgement (§2.3).
// ## @modulemap
// ## FUNC 3[calc]   => parseQuotaStop   — log tail → reset clock (the only source of the wait)
// ## FUNC 2[calc]   => nextClockTs      — «6:10pm (Europe/Moscow)» → absolute ISO instant
// ## FUNC 2[calc]   => quotaOpen        — is the account-wide window still running?
// ## FUNC 4[persist]=> pauseForQuota    — the non-error stop: pause + human-readable promise
// ## FUNC 5[persist]=> quotaResumeTick  — the clock is up → resume every card that was waiting
// GREP_SUMMARY: quota, usage limit, 5-hour limit, resets, pause, auto-resume, self-healing wait
// STRUCTURE: ▶ run dies → ⊕ parseQuotaStop(log) → ⚡ pauseForQuota → ⏳ clock → ⎋ quotaResumeTick

const QUOTA_FALLBACK_MIN = Number(process.env.GRACE_QUOTA_FALLBACK_MIN || 30);   // no clock in the log → probe again
const QUOTA_MAX_WAIT_MIN = Number(process.env.GRACE_QUOTA_MAX_WAIT_MIN || 360);  // sanity cap: the window is 5 h
const QUOTA_MARK = /(hit your (usage |session )?limit|usage limit reached|limit reached|limit exceeded|out of (usage|credits)|rate.?limit(ed)?)/i;
// «resets 6:10pm (Europe/Moscow)» · «reset at 3pm» · «try again at 18:10» — hour, optional minutes,
// optional am/pm, optional IANA zone. The zone matters: the log speaks the user's zone, not UTC.
const QUOTA_CLOCK = /(?:resets?|reset at|resets at|try again(?: at)?|available again(?: at)?)\D{0,12}?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([A-Za-z]+\/[A-Za-z_\-0-9+]+)\))?/i;

// The next instant whose wall-clock in `tz` is hh:mm. Intl gives the zone's current time without
// a date library; «already passed today» can only mean tomorrow.
function nextClockTs(hour, minute, tz, nowMs) {
  let cur;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz || undefined, hour12: false,
      hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(nowMs));
    const p = {}; for (const x of parts) if (x.type !== "literal") p[x.type] = Number(x.value);
    cur = (p.hour % 24) * 3600 + p.minute * 60 + p.second;
  } catch {
    const d = new Date(nowMs); cur = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  }
  let delta = (hour * 3600 + minute * 60) - cur;
  if (delta <= 0) delta += 24 * 3600;
  return new Date(nowMs + delta * 1000).toISOString();
}
// Read the stop out of a log tail. Returns null when the tail shows no limit at all — that is the
// normal case, and it is what keeps a genuinely broken run on the autoheal/block path.
function parseQuotaStop(text, nowMs) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim()).slice(-40);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!QUOTA_MARK.test(lines[i])) continue;
    const m = QUOTA_CLOCK.exec(lines[i]);
    const raw = lines[i].trim().slice(0, 200);
    const fallback = new Date(nowMs + QUOTA_FALLBACK_MIN * 60000).toISOString();
    if (!m) return { until: fallback, exact: false, raw };
    let h = Number(m[1]) % 24; const min = Number(m[2] || 0), ap = (m[3] || "").toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    const until = nextClockTs(h, min, m[4] || null, nowMs);
    // Further away than a whole window? Then this stamp is a LEFTOVER from an earlier run in the
    // same appended log (its clock rolled to «tomorrow»). Probe soon instead of sleeping a day.
    if (Date.parse(until) - nowMs > QUOTA_MAX_WAIT_MIN * 60000) return { until: fallback, exact: false, raw };
    return { until, exact: true, raw };
  }
  return null;
}
// Only the CURRENT run's output counts: `fromBytes` (recorded at spawn) cuts off everything an
// earlier attempt appended, so a stale limit line cannot pause a card that died for a real reason.
function detectQuotaStop(logFile, nowMs, fromBytes) {
  if (!logFile) return null;
  try {
    const size = fs.statSync(logFile).size;
    const start = Math.max(Number(fromBytes) || 0, Math.max(0, size - 64 * 1024));
    if (size - start <= 0) return null;
    const fd = fs.openSync(logFile, "r");
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, size - start, start);
    fs.closeSync(fd);
    return parseQuotaStop(buf.toString("utf8"), nowMs);
  } catch { return null; }
}

// Is the account-wide window still open? While it is, the board starts nothing new.
const quotaOpen = (board, nowMs) =>
  (board.quota && board.quota.until && Date.parse(board.quota.until) > (nowMs || Date.now())) ? board.quota : null;
const hhmm = (iso) => { try { return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }); } catch { return iso; } };

// One card stops on the clock. Deliberately NOT blockCard(): no error chip, no burnt fuse, and
// the note says what the human actually needs — nothing is lost, and when it comes back.
function pauseForQuota(board, card, stop, how) {
  const ts = new Date().toISOString();
  card.paused = true;
  card.pausedKind = "quota";
  card.pausedReason = "лимит Claude";
  card.pausedUntil = stop.until;
  card.pausedAt = ts;
  card.blockReason = null;
  card.wardenPending = null;
  card.quotaWaits = (card.quotaWaits || 0) + 1;
  card.notes = (card.notes || []).slice(-19);
  card.notes.push({ ts, by: "board", class: "quota", text:
    `Лимит подписки Claude — прогон остановлен на станции «${card.column}»${how ? ` (${how})` : ""}. Это не ошибка: ` +
    `сделанное сохранено, карточка держит своё место и продолжится сама в ${hhmm(stop.until)}` +
    `${stop.exact ? "" : ` (время сброса в логе не указано — доска проверит снова через ${QUOTA_FALLBACK_MIN} мин)`}. ` +
    `Из лога: ${stop.raw}` });
  // Account-wide: keep the LATEST known reset, so a second card cannot shorten the wait.
  if (!board.quota || Date.parse(board.quota.until || 0) < Date.parse(stop.until))
    board.quota = { since: board.quota && quotaOpen(board) ? board.quota.since : ts, until: stop.until,
      exact: stop.exact, raw: stop.raw, cardId: card.id };
  try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts, event: "quota-pause", cardId: card.id,
    column: card.column, until: stop.until, exact: stop.exact, raw: stop.raw }) + "\n"); } catch {}
}

// The clock is up → put everything back on the rails. Runs FIRST in the tick, before the liveness
// watchdog can mistake a just-resumed card for a dead one.
function quotaResumeTick(board, now) {
  let changed = false;
  if (board.quota && !quotaOpen(board, now)) {
    try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: new Date(now).toISOString(), event: "quota-clear", until: board.quota.until }) + "\n"); } catch {}
    board.quota = null; changed = true;
  }
  for (const card of board.cards) {
    if (!card.paused || card.pausedKind !== "quota") continue;
    if (!card.pausedUntil || Date.parse(card.pausedUntil) > now) continue;
    const unpause = () => { card.paused = false; card.pausedKind = null; card.pausedReason = null; card.pausedUntil = null; card.pausedAt = null; };
    // Never dispatched / queued / finished: the scheduler owns it — just lift the pause.
    if (!card.dispatchedAt || card.queued || card.column === TERMINAL || card.column === "backlog") {
      unpause(); changed = true; continue;
    }
    const projectDir = resolveProjectDir(card.project);
    if (!isInsideRoot(projectDir)) { unpause(); changed = true; continue; }
    // WIP=1 still holds after a global stop: if a sibling already took the project's slot,
    // wait for the next tick rather than starting two runs in the same working copy.
    if (hasActiveForProject(board, card.project, card.id)) continue;
    const runDir = path.join(projectDir, ".grace-feature-dev", card.slug);
    const rigor = (card.rigor && card.rigor !== "auto") ? card.rigor : "off";
    const recovery = [
      `RECOVERY-КОНТЕКСТ (пауза по лимиту подписки): ПРЕДЫДУЩИЙ прогон был убит лимитом Claude на станции`,
      `«${card.column}» — это НЕ дефект кода и НЕ причина что-то переделывать. Лимит сброшен, продолжай работу.`,
      `Продолжи с самого дальнего ЗЕЛЁНОГО чекпоинта: "git log --oneline" в ветке "${branchFor(card)}" → коммиты`,
      `"green(<cardId>): …"; при необходимости "git restore --source=<sha> -- <файл>". Фичу заново НЕ начинай.`,
    ].join("\n");
    const { target, launch, kind } = resumeRun(card, projectDir, runDir, rigor, recovery);
    if (launch && launch.launched) {
      unpause();
      card.column = target;
      card.blockReason = null;
      card.lastColumnChangeAt = new Date().toISOString();
      recordLaunch(card, launch, kind);
      card.history.push({ column: target, ts: card.lastColumnChangeAt, via: "quota-resume" });
      card.notes = (card.notes || []).slice(-19);
      card.notes.push({ ts: card.lastColumnChangeAt, by: "board", class: "quota",
        text: `Лимит сброшен — прогон продолжен со станции «${target}» (${kind}), с последнего зелёного чекпоинта.` });
      try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: card.lastColumnChangeAt, event: "quota-resume", cardId: card.id, kind, launch }) + "\n"); } catch {}
    } else {
      // Could not spawn (bin missing, AUTORUN=0…) — stay paused and probe again, never silently die.
      card.pausedUntil = new Date(now + QUOTA_FALLBACK_MIN * 60000).toISOString();
      try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: new Date(now).toISOString(), event: "quota-resume-failed",
        cardId: card.id, error: (launch && launch.error) || (launch && launch.reason) || "spawn failed", retryAt: card.pausedUntil }) + "\n"); } catch {}
    }
    changed = true;
  }
  return changed;
}
// endregion FUNC_quotaStop

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
  } else if (card.askBuildMerged) {
    // B2: a merged card resumes as merged — otherwise a crash before the gate would silently
    // demote the card back to the two-session path it was dispatched to avoid.
    target = "asking"; kind = "ask-build";
    launch = launchAskBuild(card, projectDir, runDir, rigor);
    card.autoArchLaunched = false; card.buildLaunched = false;
  } else {
    target = "asking"; kind = "ask-functional";
    launch = launchAskFunctional(card, projectDir, runDir, rigor);
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
  // S6 · 0) the clock first: cards that were waiting out a subscription limit go back to work
  // before the liveness watchdog gets a chance to read a just-resumed card as a dead one.
  if (quotaResumeTick(board, now)) changed = true;
  // v4 Ш0 · 0b) same reasoning for the brake: a hold the human just lifted must relaunch what it
  // stopped BEFORE the watchdog sees a dispatched card with a dead pid and calls it blocked.
  if (resumeHeld(board)) changed = true;
  for (const card of board.cards) {
    if (!card.dispatchedAt || card.column === TERMINAL || card.column === "blocked") continue;
    // S4 §2.2: a paused card is NOT broken — it is waiting out an external limit. Keep its
    // station and its place in the queue, and take the supervisor's hands off it entirely,
    // otherwise the liveness watchdog would «heal» it straight back into the dead limit.
    if (card.paused) continue;
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
        // S3 §4.1: a `contract: TBD` card publishes the contract it designed as top-level
        // "contract" — mirror it so buildResult exposes it and dependents inherit it.
        if (typeof pip.contract === "string" && pip.contract.trim() && pip.contract !== card.contractResult) {
          card.contractResult = pip.contract.slice(0, MAX_DESC); changed = true;
        }
        // SR: mirror the 5-section release manifest the build writes at `ready` (generalises
        // `migration`) + the archDecisions (an AUTO run's own forks feed result.autoDecisions).
        if (pip.deploy && JSON.stringify(pip.deploy) !== JSON.stringify(card.deploy)) { card.deploy = pip.deploy; changed = true; }
        if (Array.isArray(pip.archDecisions) && pip.archDecisions.length && JSON.stringify(pip.archDecisions) !== JSON.stringify(card.archDecisions || [])) { card.archDecisions = pip.archDecisions; changed = true; }
        // Recompute the "Результат" aggregate from the freshly-mirrored fields (§6). Pure —
        // only writes back (and flags `changed`) when it actually differs.
        { const r = buildResult(card); if (JSON.stringify(r) !== JSON.stringify(card.result || null)) { card.result = r; changed = true; } }
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
              // S3 §4.2: a tail is NOT a fresh statement of work — it inherits the parent's
              // context (sources / contract / req link / write footprint) and starts as a
              // DRAFT: visible on the board, but dispatchBlock() refuses to run it until a
              // human has looked it over. That is what stopped 30 tails/run being auto-work.
              origin: "deferred", draft: true,
              sources: Array.isArray(card.sources) ? card.sources.slice() : [],
              // a parent whose contract was TBD has already published the real one — hand the
              // tail the RESULT, not the placeholder, or the tail would re-design it.
              contract: card.contractResult || card.contract || null,
              files: Array.isArray(card.files) ? card.files.slice() : [],
              outOfScope: null, acceptance: [],
              planId: null, dependsOn: [], autonomy: null,
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
    // B2: while a MERGED session (autonomy=auto) is alive it owns the whole card — it classifies
    // the gates and then builds in the SAME process. Launching anything here would be a second
    // build against the same working tree. If it dies, the guard falls away and the ordinary
    // recovery below/here takes over from the furthest recorded point.
    if (pip && card.column === "asking" && !card.buildLaunched && !(card.askBuildMerged && isAlive(card.runPid))) {
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
      } else if (Array.isArray(pip.archQuestions) && pip.archQuestions.length
                 && !(Array.isArray(pip.archDecisions) && pip.archDecisions.length)
                 && effAutonomy(card) === "auto" && !card.autoResolved) {
        // AUTO (§5.3): the arch run proposed REAL forks but there's no human in AUTO. Auto-pick the
        // recommended option per fork — UNLESS a fork is hard-floor (floor:true from the narrow
        // classifier folded into the arch run), which ALWAYS waits for a human even in AUTO. Any
        // floor fork present → hold the whole gate for the human (card stays in `asking`).
        card.autoResolved = true; // idempotent — evaluate the AUTO gate once per card
        const forks = pip.archQuestions;
        const floorForks = forks.filter((f) => f && (f.floor === true || (Array.isArray(f.options) && f.options.some((o) => o && o.floor))));
        if (floorForks.length) {
          card.autoFloorHeld = floorForks.map((f) => f.q || f.id);
          card.lastColumnChangeAt = new Date().toISOString();
          try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: card.lastColumnChangeAt, event: "auto-floor-hold", cardId: card.id, forks: card.autoFloorHeld }) + "\n"); } catch {}
          changed = true;
        } else {
          const decisions = forks.map((d) => {
            const opt = (Array.isArray(d.options) ? d.options : []).find((o) => o && o.recommended) || (d.options || [])[0] || {};
            return { id: d.id, q: d.q, choice: opt.id || "auto", chosenTitle: opt.title || "авто-выбор", ownText: "AUTO: выбран рекомендованный вариант (обратимо, порог §5.3)" };
          });
          try { pip.archDecisions = decisions; pip.askStage = "done"; pip.column = "implementing"; fs.writeFileSync(pipFile, JSON.stringify(pip, null, 2)); } catch {}
          const launch = launchBuild(card, projectDir, runDir, pip.answers || card.answers || [], decisions, rigor);
          recordLaunch(card, launch, "build");
          card.archDecisions = decisions;
          card.result = buildResult(card); // reflect the AUTO forks in «Результат» immediately (🤖 N)
          card.buildLaunched = true;
          card.column = "implementing";
          card.askStage = "done";
          card.blockReason = null;
          card.lastColumnChangeAt = new Date().toISOString();
          card.history.push({ column: "implementing", ts: card.lastColumnChangeAt, via: "auto-resolve" });
          try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: card.lastColumnChangeAt, event: "auto-resolve", cardId: card.id, autoDecisions: decisions.length, launch }) + "\n"); } catch {}
          changed = true;
        }
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
        // S4 §2.3: remember the death board-wide. Several deaths inside DEATH_WINDOW_MS is the
        // objective signature of a GLOBAL event (subscription limit), not N independent bugs —
        // the warden classifies on this signal, the board only records it.
        if (died) {
          board.recentDeaths = (board.recentDeaths || []).filter((d) => now - (Date.parse(d.ts || "") || 0) < 10 * 60 * 1000);
          board.recentDeaths.push({ ts: new Date().toISOString(), cardId: card.id, column: card.column });
          if (board.recentDeaths.length > 20) board.recentDeaths = board.recentDeaths.slice(-20);
          changed = true;
        }
        const fromCol = card.column;
        const how = stalled ? "ЗАВИС" : "УМЕР";
        // S6: was it the account's 5-hour limit? Then nothing is broken — do NOT spend the
        // autoheal fuse (the relaunch would die inside the same dead window, which is exactly
        // how 3.6 h were lost on 30.07) and do NOT block. Wait out the clock and resume.
        if (died) {
          const stop = detectQuotaStop(card.runLog, now, card.runLogFrom)
            || (quotaOpen(board, now) ? { until: board.quota.until, exact: board.quota.exact, raw: board.quota.raw } : null);
          if (stop) { pauseForQuota(board, card, stop, card.runKind || "run"); changed = true; continue; }
        }
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
            `дальнего ЗЕЛЁНОГО чекпоинта: "git log --oneline" в ветке "${branchFor(card)}" → коммиты`,
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
            escalate(board, card, `${humanTail} Авто-исцеление не помогло — перезапуск не стартовал${launch && launch.error ? ": " + launch.error : ""}. Открой лог и перезапусти вручную.`, { kind: "about-to-block", hint: "stall-real" });
            changed = true;
          }
        } else {
          // second consecutive failure (or an unsafe project path) → escalate. With a warden armed
          // this HANDS THE CARD OVER instead of blocking it — §2.1: the board calls the agent.
          const healed = (card.autoHealCount || 0) >= 1 ? " Авто-исцеление уже применялось и не помогло." : "";
          escalate(board, card, `${humanTail}${healed} Открой лог и перезапусти.`, { kind: "about-to-block", hint: stalled ? "stall-real" : "run-died" });
          changed = true;
        }
      }
    }

    // 3) S4 · the `asking` watchdog. ACTIVE_COLUMNS deliberately excludes `asking` — there the
    //    run has exited and we wait on the HUMAN, so a dead pid is expected. But two states are
    //    not a human wait at all: (a) crash-before-write — the run died before writing its
    //    questions, so the card sits in `asking` with questions:[] and nothing to answer (the
    //    exact dead end of 25.07); (b) the card has sat in `asking` past ASK_STALL_MS. Both go
    //    to the warden, and NEITHER auto-blocks: blocking a card a human may simply not have
    //    answered yet would be a lie.
    if (card.column === "asking" && !card.queued && !card.paused && !card.wardenPending) {
      const cooldownOk = !card.wardenCooldownUntil || now > Date.parse(card.wardenCooldownUntil);
      const sinceMove = now - (Date.parse(card.lastColumnChangeAt || card.dispatchedAt || "") || now);
      const nothingToAnswer = !(card.questions || []).length && !(card.archQuestions || []).length;
      const crashed = nothingToAnswer && card.askStage !== "done" && !isAlive(card.runPid)
        && sinceMove > LIVENESS_GRACE_MS;
      // S6: the same limit can kill an ask-run before it writes its questions. Then the card sits
      // in `asking` with nothing to answer and the human is «needed» for no reason — the exact
      // dead end of 30.07. A read of the log settles it without a model: pause, don't wait on a human.
      if (crashed) {
        const stop = detectQuotaStop(card.runLog, now, card.runLogFrom)
          || (quotaOpen(board, now) ? { until: board.quota.until, exact: board.quota.exact, raw: board.quota.raw } : null);
        if (stop) { pauseForQuota(board, card, stop, "вопросы не записаны"); changed = true; continue; }
      }
      // B2: a MERGED ask+build session stays in `asking` until it writes `implementing` itself —
      // it is working, not waiting on a human, so «стоит в asking > 30 мин» is not a stall for it
      // while its process is alive. Death still reaches the warden through `crashed` above.
      const mergedAlive = card.askBuildMerged && isAlive(card.runPid);
      if (cooldownOk && (crashed || (sinceMove > ASK_STALL_MS && !mergedAlive))) {
        if (fireWardenEvent(board, card, {
          kind: crashed ? "crash-before-write" : "asking-stalled",
          hint: crashed ? "crash-before-write" : "needs-human",
          reason: crashed
            ? `Карточка в «asking» без вопросов: ран умер до того, как записал questions — человеку отвечать не на что.`
            : `Карточка стоит в «asking» больше ${Math.round(ASK_STALL_MS / 60000)} мин.`,
          blockOnTimeout: false,
        })) changed = true;
      }
    }

    // 4) S4 · the warden did not answer. A deferred block is a promise: either the agent acts
    //    within WARDEN_TIMEOUT_MS, or the board keeps its original decision. Never leave a card
    //    hanging on an agent that may not even be installed.
    if (card.wardenPending && now - (Date.parse(card.wardenPending.ts || "") || now) > WARDEN_TIMEOUT_MS) {
      const p = card.wardenPending;
      card.wardenPending = null;
      if (p.blockOnTimeout) {
        blockCard(card, `${p.reason || "Прогон остановлен."} Страж не ответил за ${Math.round(WARDEN_TIMEOUT_MS / 60000)} мин.`);
      } else {
        card.wardenCooldownUntil = new Date(now + ASK_STALL_MS).toISOString();
        try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: new Date().toISOString(), event: "warden-silent", cardId: card.id, kind: p.kind }) + "\n"); } catch {}
      }
      changed = true;
    }
  }
  // WIP=1 scheduler (§5.1/§5.2): after mirroring, feed each now-free project its next
  // queued card. Runs last so it sees this pass's ready/blocked transitions (a card that
  // just reached `ready` frees the slot for its successor in the same tick).
  if (scheduleQueued(board)) changed = true;
  // S5 §5.2: the closing phase runs itself once every stage of a plan is `ready`. Last, so it
  // sees the transitions this pass produced (the final stage reaching `ready` closes the run).
  if (planCloseTick(board)) changed = true;
  // A5: последним — счёт денег и времени по закрытым прогонам. Ничего не запускает и не мержит,
  // только читает транскрипты в отдельном процессе, поэтому стоит после всех переходов.
  if (planMetricsTick(board)) changed = true;
  if (changed) writeBoard(board);
  flushWardenQueue();   // strictly after the write — see the note on WARDEN_QUEUE
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

  // PATCH /api/settings -> board-wide defaults: the global autonomy (§5.3 header toggle) and
  // the v4 Ш0 brake. `hold: "now"` is an ACTION, not a stored position — it SIGTERMs whatever is
  // live and leaves the board in "after-stage", so the queue behind it cannot roll forward.
  if (req.method === "PATCH" && urlPath === "/api/settings") {
    const b = await readBody(req);
    const board = readBoard();
    if (AUTONOMIES.includes(b.autonomy)) { board.autonomy = b.autonomy; GLOBAL_AUTONOMY = b.autonomy; }
    let stopped = null;
    if (b.hold !== undefined) {
      if (b.hold === "now") { stopped = stopNow(board); board.hold = "after-stage"; }
      else if (HOLDS.includes(b.hold)) board.hold = b.hold;
      else return sendJSON(res, 400, { error: `hold must be one of ${HOLDS.join(" | ")} | now` });
      board.holdSetAt = new Date().toISOString();
      try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: board.holdSetAt, event: "hold-set", hold: board.hold, asked: b.hold, stopped }) + "\n"); } catch {}
    }
    writeBoard(board);
    return sendJSON(res, 200, { autonomy: board.autonomy || GLOBAL_AUTONOMY, hold: holdMode(board), stopped });
  }

  // GET /api/projects/:project/policy -> дефолтная политика релиза ЭТОГО проекта (v4 Ш2).
  // Мастер обязан показать ровно то, что применит сервер: .grace/project.md → deploy_policy,
  // иначе человек видит одно, а прогон уезжает с другим.
  const mpol = urlPath.match(/^\/api\/projects\/([^/]+)\/policy$/);
  if (mpol && req.method === "GET") {
    const project = decodeURIComponent(mpol[1]);
    const dir = resolveProjectDir(project);
    if (!isInsideRoot(dir)) return sendJSON(res, 400, { error: "project outside root" });
    return sendJSON(res, 200, { project, policy: policyFor(readBoard(), { project, policy: null }) });
  }

  // GET /api/plans/:planId/manifest -> plan.result.releaseManifest (§6.1): accumulated,
  // per-section, DAG-ordered over the plan's stage cards. Read-only; feeds the plan-rail (S4).
  const mpm = urlPath.match(/^\/api\/plans\/([^/]+)\/manifest$/);
  if (mpm && req.method === "GET") {
    return sendJSON(res, 200, planReleaseManifest(readBoard(), decodeURIComponent(mpm[1])));
  }

  // GET /api/plans -> all plans as rail projections (derived status + manifest)
  if (req.method === "GET" && urlPath === "/api/plans") {
    const board = readBoard();
    return sendJSON(res, 200, { plans: (board.plans || []).map((p) => planView(board, p)) });
  }
  // GET /api/plans/:id -> one plan projection
  const mpone = urlPath.match(/^\/api\/plans\/([^/]+)$/);
  if (mpone && req.method === "GET") {
    const board = readBoard();
    const plan = planById(board, decodeURIComponent(mpone[1]));
    return plan ? sendJSON(res, 200, { plan: planView(board, plan) }) : sendJSON(res, 404, { error: "plan not found" });
  }
  // DELETE /api/plans/:id[?withCards=1] -> archive a plan (hide its rail). Stage cards keep their
  // history/branch/manifest either way; `withCards` additionally marks the run's FINISHED cards
  // archived (v4 Ш3), which is the end of a card's life: 11 of 23 cards on the live board were
  // `ready` leftovers of closed runs. Unfinished cards are never touched — archiving work that is
  // still moving would hide a live run. There is no un-archive: the card stays visible inside its
  // run on the shelf, so nothing is actually lost.
  if (mpone && req.method === "DELETE") {
    const board = readBoard();
    const plan = planById(board, decodeURIComponent(mpone[1]));
    if (!plan) return sendJSON(res, 404, { error: "plan not found" });
    const withCards = new URL(req.url, `http://${HOST}`).searchParams.get("withCards") === "1";
    plan.archived = true;
    const archived = [];
    if (withCards) {
      const ts = new Date().toISOString();
      for (const card of planCards(board, plan)) {
        if (card.column !== TERMINAL || card.archived) continue;
        card.archived = true;
        card.archivedAt = ts;
        archived.push(card.id);
      }
    }
    writeBoard(board);
    try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: new Date().toISOString(), event: "plan-archive", planId: plan.id, cards: archived }) + "\n"); } catch {}
    return sendJSON(res, 200, { ok: true, archived, left: planCards(board, plan).filter((c) => !c.archived).length });
  }

  // POST /api/plans/:id/reopen -> переиграть приёмку проваленного прогона (v4 Ш1.1). Без этой
  // ручки единственный выход из терминального `failed` — собрать прогон заново, а «провален»
  // он мог оказаться из-за лимита подписки, пойманного до того, как лимит начали распознавать.
  const mreopen = urlPath.match(/^\/api\/plans\/([^/]+)\/reopen$/);
  if (mreopen && req.method === "POST") {
    const board = readBoard();
    const plan = planById(board, decodeURIComponent(mreopen[1]));
    if (!plan) return sendJSON(res, 404, { error: "plan not found" });
    if (plan.closeStatus !== "failed") return sendJSON(res, 409, { error: "переиграть можно только проваленный прогон" });
    plan.closeStatus = "verifying";
    plan.closeStep = "acceptance";
    plan.acceptanceRun = null;                 // тик перезапустит приёмку сам
    plan.archived = false;
    if (plan.result) plan.result.acceptance = null;
    planNotice(plan, "Приёмка переигрывается по просьбе человека — прогон снова в закрытии.", "warn");
    writeBoard(board);
    try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: new Date().toISOString(), event: "plan-reopen", planId: plan.id }) + "\n"); } catch {}
    return sendJSON(res, 200, { plan: planView(board, plan) });
  }

  // POST /api/plans/preflight -> S5 summary-gate items for a candidate plan (blockers/floor/forks)
  if (req.method === "POST" && urlPath === "/api/plans/preflight") {
    const b = await readBody(req);
    const project = String(b.project || "").trim();
    if (!project || !isInsideRoot(resolveProjectDir(project))) return sendJSON(res, 400, { error: "valid project required" });
    const cardIds = Array.isArray(b.cardIds) ? b.cardIds.filter((x) => typeof x === "string") : [];
    return sendJSON(res, 200, preflightPlan(readBoard(), project, cardIds));
  }

  // POST /api/plans -> ASSEMBLE a run from existing board cards (v2). Body:
  //   { project, goal?, mode:"ask"|"auto", stages:[ { cardId, dependsOn:[cardId,...] } ] }
  // Wires planId + integration branch + dependsOn onto the chosen cards and enqueues them.
  if (req.method === "POST" && urlPath === "/api/plans") {
    const b = await readBody(req);
    const project = String(b.project || "").trim();
    if (!project) return sendJSON(res, 400, { error: "project is required" });
    if (!isInsideRoot(resolveProjectDir(project))) return sendJSON(res, 400, { error: `project must resolve inside ${PROJECTS_ROOT}` });
    const stages = Array.isArray(b.stages) ? b.stages.filter((s) => s && typeof s.cardId === "string") : [];
    if (!stages.length) return sendJSON(res, 400, { error: "select at least one card" });
    const board = readBoard();
    board.plans = board.plans || [];
    const ids = stages.map((s) => s.cardId);
    if (new Set(ids).size !== ids.length) return sendJSON(res, 400, { error: "duplicate card in stages" });
    const cards = ids.map((id) => board.cards.find((c) => c.id === id));
    if (cards.some((c) => !c)) return sendJSON(res, 400, { error: "unknown card in stages" });
    if (cards.some((c) => c.project !== project)) return sendJSON(res, 400, { error: "a card does not belong to the project" });
    if (cards.some((c) => !PLAN_ASSEMBLABLE.has(c.column) || c.dispatchedAt)) return sendJSON(res, 400, { error: "only undispatched Backlog/To do cards can be assembled" });
    if (cards.some((c) => c.planId)) return sendJSON(res, 400, { error: "a card is already part of a plan" });
    if (stagesHaveCycle(stages)) return sendJSON(res, 400, { error: "dependency cycle between stages — a plan DAG must be acyclic" });
    // S3 §4.2: refuse the whole assembly if any stage's brief is incomplete (or is an unreviewed
    // draft). Letting it in would park that stage in the queue forever — deps never satisfy.
    const badStage = cards.map((c) => ({ c, veto: dispatchBlock(c) })).find((x) => x.veto);
    if (badStage) return sendJSON(res, 400, { error: `этап «${badStage.c.theme || badStage.c.id}»: ${badStage.veto.error}`, cardId: badStage.c.id, missing: badStage.veto.missing });

    const id = crypto.randomUUID().slice(0, 8);
    const integrationBranch = `autodev/plan-${id}`;
    const mode = AUTONOMIES.includes(b.mode) ? b.mode : "ask";
    const idset = new Set(ids);
    // S5: plan-level decisions from the summary gate (deduped, human-made once) — sanitized,
    // then stamped onto every stage so no stage re-asks them (planDecisionsBlock).
    const decisions = (Array.isArray(b.decisions) ? b.decisions : [])
      .filter((d) => d && d.q)
      .map((d) => ({ id: String(d.id || ""), q: String(d.q), choice: String(d.choice || ""), chosenTitle: String(d.chosenTitle || d.a || ""), ownText: d.ownText ? String(d.ownText) : null }));
    // S5 §5.1: the release policy is set AT THE INPUT of the run — what came in the body wins,
    // then .grace/project.md → deploy_policy, then always/manual/off.
    const wanted = (b.policy && typeof b.policy === "object") ? b.policy : {};
    const cfgPol = ((readProjectConfig(resolveProjectDir(project)) || {}).cfg || {}).deploy_policy || {};
    const policy = {
      pr: [wanted.pr, cfgPol.pr, DEPLOY_POLICY_DEFAULT.pr].find((v) => PR_MODES.includes(v)),
      merge: [wanted.merge, cfgPol.merge, DEPLOY_POLICY_DEFAULT.merge].find((v) => MERGE_MODES.includes(v)),
      deploy: [wanted.deploy, cfgPol.deploy, DEPLOY_POLICY_DEFAULT.deploy].find((v) => DEPLOY_MODES.includes(v)),
    };
    // B3′/B7: a run may pin the main thread's model and the build mode. Unset = the board's env
    // default (GRACE_CLAUDE_MODEL / GRACE_BUILD_MODE), which is what makes «тяжёлые доменные
    // карточки на Opus, экраны на Sonnet» a per-run switch instead of a code change.
    const planModel = typeof b.model === "string" && b.model.trim() ? b.model.trim() : null;
    const planBuildMode = BUILD_MODES.includes(b.buildMode) ? b.buildMode : null;
    const plan = {
      id, project, goal: String(b.goal || "").trim().slice(0, MAX_DESC) || null,
      integrationBranch, mode, cardIds: ids, status: "running", policy,
      model: planModel, buildMode: planBuildMode,
      decisions, createdAt: new Date().toISOString(), result: null,
    };
    board.plans.push(plan);
    // Wire every stage, then enqueue it exactly like the launch lever (§5.1): dispatch if the
    // project slot is free AND deps are ready, else queue. WIP=1 + dependsOn serialize the rest.
    for (const s of stages) {
      const card = board.cards.find((c) => c.id === s.cardId);
      card.planId = id;
      card.integrationBranch = integrationBranch;
      card.autonomy = mode;
      // The stage keeps its OWN pin if it has one (a heavy stage on Opus inside a Sonnet run);
      // otherwise it inherits the run's, so the prompt builders only ever look at the card.
      if (!card.model && planModel) card.model = planModel;
      if (!card.buildMode && planBuildMode) card.buildMode = planBuildMode;
      card.planDecisions = decisions; // S5: plan-level gate answers ride the stage seed
      card.dependsOn = Array.isArray(s.dependsOn) ? s.dependsOn.filter((x) => idset.has(x) && x !== s.cardId) : [];
      card.column = "todo";
      if (canDispatchNow(board, card)) {
        dispatchNow(board, card, "plan-launch");
      } else {
        card.queued = true;
        card.queuedAt = new Date().toISOString();
        card.lastColumnChangeAt = card.queuedAt;
        card.history.push({ column: "todo", ts: card.queuedAt, via: "plan-queued" });
      }
    }
    writeBoard(board);
    try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: plan.createdAt, event: "plan-create", planId: id, project, stages: ids.length, mode, policy, branch: integrationBranch }) + "\n"); } catch {}
    return sendJSON(res, 201, { plan: planView(board, plan) });
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
      // Plan Run scaffold (additive; null/[] = single card = today's behaviour, §1).
      // The integration branch / final-PR mechanics land with the Plan entity (S4);
      // here the fields are just carried so a card can belong to a plan and declare its
      // dependency edges + write-footprint. Empty → no DAG gating → immediate dispatch.
      planId: (typeof b.planId === "string" && b.planId.trim()) ? b.planId.trim() : null,
      dependsOn: Array.isArray(b.dependsOn) ? b.dependsOn.filter((x) => typeof x === "string") : [],
      files: Array.isArray(b.files) ? b.files.filter((x) => typeof x === "string") : [],
      autonomy: AUTONOMIES.includes(b.autonomy) ? b.autonomy : null,   // S3: null = inherit the global default (§5.3)
      // B3′/B7: per-card pins. null = inherit the run's, then the board's env default.
      model: (typeof b.model === "string" && b.model.trim()) ? b.model.trim() : null,
      buildMode: BUILD_MODES.includes(b.buildMode) ? b.buildMode : null,
      // S3 · statement of work (§4.1). Defaults = today's card: origin "human" → no checks.
      outOfScope: null, acceptance: [], contract: null, sources: [], origin: "human", draft: false,
      ...normalizeBrief(b),
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

  // ── S4 · warden API (design §2.2). One contract for local and VPS: the agent NEVER writes
  //    board.json, it only calls these. `by:"warden"` marks an agent action — that is what the
  //    5-per-day budget counts (§2.4); a human pressing the same button is never rationed.
  // GET /api/health[?minutes=N] -> cards standing longer than N, with classifier evidence
  if (req.method === "GET" && urlPath === "/api/health") {
    const m = Number(new URL(req.url, `http://${HOST}`).searchParams.get("minutes"));
    return sendJSON(res, 200, healthReport(readBoard(), Number.isFinite(m) && m >= 0 ? m : 0));
  }
  // GET|POST /api/hooks/warden -> read / register the handler the board CALLS on an event
  if (urlPath === "/api/hooks/warden") {
    const board = readBoard();
    if (req.method === "GET") return sendJSON(res, 200, { hook: wardenHook(board), stored: board.wardenHook || null });
    if (req.method === "POST") {
      const b = await readBody(req);
      const kind = ["command", "http", "off"].includes(b.kind) ? b.kind : null;
      if (!kind) return sendJSON(res, 400, { error: "kind must be command | http | off" });
      if (kind === "command" && !String(b.cmd || "").trim()) return sendJSON(res, 400, { error: "cmd is required for kind=command" });
      if (kind === "http" && !String(b.url || "").trim()) return sendJSON(res, 400, { error: "url is required for kind=http" });
      board.wardenHook = kind === "off" ? { kind: "off" }
        : { kind, cmd: b.cmd ? String(b.cmd) : undefined, url: b.url ? String(b.url) : undefined,
            notify: ["desktop", "telegram", "none"].includes(b.notify) ? b.notify : "desktop",
            registeredAt: new Date().toISOString() };
      writeBoard(board);
      try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: new Date().toISOString(), event: "warden-hook", kind }) + "\n"); } catch {}
      return sendJSON(res, 200, { hook: wardenHook(board) });
    }
  }
  // POST /api/tasks/:id/pause  { reason, minutes?, note?, by? } -> paused, place in queue kept
  // POST /api/tasks/:id/resume { by? }
  // POST /api/tasks/:id/note   { text, class?, by? } -> the diagnosis a human reads on the card
  const mw = urlPath.match(/^\/api\/tasks\/([^/]+)\/(pause|resume|note)$/);
  if (mw && req.method === "POST") {
    const b = await readBody(req);
    const board = readBoard();
    const card = board.cards.find((c) => c.id === mw[1]);
    if (!card) return sendJSON(res, 404, { error: "card not found" });
    const action = mw[2], by = b.by === "warden" ? "warden" : "human";
    const budget = wardenBudget(card);
    if (by === "warden" && WARDEN_ACTIONS.has(action) && budget.left <= 0)
      return sendJSON(res, 429, { error: `бюджет стража исчерпан: ${WARDEN_BUDGET} вмешательств на карточку за 24 ч (§2.4) — эскалируй человеку`, budget });
    const ts = new Date().toISOString();
    if (action === "pause") {
      const mins = Number(b.minutes);
      card.paused = true;
      card.pausedReason = String(b.reason || "quota").slice(0, 200);
      card.pausedUntil = Number.isFinite(mins) && mins > 0 ? new Date(Date.now() + mins * 60000).toISOString() : null;
      card.pausedAt = ts;
      // S6: a quota pause is the one pause that ENDS BY ITSELF. Mark it so the tick resumes the
      // card when its clock runs out — a warden that says «quota» gets the auto-resume for free.
      card.pausedKind = (b.kind === "quota" || /quota|лимит/i.test(card.pausedReason)) && card.pausedUntil ? "quota" : null;
      if (b.note) (card.notes = card.notes || []).push({ ts, by, class: card.pausedReason, text: String(b.note).slice(0, 2000) });
      card.wardenPending = null;
    } else if (action === "resume") {
      card.paused = false; card.pausedKind = null; card.pausedReason = null; card.pausedUntil = null; card.pausedAt = null;
      card.wardenPending = null;
    } else {
      if (!String(b.text || "").trim()) return sendJSON(res, 400, { error: "text is required" });
      card.notes = (card.notes || []).slice(-19);
      card.notes.push({ ts, by, class: b.class ? String(b.class).slice(0, 40) : null, text: String(b.text).slice(0, 2000) });
      // a note is DIAGNOSIS, not an intervention: it does not clear wardenPending, so a card the
      // warden could only describe still falls through to the human on timeout (§2.3 needs-human).
    }
    if (by === "warden" && WARDEN_ACTIONS.has(action)) recordWardenAction(card, action);
    writeBoard(board);
    try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts, event: "warden-" + action, cardId: card.id, by, reason: card.pausedReason || null }) + "\n"); } catch {}
    return sendJSON(res, 200, { card, budget: wardenBudget(card) });
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
    const rb = await readBody(req);
    const by = rb.by === "warden" ? "warden" : "human";
    const board = readBoard();
    const card = board.cards.find((c) => c.id === mre[1]);
    if (!card) return sendJSON(res, 404, { error: "card not found" });
    // S4 §2.4: the warden's relaunches are rationed (5/card/24 h) — the human's are not.
    if (by === "warden") {
      const budget = wardenBudget(card);
      if (budget.left <= 0) return sendJSON(res, 429, { error: `бюджет стража исчерпан: ${WARDEN_BUDGET} вмешательств за 24 ч (§2.4) — эскалируй человеку`, budget });
      recordWardenAction(card, "relaunch");
    }
    card.wardenPending = null;   // the agent answered → the deferred block is cancelled
    card.paused = false; card.pausedKind = null; card.pausedReason = null; card.pausedUntil = null;
    // S6: a human pressing «перезапустить» is proof the account works again — close the board-wide
    // quota window too, or the queue stays frozen against a clock that is already wrong.
    if (by === "human" && board.quota) {
      try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: new Date().toISOString(), event: "quota-clear", by: "human", until: board.quota.until }) + "\n"); } catch {}
      board.quota = null;
    }
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
    try { fs.appendFileSync(DISPATCH_LOG, JSON.stringify({ ts: card.lastColumnChangeAt, event: "relaunch", cardId: card.id, kind, by, launch }) + "\n"); } catch {}
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
        // S3 §4.2 · REFUSE at the lever, not silently in the queue: an incomplete agent-authored
        // brief (or an unreviewed deferred draft) must never leave Backlog. A `human` card is
        // never refused here — it has nothing to fill in by design.
        const veto = dispatchBlock(card);
        if (veto) return sendJSON(res, 409, { error: veto.error, missing: veto.missing, draft: !!veto.draft, origin: cardOrigin(card) });
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
    if (b.model !== undefined) card.model = (typeof b.model === "string" && b.model.trim()) ? b.model.trim() : null;
    if (b.buildMode !== undefined) card.buildMode = BUILD_MODES.includes(b.buildMode) ? b.buildMode : null;
    if (b.autonomy !== undefined) card.autonomy = AUTONOMIES.includes(b.autonomy) ? b.autonomy : null; // null = inherit global (§5.3)
    if (Array.isArray(b.files)) card.files = b.files.filter((x) => typeof x === "string");
    Object.assign(card, normalizeBrief(b, card));   // S3 §4.1 — incl. clearing the draft flag
    writeBoard(board);
    return sendJSON(res, 200, { card, blocked: dispatchBlock(card) });
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

// region FUNC_legacyNotice — say it AT UPGRADE TIME, not in a README nobody re-reads
// ## @purpose This version added a statement of work per card (§4) and an automatic closing
// ##   phase per run (§5). Data written by an older version predates both: cards carry no
// ##   `origin`, runs carry no `policy`. Nothing breaks — an old card reads as `origin: human`
// ##   (no checks at all) and an old run is skipped by the closing phase on purpose — but a
// ##   board still holding dozens of finished cards and runs starts the new automation on top
// ##   of a history that was never meant for it. Cheapest honest fix: the server SAYS SO on the
// ##   first boot after the upgrade, with the exact commands, and never nags again once clean.
// ## @invariants Read-only: it looks at board.json and prints. It never deletes anything —
// ##   wiping a board is the human's decision, and it is irreversible without the backup.
function legacyDataNotice() {
  let b;
  try { b = JSON.parse(fs.readFileSync(BOARD_FILE, "utf8")); } catch { return; }
  const cards = (b.cards || []).filter((c) => !c.origin);
  const plans = (b.plans || []).filter((p) => !p.policy);
  if (!cards.length && !plans.length) return;
  const done = cards.filter((c) => c.column === TERMINAL).length;
  console.log("");
  console.log("⚠  На доске есть данные, созданные ПРЕДЫДУЩЕЙ версией:");
  console.log(`   карточек без постановки (origin): ${cards.length}${done ? ` (из них выполненных: ${done})` : ""}`);
  console.log(`   прогонов без политики релиза: ${plans.length}`);
  console.log("   Работать они будут: старая карточка читается как origin=human (проверок нет),");
  console.log("   старый прогон фаза закрытия НЕ трогает. Но новая автоматика — постановка,");
  console.log("   страж, авто-закрытие — рассчитана на чистую доску.");
  console.log("   РЕКОМЕНДУЕТСЯ очистить доску перед работой (сначала бэкап!):");
  console.log("     cp data/board.json data/board.json.bak.pre-wipe");
  console.log("     node -e 'const f=\"data/board.json\",fs=require(\"fs\"),b=JSON.parse(fs.readFileSync(f,\"utf8\"));" +
              "b.cards=[];b.plans=[];fs.writeFileSync(f,JSON.stringify(b,null,2))'");
  console.log("   Подробнее: README → «Upgrading».");
  console.log("");
}
// endregion FUNC_legacyNotice

ensureData();
server.listen(PORT, HOST, () => {
  console.log(`grace-board → http://${HOST}:${PORT}`);
  console.log(`projects root: ${PROJECTS_ROOT}  (override with GRACE_PROJECTS_ROOT)`);
  legacyDataNotice();
  setInterval(syncFromPipeline, 2000); // mirror pipeline phase onto the board
});
