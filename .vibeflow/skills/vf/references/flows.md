# VibeFlow Flows (A-D) — full playbooks

Detail for the four flows summarised in `../SKILL.md`. Load this when a task maps to
one of them. Every flow obeys the SPEC-FIRST gate in SKILL.md §0 before any writing or
dispatching command.

Always run `vf doctor --probe` first if you have not confirmed an engine is ready this
session — a dispatch against a cold engine fails the creation gate.

| The user wants… | Flow |
|---|---|
| set up a repo for AI agents | **Flow A — init** |
| "here's a spec/issue, implement it" | **Flow B — spec → task** |
| several independent changes in parallel | **Flow C — workflow** |
| "is it done / ship it" | **Flow D — verify & ship** |

## Flow A — init (set a repo up for AI agents)

Generates the canonical context (`AGENTS.md`/`CLAUDE.md`/`.vibeflow/*`), the engine
instruction files, the guardrail hooks, and a workflow ledger.

1. SPEC-FIRST: confirm engine + whether to run the intake questionnaire + AI enrichment.
2. Preview first: `vf init --dry-run` (writes nothing; shows what it would create).
3. Apply: `vf init --engine <e>` (omit `--engine` to use the default copilot).
   - `--no-ask` skips the TTY questionnaire (use in non-interactive sessions).
   - `--no-ai` skips the headless enrichment dispatch (deterministic files only).
   - `--no-hooks` keeps guardrails on but skips the interactive setup.
4. After editing any `.vibeflow/*` by hand later, RE-RUN `vf init` to regenerate the
   derived context — never hand-edit the generated block between the vibeflow markers.
5. Verify: `vf doctor` shows the engine ready and hooks armed.

## Flow B — spec to task (implement one concern)

For a single-concern task (one issue, one bug, one feature slice).

1. SPEC-FIRST: restate goal + scope + engine + risk. Get confirmation.
2. Dry preview the dispatch: `vf run <engine>` (writes the prompt, launches nothing).
3. Real run behind the source-protection gate:
   `vf run <engine> --yes --auto-wip --rollback-on-fail`
   - `--auto-wip` snapshots a dirty tree first; `--rollback-on-fail` resets on failure.
4. Verify before claiming done: `vf verify` (typecheck/lint/test + confidence/evidence/scope gates).
5. If the gate is red, fix the root cause and re-run `vf verify` — do NOT work around it.

## Flow C — workflow (parallel multi-unit)

When the task splits into independent slices with distinct file scopes.

1. SPEC-FIRST: list the slices, each with its own scope. Confirm the split with the user.
2. Model each slice as a work unit: `vf units add <slice-name>` (one per slice).
   Set each unit's spec (what to build) + scope (files it may touch) in the ledger.
3. Inspect the plan: `vf units status` (lists units + their gates).
4. Dry-run the orchestration (default is read-only): `vf orchestrate`
   — review the plan + which units run in parallel vs serialised (overlapping scopes serialise).
5. Real run: `vf orchestrate --engine codex --yes --concurrency 3 --isolate --pr`
   - `--isolate` gives each unit its own git worktree (zero cross-unit clobber).
   - `--pr` opens a QUEUED PR per unit after its independent review passes (never auto-merges).
   - `--concurrency <n>` caps parallel dispatch.
6. Orchestrate already runs an independent reviewer + records evidence per unit — do NOT
   hand-roll a separate review pass.
7. Re-run `vf orchestrate` if it crashed mid-flight; completed units are skipped (ledger-tracked).

## Flow D — verify and ship (is it done?)

1. `vf verify` — the full gate: typecheck / lint / test + confidence / evidence / scope.
2. For a unit stuck below 1.0: record proof then close it:
   `vf units evidence <u> --add "<command output / file path / test result>"`
   `vf units update <u> --status done --confidence 1`
3. Re-run `vf verify` until green. Nothing is "done" until it passes WITH evidence.
4. `vf verify` is read-only by default; pass `--journal` only to append the run to the work journal.

## Recent features (v0.12.x)

- **Skill tiers (`type: repo|knowledge`)** — a SKILL.md frontmatter `type: repo` makes the
  skill always-on "project law" injected into every dispatch; `knowledge` (default) stays
  keyword-gated. `type: repo` skills are your team invariants that must never be missed.
- **User MCP servers (`vf config mcp`)** — declare arbitrary MCP servers (stdio/http/sse)
  once and vf fans them out to every engine: `vf config mcp add <name> --stdio --command <cmd>`
  / `--http <url>` / `--sse <url>`; `vf config mcp list|remove <name>`. Codex has no SSE
  (skipped+warned). Header values are never logged; use `${VAR}` for tokens in `.mcp.json`.
- **Sandboxed verify (`vf verify --sandbox`)** — run the verify gate inside a throwaway
  container (opt-in; default is host speed). Image via the `sandboxImage` setting.
- **Merge-when-green notify** — `vf pr merge-when-green` fires an OS desktop notification when
  CI settles (toggle with the `notifications` setting / `--no-notify`).

## Verification (prove it worked)

- After init: `vf doctor` (engine ready + hooks armed) and the generated files exist.
- After a dispatch/workflow: `vf verify` exits 0 (all gates green) and `vf units status`
  shows the units done at confidence 1.0 with recorded evidence.
- Validate this skill itself: `vf skills validate` (errors + warnings per the Anthropic standard).

Powered by VibeFlow.
