# VibeFlow Pitfalls (learned the hard way)

Anti-patterns to avoid when driving work through `vf`. Read this before improvising a
manual workaround — most of these are the exact failure modes the CLI exists to prevent.

- **Do not free-hand what `vf orchestrate` does.** Manual `codex exec` + a hand-dispatched
  reviewer + `gh pr create` re-implements `--isolate --pr` + the built-in reviewer + the
  evidence ledger, badly. Use the orchestrator; it is the product.

- **Spec-first is non-negotiable for writing commands.** A vague goal yields a vague
  dispatch. Restate goal + scope + engine + risk and confirm before `--yes`. (See
  SKILL.md §0 and `grill.md` for the bare-`/vf` interview that forces this.)

- **`--dry-run` / no-`--yes` is your friend.** Every destructive/dispatch path previews
  first. Default to the preview, show the plan, then re-run with `--yes`.

- **Re-run `vf init` after editing `.vibeflow/*`.** The context block is generated; hand
  edits to the generated region (between the vibeflow markers) are clobbered on the next
  regeneration. Edit sources, then regenerate.

- **A red `vf verify` is investigated, not worked around.** Read the failing lines — each
  names a failing toolchain gate (typecheck/lint/test) or a policy gate (confidence < 1,
  no-evidence, scope overlap). Fix the root cause, then re-run. Never paper over it by
  forcing a status or fabricating evidence.

- **One runner / cold engine fails the creation gate.** Run `vf doctor --probe` first to
  confirm the engine is warm; a dispatch against a cold engine fails the gate.

- **Never assume a destructive command is blocked on Codex/Copilot.** The live PreToolUse
  gate BLOCKS only on Claude; Codex/Copilot hook configs are detection-only (observe +
  log). See `hooks.md` — do not rely on a block that will not happen.

- **Overlapping work-unit scopes serialise; they do not run in parallel.** If you expected
  concurrency and got serial execution, check for file-scope overlap between units and
  split the scopes cleanly.

- **`vf init` / `vf orchestrate` pollute generated files — clean them out of the PR.** A
  dogfood run rewrites `AGENTS.md`, `CLAUDE.md`, `.vibeflow/SETTINGS.json`, `.claude/settings.json`,
  and `.githooks/*` (often injecting a machine-specific absolute `$HOME` path that trips the
  `no-tracked-machine-path` test). The orchestrator's WIP checkpoint commit bundles these with
  your real changes. Before opening the PR: `git reset --soft main`, then `git restore --staged
  --worktree` the generated files back to `main`, and `git add` ONLY the source/test/docs you
  meant to change. Never stage the vf-generated files (`AGENTS.md`, `CLAUDE.md`,
  `.vibeflow/SETTINGS.json`, `.claude/settings.json`, `.githooks/*`).

- **The engine can finish coding then FAIL the final verify — the diff is still usable.** If
  `vf orchestrate --yes` reports the unit blocked because the verify/gate step errored (e.g. the
  engine's model 404'd at the end, or lint tripped), inspect `git diff` first: the engine
  usually wrote correct source + tests over its earlier turns. Run the gates yourself
  (`bun run typecheck`, `bun run lint`, `bun run coverage:check`), auto-fix format, and continue —
  do not throw away 30+ turns of work because the last step died.

- **The engine skips docs.** Dispatched engines reliably implement code + tests but ignore the
  "update docs / mirror the landing wiki 1:1" part of a spec. After a dispatch, check
  `git status docs/ landing/` yourself and write the doc + its mirror by hand.

- **A failing engine test is usually a dodgy prompt, not a dumb engine.** The cheap engine follows
  the prompt literally — so encode test pitfalls IN the prompt or you get code that compiles but
  fails: (1) a spawn test that mutates `PATH` breaks the binary lookup — tell it to spawn via
  `process.execPath`, not `"node"`; (2) never restore env with `process.env[K] = undefined` — it
  sets the literal string `"undefined"` (Copilot flags this). Use the save/restore pattern in
  pitfall (4), not a bare unconditional `delete`; (3) `let x = undefined`
  makes TS narrow the type to `undefined` and later casts fail TS2352 — tell it to declare
  `let x: T | undefined;` with no initializer; (4) a test that sets `process.env.KEY` must SAVE the
  original first and RESTORE it in finally (`delete` only when it was absent) — a bare
  `delete process.env.KEY` wipes a real value from the dev/CI env for the rest of the run; (5) don't
  assert `HOME` is set (unset on Windows — USERPROFILE is the standard); `PATH` is the cross-platform
  ALWAYS_KEEP probe. When a dispatched test fails, first ask "did my prompt warn about this pitfall?"
  before blaming the engine.

- **Cheap-engine model tags must point at an AUTHENTICATED provider account.** When routing
  `vf`'s engines through a local proxy (e.g. 9router) to a cheap model, a wrong model tag fails
  in two stages that look different: an unreachable model → `404` (no access), and a reachable
  model on an un-authed account → `401 Missing API key`. `vf doctor --probe` surfaces this as a
  probe timeout/failure for that engine. See `references/cheap-engine-setup.md` for the recipe
  to find the correct tag.

Powered by VibeFlow.
