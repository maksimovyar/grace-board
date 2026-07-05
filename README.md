# grace-board

A local kanban **dispatch board** for the [`grace-feature-dev`](.claude/skills/grace-feature-dev)
pipeline. Accumulate tasks in **Backlog**; drag a card across the **launch lever** and
the team of agents picks it up — the card then rides the stations on its own, from
questions through implementation, verification and review, to *Ready for deploy*.

Zero dependencies, no build step — plain Node ≥ 18, bound to `127.0.0.1` (local only).

![the board](board-screenshot.png)

## What's in this repo

| Path | What it is |
|---|---|
| `server.js`, `public/` | the board — a zero-dependency Node HTTP server + static UI |
| `.claude/commands/grace-feature-dev.md` | the `/grace-feature-dev` slash command |
| `.claude/agents/gfd-*.md` | the pipeline's sub-agents (architect, coder, explorer, reviewer, verifier) |
| `.claude/skills/grace-feature-dev` | the pipeline skill — board lifecycle, build phases, GRACE markup, anti-loop |
| `install.sh` | links the command/agents/skill into your `~/.claude` |

> The board is a **dispatcher**: it spawns `claude -p "/grace-feature-dev …"` runs
> inside your *target* project. Those runs resolve the command, agents and skills from
> your **user-level** Claude config (`~/.claude`) — not from this repo. That's why the
> extensions are bundled here **and** installed into `~/.claude` by `install.sh`.

## Why GRACE — the method behind the board

GRACE (a methodology by Vladimir Ivanov) works *with* how an LLM actually behaves — a
semantic processor that reads strictly left-to-right and whose attention silently
degrades on long context — instead of anthropomorphizing it. Most user mistakes come
from treating it like a human; the board and the `grace-feature-dev` pipeline encode the
principles that avoid them. What you get out of it:

- **Embedded documentation (a "semantic exoskeleton") instead of separate docs.**
  Standalone docs have a ~45% chance of never being read by the agent, and once they
  drift from the code they *poison* the context — the model builds its picture from the
  doc, not the code. Docs written *into* the code can't be skipped, run ~20–30% of the
  code size (≈3× smaller than standalone docs), and **cut tokens** — the expensive tokens
  are generation, not reading. That's the **GRACE markup** toggle: it documents only what
  isn't visible from the code (intent, design rationale, module map, use cases), not the
  algorithm itself.

- **Goal first, then decomposition.** Goal-alignment outranks your instructions, so a run
  states its goal up front, then splits the root goal into a tree of subgoals — the
  board's cards. Setting the *root* goal is the one thing the model won't do on its own
  (left alone it drifts to inaction); that's your job in **Backlog**.

- **Superposition of hypotheses, not rework.** An LLM has no good way to "change its
  mind" — reversing a decision risks hallucination and a jump backwards. So instead of
  redoing work, the **Asking · architecture** gate presents each fork as **2–4 variants
  with pros/cons and a recommended pick**; choosing one just re-weights the options, which
  is cheap for the model (3–5 hypotheses is the sweet spot for code).

- **Decisions locked before code is generated.** Backtracking is expensive for a model:
  a reversed decision doesn't get erased, it lingers in the context as a contradiction and
  drags quality down (the same context-poisoning as drifted docs). So the pipeline
  front-loads every choice while the context is still "clean" — discovery → clarify →
  architecture — and only then generates code, straight through, in one direction:
  implement → verify → review. The payoff: no costly rewrites of already-generated code,
  no half-old/half-new plan muddying the context, and cheaper, more predictable runs. The
  flexibility you'd normally get from iterating is provided *before* the build instead — by
  the 2–4 architecture variants you pick from, which cost the model almost nothing to
  switch between.

- **Structured context for distributed attention.** Past ~10–20k tokens attention grows
  "holes" (up to 96%) and the model quietly gets dumber *while reporting all-is-well*.
  Paired tags/anchors and keyword saturation — in code **and** logs — keep a session
  coherent across 200–300k tokens and let agents navigate by grep. The GRACE markup
  carries this.

- **Independent verification (the board never lies).** Because the model claims "all
  good" even when it isn't, trust isn't enough. The **Verify** phase runs a *separate*
  agent doing Semantic Trace Verification — does the real execution path in the logs match
  the planned data flow? — backed by green checkpoints that make each card an atomic
  rollback point.

> Distilled from the GRACE methodology notes (V. Ivanov). The short version: causal
> reading (only ever backwards) · goal outranks your instructions (it silently ignores
> what it deems low-quality) · long-context attention gets dumber and lies about it · give
> it vector capacity to think · stack choice matters more than requirements.

## Quick start

Requires [Claude Code](https://claude.com/claude-code) (the `claude` CLI) and Node ≥ 18.

```bash
git clone https://github.com/maksimovyar/grace-board.git
cd grace-board

# 1) install the /grace-feature-dev command, gfd-* agents and the skill into ~/.claude
./install.sh

# 2) configure (optional — sane defaults otherwise)
cp .env.example .env        # then edit GRACE_PROJECTS_ROOT / GRACE_CLAUDE_BIN

# 3) run the board
npm start                   # or: node server.js
# → http://127.0.0.1:4317
```

`install.sh` **symlinks** each extension into `~/.claude/{commands,agents,skills}`, so a
later `git pull` keeps them current. Pre-existing, non-symlink files are never
overwritten. Start a fresh Claude Code session afterwards so it picks up the command.

### Configuration (env vars / `.env`)

`.env` in the repo root is auto-loaded on start; exported environment variables win
over it. See [`.env.example`](.env.example).

| var | default | meaning |
|---|---|---|
| `GRACE_BOARD_PORT` | `4317` | port the board listens on (loopback only) |
| `GRACE_PROJECTS_ROOT` | `~/Projects` | root your projects live under; a task's project must resolve inside it |
| `GRACE_CLAUDE_BIN` | `~/.local/bin/claude` | path to the Claude CLI the server spawns |
| `GRACE_BIN_PATH` | derived | extra `PATH` for spawned runs, if `claude`/`node` aren't on it |
| `GRACE_AUTORUN` | on | set `0` to disable auto-launch (dispatch then only seeds) |
| `GRACE_STALL_MIN` | `120` | minutes a phase may stall before the watchdog steps in |

## Stations (= the grace-feature-dev build phases)

```
01 Backlog ─┤launch lever├─ 02 To do → 03 Asking → 04 Implementing → 05 Verifying → 06 Reviewing → 07 Ready for deploy     · Blocked
```

- **Backlog** — the only station you add to. Tasks wait here until you're ready.
- **Launch lever** — dragging a card OUT of Backlog **dispatches** it: the card is
  stamped, a `dispatch` event is logged, a `board.json` seed is written into the
  project, and the run starts.
- **Asking** — the two-block HITL gate (see below). The card waits on you here.
- **Implementing → Verifying → Reviewing** — the agent-held build phases; the card's
  lamp pulses while a `gfd-*` agent works it.
- **Ready for deploy** — terminal: all gates green.
- **Blocked** — a side state for cards that need you (run died/stalled twice, anti-loop tripped).

## Creating tasks

**+ New task** opens a composer with: **Project** (folder under your projects root,
required), **Theme** (the headline the team builds against, required), **Description**
(detail, up to 2000 chars), **Design link** & **Requirements link** (optional),
**Attachments** (screenshots / requirements files, ≤ 8 MB each), and the **GRACE
markup** toggle. A Backlog task can be re-opened and **edited** until you dispatch it.

## Asking — the two-block gate

The process always asks before it builds. After dispatch the run does discovery and
stops at **Asking**, which has two blocks:

1. **Functional** — the agent posts questions about *what* to build; you answer them
   on the card.
2. **Architecture** — the agent then proposes, for each fork (storage, stack,
   integrations, …), **2–4 variant options with pros/cons** and a recommended pick.
   You choose one per decision (or write your own), then **launch the build**.

Only after both blocks does the build run to **Ready for deploy**. (If the agent
decides no architecture forks are needed, it proceeds straight to the build.)

## How dispatch connects to the pipeline (auto-launch)

On dispatch the server:

1. writes a pipeline seed `<project>/.grace-feature-dev/<slug>/board.json`
   (creating the project dir for a greenfield task) + an audit line in
   `data/dispatch-log.ndjson`, and
2. **spawns a headless, autonomous `claude -p "/grace-feature-dev …"` run** in the
   project. Dispatch runs the **Asking · functional** step (posts questions, stops);
   answering launches **Asking · architecture** (posts decisions, stops); choosing
   launches the **build**. Each run writes the seed's top-level `column` **at the
   start of each phase**; the server polls that file and mirrors the column onto the
   kanban card — so the card advances **on its own**.

### Self-healing supervision (the board never lies)

A launched run is **watched**, not fire-and-forget. The server tracks the run's pid
and the time of the last phase change, and adds two layers of resilience (**LA4**):

- **Green checkpoints** — each time a decomposed card passes verify **and** review, the
  run makes a micro-commit `green(<cardId>): …` on the feature branch `autodev/<slug>`,
  staging **only** that card's files. The build stays "always green" and every card is
  an atomic rollback point (`git restore --source=<sha> -- <file>`).
- **Auto-heal** — if a run **dies without reaching `ready`** or **stalls** past
  `GRACE_STALL_MIN`, the watchdog **auto-relaunches it once**, injecting a RECOVERY
  context (the tail of the dead run's log) so the resumed run self-diagnoses and
  continues from the furthest green checkpoint. Only a **second** consecutive failure
  moves the card to **Blocked**. (Asking is exempt — there the run has exited by design
  and is waiting on you.)

From a dispatched card you can **⊟ log** (tail the run's log live) and **↻ relaunch**
(manually re-spawn from the furthest-reached step, reusing saved answers/decisions).

> ⚠️ **The launched run uses `--permission-mode bypassPermissions`** — it writes files
> and runs commands autonomously with no prompts, scoped to the project dir
> (`--add-dir`). That is what "drag right → the team works" requires, but it means
> **every dispatch runs unattended code**. The server only accepts mutating requests
> from its own loopback origin (CSRF guard) and confines every task's project to
> `GRACE_PROJECTS_ROOT`. Disable auto-launch with `GRACE_AUTORUN=0` to launch by hand.

## Storage

All board state lives in `data/board.json` (single source of truth, git-ignored).
Deleting it resets the board.

## License

[MIT](LICENSE) © maksimovyar
