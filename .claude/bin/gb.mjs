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
//       release policy of the run (design §5.1). Omitted → .grace/project.md → deploy_policy,
//       then always/manual/off. Red acceptance never deploys; a production stand always
//       requires a human for the deploy, whatever the policy says.
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
  const multi = new Set(["--card", "--stage", "--acceptance", "--source", "--file"]);
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
  const { plan } = await api("POST", "/api/plans", payload);
  console.log(`created plan ${plan.id}  mode=${plan.mode}  branch=${plan.integrationBranch}`);
  const p = plan.policy || {};
  console.log(`policy: pr=${p.pr} merge=${p.merge} deploy=${p.deploy}`);
  console.log(`stages: ${(plan.cardIds || []).join(", ")}`);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const table = { board: cmdBoard, card: cmdCard, preflight: cmdPreflight, run: cmdRun };
if (!table[cmd]) die(`unknown command "${cmd || ""}". Use: board | card | preflight | run`);
table[cmd](args).catch((e) => die(e.stack || String(e)));
