---
name: grace-feature-dev
description: Canonical board + phase + markup spec for the grace-feature-dev pipeline. Load when the /grace-feature-dev command (or its agents) needs the board.json schema, the kanban lifecycle (how a card moves through build phases), the run-level phase state machine, the GRACE semantic-exoskeleton markup template, the LDD log format, or the Anti-Loop signature rule. This file is the single source of truth for those formats.
---

# grace-feature-dev — board, phases & markup spec

This skill is the **reference contract** for the `/grace-feature-dev` pipeline.
The orchestrator (the command) and every `gfd-*` agent read formats from here so
they agree byte-for-byte. It defines four things:

1. The **run-level phase machine** (the feature's journey).
2. The **kanban board** (`board.json`) and the **card lifecycle** (how a card moves
   through the build phases — the autonomous part).
3. The **GRACE markup** (semantic exoskeleton + LDD), applied conditionally by `rigor`.
4. The **Anti-Loop** signature rule.

Core stance: **feature-dev is the engine.** This pipeline keeps feature-dev's
explore → architect → implement(inline) → review machinery and quality. It only
adds (a) durable artifacts + a board so the build runs **autonomously, not only in
chat**, and (b) optional **markup + trace verification**. It does NOT delegate to
autodev's wave-loop.

---

## 1. Run-level phases (the feature's journey)

```
discovery → exploration → clarify[GATE] → architecture[GATE] → decompose → build → summary
                                                                              │
                                          (build is the AUTONOMOUS card loop) ┘
```

- `clarify` and `architecture` are the **only two HITL gates**. After the human
  approves the architecture, the feature **rides the board autonomously** through
  `build`; the human is consulted again only on a `blocked` card or at `summary`.
- The run-level phase is stored in `board.phase`.

`board.phase ∈ discovery | exploration | clarify | architecture | decompose | build | summary`

---

## 2. The board — `board.json`

Location (in the **target project**, never in `~/.claude`):
```
.grace-feature-dev/<feature-slug>/board.json        ← canonical run state (single source of truth)
.grace-feature-dev/<feature-slug>/progress.ndjson   ← append-only event journal
.grace-feature-dev/<feature-slug>/requirements.md   ← swarm-memory artifact (from clarify)
.grace-feature-dev/<feature-slug>/DevelopmentPlan.md← swarm-memory artifact (from architecture)
.grace-feature-dev/<feature-slug>/app.log           ← LDD trace (when rigor != off)
.grace-feature-dev/<feature-slug>/test_guide-<cardId>.md ← per-card verification contract (coder → verifier, §2.6)
```

**board.json is the ONE source of truth.** The task list is NOT kept in chat or
TodoWrite — it is read from / written to this file. Anything else describing
"what's left" is a projection of this file. This is what makes the run survive
`/compact` and crashes (a `done` card is never re-run).

### Schema

```jsonc
{
  "feature": "Human-readable feature title",
  "slug": "kebab-feature-slug",
  "createdAt": "<iso>",
  "phase": "build",                       // run-level phase (§1)
  "column": "implementing",               // current kanban column — the dispatch board mirrors THIS (§2.4)
  "rigor": "grace",                       // grace | light | off  (§3)
  "mode": "inline",                       // inline | hybrid | fanout  (§ command)
  "gates": { "clarify": "approved", "architecture": "approved" },
  "antiLoop": { "max": 3 },               // §4

  "milestones": [
    { "id": "m1", "title": "vertical shippable slice", "status": "todo" }  // todo|in-progress|done
  ],

  "cards": [
    {
      "id": "t1",
      "title": "Persistence layer for export",
      "milestone": "m1",
      "wave": 1,                          // dependency layer; same-wave cards may run in parallel
      "column": "todo",                   // KANBAN column — the card's build phase (§2.1)
      "files": ["src/db/export.py"],      // write-isolation unit (§2.2)
      "deps": [],                         // card ids that must be `done` first
      "acceptance": ["AC1", "AC3"],       // acceptance-criteria ids from DevelopmentPlan.md
      "rationale": "why this slice exists",
      "attempts": 0,                      // anti-loop counter (§4)
      "failSig": null,                    // last failure signature (§4)
      "verdict": null,                    // filled on done/blocked: short result + artifact paths
      "artifacts": []                     // files/logs this card produced
    }
  ]
}
```

### 2.1 Kanban columns = the card's movement through build phases

A card moves left-to-right through the build phases. **This is the "движение по
фазам фичи".** Columns:

```
backlog → todo → clarifying → implementing → verifying → reviewing → done
                       └──────────────── blocked (side state) ────────────────────┘
```

| Column | Meaning | Phase it represents |
|---|---|---|
| `backlog` | known but not ready (a dep is unmet, or a later wave) | — |
| `todo` | ready to start (all `deps` are `done`) | queued |
| `clarifying` | the clarify run posted questions; **waiting on the human's answers** | Phase 3 Clarify (HITL) |
| `implementing` | being built right now | Phase 5 Implement |
| `verifying` | tests + Semantic Trace running | Phase 5.5 Verify |
| `reviewing` | static review + fix cycle | Phase 6 Review |
| `done` | all required gates green; `verdict` recorded | finished |
| `blocked` | cannot proceed (anti-loop tripped / missing input / needs human) | escalation |

**Transition rules (the state machine):**
- Forward only: `backlog → todo → implementing → verifying → reviewing → done`.
- A failed Verify or Review sends the card **back to `implementing`** (fix), and
  increments the anti-loop counter (§4) — NOT to `blocked` yet.
- `blocked` is reachable from any active column when anti-loop trips or input is
  missing. It carries the reason in `verdict`. It returns to `implementing`/`todo`
  once unblocked.
- A `done` card is **never** re-run.

**Green-checkpoint on `done` (LA4 "вечно зелёный билд" + rollback points):** the moment
a card's gates go green and it moves to `done`, the orchestrator makes a micro-commit on
the feature branch `autodev/<slug>`:

```
git add <only this card's files[]>      # NEVER `git add .` / `-A` — keep the checkpoint atomic
git commit -m "green(<cardId>): <short title>"
```

Rules: commit **only** on a green card — a failed Verify/Review (card back to
`implementing`, or `blocked` on Anti-Loop) does **not** commit, and the last green
checkpoint is left untouched so a human can continue from it. These commits are atomic
rollback points (`git restore --source=<sha> -- <file>`); the single final `push` before
the feature reaches `ready` goes to the **same** branch and does not replace them.

**Who writes transitions:**
- The **orchestrator is the only writer** during the autonomous loop. It moves
  every card and persists the change to `board.json`, then appends an event to
  `progress.ndjson`.
- **One human-owned exception** (escort mode): a human may flip a card
  `todo → implementing` as a *launch trigger* ("start this one now"). No other
  human transition is part of the protocol.

### 2.2 Parallelism invariant (file-disjoint)

Cards that run **in parallel within a wave MUST have non-overlapping `files[]`**.
Anything several cards need (shared types/utilities) is produced by **one
`contract-types` card scheduled first in the wave**; the rest only read it. Cards
that cannot be made file-disjoint are linked by a `deps` edge and run
**sequentially**. (Only relevant in `fanout`/`hybrid` mode; in `inline` mode the
main thread does one card at a time anyway, but the invariant still governs which
cards *may* be parallelized when scaling out.)

### 2.5 Clarify step — questions on the board (HITL, even when headless)

The process always asks before it builds — this is the gate that prevents
under-scoped results (e.g. shipping a localStorage toy when a full stack was meant).
When launched by a grace-board dispatch it runs in **two phases**:

1. **Clarify run** (on dispatch): does discovery, writes a top-level `questions`
   array (3-6 short strings) into `board.json`, sets `column: "clarifying"`, and
   **stops** — no design, no build. grace-board mirrors the questions onto the card.
2. The human answers on the board. The server pairs answers with questions into
   `board.json.answers` (`[{q,a}]`), sets `column: "implementing"`, and launches the
3. **Build run**, which gets the Q&A in its prompt and runs architecture (the
   **architect chooses the stack** — never pre-assumed) → decompose → implement →
   verify → review → done.

`questions` and `answers` are top-level fields on `board.json` alongside `column`.

### 2.4 Board sync — how the kanban moves automatically

The dispatch UI (grace-board) is a **live projection** of this file, not a thing you
move by hand. Contract:

- This `board.json` carries a **top-level `column`** (one of the lifecycle columns
  in §2.1). It is the feature's current kanban column.
- The orchestrator updates `column` (and `phase`) **at every build-phase boundary**
  as a defined step — `todo → implementing → verifying → reviewing → done` (or
  `blocked`) — and re-writes the file.
- The grace-board server polls `<project>/.grace-feature-dev/<slug>/board.json` and
  mirrors `column` onto the dispatched card. The card therefore advances **on its
  own** while the pipeline works — no manual drags, nothing typed in chat. The human
  only ever performs the one launch-trigger drag out of Backlog (§2.1).

### 2.3 Milestones = vertical shippable slices

A milestone is a **thin end-to-end increment** that leaves the product coherent —
never a horizontal layer ("all backend"). Decompose along vertical slices.

### 2.6 test_guide — per-card verification contract (coder → verifier bridge)

Unless `rigor: off`, the implementer writes a **`test_guide-<cardId>.md`** for each
card and records its path in `card.artifacts[]`. It is the semantic bridge from the
agent that just wrote the code to the independent verifier — so the verifier
**reads** what counts as correct instead of re-deriving it from the plan + log every
run (cheaper on retries, deterministic across `/compact` and crashes). It contains:

1. **Input data** — the fixtures / params the card's behavior is exercised with.
2. **Verification queries / inspections** — the exact SQL or data checks that prove
   the card did what it claims (e.g. `SELECT COUNT(*) FROM points` and the expected
   value, file existence, response shape).
3. **Expected `[IMP:9-10]` markers** — per business function, the BELIEF lines that
   must appear in `app.log` (this is what makes Green-Test-Trap detection concrete).

The verifier's first step is to load this guide (gfd-verifier §0). A **missing**
guide when `rigor != off` is itself a Verify failure (`missing-test-guide`
signature) — verification without a contract is untrusted.

---

## 3. GRACE markup — conditional by `rigor`

`rigor` is chosen at intake and stored in `board.rigor`:

| `rigor` | When | Markup applied |
|---|---|---|
| `grace` | greenfield, or a repo already using GRACE markers | full exoskeleton + LDD |
| `light` | you want navigability without noise | GREP_SUMMARY + STRUCTURE + BUG_FIX_CONTEXT only |
| `off` | established 3rd-party repo with its own idiom | **none** — write in the repo's style |

> **Never vandalize an existing codebase.** Default to `off` when working inside a
> mature repo with an established style; default to `grace` on greenfield.

### Semantic exoskeleton template (rigor = grace)

Applied to each created/modified module:

```python
# region MODULE_CONTRACT [DOMAIN(X): ...; CONCEPT(Y): ...; TECH(Z): ...]
## @file <name>
## @purpose <WHY this module exists — the need it fills, not what it does>
## @scope <functional areas>
## @io <module-wide input> -> <output>
## @invariants
## - <condition that always holds>
## @rationale
## Q: <why this way?>  A: <justification / rejected alternatives>
## @modulemap
## FUNC <1-10>[role] => <entity_name>
def _module_contract(): pass
# endregion MODULE_CONTRACT
# GREP_SUMMARY: <comma-separated domain + tech + entity keywords for grep navigation>
# STRUCTURE: <one-line mini block diagram, e.g. ▶ validate → ⊕ transform → ⚡ persist → ⎋ result>

# region FUNC_<name> [DOMAIN(X): ...; CONCEPT(Y): ...; TECH(Z): ...]
## @purpose <outcome this function enables — NOT a line-by-line summary>
## @io <in> -> <out>
## @complexity <1-10>
def <name>(...):
    """<one-line block diagram; for complexity > 7 add a short paragraph>"""
    ...
# endregion FUNC_<name>
```

### LDD log format (rigor = grace; emitted to `app.log`)

```
[CLASSIFIER][IMP:1-10][FUNCTION][BLOCK] description [STATUS]
```
- CLASSIFIER ∈ DB | API | CALC | IO | LOGIC | VALIDATION | UI
- IMP: 1-3 Trace · 4-6 Flow · 7-8 I/O · 9-10 Business logic / AI Belief State
- STATUS ∈ OK | FATAL | BELIEF | FLOW | INFO
- Rule: every business function emits at least one `[IMP:9]` BELIEF line — this is
  what Verify checks (a green test with no `[IMP:9]` is the **Green Test Trap**).

### BUG_FIX_CONTEXT scar (all rigor levels except `off`)

Leave at every fix site:
```
# BUG_FIX_CONTEXT: Issue <id>
# Previous: <old approach>
# Problem: <what was wrong>
# Fix: <how fixed>
```

---

## 4. Anti-Loop — signature rule

The orchestrator owns ONE counter per card (`card.attempts` + `card.failSig`):

- Track the **failure signature** (the content: key error / failed AC / finding
  set), **NOT** the gate name.
- **Same signature repeats → `attempts += 1`. A different finding → reset to 1**
  (a reviewer surfacing a *new* problem each pass is progress, not a loop).
- Escalation ladder by `attempts`:
  - 1-2: standard fix checklist.
  - 3: external lookup (docs / WebSearch / context7).
  - 4: WARNING — superposition of causes; list 2-3 alternative diagnoses.
  - ≥ `antiLoop.max` (default 3): set card `blocked`, record reason in `verdict`,
    stop the loop, escalate to the human. This is the only hard stop.

---

## 5. progress.ndjson — append-only journal

One JSON object per line; never rewritten. Records *what happened*; `board.json`
holds *what is true now*. On resume: read `board.json` for live state, use the
journal tail to confirm the last in-flight action.

```json
{"ts":"<iso>","phase":"build","card":"t1","actor":"gfd-verifier","event":"verify","result":"pass","status":"done"}
{"ts":"<iso>","phase":"architecture","actor":"orchestrator","event":"collapse","decision":"chose clean approach","status":"done"}
```

---

## 6. Review & Verify allocation invariants

These govern how the orchestrator spawns the Review/Verify phases — they are part
of the contract, not left to per-run judgement.

- **Verify** (gfd-verifier, once per card): consumes the card's
  `test_guide-<cardId>.md` (§2.6), runs the Diagnostic Trio (Logs/Code/Data),
  performs Semantic Trace Verification, then a Chain-of-Verification self-check
  before emitting the verdict.
- **Review** (gfd-reviewer, 1–3 in parallel per card, after tests are green):
  - When `rigor != off` AND `mode != inline`, **one reviewer is always assigned the
    Conventions / GRACE-markup focus** — it is not optional in the focus lottery.
    Protocol/markup adherence is the highest-priority axis because the artifacts are
    written for other agents (swarm navigation, RAG) before humans.
  - Semantic-exoskeleton violations (missing/!malformed MODULE_CONTRACT, FUNCTION_CONTRACT,
    GREP_SUMMARY, STRUCTURE; abbreviations/`...`/`pass` placeholders) are **Critical**.
  - In `inline` mode the main thread reviews; the same checklist applies but the
    dedicated markup reviewer is not separately spawned.
