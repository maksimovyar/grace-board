#!/usr/bin/env node
/*
 * plan-metrics.js — во что обошёлся прогон: токены, деньги, время, станции.
 *
 * ЗАЧЕМ. До этого стоимость и время прогона восстанавливались только ручным разбором
 * 77 МБ транскриптов из ~/.claude/projects/**. Для регулярного контроля это негодно:
 * измерение, которое делается раз в неделю руками, не измерение. Скрипт делает то же
 * самое машинно и кладёт результат в plan.result.metrics — где его читают и доска,
 * и Гермес, и человек.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ ПРОЦЕСС, А НЕ ФУНКЦИЯ В server.js. Разбор транскриптов — это
 * десятки мегабайт построчного JSON.parse. В тике доски (2 с) это заморозило бы и
 * очередь, и UI. Доска порождает этот скрипт ровно как любой другой шаг закрытия
 * (spawnStep) и читает готовый файл следующим тиком.
 *
 * КАК СОПОСТАВЛЯЮТСЯ СЕССИИ И ПРОГОН. Транскрипт не знает ни про доску, ни про план.
 * Зато первая пользовательская реплика сессии — это ПРОМПТ ДОСКИ, а в нём всегда есть
 * абсолютный путь `<project>/.grace-feature-dev/<slug>/board.json` (для приёмки —
 * `.grace-feature-dev/plan-<id>/`). Отсюда правило сопоставления: сессия принадлежит
 * прогону, если её первая реплика содержит слаг одного из этапов прогона (или каталог
 * плана) И её старт попадает в окно прогона. Второе условие обязательно: слаг живёт в
 * репозитории и всплывает в чужих сессиях (разборы, доработки) — без окна метрики
 * прогона выросли бы за счёт соседей.
 *
 * ЧТО СЧИТАЕТСЯ ЧЕСТНО, А ЧТО ПРИБЛИЖЁННО (важно не выдавать второе за первое):
 *   • токены и деньги — точно: суммы message.usage по модели, дедуп по message.id;
 *   • wallSeconds — точно: от первого dispatch этапа до конца закрытия;
 *   • activeSeconds — сумма «карточка от dispatch до ready» минус окна квоты. При WIP=1
 *     карточки не накладываются, поэтому это и есть работа агентов;
 *   • stations — сумма длительностей станций по history карточек;
 *   • loops — возвраты verifying/reviewing → implementing (то, что дороже всего);
 *   • stalls — autoheal + blocked + warden-silent по карточкам прогона.
 *
 * Запуск: node lib/plan-metrics.js --plan <id> [--out file] [--board …] [--dispatch …]
 *                                  [--projects-root …] [--transcripts …] [--prices …] [--print]
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");

// ── аргументы ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf("--" + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const ROOT = path.resolve(__dirname, "..");
const PLAN_ID = arg("plan");
const BOARD_FILE = arg("board", path.join(ROOT, "data", "board.json"));
const DISPATCH_LOG = arg("dispatch", path.join(ROOT, "data", "dispatch-log.ndjson"));
const PROJECTS_ROOT = arg("projects-root", process.env.GRACE_PROJECTS_ROOT || path.join(os.homedir(), "Projects"));
const TRANSCRIPTS = arg("transcripts", path.join(os.homedir(), ".claude", "projects"));
const PRICES_FILE = arg("prices", process.env.GRACE_PRICES || path.join(ROOT, "config", "model-prices.json"));
const OUT = arg("out", null);
if (!PLAN_ID) { console.error("нужен --plan <id>"); process.exit(2); }

const ZERO = () => ({ in: 0, out: 0, cacheWrite: 0, cacheRead: 0, calls: 0 });
const addUsage = (a, u) => {
  a.in += u.input_tokens || 0;
  a.out += u.output_tokens || 0;
  a.cacheWrite += u.cache_creation_input_tokens || 0;
  a.cacheRead += u.cache_read_input_tokens || 0;
  a.calls += 1;
  return a;
};
const ms = (s) => Date.parse(s || "") || 0;

// ── прайс ────────────────────────────────────────────────────────────────────
function loadPrices() {
  try { return JSON.parse(fs.readFileSync(PRICES_FILE, "utf8")); }
  catch { return { perMillion: {}, match: [], default: null }; }
}
const PRICES = loadPrices();
function priceKey(model) {
  const m = String(model || "");
  if (PRICES.perMillion && PRICES.perMillion[m]) return m;
  for (const [needle, key] of (PRICES.match || [])) if (m.includes(needle)) return key;
  return PRICES.default || null;
}
function costOf(model, u) {
  const p = (PRICES.perMillion || {})[priceKey(model)];
  if (!p) return 0;
  return (u.in * p.in + u.out * p.out + u.cacheWrite * p.cacheWrite + u.cacheRead * p.cacheRead) / 1e6;
}

// ── план и его карточки ──────────────────────────────────────────────────────
// board.json пишет живая доска. Даже с атомарной записью (tmp+rename) читатель может
// открыть файл ровно в момент подмены — поэтому читаем с несколькими попытками, а не
// падаем: первый же запуск метрик умер именно на полупрочитанном JSON.
function readBoardFile(file, tries = 5) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) { last = e; try { require("child_process").execFileSync("sleep", ["0.4"]); } catch {} }
  }
  throw last;
}
const board = readBoardFile(BOARD_FILE);
const plan = (board.plans || []).find((p) => p.id === PLAN_ID);
if (!plan) { console.error("план не найден: " + PLAN_ID); process.exit(3); }
const cards = (plan.cardIds || []).map((id) => (board.cards || []).find((c) => c.id === id)).filter(Boolean);
const projectDir = path.resolve(path.isAbsolute(plan.project) ? plan.project : path.join(PROJECTS_ROOT, plan.project));

// ── окно прогона ─────────────────────────────────────────────────────────────
const dispatchTimes = cards.map((c) => ms(c.dispatchedAt)).filter(Boolean);
const historyTimes = cards.flatMap((c) => (c.history || []).map((h) => ms(h.ts)).filter(Boolean));
const closeTimes = [
  ms((plan.result || {}).closingStartedAt),
  ms(((plan.result || {}).acceptance || {}).ranAt),
  ms(((plan.result || {}).ci || {}).checkedAt),
  ms((plan.result || {}).notice && plan.result.notice.ts),
].filter(Boolean);
const from = Math.min(...(dispatchTimes.length ? dispatchTimes : historyTimes.length ? historyTimes : [Date.now()]));
const to = Math.max(...[...historyTimes, ...closeTimes, from]);

// ── окна простоя по квоте ────────────────────────────────────────────────────
// Считаются ДО работы карточек, потому что вычитаются из КАЖДОГО перекрывающегося
// интервала карточки по отдельности. Вычитать общую сумму из общей суммы нельзя:
// прогон cedb1687 так получил activeSeconds = 0 при 88 минутах реальной работы —
// окно квоты накрывало его закрытие, а не его карточки.
const quotaWindows = [];
try {
  let openFrom = null;
  for (const line of fs.readFileSync(DISPATCH_LOG, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const t = ms(e.ts);
    if (!t) continue;
    if (["quota-pause", "plan-quota-hold"].includes(e.event) && openFrom === null) openFrom = t;
    else if (e.event === "quota-clear" && openFrom !== null) { quotaWindows.push([openFrom, t]); openFrom = null; }
  }
  if (openFrom !== null) quotaWindows.push([openFrom, to]);      // окно, которое ещё не закрылось
} catch { /* журнала нет */ }
const overlapSec = (a, b) => quotaWindows.reduce((s, [qa, qb]) => {
  const lo = Math.max(a, qa), hi = Math.min(b, qb);
  return s + (hi > lo ? (hi - lo) / 1000 : 0);
}, 0);

// ── станции, циклы, простои ──────────────────────────────────────────────────
const STATIONS = ["todo", "asking", "implementing", "verifying", "reviewing", "blocked"];
const stations = Object.fromEntries(STATIONS.map((s) => [s, 0]));
let loops = 0, activeSeconds = 0;
for (const c of cards) {
  const h = (c.history || []).filter((x) => x && x.ts && x.column).sort((a, b) => ms(a.ts) - ms(b.ts));
  const startedAt = ms(c.dispatchedAt);
  const endAt = (() => {
    const ready = h.find((x) => x.column === "ready");
    return ready ? ms(ready.ts) : to;
  })();
  if (startedAt) activeSeconds += Math.max(0, (endAt - startedAt) / 1000 - overlapSec(startedAt, endAt));
  let sawGate = false;
  for (let i = 0; i < h.length; i++) {
    const col = h[i].column, t0 = ms(h[i].ts), t1 = i + 1 < h.length ? ms(h[i + 1].ts) : endAt;
    if (STATIONS.includes(col) && t0 && t1 > t0) stations[col] += (t1 - t0) / 1000;
    if (col === "verifying" || col === "reviewing") sawGate = true;
    else if (col === "implementing" && sawGate) { loops += 1; sawGate = false; }   // возврат на доработку
  }
}

// ── журнал доски: квота и срывы ──────────────────────────────────────────────
const cardIds = new Set(cards.map((c) => c.id));
const quotaSeconds = overlapSec(from, to);          // простой по квоте внутри окна прогона
let stalls = 0;
try {
  for (const line of fs.readFileSync(DISPATCH_LOG, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const t = ms(e.ts);
    if (!t || t < from || t > to) continue;
    if (["autoheal", "blocked", "warden-silent", "hold-stop"].includes(e.event) && (!e.cardId || cardIds.has(e.cardId))) stalls += 1;
  }
} catch { /* журнала нет — это не повод не отдать остальные метрики */ }

// ── транскрипты ──────────────────────────────────────────────────────────────
function transcriptDir() {
  const mangled = projectDir.replace(/[^a-zA-Z0-9]/g, "-");
  const direct = path.join(TRANSCRIPTS, mangled);
  if (fs.existsSync(direct)) return direct;
  try {   // запасной путь: правило мангления менялось между версиями CLI
    const base = path.basename(projectDir);
    const hit = fs.readdirSync(TRANSCRIPTS).find((d) => d.endsWith("-" + base) || d.endsWith(base));
    if (hit) return path.join(TRANSCRIPTS, hit);
  } catch {}
  return null;
}
const needles = [
  ...cards.map((c) => `.grace-feature-dev/${c.slug}/`),
  `.grace-feature-dev/plan-${plan.id}`,
];
const firstText = (msg) => {
  const c = msg && msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (x && typeof x.text === "string" ? x.text : "")).join("\n");
  return "";
};

// Субагенты пишутся НЕ в файл сессии: рядом с <sessionId>.jsonl лежит каталог <sessionId>/
// subagents/agent-*.jsonl. Без него счёт занижен ровно на всю работу gfd-reviewer/verifier —
// по этой партии это $26 из $416 (6%), и именно та часть, которую хотят увести на Sonnet.
async function scanSubagents(sessionFile, byModel, seen) {
  const dir = sessionFile.replace(/\.jsonl$/, "");
  let files = [];
  try { files = fs.readdirSync(path.join(dir, "subagents")).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, "subagents", f)); }
  catch { return; }
  for (const f of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(f, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      const m = d.message;
      if (!m || !m.usage || String(m.model || "") === "<synthetic>") continue;
      const id = m.id || `${d.uuid || ""}`;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      byModel[m.model || "unknown"] = addUsage(byModel[m.model || "unknown"] || ZERO(), m.usage);
    }
  }
}

async function scanSession(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  const byModel = {};
  const seen = new Set();
  let belongs = false, decided = false, startedAt = 0, sessionId = null;
  for await (const line of rl) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (!startedAt) startedAt = ms(d.timestamp);
    if (!sessionId && d.sessionId) sessionId = d.sessionId;
    if (!decided && d.type === "user") {
      const text = firstText(d.message) || (typeof d.content === "string" ? d.content : "");
      if (text) {
        belongs = needles.some((n) => text.includes(n));
        decided = true;
        // окно: сессия прогона стартует не раньше первого dispatch и не позже конца закрытия
        const t = startedAt || ms(d.timestamp);
        if (belongs && !(t >= from - 5 * 60 * 1000 && t <= to + 30 * 60 * 1000)) belongs = false;
        if (!belongs) { rl.close(); return null; }
      }
    }
    if (!belongs) continue;
    const m = d.message;
    if (!m || !m.usage) continue;
    // «<synthetic>» — это не вызов модели, а заглушка харнесса (например, текст ошибки API,
    // поданный как сообщение ассистента). У неё есть usage, но за неё никто не платил;
    // прайсить её по дефолтной модели значило бы приписать прогону чужие деньги.
    if (String(m.model || "") === "<synthetic>") continue;
    const id = m.id || `${d.uuid || ""}`;
    if (id && seen.has(id)) continue;                       // дедуп: resume дописывает те же сообщения
    if (id) seen.add(id);
    const model = m.model || "unknown";
    byModel[model] = addUsage(byModel[model] || ZERO(), m.usage);
  }
  if (!belongs) return null;
  await scanSubagents(file, byModel, seen);
  return { file: path.basename(file), sessionId, startedAt, byModel };
}

(async () => {
  const dir = transcriptDir();
  const sessions = [];
  if (dir) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f))
        .filter((f) => { try { return fs.statSync(f).mtimeMs >= from - 60 * 60 * 1000; } catch { return false; } });
    } catch {}
    for (const f of files) {
      try { const r = await scanSession(f); if (r) sessions.push(r); } catch { /* один битый транскрипт не рушит отчёт */ }
    }
  }
  const byModel = {};
  for (const s of sessions) for (const [model, u] of Object.entries(s.byModel)) {
    const acc = byModel[model] || (byModel[model] = ZERO());
    for (const k of ["in", "out", "cacheWrite", "cacheRead", "calls"]) acc[k] += u[k];
  }
  const tokens = ZERO();
  let costUsd = 0;
  const byModelOut = {};
  for (const [model, u] of Object.entries(byModel)) {
    for (const k of ["in", "out", "cacheWrite", "cacheRead", "calls"]) tokens[k] += u[k];
    const c = costOf(model, u);
    costUsd += c;
    byModelOut[model] = { ...u, costUsd: Math.round(c * 100) / 100 };
  }
  const metrics = {
    planId: plan.id,
    computedAt: new Date().toISOString(),
    tokens: { in: tokens.in, out: tokens.out, cacheWrite: tokens.cacheWrite, cacheRead: tokens.cacheRead },
    calls: tokens.calls,
    costUsd: Math.round(costUsd * 100) / 100,
    byModel: byModelOut,
    sessions: sessions.length,
    sessionFiles: sessions.map((s) => s.sessionId || s.file),
    activeSeconds: Math.round(activeSeconds),
    wallSeconds: Math.round(Math.max(0, (to - from) / 1000)),
    quotaSeconds: Math.round(quotaSeconds),
    stations: Object.fromEntries(Object.entries(stations).map(([k, v]) => [k, Math.round(v)])),
    loops, stalls,
    window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    transcriptDir: dir,
    priced: Object.keys(byModelOut).every((m) => priceKey(m)),
  };
  const text = JSON.stringify(metrics, null, 2);
  if (OUT) fs.writeFileSync(OUT, text);
  if (!OUT || argv.includes("--print")) console.log(text);
})();
