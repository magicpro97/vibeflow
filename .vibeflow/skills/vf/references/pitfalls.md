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

- **Normative preimages go stale after any source/test change.** `vf verify` and the normative matrix
  intentionally reject old production digests; this is not a reason to weaken the matrix. After the
  final source/test tree is committed, run `bun run scripts/refresh-normative-proofs.ts`, inspect the
  generated manifest/matrix diff, then rerun the exact normative proof command and `vf verify`. Do not
  refresh midway through an active writer round, or generated evidence will describe the wrong HEAD.

- **Review evidence binds exact HEAD and requires a clean worktree.** A missing record or a record for
  an earlier SHA makes `vf verify` fail even when code tests pass. Finish and commit code first, classify
  and restore generated hook/config noise explicitly, then create evidence with
  `vf review evidence --base <full-SHA> --result <review-result.json>` from that clean exact HEAD and
  validate with `vf review check --base <full-SHA>`. Never use generic pass JSON or evidence from a stale
  review package.
- **Home 400-line gate counts `split(/\r?\n/).length`, so a trailing newline adds one.** A file with N content lines plus a final newline reports N+1 and fails at exactly 400. When trimming a `.vue`/`.ts` file to fit the gate, leave at least one spare line (398 content lines / 399 split entries) or the gate flips red on CI even though `wc -l` looks fine.

- **Suggestion dismiss loops when a watch signature depends on the state it resets.** Refactoring the composer's raw `suggestions` computed into `visibleSuggestions` (which includes the dismissed flag) made the suggestion-signature watcher see a change on every dismiss and immediately clear the flag — Escape never closed the listbox (CI e2e caught it). Keep watch signatures derived from RAW matcher output (draft only), never from a derived value the watcher itself mutates.

- **FIFO integration teardown must idle the queue dispatcher AND the last in-flight attempt before rm.** Quiescence + one `setTimeout(0)` is not enough: the dispatcher poll tick can land after the workspace root is removed ("trace journal: unsafe directory/journal"), and the final item's attempt finalizes its artifact publish (proper-lockfile mkdir of `artifacts.lock`) AFTER the queue row already reads "delivered" — 250ms still failed on CI under coverage instrumentation with ENOENT on the lock mkdir. Wait ~750ms after quiescence, and mention both hazards in the comment.

- **Coverage gate scans every `src/` file, not just the diff.** `scripts/coverage-gate.cjs` enforces 100% per-file on ALL source files in lcov (only `src/server.ts` is waived). A commit touching test-only files can still fail the gate if some unrelated producer file dropped below 100% — reproduce with `bun test --coverage --coverage-reporter=lcov` on the relevant test files and compare DA counts.
- **Absolute-positioned dropdowns get clipped by scrollable ancestors.** The composer wrap has `overflow-y: auto`, so a toolbar menu opened upward was cut at the wrap edge — the top ~52px (first option) hit-tested as the welcome panel and clicks landed nowhere. Anchor the menu with a Teleport to `<body>` plus fixed coordinates captured from the trigger's `getBoundingClientRect()`. Reproduce by `elementFromPoint` at the first option's center.
- **Composer suggestion lists must not stay in document flow.** Agent/action suggestions rendered below the textarea add their full menu height to the form when opened, pushing the conversation upward and leaving a large blank region after agent creation. Position `.home-suggestions` absolutely above the composer field, keep it inside the field’s positioned ancestor, and verify its opening does not change `.home-composer` height.
- **Suggestion popover must escape scrollable timeline stacking contexts.** The composer sits in grid row 3 below `.home-timeline`; an absolute popover remains under the timeline's painted content even with a local z-index. Render it through Vue `<Teleport to="body">`, use `position: fixed`, and derive top/left/width from the live composer field rect. Keep the active listbox linked with `aria-controls`/`aria-activedescendant`; verify real pointer hit-testing with `elementFromPoint` plus a user click, not only visibility.

- **A fetch that returns 404 for an expected miss spams the browser console.** The private-range preview reads the typed file path on each keystroke; a wrong path 404'd every time and e2e "no browser leakage" asserts failed on "Failed to load resource". For preview/expected-miss semantics answer HTTP 200 with `{ok:false, reason}` instead of 404; keep 404 for the contract where a miss is a transport error.
- **Picking a mention chip must append a trailing separator, or typing after it merges into the token.** `insert()` added a space only when text already followed the caret; picking at the end of the draft glued every next character onto the chip. Always end a pick with a space (and mirror it in e2e assertions, which had encoded the old no-space behavior).

---

## Incidents synced from the Hermes mirror (2026-10-07)

- **`vf init --no-ai` can leave user-scope capabilities broken (503).** `init.ts` only called `activateProjectCapabilityAuthorityForVfInit` and `activateRecoveryBootstrapForTrustedInstall` — the user-scope authority (`activateUserCapabilityAuthorityForTrustedInstall`) was never invoked. UI shows "Capability index unavailable / The capability browser is unavailable" on "All projects" tab even when project scope works. **Fix:** `init.ts` must call `activateUserCapabilityAuthorityForTrustedInstall(userVfRoot)` after the project activation, AND ensure `~/.vibeflow/SETTINGS.json` exists first (user-scope `readDurableSettingsPolicyState` requires it). Without the SETTINGS.json, user activation fails with `CapabilityValidationError: authority settings are missing`. After adding both, `vf init --no-ai --no-hooks` completes without error and both user+project capability APIs return 200.

- **`vf init` timeout (30s+) when AI engines are unresponsive.** Default `vf init` runs AI enrichment which may hang (copilot engine trying to find a model, timeout). Pass `--no-ai` for deterministic context-only init. The engine work units (`ai-init-analyzer`, `ai-init-dispatcher`) can fail with exit 1 if the model is not found on the provider — this is expected, not a bug. Use `--no-ai` for CI/headless, then the capability infrastructure is still created correctly.

- **`vf units status` crashes when a work-unit entry lacks `gates`/`resources`/`evidence` fields** (hand-edited `WORKFLOW_STATE.json`). Stack trace in `dist/cli.js` on `Array.map`. Fix: every unit must carry `gates` (build/lint/test/review = "pending"), `resources` (agents/tokens/cost_usd/wall_seconds = 0), `evidence: []`, `skills_used: []`, `skills_injected: []`, `skills_required: []`, `knowledge_heavy: false`, `knowledge_heavy_source: null`. Verify with `vf units status` before dispatching. Same root class fires at the END of a SUCCESSFUL `vf orchestrate`: recomputeTotals crashes with `TypeError: Cannot read properties of undefined (reading 'tokens')` at dist/cli.js:254 whenever ANY unit entry lacks `resources` (agents/tokens/cost_usd/wall_seconds) — units still complete and files land, but the command exits 1 and goal shows `blocked`. The field set above must be present on EVERY unit, including ones appended by script (not via `vf units add`). Ledger scripting trap that bit twice: `[u for u in work_units if u.name != 'uX'] + [new]` in Python SILENTLY DROPS the just-mutated uX from the ledger (you updated it in place in the same list, then filtered it out) — append new units without filtering, and re-inspect the unit list after every mutation.
  **2026-09-03: code-level fix shipped (#782).** `units.ts:53` now uses `u.gates ?? {}` so individual gate keys are optional-chained with `g[k] ?? ""`. The crash is prevented at the code level — missing `gates` field no longer throws. The discipline tips above still apply (incomplete units produce blank gate columns), but the stack trace is gone.

- **`vf orchestrate --yes` used to dispatch units marked `blocked` too** (confirmed bug 2026-09-02, fixed #783 2026-09-03). `orchestrate.ts:176` now filters `BLOCKED` before dispatch, logs `Skipping N blocked unit(s)`, and preserves blocked units in the merged ledger so `goalEval` returns `"blocked"` verdict. The sequential-qa workaround (keep only pending unit, stash rest) is no longer needed — blocked units are properly skipped. But verify: if a unit is accidentally `blocked` when it should be `pending` (e.g. hand-edited state), it won't dispatch.

- **vf→codex dispatch runs READ-ONLY unless `~/.codex/config.toml` sets a global sandbox** (2026-09-02, KMP build). `vf orchestrate --engine codex` doesn't pass `--approve-for-me`/`--sandbox`, and vf's `renderCodexAgent` only emits `sandbox_mode` when the unit's *spec* carries a `sandbox` field — so codex executes with `sandbox_mode = read-only`, `approval_policy = never`, and `apply_patch` reported as "unsupported call". The agent happily writes NOTHING and "completes" with a plan-only summary. Fix: put in `~/.codex/config.toml` (global): `sandbox_mode = "danger-full-access"` + `approval_policy = "never"`. And `workspace-write` is NOT enough for Gradle/KMP builds: the wrapper/daemon need `~/.gradle`, `~/.konan`, and the Android SDK — all OUTSIDE the workspace — so builds fail with `FileNotFoundException: ...gradle-9.5.0-bin.zip.lck (Operation not permitted)` and codex starts "fixing" by `rm -f` the lock (which the sandbox also rejects: "rm -f style commands are not permitted"). Confirm a real write happened (files on disk + unit moved) before trusting the run; a sandboxed run exits with everything still `pending`.

- **vf's measured gate can report `build:fail` while the code actually passes — re-verify with YOUR OWN run before re-dispatching** (2026-09-02, Wave 1: `vf orchestrate` marked BOTH u1 and u2 `build:fail` yet the real tree compiled and tests were green — 82 then 132 tests, 0 failures). The gate verdict rides on the engine's own run; when it contradicts a clean local re-run, trust the re-run: run `./gradlew :composeApp:testDebugUnitTest --rerun-tasks` (the `--rerun-tasks` matters — `UP-TO-DATE` cache can hide a broken state), count from `composeApp/build/test-results/testDebugUnitTest/*.xml` via python, then mark the unit `done@1.0` yourself with that file/count evidence instead of looping another dispatch. Also battle-tested: when the gate is right and codex's code FAILS to compile (missing `import kotlin.time.Duration.Companion.minutes`), fix the compile error directly (self-edit), re-run tests, then record the exact missing-import fact in the next unit's LESSONS block.

- **KMP orchestration environment gotchas (Wave-1 run, 2026-09-02):** (1) JDK 17 for spec-pinned Gradle/Kotlin — `brew install openjdk@17` stays keg-only, and `org.gradle.java.home` in `gradle.properties` is usually hardcoded to a Cellar path (`.../17.0.16/...`) that DIES the day brew upgrades (17.0.20.1) with `Java home supplied is invalid`; point it at the version-agnostic symlink `/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home` or export JAVA_HOME for gradle invocations. (2) Agent-chosen dependency versions drift from the spec's pinned matrix — codex wired `kotlinx-serialization-json 1.7.3` while spec §9 pins 1.11.0; after any unit that touches `libs.versions.toml`, diff versions against the spec's toolchain table before accepting the diff. (3) Sequential one-unit-at-a-time orchestration for a whole wave (dispatch → agent QA → self-fix codex compile errors → LESSONS into next unit spec → commit) is captured in `references/kmp-sequential-orchestration.md`.

- **Prep-phase gaps become PLAN UNITS, not deferred notes** (user correction 2026-09-02: "chưa có hay thiếu thì thêm bước làm vào"). When plan-mode: if you detect a missing toolchain piece (JDK, SDK platform, version-catalog drift vs spec matrix), ADD an explicit unit (e.g. `u0-prep-toolchain`) to the plan — with tool + pass criteria per step — and run it BEFORE the units that depend on it. Do NOT note "do this later in Wave N" in prose; that was called out as a bad plan. Split deliberately: minimal toolchain needed by the current wave goes now; full matrix migration becomes a named unit gated at the wave that needs it.

- **Increment mechanism for codex mistakes = inject lessons into the NEXT unit's spec** (user: "luôn có cơ chế increment để codex không mắc lại sai lầm"). After each unit, write the concrete pitfalls (forbidden commands, settled files, API facts, sandbox behavior) into the next unit's `spec` in `WORKFLOW_STATE.json` under a `LESSONS (from previous rounds — DO NOT repeat):` block. Codex follows the injected spec more reliably than a separate knowledge file. Also: correct YOUR OWN premise before blaming codex — this session the assistant wrongly assumed `kotlinx-datetime` was already wired in the catalog and flagged codex's diff as a spec violation; the diff was correct and necessary.

- **vf bugs found in the field → file GitHub issues on `magicpro97/vibeflow`** (user directive: "lỗi của vf thì tạo issues cho vf") per `references/vf-issue-standard.md`; do not silently work around a vf gap.

- Spec-first is non-negotiable for `--yes` commands; a vague goal yields a vague dispatch.

- Everything previews first (`--dry-run` / omit `--yes`).

- Repo skills live in `.vibeflow/skills/<name>/SKILL.md`; `vf skills validate` checks the Anthropic format; `vf skills sync` mirrors into engine dirs.

- **`vf init` only regenerates the ACTIVE engine's files.** If engine is `copilot`, `CLAUDE.md` is NOT touched. After a version bump (`package.json`), verify ALL engine files: `grep 'VibeFlow v' AGENTS.md CLAUDE.md .github/copilot-instructions.md`

- **mcp-language-server PATH trap.** `vf tools install lsp --yes` runs `go install` which puts the binary in `~/go/bin/`. That directory is NOT on PATH by default on macOS. Add `export PATH="$HOME/go/bin:$PATH"` to `~/.zshrc` after installing Go. Without it, LSP Bridge shows `[enabled, not installed]` even after a successful install.

- **`vf init` from a BUILT `dist/cli.js` bakes machine-absolute paths into generated config.** When you run init via `node dist/cli.js init` (instead of the repo's `bun src/cli.ts`), the generated `.githooks/*`, `.mcp.json`, `.codex/config.toml`, `.codex/hooks.json`, `.github/hooks/copilot.json` get the launcher rewritten from `bun src/cli.ts` to an absolute `node "/Users/you/repo/dist/cli.js"` plus an absolute `--workspace` path. Committing those breaks the hook for every other contributor + CI. After `vf init` on the vibeflow source repo, ALWAYS run `git diff --cached | grep "/Users/"` before committing — restore `.githooks/` to `bun src/cli.ts` and DROP the machine-path config files from the commit. Commit ONLY the portable context docs (AGENTS.md, copilot-instructions.md, SETTINGS.json — verify each is path-free). Consider adding `.mcp.json`/`.codex/` to `.gitignore` so nobody commits machine paths. The repo already gitignores `.claude/` (same class of generated abs-path config) — that inconsistency IS the bug; the fix is to make the other engine outputs match, NOT to portabilize the path. Do NOT "fix" by switching hooks to bare `vf hook`: hooks are FAIL-CLOSED security guardrails and `vf hook` fails OPEN if PATH is minimal at exec time. And remember `vf init` defaults `--ai` ON — a `--no-ai` audit misses the non-deterministic `.vibeflow/ai-context/**` writes, so any "tree clean after init?" check must run BOTH modes. Full root-cause analysis, file taxonomy, and fix shape in `references/machine-path-leak-in-generated-config.md` — now implementation-ready: `WORKFLOW_STATE.repo_path` is a verified zero-reader field (delete it, don't relativize), `.mcp.json --workspace .` was empirically tested working, and the `.vibeflow/.gitignore` `!*.md` allowlist has a re-track trap to check with `git check-ignore -v`.

- **Worktree variant of the machine-path leak (bit during plan execution):** in a fresh git worktree, `vf hooks emit --yes` rewrites tracked `.githooks/*` + `.claude/settings.json` to absolute paths pointing at the MAIN checkout's `dist/cli.js` (not the worktree's) and creates `.agents/hooks.json` — all machine noise, none of it feature diff. Revert before any commit: `git checkout -- .claude/settings.json .githooks/ && rm -f .agents/hooks.json`. You do NOT need the emit at all in a worktree: `core.hooksPath` is repo-shared and the committed hook (`bun src/cli.ts hook`) runs correctly from the worktree — sanity-check with `printf '{"event":"pre-write","files":[]}' | bun src/cli.ts hook` → `{"decision":"allow",...}`. Rule: after ANY vf init/emit inside a worktree, `git status --porcelain` must show only intended changes. Related: executing an SDD plan stored under gitignored `.hermes/plans/` in a worktree — copy the plan into the worktree FIRST; `sdd-workspace`/`task-brief` derive their workspace root from the plan path, so briefs/ledger land in the worktree and subagents can read them at worktree paths.

- **Executing an SDD plan in a worktree: per-task gates are NOT the full `vf verify`.** A fresh worktree cannot satisfy `vf verify`'s env surfaces per task (missing `dist/`, no workflow state, playwright/review-evidence belong to milestones) — and "fixing" them mid-task with `vf init` dirties tracked files (see the machine-path bullet above). Per-task acceptance = the plan's focused tests + `bun run typecheck` + `bun run lint` (+ file-size/waiver gates when the task touches fit); the full `vf verify` + build absorb at the milestone/drill. State this explicitly in every implementer dispatch so it does not burn budget fighting env-only ✗ gates or return blocked over them.

- **Task-review loop (SDD execution): APPROVE-with-minors still gets a pin-fix round.** Reviewers mutation-probe scratch copies; correct-but-unpinned guards (single-flight flag resets, wire-contract schema gates) → follow-up `test(...): pin …` commit where each new test is PROVEN red against its deleted guard (scratch copy, byte-identical restore). A surviving mutation may itself be EQUIVALENT — a flip that preserves behavior (`confirm() && !exited` ≡ `if (exited) break`; string-inequality where the old comparator coerce-parsed) — so mutate to the ORIGINAL defect's exact semantics and re-run: only a faithful mutant that stays green is a real pin gap. Brief-declared deviations are adjudicated on evidence, not auto-rejected — a self-contradictory brief (retry guard vs its own test's attempt count) is fixed minimally with the test left byte-identical (proves it wasn't bent). After ANY plan amendment: regen task-brief + re-sync BOTH plan copies (worktree + main checkout).

- **Plan-mode feasibility proof without touching the repo: scratch-copy compile + run.** `cp -R <repo>/src <scratch>/`, copy `tsconfig.json` + `package.json`, `ln -s <repo>/node_modules <scratch>/node_modules`, drop the plan's NEW files + their tests in place, then `bunx tsc --noEmit -p tsconfig.json` and `bun test <new tests>`. Catches readonly-vs-mutable tuple mismatches (`toEqual([...expected])` for an `as const` pair), import drift and wrong overloads — cite the output in the plan. Also PIN the head SHA the plan's anchors were verified against inside the plan doc and tell the implementer to re-read files before editing (`~line N` anchors drift after any commit).

- **External reviewer CLIs: anchor the verdict grep or the prompt echo fools it.** The engine echoes the prompt, which contains the literal `VERDICT: ...` line, so a loose `grep VERDICT` matches the ECHO and the wrapper reports success with no real verdict. Extract with `grep -Eq '^VERDICT: (SHIP|BLOCK)[[:space:]]*$'` and add a `dead()` detector on 429 / rate-limit lines that kills the slot and moves to the paid fallback. When every CLI slot flakes for a round, Hermes-delegate read-only subagents (anchored `FINDINGS:/VERDICT:/CONFIDENCE:/UNVERIFIED:` footer, explicit no-write/no-subagent clauses) are the reliable independent reviewers — run them in the SAME round, not after.

- **SPA-imported core modules must stay dependency-neutral — "cycle-free" ≠ "bundle-safe".** Files like `src/core/ui-cli-contract.ts` are imported by the SPA (`src/ui/src/*`), so anything THEY import rides into the Vite/browser bundle. An acyclic import can still break it by dragging node-only chains (`../update-check.js` → `core.ts` → `node:url`; vite hard-fails `Module "node:fs" has been externalized …`). Falsify any plan's "bundler-neutral" claim with an A/B probe — `bun build <entry>.ts --target=browser` (or a real `vite build`) — and lock the result with a guard test asserting `Bun.build({entrypoints:[…], target:"browser"}).success`. Pure validators belong in zero-import modules (e.g. `src/core/version-format.ts`).

- **Guardrail hook blocks commits touching `.githooks/*` (path-protected).** This is correct — those are protected config. Do NOT reach for `git commit --no-verify` (hard rule). Instead, un-stage the protected/machine files and commit only the clean portable ones; the hook then allows it.

- **Sync to main BEFORE auditing / planning a fix — `sprint-*` branches get squash-merged + deleted.** A vibeflow audit or fix-plan run against a local `sprint-vN` checkout can be stale: that branch is squash-merged into `main` and DELETED on the remote once its PR lands, so its tip (e.g. `af16771`, run.ts=407 over the 400-line cap) no longer reflects reality — `main` already carried the fix (`fix(orchestrator): close #611 post-merge nits`, run.ts=367, CI green) under a different SHA. Symptom when you try to PR the stale fix: `gh pr create` fails `No commits between sprint-vN and <branch>` + `gh api repos/.../branches/sprint-vN` → 404. ALWAYS `git fetch origin && git checkout main && git pull` first, then re-verify each finding against `main` HEAD (grep the source, check `gh run list --branch main`) before writing a plan or a fix. This is the remote-level variant of the plan skill's \"re-verify audit findings against current branch state\" — here the base branch itself vanished. Cost of skipping: a full split-PR authored, committed, pushed, then abandoned because the work was already on main.\n- **\"Mechanism exists\" ≠ \"mechanism fires.\" Audit before trusting a vf feature claim.** When asked "does vf actually do X automatically?", do not assume the building blocks are wired. Trace it: `grep -rn <function> src/` to confirm PRODUCTION imports (not just test imports), and check whether the entry point is auto-invoked vs. a manual-only CLI subcommand. This session found `src/skills/maintainer.ts` (extractLessons/draftSkillFromLesson/canPromote) had ZERO production imports — pure dead code only tests called — and that `vf skills crystallize` was manual-only, never triggered by orchestrate/verify. The fix was wiring the auto-trigger + deleting the dead module, not adding more building blocks.

- **Git push fails with "review evidence required but missing/invalid for <sha>"** (repo pre-push hook runs `vf review check --base <merge-base(HEAD, remote)>`). Base is NOT `main`: pushing on top of an already-pushed tip needs evidence for base = REMOTE TIP (sha in the hook message IS the base). `vf review evidence` accepts a reviewer JSON with EXACTLY 9 top-level fields (extra key fails silently, exit 1 no output): `schemaVersion: 1, baseSha, headSha, changed: [{status, path}]` sorted by path (NOT a digest string), `changedDigest: sha256(JSON.stringify(changed))` in **JS** (python json.dumps adds spaces → different digest), `status: "passed", exitCode: 0, timedOut: false, findings: []`; then `review evidence --base <sha> --result <json>` → `review check --base <sha>` → push. Build the JSON with a tiny bun script (git diff --name-status -M, sort, createHash) — never hand-write the manifest. For a brand-NEW branch's first push the hook uses base = `git merge-base HEAD origin/main` (the fork point, not the remote tip).

- **The docs-only fallback is decided by PATH TOKENS, not by "it's only markdown".** No reviewer record is needed only when `requiredIds(changed)` is empty — the classifier runs regexes over changed PATHS (`request|api|route|dto|schema|mutation|endpoint`, `parse|decode|diff|archive|alloc|unbounded`, `write|delete|rename|publish|transaction|rollback`, plus `startsWith` for `.github/workflows/`, `.githooks/`, `src/hooks/`, `src/ui/`). An innocuous skill name like `claude-api/SKILL.md` matches `api` and forces a record, so the push fails `record missing` even though the diff is docs-only. Pre-compute with the repo's own module before assuming the fallback: `bun -e "import {changedFiles,requiredIds} from './src/hooks/review-evidence.ts'; …"`; if the triggering word is incidental, renaming the path is cheaper than running a pretend review.

- **Park untracked strays OUTSIDE the repo while recording evidence.** `vf review evidence` demands a clean worktree — ANY `git status --porcelain` entry, untracked WIP included, fails it silently (exit 1, no output). Move stray files and scratch dirs to `~/.hermes/cache/scratch/`, record, then move them back: the record binds base + head + manifest, NOT worktree state, so `review check` and the push stay valid after the strays return.

- **A `status: "passed"` result must BE an actual clean review of the exact head — never assembled from the manifest.** The recorder's empty-`findings` contract means "an independent review found nothing", and the repo's cross-review rule wants a different engine than the implementer. Run the reviewer bounded and read-only (e.g. `codex exec -s read-only` with a scripted checklist: markdown-only diff, sampled non-blank line-multiset conservation vs base, secrets grep, frontmatter diff), then loop review → fix → commit → review again until the FINAL head comes back clean before recording.

- **Raw `chromium.launch()` QA scripts break after a Playwright upgrade.** The default headless-shell rev bumps (e.g. to `chromium_headless_shell-1243`) before `playwright install` runs, so one-off QA scripts fail at launch with `Executable doesn't exist at ...1243` while the e2e suite keeps working (it runs its own project config). Fix: `bunx playwright install chromium-headless-shell`, or pin `executablePath` to an installed rev — list `~/Library/Caches/ms-playwright/` first; the executable is NOT always `Chromium.app` (newer revs ship `chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`), so locate it before writing the pin.

- **User re-reporting a UX issue does not mean the fix regressed — verify live before re-implementing.** When the user repeats a complaint from an earlier round (rail collapse, chip borders, picker background), run the playwright probe against the RUNNING server first: this session all three were already fixed and working, and the only real gap was the wiki description. Re-implementing blind wastes a full fix cycle; a 30-line probe script settles it.

- **Playwright pre-session toolbar clicks can time out once per page load.** On the fresh home surface (no conversation yet), clicking the +Agent picker row within ~1s of open occasionally fails with a 30s actionability timeout while engine probing re-renders the composer; the same click after Control+N (conversation mode) always passes, and re-clicking after ~1.5s idle also passes. Not an app bug (e2e suite passes) — in QA scripts, add a short settle wait or force-click, and distinguish selector problems (chip class is `home-composer-chip`, not `.chip`) from real failures.

- **Coverage gate enforces EVERY `src/` file, not just the diff.** `scripts/coverage-gate.cjs` requires 100% per-file on all lcov source files (only `src/server.ts` waived). A commit that touches only tests can still fail the gate if an unrelated producer file dropped below 100% under bun's coverage instrumentation — reproduce locally with `bun test --coverage --coverage-reporter=lcov` on the relevant test files and compare DA counts. Two gaps a focused suite HIDES until the full `coverage:check`: (a) a `for (;;)` retry loop whose body only returns/throws reports its closing `}` as DA:0 — adding `continue` does not fix it and `do/while(true)` is biome-rejected (`noConstantCondition`; the `const t = true` workaround then fails TS2366) — rewrite as bounded recursion (depth ≤ deadline/retryMs), every line then executable; (b) tests that always inject a `sleep` seam never CALL the real `defaultSleep` → its declaration line is DA:0 — add one test without the seam and a tiny `retryMs` (1ms).

- **Drilling an install/upgrade feature: contain global installs in an isolated prefix and seed the registry.** `npm_config_prefix=<scratch>/drill-npm-prefix` + PATH prepend for the drill so the machine's global vf is never clobbered; a dev-tree UI's replacement respawns via `process.execPath`+`process.argv[1]` (source, not the global install). Live-server enumeration reads `~/.vibeflow/projects.json` — back it up, seed the worktree entry (a bare `vf ui` start does not register it), restore after. Cleanup: rm tarball, `git checkout -- package.json`, kill drill processes; verify the swap via `.ui-port` (NEW pid + `app_version`), a single listener on the port, HTTP 200, and the predecessor's log ending in `handoff to v… complete`.

- **Handoff hardening (seamless `vf ui` swap): three non-obvious guards the first cut missed, all adversarial-review findings.** (a) Request clear must be IDENTITY-GUARDED — `clearUpdateRequest(base, requestId)` reads the file and unlinks ONLY when `request_id` matches; clearing by path alone deletes a NEWER request written by a second `vf update` while a handoff was in flight (~33s window) and that updater then times out waiting for a state keyed to an id that can never appear. (b) The drain commit must re-check replacement liveness with OS truth (`process.kill(pid, 0)` via the seam) right before writing DRAINED — the `child.once("exit")` EVENT can be delivered late, so a replacement that died after publishing `.ui-port` would otherwise drain the old server into a port nobody serves; a dead replacement frees the port so the fail path's `recoverServer` can rebind it. A throwing DRAINED `writeState` must NOT fail the swap (state file is advisory — wrap it; failing it triggers a zombie recover that hits EADDRINUSE against the live replacement). (c) LAN-mode takeover: the replacement mints a FRESH `UiLanPageAuthority` (per-process random tokens, raw values never persisted), so the owner's session cookie 401s and the new bootstrap URL is printed only to the replacement's stdio-ignored stdout — owner locked out. Continuity = the predecessor passes its authority DIGESTS (sha256 hex: `pages[]` / `bootstrap[]` / `session`, preimage-hard, never raw values) through the spawn env (`VF_UI_LAN_ADOPT`); the replacement's authority adopts them as multi-digest arrays and also adopts an unspent bootstrap so the original owner URL still authenticates. Also refresh `boundPort` on every rebind ('r' restart, recover) — a stale captured port spawns the replacement onto the wrong port while the old server (now serving a different port) still confirms it by pid.

- **Moving spawn code moves the PINNED process-boundary inventory — classify residual full-suite fails before calling them pre-existing.** `test/owned-ai-route-coverage.test.ts` pins the exact file list allowed to import `node:child_process`; extracting code that spawns (cli.ts → commands/ui.ts + update.ts) fails it until the list moves WITH classifications (carry the old class for moved spawns; package-manager installs follow the `tool-extension` precedent). Same class: editing `docs/*.md` fails the landing byte-identical mirror tests until `cp docs/X.md landing/src/content/wiki/X.md`, and any src/test change leaves normative proof digests stale until `bun run scripts/refresh-normative-proofs.ts`. The agent's "pre-existing" label for these is wrong whenever the pin covers files your diff moved.

- **Put "commit before returning even if checks remain" in every implementer dispatch.** Cheap CLIs repeatedly hit their iteration cap with green code but before `git commit`, returning an uncommitted tree and a partial report; the clause makes them commit the last green state. Also instruct: focused suites between steps, full gates last.

- **Version decisions must use `cmpVersionPrecedence`, not `cmpSemver`.** `cmpSemver` intentionally ignores prerelease/build suffixes (`1.0.0-rc.1` compares EQUAL to `1.0.0`) — it answers "is a newer RELEASE out", not "which generation is newer". Any update/handoff/staleness/install-change decision built on it turns `rc.1 → rc.2` into a no-op: no upgrade offered, `--force` required, handoff refused. The precedence-aware comparator lives in `src/core/version-format.ts` (SemVer §11, malformed input falls back to the numeric coercion); apply it CONSISTENTLY across every version decision (install-change check, staleness filter, doctor, auto-update, the ui-watcher's actionable check). Reviewers flag equality-based version comparisons.

- **Installing packages on Windows: `.cmd` shims are not directly executable.** `spawnSync("npm", …)` fails before running on Windows because npm/pnpm resolve to `.cmd` shims. Route package-manager spawns through the canonical launcher helpers (`needsShellForCommand` / `shellLaunchArgv`, `src/core/command-runtime.ts`) — same policy `src/dispatch/spawners.ts` uses — keeping the direct argv spawn as the POSIX/real-executable path. Because macOS CI cannot execute the win32 branch, pin the routing with a source-shape test (`expect(src).toContain("needsShellForCommand(")`) — a mutation that removes the branch then goes red on every platform.

- UI version mismatch when testing locally — `bun run vf ui` can serve stale/global binary. After `bun run build`, `node dist/cli.js` resolves its package.json at runtime via `readVersion()`. If the served UI shows `vf-version=0.12.1` (old Stepper with verify-as-default page) instead of the local version, the running binary is stale or from a global install. **Check:** `curl -s http://localhost:PORT | grep vf-version` and compare to `node -p "require('./package.json').version"`. Asset hashes from `bun run --cwd src/ui build` (printed as e.g. `index-BDdjx1kV.js`) must match what's actually served — old hashes (`index-Dlz_UV3k.js`) mean a stale `dist/ui/` or a different binary. **Fix:** Kill all `lsof -ti:PORT` listeners, re-run `bun run build`, then start with `node dist/cli.js ui --port PORT` (not `bun run vf ui`) to guarantee the freshly built binary runs. Verify the version and hashes match after restart.

- UI "Capability index unavailable / Failed to fetch" — CSRF token not sent on GET requests. The VibeFlow UI `conversation-home-http.ts` headers builder only included `x-vibeflow-token` on POST/PATCH (`write && CSRF`). GET requests to `/api/capabilities`, `/api/conversations`, etc. sent no token → server `guarded()` fails → 401 → fetch throws → "Failed to fetch". **Fix:** `conversation-home-http.ts` — always include the header when CSRF is available: `...(CSRF ? { [headerName]: CSRF } : {})` (remove `write &&` guard). Every GET to an API route needs this. **Secondary layer:** the `/api/capabilities` route server-side only used `ConversationSessionAuthority.authorize()` (cookie-based), which requires a `vf_conversation_session` cookie the standalone `vf ui` server does not set. Fix: capability route falls back to `guarded(req)` (CSRF header) when session auth fails. Full trace recipe in `references/ui-auth-troubleshooting.md`.

- **`/api/settings/apply` is the POLICY-preview route, not a general settings write.** It consumes a `previewId` from the policy-preview store and refuses other shapes; a plain settings save (e.g. `{update:{mode,manager}}`) posts to `POST /api/settings` → `handleSettingsRoute` → `writeSettings` (the `update` block merges via `coerceUpdateSettings`). A plan or UI change that POSTs ordinary settings to `/apply` is broken by construction.

- **Check the waiver lists before planning edits to big files.** The 400-line gate honors in-line `// size-waiver: #N — reason` headers (e.g. `src/server.ts` — also listed in `COVERAGE_WAIVERS` in `scripts/coverage-gate.cjs`) plus the central WAIVERS in `scripts/check-file-size.cjs`. A few files sit at EXACTLY 400 (`src/server/routes.ts`, `src/ui/src/api.ts`) and must not gain lines — route new dispatch INLINE into the waived `src/server.ts` (precedent: the `/api/race` POST block self-guards with `guarded(req)` BEFORE the `isWrite` gate, whose dispatch modules are at cap).
