# `vf superpowers sync` design

Date: 2026-08-13
Issue: #765 (Layer 3 of #762)
Status: approved approach; implementation pending

## Decision

`vf superpowers sync` is dry-run by default. `--yes` is explicit consent to mutate user-level engine configuration and replace foreign Superpowers selectors with one vf-managed, exact-commit installation.

Eligibility is binary presence only for Claude Code, Codex CLI, and OpenCode. Sync does not run model-backed readiness probes and spends no model tokens.

## Source of truth

Sync reads `.vibeflow/SKILL_REGISTRY.lock.json` and requires exactly one registry with canonical URL `https://github.com/obra/superpowers.git`.

Before any engine mutation it must:

1. require a full 40-character lowercase hexadecimal `commitOID`;
2. resolve the registry cache with the existing `registryCacheDir()` helper;
3. verify `git -C <cache> rev-parse HEAD` equals the locked OID;
4. fail globally when the lock is missing, malformed, ambiguous, or inconsistent.

Sync never selects latest, resolves a branch, or changes the lock.

## Engine adapters

### Claude Code

Generate a vf-owned marketplace whose plugin source is:

```json
{
  "source": "url",
  "url": "https://github.com/obra/superpowers.git",
  "sha": "<full locked OID>"
}
```

Use a commit-qualified marketplace name (`vf-superpowers-<OID prefix>`), then invoke Claude's native marketplace and plugin commands. Confirm installation through `claude plugin list --json` plus the vf receipt.

On `--yes`, install the vf selector first. After success, remove foreign Superpowers selectors so only the exact vf-managed copy remains enabled.

### Codex CLI

Generate a compatible commit-qualified marketplace with the same exact Git source. Invoke `codex plugin marketplace add ... --json` and `codex plugin add ... --json`.

Confirm installation through structured Codex plugin output and the exact `source.sha`. After the vf selector succeeds, remove foreign Superpowers selectors and their vf-replaced marketplace only when ownership is unambiguous.

### OpenCode

Merge this exact spec into the global `opencode.json` plugin array:

```text
superpowers@git+https://github.com/obra/superpowers.git#<full locked OID>
```

Replace only canonical Superpowers Git specs. Preserve every other plugin and all unrelated provider/model/permission/agent/MCP/unknown keys. Accept OpenCode's documented JSON/JSONC formats; reject malformed config or non-string plugin arrays without writing. Write atomically, then invoke `opencode debug config` to make OpenCode's native loader resolve the exact spec without the `plugin --global` custom-config-dir bug.

## Persistent telemetry opt-out

Install-time environment variables are insufficient because Superpowers reads telemetry variables when the optional visual-companion server starts.

Each successful vf-managed engine must persist `SUPERPOWERS_DISABLE_TELEMETRY=1` through its native runtime surface:

- Claude: merge into user `settings.json.env`.
- Codex: validate user `config.toml` with installed `smol-toml`, then insert under `shell_environment_policy.set` without reserializing unrelated TOML bytes.
- OpenCode: write a vf-owned global plugin implementing the documented `shell.env` hook. It sets the variable only when no explicit value exists.

Malformed config fails that engine and remains untouched. Existing unrelated values are preserved. Receipt is not advanced unless plugin pin and telemetry persistence both succeed.

## Safety and idempotence

- No `--yes`: no manager command, config write, network action, or model probe.
- `--dry-run` is an explicit alias for the default.
- `--yes` is explicit takeover consent for foreign Superpowers selectors.
- All child processes use argv arrays with no shell interpolation, bounded timeouts, captured output, and sanitized/bounded error details.
- Per-engine failure does not stop later engines.
- Atomic writes protect JSON, TOML, generated marketplace files, telemetry hook, and receipt.
- A valid receipt plus native presence/config proves `already-current`; stale or partial state triggers repair.

Receipt path: `~/.vibeflow/superpowers-sync.json`.

## Result contract

Each supported engine produces exactly one result:

- `planned`: dry-run actions printed;
- `installed`: desired pin and telemetry persistence completed;
- `already-current`: native state/config and receipt prove desired OID;
- `skipped`: binary absent;
- `failed`: one or more adapter steps failed.

Exit codes:

- `0`: valid plan/apply with no failed engine;
- `1`: global precondition failure or any per-engine failure;
- `2`: bad subcommand/flags.

## Prerequisite bug fix

`src/cli.ts` currently drops parsed flags when routing nested `vf skills` commands. Fix forwarding before relying on Layer 1 so `--ref`, `--yes`, and `--mode` reach the registry/sync handlers. Add subprocess regressions.

## Files

- `src/superpowers-sync.ts`: strict lock/cache validation, pure plans, config/receipt mutations, adapter execution.
- `src/commands/superpowers.ts`: thin command parser and result renderer.
- `src/commands.ts`, `src/cli.ts`: facade and route; nested skills flag fix.
- `src/commands/help-superpowers.ts`, `src/commands/help-commands.ts`, `src/commands/help.ts`: help without raising 400-line cap.
- `test/superpowers-sync-765.test.ts`: focused behavior, failure isolation, merge preservation, telemetry, takeover, idempotence, dry-run.
- CLI/help regression tests plus mirrored command reference docs.

## Verification

- RED/GREEN tests for every adapter and prerequisite flag bug.
- 100% changed-line coverage.
- Full test, coverage, build, landing build, lint, typecheck, waiver, and file-size gates.
- HEAD-bound independent review evidence.
- Final `vf verify --coverage` at confidence 1.0.

## Explicit non-goals

- No plugin-loader reimplementation.
- No model-backed connection probes.
- No upstream skill vendoring or editing.
- No lock update or latest-version resolution.
- No silent mutation without `--yes`.
- No support for engines beyond Claude, Codex, and OpenCode in #765.
