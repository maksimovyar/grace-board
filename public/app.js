/* grace-board UI — render the dispatch board from board.json, drag cards across the
   launch lever (→ dispatch), and drive the drawers: detail · two-block Asking ·
   composer · run-log. The pipeline owns each card's station; we mirror it live. */

const STATIONS = {
  backlog:      { no: "01", name: "Backlog",          c: "var(--s-backlog)",      crew: "" },
  todo:         { no: "02", name: "To do",            c: "var(--s-todo)",         crew: "в очереди" },
  asking:       { no: "03", name: "Asking",           c: "var(--s-asking)",       crew: "нужны вы" },
  implementing: { no: "04", name: "Implementing",     c: "var(--s-implementing)", crew: "gfd-coder" },
  verifying:    { no: "05", name: "Verifying",        c: "var(--s-verifying)",    crew: "gfd-verifier" },
  reviewing:    { no: "06", name: "Reviewing",        c: "var(--s-reviewing)",    crew: "gfd-reviewer" },
  ready:        { no: "07", name: "Ready for deploy", c: "var(--s-ready)",        crew: "✓" },
  blocked:      { no: "—",  name: "Blocked",          c: "var(--s-blocked)",      crew: "нужны вы" },
};
const FLOW = ["backlog", "todo", "asking", "implementing", "verifying", "reviewing", "ready"]; // left→right
const WORKING = new Set(["implementing", "verifying", "reviewing"]); // agent-held → pulsing lamp

let state = { cards: [], updatedAt: null };
let igniteId = null;
let planFilter = null;   // S4: when set, the board shows only this plan's stages (rail «только этот прогон»)

// ── helpers ────────────────────────────────────────────────────────────────
const boardEl = document.getElementById("board");
const stripEl = document.getElementById("strip");
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function safeUrl(u) { try { const p = new URL(u); return (p.protocol === "http:" || p.protocol === "https:") ? p.href : null; } catch { return null; } }
function fmtSize(b) { return b >= 1048576 ? (b / 1048576).toFixed(1) + " МБ" : Math.max(1, Math.round(b / 1024)) + " КБ"; }
async function api(path, opts) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}
const cardById = (id) => state.cards.find((c) => c.id === id);
function lampColor(col) { return (STATIONS[col] || STATIONS.backlog).c; }

// What is the Asking card waiting on?  func → answer block 1 · arch-wait → agent
// is drafting decisions · arch-pick → pick decisions.
function askState(card) {
  if (!Array.isArray(card.answers) || !card.answers.length) return "func";
  if (Array.isArray(card.archQuestions) && card.archQuestions.length && !(card.archDecisions || []).length) return "arch-pick";
  return "arch-wait";
}

// ── render: strip + board ───────────────────────────────────────────────────
function count(col) { return state.cards.filter((c) => c.column === col).length; }

function stripHTML() {
  return FLOW.map((col) => `<span class="strip__cell"><span class="strip__lamp" style="color:${lampColor(col)}"></span>${esc(STATIONS[col].name)} <span class="strip__n">${count(col)}</span></span>`).join("");
}

function cardTags(card) {
  const t = [];
  // S4: plan stage badge «этап N/M» — most salient for a plan card, shown first.
  const plan = planOfCard(card);
  if (plan) { const s = stageOf(card, plan); t.push(`<span class="tag tag--stage" title="этап прогона">этап ${s.n}/${s.m}</span>`); }
  // Queue / dependency state (§5.1/§5.2) — most salient, shown first. A queued card is
  // either waiting on unmet dependsOn (🔒), or on a busy project slot (⏳).
  if (card.queued) {
    const waiting = (card.dependsOn || [])
      .map((id) => state.cards.find((c) => c.id === id))
      .filter((d) => !d || d.column !== "ready");
    if (waiting.length) {
      const names = waiting.map((d) => (d ? (d.theme || d.id) : "удалённый этап")).join(", ");
      const shown = names.length > 26 ? names.slice(0, 26) + "…" : names;
      t.push(`<span class="tag tag--wait" title="ждёт готовности: ${esc(names)}">🔒 ждёт: ${esc(shown)}</span>`);
    } else {
      t.push(`<span class="tag tag--queue">⏳ в очереди · проект занят</span>`);
    }
  }
  if (Array.isArray(card.files) && card.files.length)
    t.push(`<span class="tag tag--files" title="${esc(card.files.join(", "))}">⎘ ${card.files.length}</span>`);
  // SR: release-manifest chip — the card carries a non-empty deploy{} run-book (§6.1).
  if (manifestHasItems(card.deploy))
    t.push(`<span class="tag tag--rel" title="манифест релиза — открой карточку">⛁ релиз</span>`);
  // S3 · AUTO trail (§5.3): forks resolved without a human · hard-floor held for a human.
  const autoN = (card.result && card.result.autoDecisions || []).length;
  if (autoN) t.push(`<span class="tag tag--auto" title="авто-решений без человека">🤖 ${autoN}</span>`);
  if ((card.autoFloorHeld || []).length) t.push(`<span class="tag tag--floor" title="AUTO остановлен полом — решает человек">⚠ пол · ждёт</span>`);
  const floorN = (card.result && card.result.floor || []).length;
  if (floorN) t.push(`<span class="tag tag--floor" title="жёсткий пол — нужна подпись человека на PR">⚠ пол: ${floorN}</span>`);
  const dl = card.designLink ? safeUrl(card.designLink) : null;
  if (dl) t.push(`<a class="tag" href="${esc(dl)}" target="_blank" rel="noopener" data-stop>⧉ макеты</a>`);
  const rl = card.requirementsLink ? safeUrl(card.requirementsLink) : null;
  if (rl) t.push(`<a class="tag" href="${esc(rl)}" target="_blank" rel="noopener" data-stop>▤ требования</a>`);
  else if (card.requirements) t.push(`<span class="tag" title="${esc(card.requirements)}">▤ требования</span>`);
  if ((card.attachments || []).length) t.push(`<span class="tag">📎 ${card.attachments.length}</span>`);
  if (card.rigor === "grace") t.push(`<span class="tag">grace</span>`);
  return t.length ? `<div class="card__tags">${t.join("")}</div>` : "";
}

// ── SR: «Результат» + release manifest (§6/§6.1) ─────────────────────────────
const MANIFEST_SECTIONS = [["migrations", "Миграции"], ["env", "env"], ["services", "Сервисы/таймеры"], ["seed", "seed/скрипты"], ["manualChecks", "Ручная проверка"]];
function manifestHasItems(d) {
  return !!d && typeof d === "object" && MANIFEST_SECTIONS.some(([k]) => Array.isArray(d[k]) && d[k].length);
}
function manifestItemText(it) {
  if (it && typeof it === "object") return it.name ? `${it.name}${it.value != null ? "=" + it.value : ""}${it.note ? " — " + it.note : ""}` : (it.path || it.file || it.id || JSON.stringify(it));
  return String(it);
}
// The result aggregate on the card (server-built). Renders git link + outcome + AUTO forks
// + block reason, then the 5-section manifest (empty = "проверял, пусто", missing = red).
function resultHTML(card) {
  const r = card.result;
  const m = r && r.releaseManifest;
  if (!r || (!m && !r.branchLink && !r.finishNote && !r.blockReason && !(r.autoDecisions || []).length)) return "";
  const missing = new Set(r.manifestMissing || []);
  const rows = [];
  const blHref = r.branchLink && safeUrl(r.branchLink);
  if (r.branchLink) rows.push(`<div class="res__row"><span class="res__k">⎇ ветка</span><span class="res__v">${blHref ? `<a href="${esc(blHref)}" target="_blank" rel="noopener">${esc(r.branchLink)}</a>` : esc(r.branchLink)}</span></div>`);
  if (r.finishNote) rows.push(`<div class="res__row"><span class="res__k">итог</span><span class="res__v">${esc(r.finishNote)}</span></div>`);
  if ((r.autoDecisions || []).length) rows.push(`<div class="res__row"><span class="res__k">🤖 авто</span><span class="res__v">${r.autoDecisions.map((d) => esc(d.chosenTitle || d.q || "решение")).join(" · ")}</span></div>`);
  if (r.blockReason) rows.push(`<div class="res__row res__row--block"><span class="res__k">⚠ причина</span><span class="res__v">${esc(r.blockReason)}</span></div>`);
  if ((r.floor || []).length) rows.push(`<div class="res__row res__row--block"><span class="res__k">⚠ пол</span><span class="res__v">${r.floor.map((f) => esc(`${f.class}: ${f.detail}`)).join("<br>")}<div class="res__floornote">жёсткий пол §5.3 — требует подписи человека на финальном PR</div></span></div>`);
  let manifest = "";
  if (m) {
    manifest = `<div class="manifest">` + MANIFEST_SECTIONS.map(([k, label]) => {
      const items = m[k] || [], miss = missing.has(k);
      const body = miss
        ? `<span class="manifest__miss">ключ пропущен — не заполнен (→ verify фейлит)</span>`
        : items.length
          ? `<ul class="manifest__items">${items.map((it) => `<li>${esc(manifestItemText(it))}</li>`).join("")}</ul>`
          : `<span class="manifest__empty">проверял, пусто</span>`;
      return `<div class="manifest__sec${miss ? " is-miss" : ""}"><div class="manifest__label">${esc(label)}</div>${body}</div>`;
    }).join("") + `</div>`;
  }
  return `<div><div class="dt__label">Результат · манифест релиза</div><div class="result">${rows.join("")}${manifest}</div></div>`;
}

// S4: the plan a card belongs to (null = single card) + its 1-based stage index.
const planOfCard = (card) => card.planId ? (state.plans || []).find((p) => p.id === card.planId) : null;
function stageOf(card, plan) { const i = (plan.cardIds || []).indexOf(card.id); return { n: i + 1, m: (plan.cardIds || []).length }; }

function cardHTML(card) {
  const st = STATIONS[card.column] || STATIONS.backlog;
  const plan = planOfCard(card);
  const stage = plan ? stageOf(card, plan) : null;
  const crew = st.crew ? `<span class="card__crew">${esc(st.crew)}</span>` : "";
  const working = WORKING.has(card.column) ? ` data-working="1"` : "";
  const ignite = card.id === igniteId ? " is-ignite" : "";
  const planAttr = plan ? ` data-plan="${esc(plan.id)}"` : "";
  const projectLabel = plan ? "⚡ Plan Run" : card.project;
  const stagePrefix = stage ? `<span class="card__stage">S${stage.n} ·</span>` : "";

  // Asking banner — clickable, opens the questionnaire drawer
  let askBanner = "";
  if (card.column === "asking") {
    const s = askState(card);
    const label = s === "func"
      ? `${(card.questions || []).length || "…"} вопросов · ответь`
      : s === "arch-pick"
        ? `Блок 1 готов · ${card.archQuestions.length} решений по архитектуре`
        : `Блок 1 готов · архитектор думает…`;
    askBanner = `<div class="card__ask" data-ask="${card.id}"><span class="dot"></span>${esc(label)}<span class="arr">→</span></div>`;
  }

  const blocked = (card.column === "blocked" && card.blockReason)
    ? `<div class="card__blocked">⚠ ${esc(card.blockReason)}</div>` : "";
  const stamp = card.column === "ready"
    ? `<div class="card__stamp">✓ готово к деплою · все гейты зелёные</div>`
    : (card.dispatchedAt ? `<div class="card__stamp">⟶ отправлено · ${new Date(card.dispatchedAt).toLocaleString()}</div>` : "");

  // foot actions
  const acts = [];
  if (card.dispatchedAt) acts.push(`<button class="card__act" data-log="${card.id}" data-stop>⊟ лог</button>`);
  if (card.dispatchedAt && (card.column === "blocked" || WORKING.has(card.column))) acts.push(`<button class="card__act" data-relaunch="${card.id}" data-stop>↻ перезапуск</button>`);
  acts.push(`<button class="card__del" data-del="${card.id}" data-stop>✕ ${card.column === "ready" ? "удалить" : "отмена"}</button>`);

  const desc = card.description ? `<p class="card__desc">${esc(card.description)}</p>` : "";
  return `
    <article class="card${ignite}" draggable="true" data-id="${card.id}" data-col="${esc(card.column)}"${working}${planAttr}>
      <div class="card__body">
        <div class="card__meta"><span class="card__lamp" style="color:${st.c}"></span><span class="card__project">${esc(projectLabel)}</span>${crew}</div>
        <h3 class="card__theme">${stagePrefix}${esc(card.theme || card.description || "—")}</h3>
        ${desc}
        ${cardTags(card)}
        ${askBanner}
      </div>
      ${blocked}
      ${stamp}
      <div class="card__foot">${acts.join("")}</div>
    </article>`;
}

function stationHTML(col) {
  const st = STATIONS[col];
  const cards = state.cards.filter((c) => c.column === col && (!planFilter || c.planId === planFilter));
  const empty = col === "backlog"
    ? "Добавь задачу и перетащи\nеё через рычаг запуска ⟶"
    : "—";
  const inner = cards.length ? cards.map(cardHTML).join("") : `<div class="well__empty">${empty}</div>`;
  const mod = col === "backlog" ? "station--backlog" : (col === "blocked" ? "station--blocked" : "");
  return `
    <section class="station ${mod}" data-col="${col}">
      <header class="station__head">
        <span class="station__no">${st.no}</span>
        <span class="station__lamp" style="color:${st.c}"></span>
        <span class="station__name">${esc(st.name)}</span>
        <span class="station__count">${cards.length}</span>
      </header>
      <div class="well" data-drop="${col}">${inner}</div>
    </section>`;
}

// ── S3: global autonomy toggle (Ask/Auto), injected into the header (§5.3) ──────
// index.html markup is S4's territory; S3 builds the control in JS so its files[] stay
// server.js + app.js + styles.css. board.autonomy is the global default (card override wins).
let autoSegEl = null;
function ensureAutonomyToggle() {
  if (autoSegEl) return;
  const consoleEl = document.querySelector(".console");
  const openC = document.getElementById("openComposer");
  if (!consoleEl || !openC) return;
  autoSegEl = document.createElement("div");
  autoSegEl.className = "auto-seg";
  autoSegEl.title = "глобальный режим автономии (оверрайд на карточке)";
  autoSegEl.innerHTML = `<span class="auto-seg__label">Режим</span><div class="seg" id="autoSeg"><button type="button" class="seg__opt" data-auto="ask">Ask</button><button type="button" class="seg__opt" data-auto="auto">Auto</button></div>`;
  consoleEl.insertBefore(autoSegEl, openC);
  autoSegEl.querySelectorAll(".seg__opt").forEach((o) => o.addEventListener("click", () => setAutonomy(o.dataset.auto)));
}
function paintAutonomy() {
  if (!autoSegEl) return;
  const v = state.autonomy === "auto" ? "auto" : "ask";
  autoSegEl.querySelectorAll(".seg__opt").forEach((o) => o.classList.toggle("is-on", o.dataset.auto === v));
}
async function setAutonomy(v) {
  try {
    const r = await api("/api/settings", { method: "PATCH", body: JSON.stringify({ autonomy: v }) });
    state.autonomy = r.autonomy; paintAutonomy();
    toast(`Режим по умолчанию: <strong>${v === "auto" ? "Auto" : "Ask"}</strong>`);
  } catch (err) { toast("Не удалось: " + err.message); }
}

// ── S4: plan-rail(s) over the columns — a running big feature (§2, design v2) ──
function dagNodeClass(card) {
  if (!card) return "wait";
  if (card.column === "blocked") return "blocked";
  if (card.column === "ready") return "done";
  if (card.dispatchedAt) return "live";     // asking / implementing / verifying / reviewing
  return "wait";                             // queued or not-yet-dispatched todo
}
function railHTML(plan) {
  const cards = (plan.cardIds || []).map((id) => cardById(id)).filter(Boolean);
  const total = cards.length;
  const done = cards.filter((c) => c.column === "ready").length;
  const autoN = cards.reduce((n, c) => n + ((c.result && c.result.autoDecisions || []).length), 0);
  const nodes = cards.map((c, i) => {
    const cls = dagNodeClass(c);
    const dot = cls === "done" ? "✓" : cls === "live" ? "●" : cls === "blocked" ? "!" : "○";
    return `${i ? '<span class="dag__arrow">→</span>' : ""}<span class="dag__node dag__node--${cls}" title="${esc(c.theme || "")}"><span class="dag__dot">${dot}</span>S${i + 1}</span>`;
  }).join("");
  const filterOn = planFilter === plan.id;
  return `<section class="rail" data-plan-rail="${esc(plan.id)}">
    <div class="rail__top">
      <span class="rail__badge">⚡ прогон</span>
      <div class="rail__goal">
        <h2 class="rail__title">${esc(plan.goal || "Прогон " + plan.id)}</h2>
        <div class="rail__meta">
          <span class="rail__chip rail__chip--branch">⎇ ${esc(plan.integrationBranch)}</span>
          <span class="rail__chip rail__chip--auto">режим: ${plan.mode === "auto" ? "Auto" : "Ask"}</span>
          <span class="rail__chip">🧩 ${total} этап.</span>
          <span class="rail__chip">🤖 авто-решений: ${autoN}</span>
        </div>
      </div>
      <div class="rail__actions">
        <button class="rail__filter${filterOn ? " is-on" : ""}" type="button" data-planfilter="${esc(plan.id)}">⛁ только этот прогон</button>
        <button class="rail__pr" type="button" data-planpr="${esc(plan.id)}">Финальный PR в main →</button>
      </div>
    </div>
    <div class="dag">${nodes}<span class="dag__count">${done} / ${total} · строго последовательно (WIP=1)</span></div>
  </section>`;
}
function renderRails() {
  const host = document.getElementById("railHost");
  if (!host) return;
  const plans = (state.plans || []).filter((p) => (p.cardIds || []).some((id) => cardById(id)));
  host.innerHTML = plans.map(railHTML).join("");
  host.querySelectorAll("[data-planfilter]").forEach((b) => b.addEventListener("click", () => { planFilter = planFilter === b.dataset.planfilter ? null : b.dataset.planfilter; render(); }));
  host.querySelectorAll("[data-planpr]").forEach((b) => b.addEventListener("click", () => onPlanPR(b.dataset.planpr)));
}
async function onPlanPR(planId) {
  const plan = (state.plans || []).find((p) => p.id === planId);
  try {
    const m = await api(`/api/plans/${planId}/manifest`);
    const floor = (m.floor || []).length ? ` · ⚠ пол: ${m.floor.length}` : "";
    toast(`Интеграционная ветка <strong>${esc(plan ? plan.integrationBranch : planId)}</strong> · ${m.stageCount} этап.${floor} · мерж в main — гейт человека`);
  } catch (err) { toast("Не удалось: " + err.message); }
}

function render() {
  ensureAutonomyToggle(); paintAutonomy();
  renderRails();
  stripEl.innerHTML = stripHTML();
  const parts = [stationHTML("backlog")];
  parts.push(`<div class="lever" data-drop="todo" id="lever" title="перетащи карточку через рычаг — команда возьмёт задачу"><span class="lever__knob"></span><span class="lever__label">launch</span></div>`);
  for (const col of ["todo", "asking", "implementing", "verifying", "reviewing", "ready"]) parts.push(stationHTML(col));
  parts.push(stationHTML("blocked"));
  boardEl.innerHTML = parts.join("");
  igniteId = null;
  wireDnD();
  boardEl.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", onDelete));
  boardEl.querySelectorAll("[data-log]").forEach((b) => b.addEventListener("click", (e) => openLog(e.currentTarget.dataset.log)));
  boardEl.querySelectorAll("[data-relaunch]").forEach((b) => b.addEventListener("click", onRelaunch));
  boardEl.querySelectorAll("[data-ask]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); openAsk(e.currentTarget.dataset.ask); }));
  boardEl.querySelectorAll(".card").forEach((el) => el.addEventListener("click", (e) => {
    if (e.target.closest("[data-stop],button,a,input,textarea")) return;
    const card = cardById(el.dataset.id); if (!card) return;
    card.column === "asking" ? openAsk(card.id) : openDetail(card.id);
  }));
}

// ── drag & drop ──────────────────────────────────────────────────────────
let dragId = null;
function wireDnD() {
  boardEl.querySelectorAll(".card").forEach((el) => {
    el.addEventListener("dragstart", (e) => { dragId = el.dataset.id; el.classList.add("is-dragging"); e.dataTransfer.effectAllowed = "move"; });
    el.addEventListener("dragend", () => { el.classList.remove("is-dragging"); dragId = null; });
  });
  boardEl.querySelectorAll("[data-drop]").forEach((zone) => {
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("is-over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
    zone.addEventListener("drop", (e) => { e.preventDefault(); zone.classList.remove("is-over"); onDrop(zone.dataset.drop); });
  });
}
async function onDrop(targetCol) {
  if (!dragId) return;
  const card = cardById(dragId);
  if (!card || card.column === targetCol) return;
  try {
    const { card: updated, dispatched } = await api(`/api/tasks/${card.id}`, { method: "PATCH", body: JSON.stringify({ column: targetCol }) });
    Object.assign(card, updated);
    if (dispatched) { igniteId = card.id; toast(`Отправлено команде · <strong>${esc(card.project)}</strong>`); }
    render();
  } catch (err) { toast("Не удалось переместить: " + err.message); }
}

async function onDelete(e) {
  const id = e.currentTarget.dataset.del;
  if (!confirm("Удалить задачу?")) return;
  try { await api(`/api/tasks/${id}`, { method: "DELETE" }); state.cards = state.cards.filter((c) => c.id !== id); closeAll(); render(); }
  catch (err) { toast("Не удалось удалить: " + err.message); }
}
async function onRelaunch(e) {
  const id = e.currentTarget.dataset.relaunch;
  if (!confirm("Перезапустить прогон для этой карточки?")) return;
  try { const { card } = await api(`/api/tasks/${id}/relaunch`, { method: "POST", body: "{}" }); Object.assign(cardById(id) || {}, card); toast("Прогон перезапущен"); loadBoard(); }
  catch (err) { toast("Не удалось перезапустить: " + err.message); }
}

// ── sheets ─────────────────────────────────────────────────────────────────
const sheets = { detail: document.getElementById("detail"), ask: document.getElementById("ask"), composer: document.getElementById("composer"), log: document.getElementById("logsheet") };
let openDetailId = null, openAskId = null, askSig = null;
function closeAll() {
  Object.values(sheets).forEach((s) => (s.hidden = true));
  openDetailId = openAskId = askSig = null; logCardId = null; clearInterval(logTimer);
}
document.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", closeAll));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAll(); });

function badge(col) { const s = STATIONS[col] || STATIONS.backlog; return `<span class="badge"><span class="station__lamp" style="color:${s.c}"></span>${esc(s.name)}</span>`; }
function linksHTML(card) {
  const l = [];
  const dl = card.designLink && safeUrl(card.designLink); if (dl) l.push(`<a class="tag" href="${esc(dl)}" target="_blank" rel="noopener">⧉ макеты</a>`);
  const rl = card.requirementsLink && safeUrl(card.requirementsLink); if (rl) l.push(`<a class="tag" href="${esc(rl)}" target="_blank" rel="noopener">▤ требования</a>`);
  return l.length ? `<div class="dt__links">${l.join("")}</div>` : "";
}
function attViewHTML(card) {
  if (!(card.attachments || []).length) return "";
  const items = card.attachments.map((a) => {
    const img = (a.type || "").startsWith("image/");
    const thumb = img ? `<span class="att__thumb att__thumb--img" style="background-image:url('${esc(a.url)}')"></span>` : `<span class="att__thumb">${esc((a.name.split(".").pop() || "").slice(0, 4).toUpperCase())}</span>`;
    return `<li class="att">${thumb}<a class="att__name" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.name)}</a><span class="att__size">${fmtSize(a.size)}</span></li>`;
  }).join("");
  return `<div><div class="dt__label">Вложения</div><ul class="att-list">${items}</ul></div>`;
}

// detail drawer (non-asking)
function openDetail(id) {
  const card = cardById(id); if (!card) return;
  closeAll(); openDetailId = id;
  const editable = card.column === "backlog" && !card.dispatchedAt;
  const note = editable ? `<div class="dt__note">Вопросы появятся, когда задача дойдёт до <b>Asking</b> — сначала по функционалу, затем по архитектуре.</div>` : "";
  document.getElementById("detailPanel").innerHTML = `
    <div class="sheet__head">
      <div class="dt__badges">${badge(card.column)}<span class="badge">${esc(card.project)}</span></div>
      <button class="sheet__close" type="button" data-close aria-label="Закрыть">✕</button>
    </div>
    <h2 class="dt__theme">${esc(card.theme || "—")}</h2>
    <div><div class="dt__label">Описание</div><p class="dt__desc">${esc(card.description || "Описание не задано.")}</p></div>
    ${linksHTML(card)}
    ${attViewHTML(card)}
    ${card.column === "blocked" && card.blockReason ? `<div class="card__blocked">⚠ ${esc(card.blockReason)}</div>` : ""}
    ${resultHTML(card)}
    ${note}
    <div class="sheet__actions">
      <button class="btn btn--danger" type="button" data-del-detail>Отменить задачу</button>
      ${editable ? `<button class="btn btn--ghost" type="button" data-edit>Изменить</button>` : ""}
    </div>`;
  const panel = document.getElementById("detailPanel");
  panel.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeAll));
  panel.querySelector("[data-del-detail]").addEventListener("click", () => { if (confirm("Удалить задачу?")) api(`/api/tasks/${id}`, { method: "DELETE" }).then(() => { state.cards = state.cards.filter((c) => c.id !== id); closeAll(); render(); }); });
  const edit = panel.querySelector("[data-edit]"); if (edit) edit.addEventListener("click", () => openComposer(card));
  sheets.detail.hidden = false;
}

// asking drawer (two blocks)
function openAsk(id) {
  const card = cardById(id); if (!card) return;
  closeAll(); openAskId = id; askSig = JSON.stringify([askState(card), (card.questions || []).length, (card.archQuestions || []).length]);
  renderAsk(card);
  sheets.ask.hidden = false;
}
function renderAsk(card) {
  const s = askState(card);
  // block 1 — functional
  let b1;
  if (Array.isArray(card.answers) && card.answers.length) {
    b1 = card.answers.map((qa, i) => `<div class="qrow"><span class="qrow__q"><b>${i + 1}</b>${esc(qa.q)}</span><div class="qrow__ans">${esc(qa.a || "(без ответа)")}</div></div>`).join("")
      + `<div class="qblock__done">✓ ответы приняты${s !== "func" ? " · архитектор предложил решения ниже" : ""}</div>`;
  } else if ((card.questions || []).length) {
    b1 = card.questions.map((q, i) => `<div class="qrow"><span class="qrow__q"><b>${i + 1}</b>${esc(typeof q === "string" ? q : q.q)}</span><textarea class="qrow__a" data-fi="${i}" rows="2" placeholder="Ответ…"></textarea></div>`).join("")
      + `<button class="qblock__send" type="button" id="sendFunc">Ответить →</button>`;
  } else {
    b1 = `<div class="qblock__wait"><span class="dot"></span>агент формулирует вопросы…</div>`;
  }

  // block 2 — architecture
  let b2 = "";
  if (s === "arch-pick") {
    const decisions = card.archQuestions.map((d, di) => {
      const opts = (d.options || []).map((o, oi) => `
        <label class="opt"><input type="radio" name="${esc(d.id)}" value="${esc(o.id)}" ${o.recommended ? "checked" : ""} data-dec="${esc(d.id)}" />
          <div class="opt__title">${esc(o.title)}${o.recommended ? `<span class="opt__rec">рекомендуем</span>` : ""}</div>
          ${o.desc ? `<div class="opt__desc">${esc(o.desc)}</div>` : ""}
          <div class="opt__pc">${(o.pros || []).map((p) => `<span class="pro">${esc(p)}</span>`).join("")}${(o.cons || []).map((c) => `<span class="con">${esc(c)}</span>`).join("")}</div>
        </label>`).join("");
      return `<div class="decision" data-decision="${esc(d.id)}">
        <div class="decision__q"><b>${di + 1}</b>${esc(d.q)}</div>
        ${opts}
        <label class="opt opt--own"><input type="radio" name="${esc(d.id)}" value="own" data-dec="${esc(d.id)}" /><div class="opt__title">Свой вариант</div><input class="optown__in" data-own="${esc(d.id)}" placeholder="опиши, как лучше…" /></label>
      </div>`;
    }).join("");
    b2 = `<div class="qblock qblock--arch">
      <div class="qblock__head"><span class="qblock__no">2</span><span class="qblock__title">Вопросы по архитектуре</span></div>
      <p class="qblock__sub">по каждому вопросу выбери решение — варианты с плюсами и минусами</p>
      ${decisions}
      <button class="qblock__send" type="button" id="sendArch">Принять решения и запустить сборку →</button>
    </div>`;
  } else if (s === "arch-wait") {
    b2 = `<div class="qblock qblock--arch"><div class="qblock__head"><span class="qblock__no">2</span><span class="qblock__title">Вопросы по архитектуре</span></div><div class="qblock__wait"><span class="dot"></span>архитектор готовит решения…</div></div>`;
  }

  document.getElementById("askPanel").innerHTML = `
    <div class="sheet__head">
      <div class="dt__badges">${badge("asking")}<span class="badge">${esc(card.project)}</span></div>
      <button class="sheet__close" type="button" data-close aria-label="Закрыть">✕</button>
    </div>
    <h2 class="dt__theme">${esc(card.theme || "—")}</h2>
    ${card.description ? `<div><div class="dt__label">Описание</div><p class="dt__desc">${esc(card.description)}</p></div>` : ""}
    ${linksHTML(card)}
    <div class="qblock qblock--func">
      <div class="qblock__head"><span class="qblock__no">1</span><span class="qblock__title">Вопросы по функционалу</span></div>
      <p class="qblock__sub">смысл задачи</p>
      ${b1}
    </div>
    ${b2}
    <div class="sheet__actions"><button class="btn btn--danger" type="button" data-del-ask>Отменить задачу</button></div>`;

  const panel = document.getElementById("askPanel");
  panel.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeAll));
  panel.querySelector("[data-del-ask]").addEventListener("click", () => { if (confirm("Удалить задачу?")) api(`/api/tasks/${card.id}`, { method: "DELETE" }).then(() => { state.cards = state.cards.filter((c) => c.id !== card.id); closeAll(); render(); }); });
  const sf = panel.querySelector("#sendFunc"); if (sf) sf.addEventListener("click", () => sendFunctional(card.id, sf));
  const sa = panel.querySelector("#sendArch"); if (sa) sa.addEventListener("click", () => sendArchitecture(card.id, sa));
}

async function sendFunctional(id, btn) {
  const answers = [...document.querySelectorAll("#askPanel [data-fi]")].sort((a, b) => a.dataset.fi - b.dataset.fi).map((t) => t.value.trim());
  btn.disabled = true; btn.textContent = "Отправляю…";
  try {
    const { card } = await api(`/api/tasks/${id}/answers`, { method: "POST", body: JSON.stringify({ stage: "functional", answers }) });
    Object.assign(cardById(id) || {}, card);
    toast("Ответы приняты · архитектор готовит решения");
    render(); openAsk(id);
  } catch (err) { btn.disabled = false; btn.textContent = "Ответить →"; toast("Не удалось отправить: " + err.message); }
}
async function sendArchitecture(id, btn) {
  const card = cardById(id);
  const answers = (card.archQuestions || []).map((d) => {
    const sel = document.querySelector(`#askPanel input[name="${d.id}"]:checked`);
    const choice = sel ? sel.value : null;
    const ownText = choice === "own" ? (document.querySelector(`#askPanel [data-own="${d.id}"]`)?.value.trim() || "") : null;
    return { decisionId: d.id, choice, ownText };
  });
  if (answers.some((a) => !a.choice)) { toast("Выбери решение в каждом вопросе"); return; }
  btn.disabled = true; btn.textContent = "Запускаю сборку…";
  try {
    const { card: updated } = await api(`/api/tasks/${id}/answers`, { method: "POST", body: JSON.stringify({ stage: "architecture", answers }) });
    Object.assign(cardById(id) || {}, updated);
    igniteId = id; closeAll(); render();
    toast(`Решения приняты · сборка запущена — <strong>${esc(updated.project)}</strong>`);
  } catch (err) { btn.disabled = false; btn.textContent = "Принять решения и запустить сборку →"; toast("Не удалось: " + err.message); }
}

// ── composer (new task / edit) ───────────────────────────────────────────────
const form = document.getElementById("composerForm");
let editId = null;        // null → new task; else editing this backlog card
let pendingFiles = [];    // staged uploads for a NEW task (uploaded after create)
let rigorVal = "grace";

function openComposer(card) {
  closeAll();
  editId = card ? card.id : null;
  pendingFiles = [];
  document.getElementById("composerTitle").textContent = card ? "Изменить задачу" : "Новая задача";
  document.getElementById("composerSubmit").textContent = card ? "Сохранить" : "В Backlog";
  form.project.value = card ? card.project : "";
  form.project.readOnly = !!card; // project drives the run dir slug — don't move it on edit
  form.theme.value = card ? (card.theme || "") : "";
  form.description.value = card ? (card.description || "") : "";
  form.designLink.value = card ? (card.designLink || "") : "";
  form.requirementsLink.value = card ? (card.requirementsLink || "") : "";
  document.getElementById("cnt").textContent = form.description.value.length;
  rigorVal = card ? (card.rigor === "grace" ? "grace" : "off") : "grace";
  setRigor(rigorVal);
  renderAttList();
  sheets.composer.hidden = false;
  form.project.focus();
}
document.getElementById("openComposer").addEventListener("click", () => openComposer(null));
form.description.addEventListener("input", () => (document.getElementById("cnt").textContent = form.description.value.length));

function setRigor(v) { rigorVal = v; document.querySelectorAll("#rigorSeg .seg__opt").forEach((o) => o.classList.toggle("is-on", o.dataset.rigor === v)); }
document.querySelectorAll("#rigorSeg .seg__opt").forEach((o) => o.addEventListener("click", () => setRigor(o.dataset.rigor)));

// attachments in composer
const dropzone = document.getElementById("dropzone"), fileInput = document.getElementById("fileInput"), attListEl = document.getElementById("attList");
dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("is-over"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-over"));
dropzone.addEventListener("drop", (e) => { e.preventDefault(); dropzone.classList.remove("is-over"); addFiles(e.dataTransfer.files); });
fileInput.addEventListener("change", () => { addFiles(fileInput.files); fileInput.value = ""; });

function readFile(file) {
  return new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve({ name: file.name, type: file.type || "application/octet-stream", size: file.size, data: r.result }); r.readAsDataURL(file); });
}
async function addFiles(fileList) {
  for (const f of [...fileList]) {
    if (f.size > 8 * 1024 * 1024) { toast(`«${f.name}» больше 8 МБ`); continue; }
    const meta = await readFile(f);
    if (editId) {
      try { const { attachment } = await api(`/api/tasks/${editId}/attachments`, { method: "POST", body: JSON.stringify(meta) }); (cardById(editId).attachments ||= []).push(attachment); }
      catch (err) { toast("Не удалось загрузить: " + err.message); }
    } else { pendingFiles.push(meta); }
  }
  renderAttList();
}
function renderAttList() {
  const list = editId ? (cardById(editId)?.attachments || []) : pendingFiles;
  attListEl.innerHTML = list.map((a, i) => {
    const img = (a.type || "").startsWith("image/");
    const src = editId ? a.url : a.data;
    const thumb = img ? `<span class="att__thumb att__thumb--img" style="background-image:url('${esc(src)}')"></span>` : `<span class="att__thumb">${esc((a.name.split(".").pop() || "").slice(0, 4).toUpperCase())}</span>`;
    return `<li class="att">${thumb}<span class="att__name">${esc(a.name)}</span><span class="att__size">${fmtSize(a.size)}</span><button class="att__del" type="button" data-att="${editId ? a.id : i}">✕</button></li>`;
  }).join("");
  attListEl.querySelectorAll("[data-att]").forEach((b) => b.addEventListener("click", () => removeAtt(b.dataset.att)));
}
async function removeAtt(ref) {
  if (editId) { try { await api(`/api/tasks/${editId}/attachments/${ref}`, { method: "DELETE" }); const c = cardById(editId); c.attachments = (c.attachments || []).filter((a) => a.id !== ref); } catch (err) { toast(err.message); } }
  else { pendingFiles.splice(Number(ref), 1); }
  renderAttList();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = { project: form.project.value.trim(), theme: form.theme.value.trim(), description: form.description.value.trim(), designLink: form.designLink.value.trim(), requirementsLink: form.requirementsLink.value.trim(), rigor: rigorVal };
  const btn = document.getElementById("composerSubmit"); btn.disabled = true;
  try {
    if (editId) {
      const { card } = await api(`/api/tasks/${editId}`, { method: "PATCH", body: JSON.stringify(payload) });
      Object.assign(cardById(editId) || {}, card);
      toast(`Сохранено · <strong>${esc(card.project)}</strong>`);
    } else {
      const { card } = await api("/api/tasks", { method: "POST", body: JSON.stringify(payload) });
      for (const f of pendingFiles) { try { const { attachment } = await api(`/api/tasks/${card.id}/attachments`, { method: "POST", body: JSON.stringify(f) }); (card.attachments ||= []).push(attachment); } catch {} }
      state.cards.push(card);
      toast(`В Backlog · <strong>${esc(card.project)}</strong>`);
    }
    closeAll(); render();
  } catch (err) { toast("Не удалось сохранить: " + err.message); }
  finally { btn.disabled = false; }
});

// ── S4: launch wizard (⚡ Прогон) — assemble a plan from EXISTING board cards ──
const launchEl = document.getElementById("launch");
let wizStep = 1, wizMode = "ask", wizPicks = [];   // wizPicks: ordered [{cardId, deps:Set<cardId>}]
const assemblable = (project) => state.cards.filter((c) => c.project === project && (c.column === "backlog" || c.column === "todo") && !c.dispatchedAt && !c.planId);
const pickIndex = (id) => wizPicks.findIndex((p) => p.cardId === id);
function syncProjName() { const v = document.getElementById("lProject").value; document.querySelectorAll("#lProjName,#lProjName2").forEach((e) => (e.textContent = v || "проекта")); }
function setWizMode(v) { wizMode = v; document.querySelectorAll("#lMode .seg__opt").forEach((o) => o.classList.toggle("is-on", o.dataset.auto === v)); }
function openLaunch() {
  closeAll();
  wizPicks = []; setWizMode(state.autonomy === "auto" ? "auto" : "ask");
  const projects = [...new Set(state.cards.filter((c) => (c.column === "backlog" || c.column === "todo") && !c.dispatchedAt && !c.planId).map((c) => c.project))];
  const sel = document.getElementById("lProject");
  sel.innerHTML = projects.length ? projects.map((p) => `<option>${esc(p)}</option>`).join("") : `<option value="">— нет свободных карточек —</option>`;
  document.getElementById("lGoal").value = "";
  syncProjName(); wizGoto(1);
  launchEl.hidden = false;
}
function wizGoto(n) {
  wizStep = n;
  launchEl.querySelectorAll(".lpane").forEach((p) => p.classList.toggle("is-on", +p.dataset.pane === n));
  launchEl.querySelectorAll(".steps__i").forEach((s) => { const k = +s.dataset.step; s.classList.toggle("is-on", k === n); s.classList.toggle("is-done", k < n); });
  if (n === 2) renderDraft();
  if (n === 3) renderGate();
  launchEl.querySelector(".launch__panel").scrollTop = 0;
}
function renderDraft() {
  const project = document.getElementById("lProject").value;
  const cards = assemblable(project);
  const draft = document.getElementById("draft");
  if (!cards.length) { draft.innerHTML = `<div class="gate-empty">Нет незавершённых карточек в Backlog/To do этого проекта. Заведи их на доске.</div>`; updatePickCount(); return; }
  draft.innerHTML = cards.map((c) => {
    const idx = pickIndex(c.id), on = idx >= 0;
    const others = wizPicks.filter((p) => p.cardId !== c.id);
    const deps = (on && others.length) ? `<div class="stagedeps"><span class="stagedeps__lk">зависит:</span>${others.map((p) => {
      const dn = `S${pickIndex(p.cardId) + 1}`, active = wizPicks[idx].deps.has(p.cardId), oc = cardById(p.cardId);
      return `<button type="button" class="depchip${active ? " is-on" : ""}" data-dep="${esc(c.id)}|${esc(p.cardId)}" title="${esc(oc ? oc.theme : "")}">${dn}</button>`;
    }).join("")}</div>` : "";
    return `<div class="stagerow" data-on="${on ? 1 : 0}">
      <label class="pick"><input type="checkbox" data-pick="${esc(c.id)}" ${on ? "checked" : ""}/></label>
      <span class="stagerow__id">${on ? "S" + (idx + 1) : "—"}</span>
      <span class="stagerow__t" title="${esc(c.theme || "")}">${esc(c.theme || "—")}</span>
      <span class="stagerow__col" style="color:${lampColor(c.column)}">${esc((STATIONS[c.column] || {}).name || c.column)}</span>
      ${deps}
    </div>`;
  }).join("");
  draft.querySelectorAll("[data-pick]").forEach((cb) => cb.addEventListener("change", () => togglePick(cb.dataset.pick)));
  draft.querySelectorAll("[data-dep]").forEach((ch) => ch.addEventListener("click", () => { const [cid, did] = ch.dataset.dep.split("|"); toggleDep(cid, did); }));
  updatePickCount();
}
function togglePick(id) {
  const i = pickIndex(id);
  if (i >= 0) { wizPicks.splice(i, 1); wizPicks.forEach((p) => p.deps.delete(id)); }
  else wizPicks.push({ cardId: id, deps: new Set() });
  renderDraft();
}
function toggleDep(cid, did) { const p = wizPicks[pickIndex(cid)]; if (!p) return; p.deps.has(did) ? p.deps.delete(did) : p.deps.add(did); renderDraft(); }
function updatePickCount() { document.getElementById("pickCount").textContent = "выбрано " + wizPicks.length; }
let wizPreflight = { blockers: [], floor: [], forks: [] };
async function renderGate() {
  const g = document.getElementById("gate"), project = document.getElementById("lProject").value, n = wizPicks.length;
  if (!n) { g.innerHTML = `<div class="gate-empty">Не выбрано ни одной карточки — вернись на шаг 2.</div>`; return; }
  g.innerHTML = `<div class="gate-empty">Свожу развилки/блокеры/пол…</div>`;
  try { wizPreflight = await api("/api/plans/preflight", { method: "POST", body: JSON.stringify({ project, cardIds: wizPicks.map((p) => p.cardId) }) }); }
  catch { wizPreflight = { blockers: [], floor: [], forks: [] }; }
  const composeItem = `<div class="gate-item"><span class="gate-item__type">состав</span><div class="gate-item__q">${esc(project)} · ${n} этап(ов) · режим ${wizMode === "auto" ? "Auto" : "Ask"} · ветка autodev/plan-…</div></div>`;
  // blockers/forks — the human picks once here; the choice rides every stage seed (§2 Фаза 1)
  const gateItems = [...(wizPreflight.blockers || []), ...(wizPreflight.forks || [])].map((it) => {
    const opts = (it.options || []).map((o) => `<label class="opt"><input type="radio" name="gate-${esc(it.id)}" value="${esc(o.id)}" data-gate="${esc(it.id)}" data-q="${esc(it.q)}" data-title="${esc(o.title)}" ${o.recommended ? "checked" : ""}/><div class="opt__title">${esc(o.title)}${o.recommended ? `<span class="opt__rec">рекомендуем</span>` : ""}</div></label>`).join("");
    const kind = it.type === "blocker" ? "gate-item--blocker" : "gate-item--fork";
    return `<div class="gate-item ${kind}"><span class="gate-item__type">${it.type === "blocker" ? "блокер" : "развилка"}</span><div class="gate-item__q">${esc(it.q)}</div>${opts}</div>`;
  }).join("");
  const floor = (wizPreflight.floor || []).length
    ? `<div class="gate-item gate-item--floor"><span class="gate-item__type">пол</span><div class="gate-item__q">Жёсткий пол (§5.3) — нужна подпись человека:</div>${wizPreflight.floor.map((f) => `<div class="lnote" style="color:#a8362e">• ${esc(f.class)}: ${esc(f.detail)}</div>`).join("")}</div>`
    : "";
  const rows = wizPicks.map((p, i) => {
    const c = cardById(p.cardId), deps = [...p.deps].map((d) => `S${pickIndex(d) + 1}`).join(", ") || "—";
    return `<div class="stagerow" data-on="1"><span class="stagerow__id">S${i + 1}</span><span class="stagerow__t">${esc(c ? c.theme : "")}</span><span class="stagerow__col" style="color:var(--ink-faint)">deps: ${esc(deps)}</span></div>`;
  }).join("");
  g.innerHTML = composeItem + gateItems + floor + `<div class="plandraft">${rows}</div>`
    + `<p class="lnote" style="margin-top:8px;color:var(--ink-faint)">Решения выше принимаются РАЗ на уровне прогона и прописываются в seed каждой карточки — этапы их НЕ переспрашивают.</p>`;
}
function collectGateDecisions() {
  return [...document.querySelectorAll('#gate input[type="radio"][data-gate]:checked')].map((el) => ({ id: el.dataset.gate, q: el.dataset.q, choice: el.value, chosenTitle: el.dataset.title }));
}
async function fireLaunch(btn) {
  const project = document.getElementById("lProject").value;
  if (!project || !wizPicks.length) { toast("Выбери проект и хотя бы одну карточку"); return; }
  const stages = wizPicks.map((p) => ({ cardId: p.cardId, dependsOn: [...p.deps] }));
  const decisions = collectGateDecisions();
  btn.disabled = true; btn.textContent = "Запускаю…";
  try {
    const { plan } = await api("/api/plans", { method: "POST", body: JSON.stringify({ project, goal: document.getElementById("lGoal").value.trim(), mode: wizMode, stages, decisions }) });
    launchEl.hidden = true;
    toast(`⚡ Прогон запущен · <strong>${esc(plan.integrationBranch)}</strong>`);
    loadBoard();
  } catch (err) { btn.disabled = false; btn.textContent = "✅ Утвердить и запустить прогон →"; toast("Не удалось запустить: " + err.message); }
}
document.getElementById("openLaunch").addEventListener("click", openLaunch);
launchEl.querySelectorAll("[data-lclose]").forEach((b) => b.addEventListener("click", () => (launchEl.hidden = true)));
launchEl.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => wizGoto(+b.dataset.go)));
document.querySelectorAll("#lMode .seg__opt").forEach((o) => o.addEventListener("click", () => setWizMode(o.dataset.auto)));
document.getElementById("lProject").addEventListener("change", () => { wizPicks = []; syncProjName(); if (wizStep === 2) renderDraft(); });
document.getElementById("toBoard").addEventListener("click", () => { launchEl.hidden = true; openComposer(null); });
document.getElementById("fire").addEventListener("click", (e) => fireLaunch(e.currentTarget));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !launchEl.hidden) launchEl.hidden = true; });

// ── run viewer (План · Лог) ──────────────────────────────────────────────────
const logBody = document.getElementById("logBody"), logMeta = document.getElementById("logMeta");
const planStatus = document.getElementById("planStatus"), planDoc = document.getElementById("planDoc");
const planView = document.getElementById("planView"), logView = document.getElementById("logView");
let logCardId = null, logTimer = null, runTab = "plan";
function openLog(id) {
  closeAll(); logCardId = id; sheets.log.hidden = false;
  setRunTab(runTab);
  logTimer = setInterval(runTick, 2000);
}
function setRunTab(tab) {
  runTab = tab;
  planView.hidden = tab !== "plan"; logView.hidden = tab !== "log";
  document.querySelectorAll("[data-runtab]").forEach((b) => b.classList.toggle("is-active", b.dataset.runtab === tab));
  runTick();
}
function runTick() { if (runTab === "plan") fetchPlan(); else fetchLog(); }
document.querySelectorAll("[data-runtab]").forEach((b) => b.addEventListener("click", () => setRunTab(b.dataset.runtab)));

// done isn't a station; render it with the terminal (ready) lamp
function planLamp(col) { return ((STATIONS[col] || (col === "done" ? STATIONS.ready : STATIONS.backlog)).c); }
const MSTAT = { todo: "—", "in-progress": "в работе", done: "✓ готов" };

async function fetchPlan() {
  if (!logCardId) return;
  try {
    const r = await api(`/api/tasks/${logCardId}/plan`);
    const ms = (r.milestones || []).map((m) =>
      `<span class="mstone" style="--lc:${planLamp(m.status === "done" ? "done" : m.status === "in-progress" ? "implementing" : "todo")}">${esc(m.id)} · ${esc(m.title || "")} <em>${esc(MSTAT[m.status] || m.status || "")}</em></span>`).join("");
    const cards = (r.cards || []).map((c) =>
      `<li class="pcard"><span class="station__lamp" style="color:${planLamp(c.column)}"></span>` +
      `<span class="pcard__id">${esc(c.id)}</span>` +
      `<span class="pcard__t">${esc(c.title || "")}</span>` +
      `<span class="pcard__col" style="color:${planLamp(c.column)}">${esc(c.column)}</span>` +
      (c.verdict ? `<span class="pcard__v">${esc(c.verdict)}</span>` : "") + `</li>`).join("");
    const live = r.pidAlive ? `<span class="logmeta__lamp" style="color:var(--s-ready)"></span>процесс жив` : `<span class="logmeta__lamp" style="color:var(--s-blocked)"></span>остановлен`;
    planStatus.innerHTML = (ms ? `<div class="mstones">${ms}</div>` : "") +
      (cards ? `<ul class="pcards">${cards}</ul>` : `<div class="planempty">Декомпозиция ещё не записана…</div>`) +
      `<div class="planlive">${live} · этап: ${esc(r.column || "—")}</div>`;
    planDoc.textContent = r.developmentPlan || r.requirements || "(DevelopmentPlan.md ещё не создан)";
  } catch (err) { planStatus.innerHTML = ""; planDoc.textContent = "Не удалось загрузить план: " + err.message; }
}
async function fetchLog() {
  if (!logCardId) return;
  try {
    const r = await api(`/api/tasks/${logCardId}/log`);
    logMeta.innerHTML = `<span>${esc(r.file || "—")}</span><span>· ${esc(r.column || "")}</span><span class="logmeta__lamp" style="color:${r.pidAlive ? "var(--s-ready)" : "var(--s-blocked)"}"></span><span>${r.pidAlive ? "процесс жив" : "остановлен"}</span>`;
    const atBottom = logBody.scrollTop + logBody.clientHeight >= logBody.scrollHeight - 24;
    logBody.textContent = r.log || "(пусто)";
    if (atBottom) logBody.scrollTop = logBody.scrollHeight;
  } catch (err) { logBody.textContent = "Не удалось загрузить лог: " + err.message; }
}

// ── toast ────────────────────────────────────────────────────────────────
const toastEl = document.getElementById("toast"); let toastTimer = null;
function toast(html) { toastEl.innerHTML = html; toastEl.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (toastEl.hidden = true), 3400); }

// ── live refresh ─────────────────────────────────────────────────────────
const loadBoard = () => api("/api/board").then((b) => { state = b; render(); });
function anySheetOpen() { return Object.values(sheets).some((s) => !s.hidden); }
async function refresh() {
  if (dragId) return;
  if (!sheets.composer.hidden) return;               // never wipe a half-typed task
  if (document.activeElement && document.activeElement.closest && document.activeElement.closest("#askPanel")) return; // nor a half-typed answer
  try {
    const b = await api("/api/board");
    if (b.updatedAt === state.updatedAt) return;
    state = b;
    // keep an open detail/ask drawer in sync without clobbering input
    if (!sheets.detail.hidden && openDetailId) { if (cardById(openDetailId)) openDetail(openDetailId); else closeAll(); }
    else if (!sheets.ask.hidden && openAskId) {
      const card = cardById(openAskId);
      if (!card) closeAll();
      else { const sig = JSON.stringify([askState(card), (card.questions || []).length, (card.archQuestions || []).length]); if (sig !== askSig) { openAsk(openAskId); } }
    }
    render();
  } catch { /* transient */ }
}
setInterval(refresh, 2500);

loadBoard().catch((err) => toast("Не удалось загрузить доску: " + err.message));
