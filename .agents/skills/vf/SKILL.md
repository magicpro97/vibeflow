---
name: vf
description: "Drive any task through VibeFlow's local-first CLI (vf) instead of free-handing it. Triggers: /vf, the word vibeflow, orchestrate, init, or a request to set up a repo for AI agents, implement a spec/issue, run a parallel multi-unit workflow, or verify/ship under the confidence gate. SPEC-FIRST: ask the clarifying questions BEFORE running anything that writes or dispatches. /vf with no args → load references/grill.md and grill the user from chat context toward a concrete spec. Wraps vf init / run / orchestrate / units / verify / skills / discover / doctor / hooks."
when_to_load: on any `/vf …` command (and bare `/vf`), and whenever a task maps to init / spec-implementation / workflow-creation / verify-and-ship on a VibeFlow repo
---

# Driving work through VibeFlow (`vf`)

VibeFlow is a local-first orchestrator for AI coding agents (Claude Code, Codex,
Copilot CLI). The golden rule: **drive the task through `vf`, do not free-hand it.**
`vf` already encodes the confidence gate (nothing is "done" < 1.0 with evidence),
the guardrail hooks, the skills store, and the parallel work-unit orchestrator.
Re-implementing those by hand (manual `codex exec`, hand-rolled review, `gh pr create`
loops) is the anti-pattern this skill exists to stop.

This SKILL.md is the slim index. Load a reference file only when the task needs it
(progressive disclosure) — do not carry the full detail in every turn.

## 0. SPEC-FIRST GATE (before any writing/dispatching command)

`vf init`, `vf run --yes`, and `vf orchestrate --yes` all WRITE or DISPATCH. Never
run them blind. First reflect the task back as a short spec and get confirmation.
Ask only the questions whose answers you don't already have:

1. **Goal** — one sentence: what does "done" look like? (becomes the workflow goal)
2. **Scope** — which files/dirs may change? what is off-limits? (drives per-unit scope)
3. **Engine** — claude, codex, or copilot? (default: copilot). Cheap mechanical work → codex.
4. **Risk class** — docs | simple-code | feature | architecture | security | deploy
   (sets the confidence band; default 1.0 for code).
5. **Parallel?** — one concern → a single unit; several independent slices → one work
   unit each. Overlapping file scopes are serialised automatically.
6. **Real run or preview?** — default everything to a DRY run first, confirm, then `--yes`.

State the spec back in 3-5 lines, ask the open questions, WAIT for the answer, THEN act.
Skip the gate only for read-only commands (`vf doctor`, `vf units status`, `vf verify`,
`vf skills list`, any `--dry-run`).

## 1. Pick the flow

| The user wants… | Flow | Detail |
|---|---|---|
| set up a repo for AI agents | **Flow A — init** | `references/flows.md` |
| "here's a spec/issue, implement it" | **Flow B — spec → task** | `references/flows.md` |
| several independent changes in parallel | **Flow C — workflow** | `references/flows.md` |
| "is it done / ship it" | **Flow D — verify & ship** | `references/flows.md` |
| bare `/vf` (no arguments) | **Grill from context** | `references/grill.md` |

## Hook behavior: web UI vs CLI

**Web UI dispatch** (vf orchestrate --yes via browser):
- require_approval → user sees modal in browser (waits indefinitely)
- --auto-pilot: independent LLM eval, approve if confidence >= 0.9
- --yolo: blind allow-all

**CLI dispatch** (vf orchestrate --yes in terminal, no UI):
- require_approval → auto-block (no UI available)
- Set VF_HOOK_MODE=yolo in env to override (use carefully)

Always start with `vf doctor --probe` if you have not confirmed an engine is ready
this session — a dispatch against a cold engine fails the creation gate.

### Bare `/vf` — grill first

If the user typed `/vf` with NO task, do not guess and dispatch. Load
`references/grill.md`: read the recent chat context (last messages, open files,
errors), infer 2-3 likely intents, then relentlessly grill the user through the
SPEC-FIRST questions until the spec is concrete — then map it to a Flow above.
(Interview technique credited to mattpocock/grill-me.)

## 2. References (load on demand)

- **`references/flows.md`** — full Flow A-D playbooks (init / spec→task / workflow / verify-and-ship), every flag explained.
- **`references/grill.md`** — bare `/vf` context-grill protocol: infer intents, interview to a spec, route to a Flow.
- **`references/hooks.md`** — guardrail hooks: arming, live PreToolUse gate, per-engine semantics, web UI approval modal, auto-pilot/yolo flags, audit log
- **`references/pitfalls.md`** — the anti-patterns learned the hard way; read before improvising.

## 3. Skills and external docs (before inventing steps)

- `vf skills list` / `vf skills search <task>` — find a verified skill before hand-rolling.
- `vf skills resolve` — report which skill needs are satisfied locally vs. on demand.
- `vf discover docs <lib> --yes` — pull external library docs via Context7 (network needs `--yes`).
- `vf discover skills "<task>" --yes` — find an external skill to import.
- `vf skills validate` — validate the skill store against the Anthropic format.
- `vf skills sync --engine <name>` — mirror `.vibeflow/skills` into an engine's skill dir.

## 4. Verification (prove it worked)

- After init: `vf doctor` (engine ready + hooks armed) and the generated files exist.
- After a dispatch/workflow: `vf verify` exits 0 (all gates green) and `vf units status`
  shows the units done at confidence 1.0 with recorded evidence.
- Validate this skill itself: `vf skills validate`.
- goalEval gate (ADR-003): pass goal + goalEvalFn to collectVerifyReportAsync for behavioral verification

See `references/flows.md` §Flow D and `references/pitfalls.md` for the full verify loop.

Powered by VibeFlow.

## Spec-first test generation (ADR-002)

`generateSpecFirstTests({ unitName, spec, llmFn })` — generate test stubs from spec ONLY.
- Returns null if spec is empty (skip silently)
- LLM sees ONLY spec + unit name, no implementation
- Generated files (*.spec-first.test.ts) are oracle — pre-write hook blocks modification
- Phase 2: `vf orchestrate --spec-first` generates and protects these files automatically
