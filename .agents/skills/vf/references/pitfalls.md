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

- **Centralize workspace configuration in the Home control center.** Keep harness detection/init,
  agent initialization, CLI enablement, Memory/CodeGraph/LSP toggles, capability inventory,
  skills inventory, and MCP inventory in one UI surface. Reuse `/api/detect`, `/api/init`,
  `/api/settings`, `conversationHomeApi.capabilities`, and `api.skills`; do not invent a second
  backend or fake MCP entries. Keep reviewed capability install/repair actions in the existing
  Capabilities drawer. Persist only validated engine names and display unavailable CLIs honestly.

- **Capability-gate on the static support matrix, not the live probe.** The engine
  readiness probe is slow (CLI spawns, 5-15s) and can report "unknown" on a fresh start.
  If a UI surface gates its visibility/acceptance on `ready`, it flickers hidden or blocks
  use for seconds on machines that actually have the CLI. Gate *display* on the static
  contract (support matrix) and let dispatch fail loudly; gate *dispatch* on readiness.
  Example: attach "Auto" mode — file-dialog `accept` unions every engine's kinds and the
  per-file gate falls back to the first engine whose support matrix covers the kind, so a
  fresh probe never hides images that codex/copilot can consume. This exact bug shipped as
  "attach does not support images" — the resolved engine was claude (first ready), the
  dialog hid `.png`, and probes still filling in caused "no ready engine supports png".

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

- **Attachments and private ranges are different context lifecycles.** Attachments upload into
  `.vibeflow/attachments/<name>` and remain selectable chips for engine argv projection. A private
  range is an exact text excerpt staged through the guarded private-context broker; when text
  attachments exist, the panel must offer a file selector sourced from those chips instead of
  making users retype a path. Keep path input only as an explicit fallback for repo files that
  were not uploaded. Images/documents cannot provide line ranges; reject them with a readable
  source hint. Test this as a real flow: upload text + image, open Private range, select text file,
  verify preview and staged repo-relative path, then remove attachment and verify selector state.

- **Full-flow UI verification must include feature transitions, not only static render.** For any
  picker/attachment change, exercise the exact user sequence (open page, wait for probe, choose
  file, observe chip, open dependent panel, select source, preview, choose range, send, remove).
  Assert browser console is clean, accessibility has no violations, controls remain viewport-safe at
  mobile widths/200% zoom, and server-side upload/delete state matches visible chips. Unit tests
  alone miss stale shared composable state and readiness races.

- **Clean the Playwright workspace before every real-user run.** Each invocation now uses unique `.e2e-workspace-<run-id>` and `vibeflow-playwright-<run-id>` roots; this prevents concurrent runs from deleting another run’s `.home/go/pkg/mod` tree. Remove stale `.e2e-workspace*` and `test-results` only after stopping stale UI/Playwright processes, then verify the new run’s workspace is isolated. Do not treat setup cleanup errors as app passes.

- **Pre-push local CI must not be weakened by convenience flags.** Run the full local CI sequence
  after source/test/docs changes; `--quick` is diagnostic only and never evidence for a mergeable
  PR. If the hook reports failure, fix the first failing gate, refresh normative proofs, regenerate
  review evidence against the remote tip, then retry push. Never use `--no-verify`.
- **Home 400-line gate counts `split(/\r?\n/).length`, so a trailing newline adds one.** A file with N content lines plus a final newline reports N+1 and fails at exactly 400. When trimming a `.vue`/`.ts` file to fit the gate, leave at least one spare line (398 content lines / 399 split entries) or the gate flips red on CI even though `wc -l` looks fine.

- **Suggestion dismiss loops when a watch signature depends on the state it resets.** Refactoring the composer's raw `suggestions` computed into `visibleSuggestions` (which includes the dismissed flag) made the suggestion-signature watcher see a change on every dismiss and immediately clear the flag — Escape never closed the listbox (CI e2e caught it). Keep watch signatures derived from RAW matcher output (draft only), never from a derived value the watcher itself mutates.

- **FIFO integration teardown must idle the queue dispatcher AND the last in-flight attempt before rm.** Quiescence + one `setTimeout(0)` is not enough: the dispatcher poll tick can land after the workspace root is removed ("trace journal: unsafe directory/journal"), and the final item's attempt finalizes its artifact publish (proper-lockfile mkdir of `artifacts.lock`) AFTER the queue row already reads "delivered" — 250ms still failed on CI under coverage instrumentation with ENOENT on the lock mkdir. Wait ~750ms after quiescence, and mention both hazards in the comment.

- **Coverage gate scans every `src/` file, not just the diff.** `scripts/coverage-gate.cjs` enforces 100% per-file on ALL source files in lcov (only `src/server.ts` is waived). A commit touching test-only files can still fail the gate if some unrelated producer file dropped below 100% — reproduce with `bun test --coverage --coverage-reporter=lcov` on the relevant test files and compare DA counts.
- **Absolute-positioned dropdowns get clipped by scrollable ancestors.** The composer wrap has `overflow-y: auto`, so a toolbar menu opened upward was cut at the wrap edge — the top ~52px (first option) hit-tested as the welcome panel and clicks landed nowhere. Anchor the menu with a Teleport to `<body>` plus fixed coordinates captured from the trigger's `getBoundingClientRect()`. Reproduce by `elementFromPoint` at the first option's center.
- **Composer suggestion lists must not stay in document flow.** Agent/action suggestions rendered below the textarea add their full menu height to the form when opened, pushing the conversation upward and leaving a large blank region after agent creation. Position `.home-suggestions` absolutely above the composer field, keep it inside the field’s positioned ancestor, and verify its opening does not change `.home-composer` height.
- **Suggestion popover must escape scrollable timeline stacking contexts.** The composer sits in grid row 3 below `.home-timeline`; an absolute popover remains under the timeline's painted content even with a local z-index. Render it through Vue `<Teleport to="body">`, use `position: fixed`, and derive top/left/width from the live composer field rect. Keep the active listbox linked with `aria-controls`/`aria-activedescendant`; verify real pointer hit-testing with `elementFromPoint` plus a user click, not only visibility.

- **A fetch that returns 404 for an expected miss spams the browser console.** The private-range preview reads the typed file path on each keystroke; a wrong path 404'd every time and e2e "no browser leakage" asserts failed on "Failed to load resource". For preview/expected-miss semantics answer HTTP 200 with `{ok:false, reason}` instead of 404; keep 404 for the contract where a miss is a transport error.
- **Picking a mention chip must append a trailing separator, or typing after it merges into the token.** `insert()` added a space only when text already followed the caret; picking at the end of the draft glued every next character onto the chip. Always end a pick with a space (and mirror it in e2e assertions, which had encoded the old no-space behavior).
