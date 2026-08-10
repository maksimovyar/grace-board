#!/usr/bin/env node
// gb — helper CLI for the local grace-board (Доска). Zero-dep, Node >=18 (global fetch).
// Shared by the graceboard-card and graceboard-run skills. Talks to the board over HTTP.
//
// Usage:
//   gb board [--project X] [--column backlog|todo|...]   list cards (filtered), id · column · theme
//   gb card  --project X --theme "T" [desc opts] [--rigor off|grace] [--autonomy ask|auto]
//            [--design-link URL] [--req-link URL] [--requirements "..."]
//            [--origin human|skill|agent] [--out-of-scope "..." | --out-of-scope-file PATH]
//            [--contract "..." | --contract-file PATH | --contract TBD]
//            [--acceptance "пункт" ...] [--source "источник" ...] [--file path/to/x.ts ...]
//       desc opts (pick one): --desc "text" | --desc-file PATH | --desc-stdin
//       origin skill/agent ⇒ the board REQUIRES out-of-scope + acceptance + sources + contract
//       (design §4.2) and refuses to dispatch the card otherwise.
//   gb preflight --project X --card ID [--card ID ...]
//   gb run   --project X [--goal "G"] [--mode ask|auto] --stage ID [--stage ID:dep1,dep2 ...]
//            [--pr always|never] [--merge manual|auto] [--deploy off|after-merge|ask]
//            [--decision "вопрос=ответ" ...] [--loops N] [--log-mb N]
//       release policy of the run (design §5.1). Omitted → .grace/project.md → deploy_policy,
//       then always/manual/off. Red acceptance never deploys; a production stand always
//       requires a human for the deploy, whatever the policy says.
//       --decision — решения сводного гейта (Ш7): доска штампует их на КАЖДЫЙ этап блоком
//       «СОБЛЮДАЙ, НЕ переспрашивай», и этап не выносит их снова в вопросы. Повторяемый флаг.
//       --loops / --log-mb — порог предохранителя (A1.1) на этот прогон; без них — константы доски.
//
//   ── сопровождение запущенного (A1.5 · О4.1) ────────────────────────────────
//   gb plans   [--project X] [--json]        прогоны: статус · стадия релиза · возраст · PR
//   gb answers --card ID                     показать вопросы карточки
//   gb answers --card ID --answer "..." ...  ответить на функциональный гейт (по порядку вопросов)
//   gb answers --card ID --decision d1=o2 ...  ответить на архитектурный гейт (id вопроса = id опции)
//   gb note    --card ID --text "..." [--class env-broken]
//   gb relaunch --card ID                    перезапуск с самой дальней достигнутой точки
//
// Env: GRACE_BOARD_PORT (default 4317). Host is always 127.0.0.1 (board is local-only).

import fs from "node:fs";

const PORT = Number(process.env.GRACE_BOARD_PORT) || 4317;
const BASE = `http://127.0.0.1:${PORT}`;
const MAX_DESC = 50000; // mirrors server.js MAX_DESC — used only to warn on truncation

function die(msg) { console.error("gb: " + msg); process.exit(1); }

// Minimal flag parser. Repeatable flags (--card, --stage) collect into arrays.
function parseArgs(argv) {
  const out = { _: [] };
  const multi = new Set(["--card", "--stage", "--acceptance", "--source", "--file", "--decision", "--answer"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const bool = a === "--desc-stdin";
      const val = bool ? true : argv[++i];
      if (val === undefined) die(`flag ${a} needs a value`);
      if (multi.has(a)) (out[a] = out[a] || []).push(val);
      else out[a] = val;
    } else out._.push(a);
  }
  return out;
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    die(`cannot reach board at ${BASE} — is it running? (cd ~/Projects/grace-board && node server.js)\n     ${e.message}`);
  }
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) die(`${method} ${path} -> HTTP ${res.status}: ${typeof data === "object" ? JSON.stringify(data) : data}`);
  return data;
}

function readDesc(args) {
  if (args["--desc-stdin"]) return fs.readFileSync(0, "utf8");
  if (args["--desc-file"]) return fs.readFileSync(args["--desc-file"], "utf8");
  if (args["--desc"] !== undefined) return args["--desc"];
  return undefined;
}

// `project` is stored as the client sent it — some cards carry a folder name, most carry an
// absolute path. Matching on the raw string hid whole projects from the board listing, so the
// planning skill saw "(no cards)" and re-created tails that were already there. Match on both.
function sameProject(stored, want) {
  if (!stored) return false;
  return stored === want || stored.endsWith("/" + want) || stored.split("/").pop() === want;
}

async function cmdBoard(args) {
  const board = await api("GET", "/api/board");
  const all = board.cards || [];
  let cards = all;
  if (args["--project"]) cards = cards.filter((c) => sameProject(c.project, args["--project"]));
  if (args["--column"]) cards = cards.filter((c) => c.column === args["--column"]);
  if (!cards.length) {
    console.log("(no cards)");
    // Say WHY it is empty: a typo in --project must not read as "this project is clean".
    if (all.length && args["--project"]) {
      const known = [...new Set(all.map((c) => c.project))].sort();
      console.error(`gb: no card matched --project "${args["--project"]}". On the board: ${known.join(", ")}`);
    }
    return;
  }
  for (const c of cards) {
    const plan = c.planId ? ` plan=${c.planId}` : "";
    console.log(`${c.id}  [${c.column}]${plan}  ${c.theme}`);
  }
  console.log(`\n${cards.length} card(s).`);
}

async function cmdCard(args) {
  const project = args["--project"] || die("--project is required");
  const theme = args["--theme"] || die("--theme is required");
  const description = readDesc(args);
  if (description !== undefined && description.length > MAX_DESC)
    console.error(`gb: warning — description is ${description.length} chars, server caps at ${MAX_DESC}; the tail will be dropped SILENTLY.`);
  const payload = { project, theme };
  if (description !== undefined) payload.description = description;
  if (args["--requirements"]) payload.requirements = args["--requirements"];
  if (args["--design-link"]) payload.designLink = args["--design-link"];
  if (args["--req-link"]) payload.requirementsLink = args["--req-link"];
  if (args["--rigor"]) payload.rigor = args["--rigor"];
  if (args["--autonomy"]) payload.autonomy = args["--autonomy"];
  // statement of work (design §4.1) — required for --origin skill|agent
  if (args["--origin"]) payload.origin = args["--origin"];
  const oos = args["--out-of-scope-file"] ? fs.readFileSync(args["--out-of-scope-file"], "utf8") : args["--out-of-scope"];
  if (oos !== undefined) payload.outOfScope = oos;
  const contract = args["--contract-file"] ? fs.readFileSync(args["--contract-file"], "utf8") : args["--contract"];
  if (contract !== undefined) payload.contract = contract;
  if (args["--acceptance"]) payload.acceptance = args["--acceptance"];
  if (args["--source"]) payload.sources = args["--source"];
  if (args["--file"]) payload.files = args["--file"];
  const { card } = await api("POST", "/api/tasks", payload);
  const sent = description ? description.length : 0;
  const got = card.description ? card.description.length : 0;
  console.log(`created card ${card.id}  [${card.column}]  ${card.theme}`);
  console.log(`description: sent ${sent} chars, stored ${got} chars` + (sent === got ? "  ✓" : "  ✗ TRUNCATED"));
  // Say it NOW, not at dispatch: an agent-authored card with a gap will be refused by the lever.
  const strict = card.origin === "skill" || card.origin === "agent";
  const gaps = strict ? [["outOfScope", card.outOfScope], ["acceptance", (card.acceptance || []).length],
    ["sources", (card.sources || []).length], ["contract", card.contract]].filter(([, v]) => !v).map(([k]) => k) : [];
  if (gaps.length) { console.error(`gb: origin=${card.origin} — доска ОТКАЖЕТ в диспатче: не заполнено ${gaps.join(", ")}`); process.exitCode = 3; }
  if (sent !== got) process.exitCode = 2;
}

async function cmdPreflight(args) {
  const project = args["--project"] || die("--project is required");
  const cardIds = args["--card"] || die("at least one --card ID is required");
  const r = await api("POST", "/api/plans/preflight", { project, cardIds });
  console.log(JSON.stringify(r, null, 2));
}

async function cmdRun(args) {
  const project = args["--project"] || die("--project is required");
  const stageArgs = args["--stage"] || die("at least one --stage ID[:dep1,dep2] is required");
  const stages = stageArgs.map((s) => {
    const [cardId, deps] = s.split(":");
    return { cardId, dependsOn: deps ? deps.split(",").filter(Boolean) : [] };
  });
  const payload = { project, stages };
  if (args["--goal"]) payload.goal = args["--goal"];
  payload.mode = args["--mode"] === "auto" ? "auto" : "ask";
  const policy = {};
  if (args["--pr"]) policy.pr = args["--pr"];
  if (args["--merge"]) policy.merge = args["--merge"];
  if (args["--deploy"]) policy.deploy = args["--deploy"];
  if (Object.keys(policy).length) payload.policy = policy;
  // О4.1 · решения сводного гейта. Серверная механика была живой целиком (санитайз → штамп на
  // карточки → блок «СОБЛЮДАЙ, НЕ переспрашивай» в четырёх промптах), но отправлять их было
  // нечем: во ВСЕХ прошедших планах стояло decisions: 0. Симуляция вопросов на Ш4 делалась и
  // выбрасывалась, а потом те же вопросы задавались заново в рантайме — часами простоя.
  const decisions = parseDecisions(args["--decision"], "--decision");
  if (decisions.length) payload.decisions = decisions;
  // A1.1 · порог предохранителя на прогон (покарточного уровня нет)
  const loopBudget = {};
  if (args["--loops"]) loopBudget.loops = Number(args["--loops"]);
  if (args["--log-mb"]) loopBudget.logMB = Number(args["--log-mb"]);
  if (Object.keys(loopBudget).length) payload.loopBudget = loopBudget;
  const { plan } = await api("POST", "/api/plans", payload);
  console.log(`created plan ${plan.id}  mode=${plan.mode}  branch=${plan.integrationBranch}`);
  const p = plan.policy || {};
  console.log(`policy: pr=${p.pr} merge=${p.merge} deploy=${p.deploy}`);
  console.log(`decisions: ${(plan.decisions || []).length}${(plan.decisions || []).length ? "" : "  (гейт Ш7 ничего не передал — этапы спросят это заново)"}`);
  if (plan.loopBudget) console.log(`loop budget: loops=${plan.loopBudget.loops ?? "по умолчанию"} logMB=${plan.loopBudget.logMB ?? "по умолчанию"}`);
  console.log(`stages: ${(plan.cardIds || []).join(", ")}`);
}

// "вопрос=ответ" → форма, которую доска штампует на этапы. Разделитель — ПЕРВЫЙ `=`: в ответе
// он встречается постоянно («deploy=after-merge»), в вопросе — почти никогда.
function parseDecisions(list, flag) {
  return (list || []).map((s, i) => {
    const at = String(s).indexOf("=");
    if (at <= 0) die(`${flag} ожидает "вопрос=ответ", получено: ${s}`);
    const q = String(s).slice(0, at).trim(), a = String(s).slice(at + 1).trim();
    if (!q || !a) die(`${flag} ожидает "вопрос=ответ", получено: ${s}`);
    return { id: `d${i + 1}`, q, choice: "human", chosenTitle: a };
  });
}

// ── сопровождение запущенного (A1.5) ─────────────────────────────────────────
// Раньше всё это жило только curl-рецептами в скилле Гермеса, и Mac-сторона была слепа:
// увидеть, на чём стоит партия, или ответить на вопрос карточки без ручного curl было нечем.
const relWord = (p) => {
  const r = p.release;
  if (!r) return p.status || "—";
  const age = r.since ? ` · ${r.approx ? "≈" : ""}${Math.round((Date.now() - Date.parse(r.since)) / 60000)} мин` : "";
  return `${r.state}${r.waitingHuman ? " ⟵ ход человека" : ""}${age}${r.stale ? " ⚠ висит" : ""}`;
};
async function cmdPlans(args) {
  const { plans } = await api("GET", "/api/plans");
  let list = plans || [];
  if (args["--project"]) list = list.filter((p) => sameProject(p.project, args["--project"]));
  if (args["--json"]) return void console.log(JSON.stringify(list, null, 2));
  if (!list.length) return void console.log("(no plans)");
  for (const p of list) {
    const pr = ((p.result || {}).pr || {}).url;
    console.log(`${p.id}  [${p.status}]  ${relWord(p)}`);
    console.log(`      ${p.goal || "(без цели)"}  ⎇ ${p.integrationBranch || "—"}${pr ? "  " + pr : ""}`);
  }
  console.log(`\n${list.length} plan(s).`);
}

async function cmdAnswers(args) {
  const id = args["--card"] ? args["--card"][0] : die("--card ID is required");
  const board = await api("GET", "/api/board");
  const card = (board.cards || []).find((c) => c.id === id) || die(`card ${id} not found`);
  const answers = args["--answer"] || [];
  const decisions = args["--decision"] || [];
  if (!answers.length && !decisions.length) {
    console.log(`${card.id}  [${card.column}]  ${card.theme}`);
    console.log(`askStage: ${card.askStage || "—"}`);
    (card.questions || []).forEach((q, i) => console.log(`  Q${i + 1}. ${typeof q === "string" ? q : q.q}`));
    (card.archQuestions || []).forEach((d) => {
      console.log(`  ${d.id}. ${d.q}${d.floor ? "  [жёсткий пол — решает только человек]" : ""}`);
      (d.options || []).forEach((o) => console.log(`       ${o.id}: ${o.title}${o.recommended ? "  ←рекомендовано" : ""}`));
    });
    if (!(card.questions || []).length && !(card.archQuestions || []).length) console.log("  (вопросов нет)");
    return;
  }
  const body = decisions.length
    ? { stage: "architecture", answers: decisions.map((s) => {
        const at = String(s).indexOf("=");
        if (at <= 0) die(`--decision ожидает "idВопроса=idОпции", получено: ${s}`);
        return { decisionId: String(s).slice(0, at).trim(), choice: String(s).slice(at + 1).trim() };
      }) }
    : { stage: "functional", answers };
  const r = await api("POST", `/api/tasks/${id}/answers`, body);
  console.log(`ответы приняты (${body.stage}) · карточка теперь [${r.card.column}]` +
    (r.launch && r.launch.launched ? `, запущен ${r.launch.pid ? "pid " + r.launch.pid : "прогон"}` : ", прогон не стартовал"));
}

async function cmdNote(args) {
  const id = args["--card"] ? args["--card"][0] : die("--card ID is required");
  const text = args["--text"] || die("--text is required");
  const body = { text };
  if (args["--class"]) body.class = args["--class"];
  await api("POST", `/api/tasks/${id}/note`, body);
  console.log(`заметка записана на карточку ${id}`);
}

async function cmdRelaunch(args) {
  const id = args["--card"] ? args["--card"][0] : die("--card ID is required");
  const r = await api("POST", `/api/tasks/${id}/relaunch`, {});
  const l = r.launch || {};
  console.log(`перезапуск ${id}: станция [${r.card.column}]` + (l.launched ? `, pid ${l.pid}` : `, НЕ стартовал${l.error ? ": " + l.error : ""}`));
  if (!l.launched) process.exitCode = 2;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const table = { board: cmdBoard, card: cmdCard, preflight: cmdPreflight, run: cmdRun,
  plans: cmdPlans, answers: cmdAnswers, note: cmdNote, relaunch: cmdRelaunch };
if (!table[cmd]) die(`unknown command "${cmd || ""}". Use: board | card | preflight | run | plans | answers | note | relaunch`);
table[cmd](args).catch((e) => die(e.stack || String(e)));
