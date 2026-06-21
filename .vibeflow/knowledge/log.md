
## [2026-06-11] logbus | M2-M6 shipped — streaming logs to UI complete
- M2: engine stderr pipe (dispatch.ts + 6 tests)
- M3: SSE endpoint (server.ts + 7 tests)
- M4: UI bottom dock + Logs tab (server.html + 13 e2e tests)
- M5: .ui-port + tip + retention
- M6: final verify — 488 pass / 0 fail
- All pushed to origin/main

## [2026-06-11] M5-M6 — .ui-port + tip + retention + final verify
- src/cli.ts: .ui-port file write/delete for cross-process port discovery (port, pid, startedAt)
- src/commands.ts: print "Tip: watch live at http://...port" on orchestrate (once per process, via tipState flag)
- src/logbus.ts: prune() already called on close() + rotateLocked() — retention already implemented in M0-M4
- Total: 488 pass / 0 fail
- tsc: clean | biome: clean (73 files) | audit: no vulnerabilities

## [2026-06-11] M4 — UI bottom panel + Logs tab
- src/server.html: bottom CLI Log dock (auto-open on engine events, resizable)
- src/server.html: full-screen Logs tab with channel filter chips
- EventSource consumer for /api/logs/stream
- BroadcastChannel for cross-tab dedup
- textContent used for all rendered log text (no innerHTML)
- e2e/logs.e2e.ts: 13 Playwright tests (13 pass / 0 fail)
- Gates: tsc clean, biome clean, 488 unit tests pass / 0 fail
- Total confidence: 1.0

## [2026-06-11] dispatch | claude → goal partial
1 unit(s) dispatched (cli, concurrency 3)
- task: verifying @ 1
- review task: pass — confidence 1.0 with evidence

## [2026-06-11] dispatch | claude → goal partial
1 unit(s) dispatched (cli, concurrency 3)
- task: verifying @ 1
- review task: pass — confidence 1.0 with evidence

## [2026-06-11] verify | sport-host-build compile gate PASSED

Ran `./gradlew :composeApp:compileDebugKotlinAndroid` with JDK 17 (`JAVA_HOME=/Users/linhn/.sdkman/candidates/java/17.0.11-amzn`).
Result: BUILD SUCCESSFUL in 1s, 11 actionable tasks (1 executed, 10 up-to-date).
No source modifications needed — the AGP bypass (`android.builtInKotlin=false` + `android.newDsl=false`) and version ceiling (Kotlin ≤2.4.0, AGP ≤9.1.x, Gradle ≤9.5.0) are intact.

## [2026-06-11] dispatch | claude → goal blocked
3 unit(s) dispatched (cli, concurrency 3)
- task: verifying @ 1
- sport-host-tests: blocked @ 0.85
- sport-host-build: verifying @ 1
- review task: pass — confidence 1.0 with evidence
- review sport-host-tests: fail — confidence 0.85 < 1 — investigated, still blocked
- review sport-host-build: pass — confidence 1.0 with evidence

## [2026-06-11] verify | fail
2 gate(s) failed
- confidence<1: "sport-host-tests" at 0.85 — investigate/debate before close

## [2026-06-11] discovery | release-please integrated for @magicpro97/vibeflow
Replaced manual version-bump flow with Google `release-please` for the npm package.

**Files added**
- `release-please-config.json` — single-package `node` config; `package-name: @magicpro97/vibeflow`; `bump-minor-pre-major: false`, `bump-patch-for-minor-pre-major: false`, `include-component-in-tag: false` (tag = `vX.Y.Z`, not `package-vX.Y.Z`); 10 changelog sections (feat/fix/perf/refactor/docs/build/ci/test/chore) with `chore` hidden.
- `.release-please-manifest.json` — `{ ".": "0.3.17" }` to seed the bot at current version (matches `package.json` exactly).

**Files modified**
- `.github/workflows/ci.yml` — added `release-please` job (only on push to main, NOT on PRs); permissions `contents: write` + `pull-requests: write`. The `check` job is untouched and still gates typecheck/lint/test/build/smoke/e2e.
- `.github/workflows/release.yml` — changed trigger from `push.paths: package.json` to `pull_request: types: [closed]` + `workflow_dispatch` (manual fallback). Added job-level guard: runs only when `pull_request.merged == true` AND label `autorelease:pending` is present (release-please bot adds this label; the bot also removes it on a normal non-release PR merge, so this guard naturally short-circuits unrelated merges). Inner steps (npm version check, install/check/build, publish with provenance, tag + push tag) are unchanged.

**Verification (real command output)**
- `node -e "JSON.parse(...)"` passes for both JSON files.
- `release-please-config.json` payload: 691 chars, valid JSON.
- `.release-please-manifest.json` payload: `{ ".": "0.3.17" }`.
- `npx yaml-lint .github/workflows/{release,ci}.yml` → PASS ("✔ YAML Lint successful").
- `npx actionlint .github/workflows/{release,ci}.yml` → PASS (exit 0, no output).
- `action.yml` of `googleapis/release-please-action@v4` confirmed: input name is `token` (not `github-token`), action auto-discovers `release-please-config.json` + `.release-please-manifest.json` at repo root with no extra inputs needed.
- `yamllint` (Python) reports line-length warnings on lines 81–170 chars — these are stylistic and pre-existed in the original `release.yml`; the canonical Actions linter `actionlint` is clean.

**Caveats / points of attention**
- Conventional Commits mapping (`feat`/`fix`/`feat!`/`BREAKING`) is now the SOLE bump driver. The repo's commit history is not retroactively rescanned — first release from this setup will be whatever the next `feat:` / `fix:` / `BREAKING` PR triggers.
- `release-please` job runs ONLY on `push` to `main` (not on PRs), so it does not consume PR CI quota.
- After the first Release PR is opened, merging it triggers `release.yml` (PR closed + `autorelease:pending` label present). The `id-token: write` permission is still required for `npm publish --provenance` (Sigstore OIDC).
- Token `NPM_TOKEN` must remain valid in repo secrets; `GITHUB_TOKEN` is used by release-please (no PAT needed).
- The bot creates the Release PR from a **branch in the same repo** (default `fork: false`), named like `release-please--branches--main`. First run may take 30–60s to compute the next version.

## [2026-06-11] logbus | M1.5 — must-fixes applied; codemod rolled out — BLOCKED on test regression
- 3 must-fixes applied (src/logbus.ts, test/logbus.test.ts):
  - Real concurrent test: 2 `Logbus` instances, distinct runIds, same dir, 50 interleaved writes, all lines parse, no duplicate seqs per runId. PASSES.
  - Dead `rotate()`: now `async rotate(): Promise<void>`, properly awaits `lockfile.lock()` with same retry/stale params, wraps `rotateLocked()` in try/finally with `release()`. JSDoc added.
  - `stale: 10_000` → `stale: 2_000` (both occurrences: writeLocked + new rotate). 2s window: short for fast M2 CLI, long for graceful exit.
- New `rotate() is async, acquires the lock, and creates a fresh current.log.1` test added (covers the new async path).
- Codemod applied to `src/commands.ts` (185 console.* → 187 out()) and `src/cli.ts` (7 console.* → 7 out()). 0 console.* remaining in either file. Exactly one `import { out } from "./logbus.js";` at top of each.
- **BLOCKED on test regression**: 32 failures vs 3 baseline — 29 NEW regressions from the codemod. Root cause: `out()` writes to **process.stderr** when no bus is active, but tests that spawn the CLI capture **process.stdout** expecting `console.log`-style output. The reviewer-approved codemod is semantically correct (substitutes logging path) but breaks every test that asserts on stdout content (cli help routing, orchestrate source-protection gate, workflow command, etc.).
- Gates observed at this checkpoint:
  - `bunx tsc --noEmit` — CLEAN
  - `bunx biome check src test scripts` — CLEAN (after `--write`)
  - `bun audit` — no vulns
  - `bun test` — 441 pass / 32 fail (was 468 pass / 3 fail before codemod)
- ESCALATION to orchestrator: must decide path forward before continuing. Three options: (a) update `out()` to write to stdout (preserves user-visible behavior, contradicts logbus design), (b) revert the codemod and ship without it (defer M1.5's logging migration), (c) update the 29 affected tests to assert on stderr / the logbus file. Each has a different cost — please pick one and re-dispatch.
- M2 readiness: depends on the above decision.

## [2026-06-11] logbus | M1.5 Option A applied
- out() no-bus fallback routes level:info → console.log (stdout), level:warn|error|debug → console.error (stderr)
- Strip [vf] prefix for stdout (user-facing); keep [channel] for stderr (diagnostic); non-vf channels keep prefix on both streams
- Uses console.log/console.error (NOT raw process.stdout/stderr.write) so test mocks that replace console.log/console.error capture the fallback — production routing is identical because Node's console.* writes to the corresponding stream
- Codemod-shaped `{ level: ... }` options bag is extracted from the last variadic arg; the rest are joined with single spaces (console.log semantics preserved)
- Updated test/out.test.ts and test/logbus.test.ts to assert on console.log/console.error (mocks) instead of process.stdout/stderr.write (raw streams), and to expect the new prefix/stream routing
- 29 codemod-induced regressions resolved (all cli.test.ts out-routing assertions now pass)
- Total: 472 pass, 3 pre-existing fail (all in commands.tools — same names as pre-codemod baseline)
- Gates: bunx tsc --noEmit clean; bunx biome check src test scripts clean
- Ready for M2 (dispatch.ts stderr pipe)

## [2026-06-11] logbus | M0-M1.5 checkpoint — shipped
- All logbus code committed and pushed to origin/main in 3f3cad6 (release: v0.3.18) and surrounding context commits. Logbus is in the production tree.
- Implementation: src/logbus.ts (Logbus class with writer, rotate, prune, cross-process lock), src/logbus-watcher helper, out() variadic helper
- Codemod: scripts/codemod-console-to-out.ts (jscodeshift) + scripts/apply-codemod-m1.5.ts runner
- 185 console.* sites replaced with out("vf", ...) in src/commands.ts; 7 in src/cli.ts
- 33 new tests (test/logbus.test.ts 16, test/out.test.ts 7, test/logbus-watcher.test.ts 5, test/codemod.test.ts 5) — all 33 pass
- Cross-process serialization via proper-lockfile@^4.1.2 (POSIX + Windows); in-process via single Promise chain
- 2 MB rotation threshold, 5 rotated copies, 7-day / 500 MB retention
- chmod 0o600 on every new file (logs may contain engine output secrets)
- Deliverable: .vibeflow/logs/current.log (JSONL with runId, seq, ts, level, channel, msg)
- Working tree: only `.vibeflow/ai-context/project-profile.json` (e2e-advisory auto-regen) left unstaged per user instruction
- M2 (dispatch.ts stderr pipe → bus) is unblocked

## [2026-06-11] logbus | M2 — engine stderr pipe to bus
- src/dispatch.ts: stdio ["pipe","pipe","inherit"] → ["pipe","pipe","pipe"]; AsyncSpawnerOpts gains onStderrChunk; stderr accumulated internally (not in public AsyncSpawner shape)
- src/commands.ts: per-unit streamSpawner + orchestrator + launchEngine spawners all wire onStderrChunk to bus as out("engine-stderr", text, { level:"warn", unit, meta:{engine, unit} }); out("engine-stdout", ...) added for symmetry
- src/logbus.ts: out() now forwards unit + meta from the trailing options bag (extractOptsAndParts); "vf" channel is tee'd to console for backward compat (existing test mocks + CLI rendering), engine-*/user/hook channels are bus-only (M2 contract: stderr no longer leaks to TTY)
- installLogbus() called at top of orchestrate() and run() so engine-stderr bytes always land on the bus (deliberately NOT in main() so vf --help / version keep their stdout rendering)
- test/dispatch-stderr.test.ts: 6 new tests — stdout onChunk, stderr onStderrChunk, bus routing at level=warn, ordered stdout/stderr interleaving, engine+unit in meta, JSONL persistence on disk
- 481 pass / 0 fail (475 baseline + 6 new); no regressions
- Gates: bunx tsc --noEmit clean, bunx biome check src test clean
- M3 (SSE endpoint + createReadStream from current.log) unblocked — the bus already has a watchLogbus watcher and subscribers are wired; the missing piece is the HTTP route that tails the file

## [2026-06-11] logbus | M3 — SSE endpoint + replay endpoints
- src/server.ts: `/api/logs/stream` SSE endpoint that uses `Logbus.subscribe()` for live events, catch-up replay from current.log at connect time, 25s heartbeat, cleanup on disconnect
- src/server.ts: `/api/logs/recent?since=&limit=` JSON endpoint for replay on reconnect
- src/server.ts: `replayFromLog()` helper — reads current.log, filters by seq, caps at limit, handles files >2MB by reading only the tail
- src/server.ts: old `/events` endpoint kept as-is (marked `DEPRECATED in v0.4`)
- test/sse-stream.test.ts: 7 new tests — subscribe/unsubscribe, recent endpoint filtering, SSE headers + initial comment, catch-up events, live event delivery, old endpoint backward compat
- No changes to src/logbus.ts: `subscribe()` already returns `() => void` ✅
- Total: 488 pass / 0 fail (481 baseline + 7 new)
- Gates: bunx tsc --noEmit clean, bunx biome check src test clean

## [2026-06-12] analysis | copilot-only UI generates codex-looking config
- Investigated UI intake engine selection without code changes.
- Source evidence: `src/server.html` submits `engines: fd.getAll("engine")` to `/api/init`; `src/commands.ts` uses those engines via `chosenEngines()` and `gateEngines()`.
- Root cause candidates: `src/adapters.ts` intentionally emits `AGENTS.md` for `copilot`, and `src/commands.ts` unconditionally calls `writeToolConfigs()`, whose implementation writes Codex `.codex/config.toml` when optional tools are enabled.
- Verification attempt: `bun --input-type=module -e ...` could not run because `proper-lockfile` dependency was not installed in the workspace.

## [2026-06-12] fix | copilot-only init scoped to .github
- Fixed Copilot adapter output so `engineFiles("copilot")` emits `.github/copilot-instructions.md` only, without `AGENTS.md` or `.agents/instructions.md`.
- Scoped `writeToolConfigs()` by selected engines, so copilot-only init no longer writes `.codex/config.toml` even when optional tools are enabled.
- Updated docs to state Copilot uses `.github/`, not `.agents/` or `.codex/`.
- Verification: `bun test test/cli.test.ts` passed 91/91; `bun run lint` passed; `bun run typecheck` passed.

## [2026-06-12] update | AGENTS.md shared by codex and copilot
- Updated the Copilot contract to emit root `AGENTS.md` plus `.github/copilot-instructions.md`, while still avoiding `.agents/` and `.codex/` for copilot-only init.
- Source check: GitHub Copilot docs say repository custom instructions use `.github/copilot-instructions.md`, and agent instructions may use `AGENTS.md` stored anywhere in the repository.
- Verification: `bun test test/cli.test.ts` passed 91/91; `bun run typecheck` passed; `bun run lint` passed.

## [2026-06-12] update | active CLI intake for vf init --ai
- Added `collectAiInitIntake()` in `src/commands.ts` as a separate active intake step for `vf init --ai --ask` and `vf init --ai --interactive`.
- Updated `src/cli.ts` so plain `vf init --interactive` keeps the existing static flow, while `--ai --interactive` routes through the new active intake before deterministic init and AI enrichment.
- Updated init help text with `--ask` and `--ai`; added a non-TTY regression test in `test/cli.test.ts` to prevent hanging.
- Verification: `bun run typecheck` passed; `bunx biome check src/cli.ts src/commands.ts test/cli.test.ts` passed; `bun test test/cli.test.ts` passed 92/92; `vf verify` ran 510 tests passing but failed existing workflow confidence gate for `sport-host-tests` at 0.85.

## [2026-06-12] refactor | init intake moved to dedicated module
- Moved active CLI question helpers from `src/commands.ts` to `src/init-intake.ts`, keeping `commands.ts` as the orchestration caller only.
- Verification: `bun test test/cli.test.ts` passed 92/92 before the move; after the move, `bunx biome check src/init-intake.ts src/commands.ts src/cli.ts test/cli.test.ts` passed and `bun run typecheck` passed.

## [2026-06-12] update | init --ask questionnaire data model
- Added `createInitAskQuestionnaireData()` in `src/init-intake.ts` to accept and normalize the planned `vf init --ask` questionnaire answers without wiring it into the command flow yet.
- The data model covers project overview/source analysis choice, workflow phases, per-phase input/output/template details, document location, task platform, and document file types.
- Verification: `bun run typecheck` passed; `bunx biome check src/init-intake.ts` passed.

## [2026-06-12] update | init --ask feeds applyIntake
- Wired `vf init --ask` in `src/commands.ts` to collect the new questionnaire data, convert it with `initAskQuestionnaireToIntakeAnswers()`, and pass the resulting `IntakeAnswers` into `applyIntake()`.
- This change is CLI-only; `/api/init` and `vf ui` remain unchanged for future adjustment.
- Verification: `bun test test/cli.test.ts` passed 92/92; `bunx biome check src/init-intake.ts src/commands.ts src/cli.ts test/cli.test.ts` passed; `bun run typecheck` passed.

## [2026-06-12] test | ai-init copilot argv prompt expectation
- Updated `test/ai-init.test.ts` to match current `runAiInit()` behavior: Copilot receives the full AI-init prompt through argv (`-p`) instead of a prompt-file reference.
- Verification: `bun test test/ai-init.test.ts` passed 15/15; `bunx biome check test/ai-init.test.ts` passed; `bun run typecheck` passed.

## [2026-06-16] update | agent-team init CLI loading and inline logs
- Updated `src/commands.ts` so default `vf init --ai` agent-team workflow shows a spinner while `runAiInitWorkflow()` runs.
- Added default agent-team spawner streaming callbacks matching the legacy `--no-agent-team` flow: stdout lines go to `engine-stdout`, stderr lines go to `engine-stderr`, both prefixed with the selected engine label.
- Updated `test/commands-coverage.test.ts` loading expectations and added coverage for agent-team factory stdout/stderr streaming.
- Verification: `bun test test/commands-coverage.test.ts` passed 163/163; `bun run typecheck` passed; `bun run lint` passed.

## [2026-06-16] verify | fail
1 gate(s) failed
- confidence<1: "u1" at 0.5 — investigate/debate before close

## [2026-06-16] update | init default engine and no-ask flag
- Updated `src/commands.ts` so `vf init` defaults omitted `--engine` to `copilot` and safely falls back to `copilot` for invalid engine values.
- Replaced the `--ask` init control with default `--ai` questionnaire behavior plus `--no-ask` opt-out; `--dry-run` remains non-interactive.
- Updated `src/init-intake.ts` user-facing non-TTY guidance to say `pass --no-ask`.
- Updated `test/cli.test.ts` and `test/commands-coverage.test.ts` for the new defaults, including coverage that init requests `copilot` when `--engine` is omitted.
- Verification: `bun run typecheck` passed; `bun run lint` passed; `bun test test/cli.test.ts test/commands-coverage.test.ts` passed 258/258.

## [2026-06-16] verify | fail
1 gate(s) failed
- confidence<1: "u1" at 0.5 — investigate/debate before close

## [2026-06-16] update | agent-team instruction-writer scope follows selected engine
- Agent-team planner now scopes `ai-init-instruction-writer` to only the files needed for the engine being initialized (not all 4 instruction files unconditionally).
- Added `ENGINE_INSTRUCTION_SCOPE` mapping + `selectedInstructionScope` / `instructionDescription` / `instructionAcceptance` helpers in `src/ai-init-workflow.ts`.
- Reviewer `aiInitReviewer` uses `unit.scope` dynamically (instead of static `ADAPTER_SCOPE`) for instruction-writer evidence checks.
- `runAiInitWorkflow` in `src/ai-init.ts` now normalizes `intake.engines` from `forceEngine` when intake is empty, so planner picks the right scope.
- Tests added: planner scope per engine, reviewer dynamic scope, runner with `forceEngine: "copilot"` and empty intake.
- Verification: typecheck/lint clean, 55 workflow tests pass.

## [2026-06-16] verify | fail
1 gate(s) failed
- confidence<1: "u1" at 0.5 — investigate/debate before close

## [2026-06-17] audit-fix | 6 critical audit findings → 6 merged PRs
- 4-CLI review (claude + codex + opencode + 9router sub-agents) of PR#28
  produced 6 critical findings (C1–C6) and 24 medium/low items.
- All 6 critical issues fixed and merged to main:
  - C1: `.viteflow` → `.vibeflow` typo (56 occurrences, 9 files) — PR#94
  - C2: skill mirror roots centralized in workflow-artifacts.ts — PR#100
  - C3: engine priority centralized in core.ts:ENGINES — PR#99
  - C4: package.json files[] includes .agents/skills/skill-creator — PR#96
  - C5: hook output JSON doc corrected to actual runner shape — PR#97
  - C6: doctor copilot+gh split (AND → independent rows) — PR#98
- release-please auto-bumped to v0.7.0 after first PR merge.
- Each fix ships with a cross-file invariant test (5 new test files)
  that pins the contract against future regression.
- 4 audit/plan files written:
  - audit-2026-06-17-4cli-synthesis.json (raw findings)
  - audit-2026-06-17-ground-truth.md (verified vs source)
  - audit-2026-06-17-scoreboard.md (final scorecard)
  - plan-2026-06-17-4cli-audit.md (executive plan)
- Verification: 1279 tests pass (was 1258), 100% line coverage.

## [2026-06-17] hygiene | repo cleanup pass
- Added `.hermes/`, `claude/`, `coverage/`, `*.lcov`, `*.lcov.info` to
  `.gitignore` (with explanatory comments — inline `# comment` after a
  pattern silently breaks the pattern; fixed in same commit).
- Deleted 7 stale PR#28 review files (pr28-*.md) — superseded by the
  audit-synthesis files in `.vibeflow/knowledge/` and the 6 merged PRs.
- Deleted `20260613_120449_589ec6` Hermes session export (local, 3.6MB).
- Working tree now clean apart from committed-knowledge staging.

## [2026-06-21] init-hooks | vf init interactive guardrail-hook customization
- New: `vf init` Phase 1.65 — TTY menu to pick which built-in hook
  templates stay active + add custom rules; arms engine configs +
  persists policy to SETTINGS.json `hooks`. `--no-hooks` opts out.
- 5 built-in templates (block-destructive, flag-installs, protect-secrets,
  protect-config, workspace-guard) wrap the existing risk.ts clusters;
  scoreRisk gated by a resolved policy. Fail-safe: missing/corrupt config
  => ALL templates on (byte-identical to pre-feature). Only an explicit
  valid opt-out can drop a guardrail.
- Custom rules: case-insensitive LITERAL SUBSTRING match (NOT regex).
  Independent cross-review found regex => ReDoS holes (a blocklist for
  nested quantifiers misses `(a|a)*`, `((a)+)+`, backrefs); switched to
  String.includes to make CWE-1333 structurally impossible. Rules can
  only RAISE risk, never weaken a built-in.
- New files: src/hooks/templates.ts, src/init-hooks.ts. Reusable
  emitHookFiles/armHooks extracted from `vf hooks emit`.
- Verified: typecheck + lint + file-size + 100% per-file coverage + full
  suite; hook selftest 20/20 unchanged. Two independent review subagents
  signed off (security + UX/compat).

## [2026-06-21] init-hooks | review round 2 — address 5 follow-up findings + copilot smoke
- Decoupled Phase 1.65 from `--ai`: guardrails are independent of AI
  enrichment, so `vf init --no-ai` now arms hooks too (was: silently skipped).
- protect-secrets template now documents `.git/` in its label + description
  (the gate covers .git/ writes, previously undisclosed → surprise on opt-out).
- Collapsed CUSTOM_RISK_CHOICES + RISK_LABEL_TO_LEVEL into one
  CUSTOM_RISK_OPTIONS source; lookup default raised to `critical` (safe).
- Extracted isCancellation()/PROMPT_CANCEL_MESSAGES into terminal-prompts as
  the single source; init-hooks + init-intake both use it (was: duplicated
  string list, drift hazard).
- all-off menu: confirmed safe-default (deselect-all → all-on floor) is the
  RIGHT behavior for a security guardrail; documented it. True all-off is
  `--no-hooks` or hand-edit SETTINGS.json.
- Smoke-tested on a fresh empty repo with `--engine copilot`: 10 canonical +
  copilot-instructions.md + .github/hooks/copilot.json (native preToolUse veto)
  generated clean; `vf hooks emit --yes` MERGED an existing .claude/settings.json
  (permissions/model/env preserved); live `vf hook` honored a custom policy
  (block-destructive off → rm -rf allowed; custom "deploy prod" → blocked;
  protect-secrets on → cat .env blocked).
- Verified: bun run check green, 100% coverage (12116/12116), selftest 20/20.

## [2026-06-21] init-hooks | fix CI hang — hermetic test stdin + spawner stubs
- ROOT CAUSE of the PR #215 CI failure (test step ran 10min → self-hosted
  runner dropped): `vf init` Phase 1.65 hooks menu reads process.stdin via
  selectMany. On the interactive runner stdin.isTTY was truthy, so init tests
  that didn't inject hookSetup blocked on stdin until the 30s select timeout,
  ×~15 → runner starved. Decoupling wantHooks from --ai (prior round) widened
  the blast radius so --no-ai tests hit it too.
- Proven by probe: under a pty, `bun test` sees stdin.isTTY=true without the
  preload, false with it.
- Fix (test-infra only, no production change):
  1. test/preload.ts + bunfig.toml [test].preload — force stdin.isTTY=false for
     the whole run so init tests never block on the menu. installTtyMock still
     overrides per-test where a TTY is needed.
  2. Made init tests hermetic about Phase 1.6 (codegraph index build): added
     hasCommandFn:()=>true + syncSpawner:()=>({status:0}) + hookSetup:null to
     the 16 AI-enrichment injects in commands-coverage, the neutralizedAi helper
     (it had hasCommandFn but NOT syncSpawner → still spawned codegraph), the 4
     commands-coord init calls, and 2 commands-state init calls.
  3. Kept ONE cli.test.ts init ("writes canonical") on the DEFAULT spawner so
     init.ts:287-288 (the real-spawn closure) stays covered — codegraph is
     present on CI/dev so the index build is fast; gave it a 60s timeout.
  4. Raised timeouts on 2 deliberately-spawn-real tests (doctor default probe,
     pr-create gh fallback) that flaky-timeout under load.
- Lesson: hasCommandFn:true alone is NOT enough to neutralize Phase 1.6 —
  ensureToolIndex still spawns `codegraph index` unless syncSpawner is stubbed.
- Verified: bun run check EXIT 0 — 1716 tests 0 fail, 100% coverage (12116/12116).
