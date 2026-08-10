#!/usr/bin/env node
// grace-lint — детерминированная проверка GRACE-разметки (A3.2 · С2).
//
// ЗАЧЕМ. При `rigor: grace` && `mode != inline` один из ревьюеров ВСЕГДА получал фокус
// «Conventions / GRACE markup» — не по жребию, а обязательно (SKILL §5). За партию это 45
// ревьюерских сессий, и заметная их часть уходила на то, что проверяется grep'ом: есть ли в
// файле MODULE_CONTRACT, GREP_SUMMARY, STRUCTURE и хоть одна строка [IMP:9] в логах.
// Модель для «есть ли в файле подстрока» не нужна. Ревьюеры остаются на баги и простоту —
// то есть на то, где нужно суждение.
//
// ЧЕГО ЭТОТ ЛИНТЕР НЕ ДЕЛАЕТ. Он не судит КАЧЕСТВО разметки: осмысленность @purpose,
// честность @invariants, точность STRUCTURE — не его дело и grep'ом не проверяется. Он
// отвечает ровно на один вопрос: скелет на месте или его нет. Пустой @purpose он пропустит,
// и это осознанно — ложная строгость дороже пропуска.
//
// ИСПОЛЬЗОВАНИЕ (главный тред прогона зовёт его ДО спавна ревьюеров):
//   node .claude/scripts/grace-lint.mjs --file src/a.ts --file src/b.ts [--log app.log] [--json]
//   node .claude/scripts/grace-lint.mjs --files-from cards.json --card c3
//
// Код возврата: 0 — чисто · 1 — есть нарушения (возврат кодеру) · 2 — ошибка запуска.
// Вывод — короткий список «файл: чего нет». Это текст для кодера, а не отчёт для человека.

import fs from "node:fs";
import path from "node:path";

// Файлы, к которым разметка НЕ применяется: у данных и конфигов нет функций, а требовать
// MODULE_CONTRACT от package.json — это шум, из-за которого линтер начинают игнорировать.
const SKIP_EXT = new Set([".json", ".md", ".yml", ".yaml", ".toml", ".lock", ".txt", ".csv",
  ".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico", ".env", ".sql", ".html", ".css", ".scss"]);
const SKIP_RE = /(^|\/)(node_modules|dist|build|\.next|coverage|migrations?)(\/|$)/;

// Маркеры экзоскелета (SKILL §3). Ищем подстроку, а не структуру: язык комментария у каждого
// стека свой (#, //, --), и завязываться на него значит ломаться на каждом новом стеке.
const MARKERS = [
  { id: "MODULE_CONTRACT", re: /MODULE_CONTRACT/, what: "блок MODULE_CONTRACT (@purpose/@io/@invariants/@modulemap)" },
  { id: "GREP_SUMMARY", re: /GREP_SUMMARY:/, what: "строка GREP_SUMMARY: <ключевые слова для grep>" },
  { id: "STRUCTURE", re: /STRUCTURE:/, what: "строка STRUCTURE: <однострочная блок-схема>" },
];
// Навигация по функциям модуля. Шаблон §3 показывает `region FUNC_<name>`, но живой корпус
// grace-файлов (проверено по реальному выводу конвейера) сплошь и рядом обходится строкой
// `@modulemap` — и это ЗАКОННО: цель разметки в том, чтобы функции находились, а не в том,
// чтобы они находились ровно одним способом. Требовать `region FUNC_` буквально означало бы
// возвращать кодеру почти каждую карточку — линтер, который всегда красный, просто выключают.
// Модуль без единой функции (голые константы, типы) не проверяется вовсе.
const FUNC_REGION = /(region\s+FUNC_\w+|FUNCTION_CONTRACT|@modulemap)/;
const HAS_FUNC = /(^|\n)\s*(export\s+)?(async\s+)?(function\s+\w+|def\s+\w+|const\s+\w+\s*=\s*(async\s*)?\()/;

function parseArgs(argv) {
  const out = { files: [], log: null, json: false, card: null, filesFrom: null, rigor: "grace" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") out.files.push(argv[++i]);
    else if (a === "--files-from") out.filesFrom = argv[++i];
    else if (a === "--card") out.card = argv[++i];
    else if (a === "--log") out.log = argv[++i];
    else if (a === "--rigor") out.rigor = argv[++i];
    else if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") { console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 22).join("\n")); process.exit(0); }
  }
  return out;
}

// files[] карточки лежат в board.json прогона — брать их оттуда надёжнее, чем перечислять руками
// (перечисленные руками расходятся с карточкой ровно тогда, когда это важнее всего).
function filesFromBoard(file, cardId) {
  const board = JSON.parse(fs.readFileSync(file, "utf8"));
  const cards = Array.isArray(board.cards) ? board.cards : [];
  const picked = cardId ? cards.filter((c) => c.id === cardId) : cards;
  return [...new Set(picked.flatMap((c) => c.files || []))];
}

function lintFile(file) {
  const rel = file;
  if (SKIP_RE.test(rel) || SKIP_EXT.has(path.extname(rel).toLowerCase())) return null;
  let text;
  try { text = fs.readFileSync(rel, "utf8"); }
  catch { return { file: rel, missing: ["файл не найден — files[] карточки расходится с деревом"] }; }
  if (!text.trim()) return null;
  const missing = MARKERS.filter((m) => !m.re.test(text)).map((m) => m.what);
  if (HAS_FUNC.test(text) && !FUNC_REGION.test(text))
    missing.push("функции есть, а навигации по ним нет — нужен @modulemap в контракте модуля либо region FUNC_<name> на каждую");
  return missing.length ? { file: rel, missing } : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  // rigor: off — разметки нет по определению, и линтер обязан молчать, а не «почти проверять».
  if (args.rigor === "off") { if (!args.json) console.log("grace-lint: rigor=off — разметка не требуется"); return 0; }
  let files = args.files;
  if (args.filesFrom) {
    try { files = files.concat(filesFromBoard(args.filesFrom, args.card)); }
    catch (e) { console.error("grace-lint: не прочитать " + args.filesFrom + ": " + e.message); return 2; }
  }
  files = [...new Set(files.filter(Boolean))];
  if (!files.length) { console.error("grace-lint: нечего проверять — дай --file или --files-from"); return 2; }

  const bad = files.map(lintFile).filter(Boolean);
  // [IMP:9] — не свойство файла, а свойство ЛОГА: правило «каждая бизнес-функция пишет хотя бы
  // одну BELIEF-строку» проверяется по app.log. Нет лога — нет и претензии: линтер не выдумывает
  // нарушение из отсутствия файла, который мог просто не понадобиться этой карточке.
  let logIssue = null;
  if (args.log && fs.existsSync(args.log)) {
    const log = fs.readFileSync(args.log, "utf8");
    if (!/\[IMP:(9|10)\]/.test(log))
      logIssue = `${args.log}: ни одной строки [IMP:9]/[IMP:10] — «зелёный тест без BELIEF» (Green Test Trap, SKILL §3)`;
  }

  if (args.json) {
    console.log(JSON.stringify({ ok: !bad.length && !logIssue, files: files.length, violations: bad, log: logIssue }, null, 2));
  } else if (!bad.length && !logIssue) {
    console.log(`grace-lint: чисто (${files.length} файл(ов))`);
  } else {
    console.log(`grace-lint: НАРУШЕНИЯ РАЗМЕТКИ — исправь и не зови ревьюеров, это не предмет обсуждения.`);
    for (const b of bad) {
      console.log(`\n${b.file}:`);
      for (const m of b.missing) console.log(`  — нет: ${m}`);
    }
    if (logIssue) console.log(`\n${logIssue}`);
    console.log(`\nШаблон — grace-feature-dev SKILL §3 «Semantic exoskeleton template».`);
  }
  return (bad.length || logIssue) ? 1 : 0;
}

process.exit(main());
