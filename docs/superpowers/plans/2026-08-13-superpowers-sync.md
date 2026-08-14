# Superpowers Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dry-default `vf superpowers sync` command that installs one registry-locked Superpowers commit into present Claude, Codex, and OpenCode CLIs, takes over foreign selectors only with `--yes`, and persists telemetry-off defaults.

**Architecture:** One pure-ish core module owns strict pin resolution, generated marketplace/config/receipt mutations, engine plans, and isolated native-manager execution through injected seams. A thin command module renders results. Existing CLI/facade/help wire the command without adding dependencies or exceeding the 400-line cap.

**Tech Stack:** TypeScript, Node stdlib, existing `smol-toml`, Bun tests, native Claude/Codex/OpenCode plugin managers.

## Global Constraints

- No model-backed readiness probes or token spend; eligibility is binary presence only.
- No `--yes` means dry-run; `--dry-run` is an explicit alias.
- `--yes` is explicit takeover consent for foreign Superpowers selectors.
- Desired source is exactly one canonical `https://github.com/obra/superpowers.git` lock entry with a full 40-character lowercase OID and matching cache HEAD.
- No shell interpolation; child operations use argv arrays, bounded timeout, captured output, and sanitized/bounded errors.
- No plugin-loader reimplementation and no new runtime dependency (`confbox` and `smol-toml` are bundled into `dist/cli.js`).
- Preserve unrelated engine config; malformed config fails that engine without write.
- Continue after per-engine failure; global lock/cache failures stop before mutation.
- 100% changed-line coverage; docs and landing mirror stay identical where duplicated.

---

### Task 1: Repair Layer 1 nested flag forwarding

**Files:**
- Modify: `src/cli.ts:255-256`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: original `rest: string[]` from `main(argv)`.
- Produces: `skills(rest[0], rest.slice(1))`, preserving nested `--ref`, `--yes`, and `--mode` tokens.

- [ ] **Step 1: Add subprocess RED tests**

Add one test proving `skills registry add obra/superpowers --ref v1` reaches dry-run instead of usage exit 2, and one invalid `skills sync --mode invalid` test proving mode reaches its handler.

- [ ] **Step 2: Run RED**

Run: `bun test test/cli.test.ts -t "nested skills flags"`
Expected: existing routing drops flags; assertions fail.

- [ ] **Step 3: Apply minimum route fix**

Replace the `positionals` call with:

```ts
case "skills":
  return skills(rest[0], rest.slice(1));
```

- [ ] **Step 4: Run GREEN**

Run: `bun test test/cli.test.ts -t "nested skills flags"`
Expected: pass.

---

### Task 2: Build strict pin, marketplace, config, and receipt primitives

**Files:**
- Create: `src/superpowers-sync.ts`
- Create: `test/superpowers-sync-765.test.ts`

**Interfaces:**
- Produces:

```ts
export type SuperpowersEngine = "claude" | "codex" | "opencode";
export type SuperpowersSyncStatus = "planned" | "installed" | "already-current" | "skipped" | "failed";
export interface SuperpowersPin { url: string; commitOID: string; cacheDir: string }
export interface SuperpowersSyncResult {
  engine: SuperpowersEngine;
  status: SuperpowersSyncStatus;
  commitOID: string;
  actions: string[];
  detail: string;
}
export interface SuperpowersSyncSummary {
  ok: boolean;
  dryRun: boolean;
  commitOID?: string;
  results: SuperpowersSyncResult[];
  error?: string;
}
```

- `resolveSuperpowersPin(repo, inject)` returns an exact validated pin or a bounded error.
- `marketplaceName(oid)` and `renderMarketplace(pin)` generate one commit-qualified marketplace accepted by Claude and Codex.
- `mergeOpenCodeConfig(raw, spec)`, `mergeClaudeTelemetry(raw)`, `mergeCodexTelemetry(raw)`, and `renderOpenCodeTelemetryHook()` return validated content plus `changed`.
- `parseReceipt(raw)` and `renderReceipt(current, engine, oid)` implement schema v1 with known engines/full OIDs only.

- [ ] **Step 1: Write pin RED tests**

Cover zero/multiple canonical entries, partial/uppercase OID rejection, missing cache, cache HEAD mismatch, and valid full OID. Inject local git-head lookup; no network.

- [ ] **Step 2: Run pin RED**

Run: `bun test test/superpowers-sync-765.test.ts -t "pin"`
Expected: imports/functions absent.

- [ ] **Step 3: Implement strict pin resolution**

Use existing `parseRegistryLock`, `registryCacheDir`, and canonical URL normalization. Require `/^[0-9a-f]{40}$/`. Never resolve/refetch latest.

- [ ] **Step 4: Write config RED tests**

Cover:

```ts
// OpenCode: provider/model/permission/agent/unknown keys and other plugins survive;
// all canonical stale Superpowers git specs collapse to one desired spec.
// malformed/non-object JSON and non-string plugin entries throw with no write.
// Claude: unrelated settings/env survive; absent telemetry gets "1";
// explicit existing telemetry value survives.
// Codex: unrelated TOML semantic values survive parse/stringify;
// absent shell_environment_policy.set receives the key;
// explicit existing value survives; malformed TOML throws.
// Hook uses ??= so explicit runtime env wins.
// Receipt rejects malformed/unknown-engine/partial-OID data.
```

- [ ] **Step 5: Run config RED**

Run: `bun test test/superpowers-sync-765.test.ts -t "config|telemetry|receipt|marketplace"`
Expected: fail.

- [ ] **Step 6: Implement minimum primitives**

Use `JSON.parse/stringify`, existing `writeFileSafe`, and `smol-toml` parse/stringify. Generated marketplace plugin source:

```json
{"source":"url","url":"<lock url>","sha":"<full OID>"}
```

Keep marketplace name commit-qualified. Do not copy/vendor upstream source.

- [ ] **Step 7: Run primitive GREEN**

Run: `bun test test/superpowers-sync-765.test.ts -t "pin|config|telemetry|receipt|marketplace"`
Expected: pass.

---

### Task 3: Plan and execute three native adapters with isolation

**Files:**
- Modify: `src/superpowers-sync.ts`
- Modify: `test/superpowers-sync-765.test.ts`

**Interfaces:**
- Produces:

```ts
export interface SuperpowersSyncOptions { yes?: boolean; dryRun?: boolean }
export interface SuperpowersSyncInject {
  hasCommand?: (command: string) => boolean;
  spawnSync?: SpawnFn;
  homedir?: () => string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readFileSync?: typeof readFileSync;
  existsSync?: typeof existsSync;
  writeFileSafe?: typeof writeFileSafe;
  gitHead?: (cacheDir: string) => string | null;
}
export function syncSuperpowers(
  repo: string,
  options?: SuperpowersSyncOptions,
  inject?: SuperpowersSyncInject,
): SuperpowersSyncSummary;
```

- [ ] **Step 1: Write dry-run/eligibility RED tests**

Assert canonical result order `claude`, `codex`, `opencode`; absent binaries are `skipped`; present binaries are `planned`; exact OID and argv/config actions are printed; no spawn/write occurs.

- [ ] **Step 2: Run RED**

Run: `bun test test/superpowers-sync-765.test.ts -t "dry-run|eligibility"`
Expected: fail.

- [ ] **Step 3: Implement dry planner**

Presence-only via injected `hasCommand`; no `preflightAllAsync`, model probe, native list, file write, or network command during dry-run.

- [ ] **Step 4: Write Claude apply RED tests**

Assert telemetry/settings and marketplace files are atomic-written before install; native list JSON controls desired/foreign selectors; desired installs first; foreign selectors uninstall only after success; receipt advances last; matching receipt + selector + telemetry is `already-current` with zero native mutations.

- [ ] **Step 5: Implement Claude adapter**

Native argv only:

```text
claude plugin list --json
claude plugin marketplace add <root> --scope user
claude plugin install superpowers@<marketplace> --scope user
claude plugin uninstall <foreign-id> --scope user -y
```

- [ ] **Step 6: Write Codex apply RED tests**

Assert structured list `source.sha`, native add/install, foreign removal after success, receipt-last, and no-op current rerun.

- [ ] **Step 7: Implement Codex adapter**

Native argv only:

```text
codex plugin list --json
codex plugin marketplace add <root> --json
codex plugin add superpowers@<marketplace> --json
codex plugin remove <foreign-id> --json
```

- [ ] **Step 8: Write OpenCode apply RED tests**

Assert exact JSON/JSONC spec merge/hook, native `opencode debug config` loader execution, receipt-last, malformed config failure/no write, and current rerun zero mutations.

- [ ] **Step 9: Implement OpenCode adapter**

Use documented global/custom config path resolution and exact `#<OID>` spec. Invoke the native config loader after atomic config/hook writes.

- [ ] **Step 10: Write failure-isolation/output-safety RED tests**

Make Claude fail; assert Codex/OpenCode still run and summary exit state fails. Inject control sequences/credentials/long stderr; assert bounded sanitized detail and no env values.

- [ ] **Step 11: Implement isolation and sanitization**

Catch each adapter independently. Run child commands with 120-second timeout, `shell:false`, captured strings. Strip control/format/line-separator chars, redact URL query/userinfo, and cap details.

- [ ] **Step 12: Run adapter GREEN + coverage**

Run: `bun test test/superpowers-sync-765.test.ts --timeout 30000`
Expected: pass.

Run: `bun test test/superpowers-sync-765.test.ts --coverage --coverage-reporter=lcov`
Expected: every changed core line covered.

---

### Task 4: Wire command, help, and deterministic output

**Files:**
- Create: `src/commands/superpowers.ts`
- Create: `src/commands/help-superpowers.ts`
- Modify: `src/commands.ts`
- Modify: `src/cli.ts`
- Modify: `src/commands/help-commands.ts`
- Modify: `src/commands/help.ts`
- Test: `test/cli.test.ts`
- Test: `test/help-text.test.ts`

**Interfaces:**
- `superpowers(subcommand, flags, repo = cwd(), inject?)` accepts only `sync`; unsupported subcommand/flags return 2.
- Render one line per engine with status, full OID in dry-run plan, actions, and bounded detail.

- [ ] **Step 1: Write command RED tests**

Cover `vf superpowers --help`, invalid subcommand exit 2, dry-default output, explicit `--dry-run`, and `--yes` forwarding.

- [ ] **Step 2: Run RED**

Run: `bun test test/cli.test.ts test/help-text.test.ts -t "superpowers"`
Expected: fail.

- [ ] **Step 3: Wire minimum command**

Add facade export and top-level `case "superpowers"`. Add global help roster line. Put help text in `help-superpowers.ts`; remove enough blank lines or move an existing help block so `help-commands.ts` remains at or below 400 lines—no waiver.

- [ ] **Step 4: Run command GREEN**

Run: `bun test test/cli.test.ts test/help-text.test.ts -t "superpowers|nested skills flags"`
Expected: pass.

---

### Task 5: Document and verify end-to-end

**Files:**
- Modify: `docs/COMMAND_REFERENCE.md`
- Modify: `landing/src/content/wiki/COMMAND_REFERENCE.md`
- Keep: `docs/superpowers/specs/2026-08-13-superpowers-sync-design.md`
- Keep: `docs/superpowers/plans/2026-08-13-superpowers-sync.md`

**Interfaces:** None.

- [ ] **Step 1: Document exact contract**

Add syntax, dry-default/`--yes`, presence-only eligibility, takeover behavior, exact lock/cache pin, telemetry persistence, statuses, failure isolation, and examples. Keep duplicated sections byte-identical.

- [ ] **Step 2: Run focused/full verification**

Run:

```bash
bun run build
bun run test
bun run coverage:check
npm run build --prefix landing
bun run waiver:check
bun run file-size:check
bun run typecheck
bun run lint
git diff --check
```

Expected: all pass; no new waiver/dependency.

- [ ] **Step 3: Independent two-stage review**

Review spec compliance, then security/config preservation. Reproduce every finding before fixing.

- [ ] **Step 4: Commit final HEAD and create review evidence**

Create HEAD-bound review evidence against `origin/main` using the real reviewer result.

- [ ] **Step 5: Run mandatory VibeFlow verification**

Run: `vf verify --coverage --review-base <full-origin-main-SHA>`
Expected: confidence 1.0 and all configured gates pass, including test evidence and current-HEAD review evidence.

- [ ] **Step 6: Open PR**

Title: `feat(cli): sync pinned Superpowers across connected engines (#765)`

Body must state the grounded presence-only re-scope, explicit takeover consent, native-manager spikes, telemetry persistence, test/gate evidence, and `Closes #765`.

Then wait for final-SHA CI/Copilot, reproduce/fix findings, resolve only addressed threads, and merge only when CI is green with zero unresolved threads.
