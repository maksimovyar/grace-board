---
description: feature-dev's engine + GRACE markup + an autonomous kanban board. Interactive understand/clarify/architecture up front, then the feature rides a board.json through build phases autonomously.
argument-hint: Optional feature description (and optionally --rigor grace|light|off, --mode inline|hybrid|fanout)
---

# grace-feature-dev

You are running the **grace-feature-dev** pipeline. The engine is feature-dev —
keep its speed and quality: deep codebase understanding, clarifying questions,
superposition of architectures, and **inline implementation by you (the main
thread) with full context**. On top of that engine this pipeline adds exactly two
things:

1. **GRACE markup** — a semantic exoskeleton + LDD logs on the code you write
   (conditional on `rigor`).
2. **An autonomous kanban board** — after the architecture gate the feature is
   decomposed into `board.json` and driven through build phases **autonomously,
   not turn-by-turn in chat**, with durable on-disk state that survives `/compact`.

You do **not** hand off to autodev's wave-loop. The `gfd-*` agents and your own
inline coding are the engine.

**Load the spec first:** `Skill(grace-feature-dev)` — it defines `board.json`, the
card lifecycle (kanban columns = build phases), the markup template, the LDD
format, and the Anti-Loop rule. Treat that skill as the single source of truth for
all formats; this command is the control flow.

Initial request: $ARGUMENTS

---

## Settings (resolve once, store in board.json)

- `--rigor grace|light|off` — markup intensity. **Default: `off` inside a mature
  repo with its own style; `grace` on greenfield.** If unclear, ask once.
- `--mode inline|hybrid|fanout` — how the build loop executes cards.
  **Default: `inline`** (you write every card with full context — preserves
  feature-dev quality). `hybrid` = first wave inline, then fan out `gfd-coder`
  subagents once conventions are validated. `fanout` = a `gfd-coder` per card from
  the start (for large features that exceed one context). If unclear, default to
  `inline` and say so.

---

## Phase 1 — Discovery  (interactive)

1. Create a todo list mirroring these phases (for your own tracking).
2. If the feature is unclear, ask: what problem, what it should do, constraints.
3. Compute a `slug`, confirm understanding with the user.

## Phase 2 — Exploration  (interactive)

Launch 2-3 **`gfd-explorer`** agents in parallel, each on a different aspect
(similar features / architecture & abstractions / UI & test patterns). They
navigate cheaply (grep by `GREP_SUMMARY` first) and each returns 5-10 key files.
Read those files. Present a findings summary.

## Phase 3 — Clarify  **[HITL GATE 1]**

Identify every ambiguity (edge cases, error handling, integration points, scope,
backward-compat, perf). Present an organized question list. **Wait for answers.**
Then write `.grace-feature-dev/<slug>/requirements.md` (structured requirements +
measurable acceptance criteria with ids). This artifact is swarm memory — do not
keep requirements only in chat.

## Phase 4 — Architecture  **[HITL GATE 2]**

1. Launch 2-3 **`gfd-architect`** agents in parallel (minimal-change / clean /
   pragmatic). Each must emit its blueprint as **two orthogonal projections**:
   a **DraftCodeGraph** (modules/files/calls) and a **step-by-step Data Flow**.
   A component present in one projection but not the other = a caught
   hallucination; reconcile before proceeding.
2. Hold the alternatives in superposition, score on explicit 1-10 axes
   (maintainability / min-change / risk / speed), then **collapse** to one.
3. Present the recommendation + trade-offs. **Ask the user to approve.**
4. On approval write `.grace-feature-dev/<slug>/DevelopmentPlan.md` (the chosen
   DraftCodeGraph + Data Flow + acceptance criteria + a list of vertical slices).

## Phase 4.5 — Decompose → board.json  (no gate)

Turn `DevelopmentPlan.md` into `.grace-feature-dev/<slug>/board.json` per the
Skill schema:
- Cut **milestones** as vertical shippable slices (not horizontal layers).
- One **card per slice**: `files[]`, `deps`, `acceptance[]`, `wave`, `rationale`.
- Enforce the file-disjoint invariant; emit a first `contract-types` card for
  shared types when needed.
- **Resolve `board.verifyGate`** — the reproduced strict build/test command for this
  project's stack (inspect `package.json` scripts / build tooling). E.g. Next.js/TS:
  `npx tsc --noEmit && <test> && next build`. This is what Verify runs in the clean
  snapshot (Skill §2.1/§6); a non-zero exit fails the card. Store it on `board.json`.
- All cards start `column: backlog`; set ready cards (deps met) to `todo`.
- Set `board.phase = "build"`. Append a `decompose` event to `progress.ndjson`.
- Show the user the initial board (a compact kanban view, see "Board rendering").

## Phases 5-6 — Build loop  (AUTONOMOUS — drive the board, don't ask per card)

Loop until no card is `todo`/`backlog`-ready or a card is `blocked`:

1. **Pick** the next `todo` card whose `deps` are all `done`. In `fanout`/`hybrid`
   you may pick several file-disjoint same-wave cards at once.
2. **implementing** — move card to `implementing`, persist board, journal it.
   - `inline`: you implement it yourself with full context.
   - `fanout`/`hybrid`: spawn **`gfd-coder`** (fresh context) seeded with the
     card, `requirements.md`, `DevelopmentPlan.md`, and the markup rules.
   - Apply markup per `rigor` (Skill §3). Leave `BUG_FIX_CONTEXT` scars on fixes.
   - Unless `rigor: off`, write the card's **`test_guide-<cardId>.md`** (Skill §2.6:
     input data · verification queries · expected `[IMP:9-10]` markers) and add it
     to `card.artifacts[]` — it is the coder→verifier contract.
3. **verifying (against the clean snapshot, not the working tree)** — move to
   `verifying`. First materialize the snapshot (Skill §2.1): `git add -- <files[]>`,
   `git write-tree` → `git commit-tree` → `git worktree add --detach <wt> <snap>`,
   symlink `node_modules`. Spawn **`gfd-verifier`** (read-only) pointed at `<wt>`: it
   runs `board.verifyGate` first (**non-zero exit = fail** — this is where an untracked
   dependency that resolves on disk but is absent from git surfaces), then loads the
   card's `test_guide-<cardId>.md`, runs the Diagnostic Trio + Semantic Trace
   Verification (`[IMP:9]` when `rigor != off`; else behavior/ACs) + Chain-of-
   Verification. A missing test_guide when `rigor != off` is itself a failure.
   Returns a Bug Report.
4. **reviewing** — move to `reviewing`. Spawn **`gfd-reviewer`** ×(1-3 by card
   weight) in parallel (simplicity/DRY · bugs/correctness · conventions). When
   `rigor != off` (and not pure `inline`), **always allocate one reviewer to the
   conventions/GRACE-markup focus** (Skill §6) — markup violations are Critical.
   Only confidence ≥ 80 findings count.
5. **Resolve** (the commit is the LAST step — only on green, never before Verify):
   - Verify+Review green → the snapshot index already *is* `files[]`, so commit it to
     `autodev/<slug>` as the green-checkpoint: `git commit -m "green(<cardId>): <short
     title>"`, then `git worktree remove <wt> --force`. Move card to `done`, record
     `verdict`, journal it. See Skill §2.1.
   - Any failure → `git worktree remove <wt> --force` + `git reset -- <files[]>`
     (unstage, keep the edits), move card back to `implementing` and fix. **Nothing is
     committed on a red card.** Update the **Anti-Loop** counter by failure
     **signature** (Skill §4). At `attempts ≥ antiLoop.max`, set card `blocked`, stop
     the loop, and escalate to the human (the only return to chat during build).
6. Re-evaluate `backlog` cards: any whose deps just became `done` → `todo`.
7. Persist `board.json` after **every** transition; the board is the only state.
   **Board sync (this is what makes the kanban move on its own):** the per-task
   `board.json` carries a **top-level `column`** field. Each time you move the work
   into a new build phase (`implementing` → `verifying` → `reviewing` → `done`, or
   `blocked`), set that top-level `column` and re-write `board.json`. The grace-board
   server polls this file and mirrors the value onto the dispatched kanban card —
   so the card advances automatically as you work, with **no manual moves and
   nothing typed in chat**. Also keep `phase` current. Do this as a defined step at
   every boundary, not ad-hoc.

If a card reveals new work, do not silently expand it — add it to `backlog` with
deps and (if it changes the architecture) re-open Phase 4 for that slice.

## Phase 7 — Summary

When all cards are `done` (or the run is `blocked`), write a summary from
`board.json` + `progress.ndjson`: what was built (per AC: met/partial/not),
key collapsed decisions, files changed, the final board, gaps/escalations.
Be honest — never claim "verified" for something only statically checked.

---

## Board rendering (show the user a kanban when useful)

Render `board.json` as columns so movement is visible:

```
BACKLOG    TODO         IMPLEMENTING   VERIFYING   REVIEWING   DONE        BLOCKED
t5 cfg     t3 api       t2 engine      —           t1 db       t0 types    —
```
Show it after decompose, on request, and at summary.

## Resume

On invocation, if `.grace-feature-dev/<slug>/board.json` exists, read it (+ the
journal tail) and **continue from live state** — skip `done` cards, resume the
last in-flight card. Never restart a `done` card.

## Discipline

- The board file is the single source of truth — **do not** mirror the task list
  in chat or TodoWrite.
- Phases 1-4 are interactive (HITL gates 1 & 2). Phases 5-6 are autonomous.
- Keep feature-dev's strengths: understand before acting, ask early, implement
  cleanly inline by default.
