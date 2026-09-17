/*
 * ready-gate.js — what the board checks before it believes a card's «ready».
 *
 * WHY. Over the 20 runs of 02–15.09.2026 (DocsInside2) the card agent chose its own check
 * command every time: some cards ran three test files, some the full suite (165 full pytest
 * runs inside cards), a screen card ran the whole backend. The verifier ran on 3 cards of 66,
 * the reviewer on 7, a coder subagent on none — the main thread wrote 2278 edits itself.
 * Instructions alone did not hold, so the board now checks facts at `ready`:
 *
 *   1. the project's card gate ran on the FINAL commit of the branch and went green
 *      (<runDir>/gate.json written by the project's own gate script, not by the agent);
 *   2. the gate ran at least the tests the selection rule requires — the board recomputes
 *      that list itself with the project's selector; the agent may add tests, never drop them;
 *   3. the roles of grace-feature-dev actually worked: a coder subagent wrote the code, a
 *      verifier and a reviewer looked at it (counted from the session transcripts).
 *
 * A project opts in by declaring `commands.card_gate` and `commands.select_tests` in
 * .grace/project.md. Without them the board behaves as before.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const TRANSCRIPTS = process.env.GRACE_TRANSCRIPTS || path.join(os.homedir(), ".claude", "projects");
const CODERS = new Set(["gfd-coder", "gfd-coder-frontend"]);

function gateConfig(cfg) {
  const cmds = (cfg && cfg.commands) || {};
  const cardGate = typeof cmds.card_gate === "string" && cmds.card_gate.trim() ? cmds.card_gate.trim() : null;
  const selectTests = typeof cmds.select_tests === "string" && cmds.select_tests.trim() ? cmds.select_tests.trim() : null;
  return cardGate && selectTests ? { cardGate, selectTests, runGate: (cmds.run_gate || "").trim() || null } : null;
}

function git(projectDir, args) {
  try { return execFileSync("git", args, { cwd: projectDir, encoding: "utf8", timeout: 20000 }).trim(); }
  catch { return null; }
}

// The commit a card starts from: the tip of the run's integration branch if it already exists,
// otherwise origin/main (the card will branch from it). Recorded at dispatch.
function baseFor(projectDir, branch) {
  git(projectDir, ["fetch", "-q", "origin", "main"]);
  return (branch && git(projectDir, ["rev-parse", "--verify", "-q", branch]))
    || git(projectDir, ["rev-parse", "--verify", "-q", "origin/main"])
    || git(projectDir, ["rev-parse", "HEAD"]);
}

function selectFloor(projectDir, selectCmd, base, head) {
  const out = execFileSync("/bin/sh", ["-lc", `${selectCmd} --base ${base} --head ${head} --json`],
    { cwd: projectDir, encoding: "utf8", timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
  const sel = JSON.parse(out);
  return Array.isArray(sel.floor) ? sel.floor : [];
}

function transcriptDir(projectDir) {
  const mangled = projectDir.replace(/[^a-zA-Z0-9]/g, "-");
  const direct = path.join(TRANSCRIPTS, mangled);
  return fs.existsSync(direct) ? direct : null;
}

// Which subagent roles worked for this card: sessions whose first user prompt names the card's
// run directory and that started after the dispatch; their subagents/*.meta.json carry agentType.
function rolesForCard(projectDir, slug, sinceMs) {
  const dir = transcriptDir(projectDir);
  const roles = {};
  if (!dir) return { roles, sessions: 0, known: false };
  const needle = `.grace-feature-dev/${slug}/`;
  let sessions = 0;
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { return { roles, sessions, known: false }; }
  for (const f of files) {
    const full = path.join(dir, f);
    let st; try { st = fs.statSync(full); } catch { continue; }
    if (st.mtimeMs < sinceMs) continue;
    let head = "";
    try {
      const fd = fs.openSync(full, "r");
      const buf = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      head = buf.slice(0, n).toString("utf8");
    } catch { continue; }
    const firstUser = head.split("\n").find((l) => l.includes('"type":"user"')) || "";
    if (!firstUser.includes(needle)) continue;
    const ts = Date.parse((firstUser.match(/"timestamp":"([^"]+)"/) || [])[1] || "") || st.birthtimeMs;
    if (ts < sinceMs - 5 * 60 * 1000) continue;
    sessions += 1;
    const sub = path.join(dir, f.replace(/\.jsonl$/, ""), "subagents");
    let metas = [];
    try { metas = fs.readdirSync(sub).filter((x) => x.endsWith(".meta.json")); } catch {}
    for (const m of metas) {
      try {
        const t = JSON.parse(fs.readFileSync(path.join(sub, m), "utf8")).agentType;
        if (t) roles[t] = (roles[t] || 0) + 1;
      } catch {}
    }
  }
  return { roles, sessions, known: sessions > 0 };
}

// The verdict. `problems` are written for the agent that will be relaunched to fix them.
function checkReady({ projectDir, runDir, slug, branch, base, dispatchedAt, gate }) {
  const problems = [];
  let report = null;
  try { report = JSON.parse(fs.readFileSync(path.join(runDir, "gate.json"), "utf8")); } catch {}
  const head = git(projectDir, ["rev-parse", "--verify", "-q", branch]);
  if (!report) {
    problems.push(`Нет отчёта проверки ${path.join(runDir, "gate.json")}: перед ready запусти «${gate.cardGate} --card-dir ${path.relative(projectDir, runDir)}».`);
  } else {
    if (!report.ok) problems.push(`Проверка карточки красная: ${(report.steps || []).filter((s) => s.code).map((s) => s.name).join(", ") || report.error || "см. gate.json"}.`);
    if (head && report.head !== head) problems.push(`Проверка шла на коммите ${String(report.head).slice(0, 8)}, а ветка ${branch} сейчас на ${head.slice(0, 8)}: закоммить всё и запусти проверку заново.`);
    if (base && report.base !== base) problems.push(`Проверка сравнивала с базой ${String(report.base).slice(0, 8)}, а карточка начата от ${base.slice(0, 8)}.`);
    if (report.ok && head && report.head === head && base) {
      try {
        const floor = selectFloor(projectDir, gate.selectTests, base, head);
        const ran = new Set(report.ran || []);
        const missing = floor.filter((t) => !ran.has(t));
        if (missing.length) problems.push(`Проверка пропустила обязательные тесты (${missing.length}): ${missing.slice(0, 12).join(", ")}${missing.length > 12 ? " …" : ""}.`);
      } catch (e) {
        problems.push(`Доска не смогла пересчитать обязательный список тестов: ${String(e.message || e).slice(0, 300)}.`);
      }
    }
  }
  const since = Date.parse(dispatchedAt || "") || 0;
  const r = rolesForCard(projectDir, slug, since);
  if (r.known) {
    const coders = Object.entries(r.roles).filter(([k]) => CODERS.has(k)).reduce((s, [, v]) => s + v, 0);
    if (!coders) problems.push("Код написан без кодера: карточки декомпозиции отдаются gfd-coder (экраны — gfd-coder-frontend), главный поток код не пишет.");
    if (!r.roles["gfd-verifier"]) problems.push("Не было проверяющего: после зелёной проверки каждую карточку смотрит gfd-verifier.");
    if (!r.roles["gfd-reviewer"]) problems.push("Не было ревьюера: каждую карточку смотрит хотя бы один gfd-reviewer.");
  }
  return { ok: problems.length === 0, problems, roles: r.roles, sessions: r.sessions, head, report };
}

module.exports = { gateConfig, baseFor, checkReady, rolesForCard, selectFloor };
