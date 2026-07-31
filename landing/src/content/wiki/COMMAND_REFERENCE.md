---
title: Command Reference
description: Complete reference of all shipped `vf` CLI commands and their flags — start, doctor, init, orchestrate, units, skills, hooks, and verify.
category: reference
last_updated: 2026-06-24
---

# Command Reference

## Contents

- [Start the UI](#start-the-ui)
- [Check the Environment](#check-the-environment)
- [Initialize a Workflow](#initialize-a-workflow)
- [Dispatch](#dispatch)
- [Orchestrate](#orchestrate)
- [Work Units (Ledger)](#work-units-ledger)
- [Settings (Config)](#settings-config)
- [Skills (Demand-Driven)](#skills-demand-driven)
- [Optional Tools (Code Navigation)](#optional-tools-code-navigation)
- [Discovery (Context7, Approval-Gated)](#discovery-context7-approval-gated)
- [Hooks (Guardrails)](#hooks-guardrails)
- [PR queue & merge](#pr-queue--merge)
- [Verification](#verification)
- [Eval (Telemetry Success-Rate Gate)](#eval-telemetry-success-rate-gate)
- [Help / Version](#help--version)

The shipped `vf` surface. See `USER_GUIDE.md` for a verifiable walkthrough.

## Start the UI

```bash
npx @magicpro97/vibeflow      # or, after global install: vf  (alias: vf ui)
```

Starts a local server bound to `127.0.0.1`, opens the browser, and serves the intake
wizard + live orchestration dashboard. Flags: `--port <n>`, `--no-open`.

## Check the environment

```bash
vf doctor                # presence/auth check (--probe for a live engine round-trip)
vf doctor --probe        # also run a live "reply READY" round-trip per engine
vf doctor --refresh      # invalidate the readiness cache (60s stable / 5s short TTL) and re-probe
```

Readiness results are cached (`src/probe-cache.ts`): stable probe results live 60s,
transient `probe-failed` results live 5s. `vf doctor --refresh` discards the cache and
re-probes immediately. Engines that fail the probe (presence, auth, or quota) degrade
to detection-only per `HOOKS_AND_GUARDRAILS.md`.

Checks node, git (required) and bun, claude, codex, copilot, agy, docker (optional), plus
whether the current directory is a git repo. The "Engine readiness" block reports each
engine as ready / no-binary / no-auth / probe-failed. Without `--probe` it stops at
presence/auth; with `--probe` it actually launches each engine with a trivial prompt and
requires it to reply `READY` (a bounded round-trip that proves auth and a working CLI).

## Initialize a workflow

```bash
vf init                  # scan repo + generate canonical context for all engines
vf init --engine claude  # only one engine's files
vf init --interactive    # terminal intake questionnaire (TTY only)
vf init --memory         # force the claude-mem install (skip the prompt)
vf init --no-memory      # skip the claude-mem install (skip the prompt)
vf init --dry-run        # print what would be written
```

Scans the repo and generates the minimal set: `CLAUDE.md`, `AGENTS.md`,
`.github/copilot-instructions.md`, and `.vibeflow/*` (including a seeded
`WORKFLOW_STATE.json`). `PROJECT_CONTEXT.md` includes a `## Detected stack` section.

**Memory (claude-mem):** on a TTY, `init` asks `Install claude-mem for spec/plan
recall? (Y/n)` (default yes). On yes it installs claude-mem (non-interactive) and
appends a usage guide to `WORKFLOW_POLICY.md`. The answer is saved to
`settings.memory`. `--memory` / `--no-memory` skip the prompt; a non-TTY run with
neither flag skips the step entirely. Toggle the stored setting later with
`vf config memory`.

**Readiness gate:** a real `init` runs a live preflight (the same probe as
`vf doctor --probe`) and **refuses to create a workflow when no engine is ready**.
Engines that fail the probe are skipped with a note; files are generated only for the
ready ones. `--dry-run` skips the gate (nothing is written), as does the web intake path.

## Dispatch

```bash
vf run <claude|codex|copilot|opencode|antigravity>   # write .vibeflow/dispatch/<engine>.md (dry)
vf run <engine> --yes           # launch the engine CLI
```

## Ask (inline code Q&A)

```bash
vf ask src/cli.ts:210-267 "what does this switch do?"   # stream an answer about a snippet
vf ask src/dispatch.ts:172 "why json output?"           # single line (start==end)
vf ask src/x.ts:5-12 "explain" --engine claude          # force a specific ready engine
vf ask --resume "ok, and is that thread-safe?"          # continue the last conversation (multi-turn)
```

Reads the given line range, frames a prompt (file path + language-fenced snippet +
your question), picks the first ready engine (or `--engine`), and streams the
answer straight to your terminal. `--resume` continues the engine's most-recent
conversation with a follow-up (no target needed — Claude, Codex, OpenCode, and
Antigravity; Antigravity uses workspace-scoped `agy --continue`). Reuses vf's engine-readiness
selection — no new dispatch path, no dependency. Bad target/range, missing file,
missing question, or no ready engine exits non-zero with an actionable message.
Run `vf doctor --probe` if none are ready.

## Orchestrate

```bash
vf orchestrate                         # plan + dispatch work units (dry: prompts only)
vf orchestrate --engine codex          # choose the engine
vf orchestrate --concurrency 4         # bound the parallel pool (default 3)
vf orchestrate --review-engine codex           # optional: reviewer engine (ADR-001)
vf orchestrate --allow-unverified-evidence     # skip evidence format gate (ADR-004 escape hatch)
vf orchestrate --spec-first           # phase 2: generate spec-first tests before dispatch (ADR-002)
                                       # current: flag accepted but no-op until phase 2 wiring
                                       # default: same engine, fresh session, isolated context
vf orchestrate --yes                   # real dispatch via the engine CLI
```

  --auto-pilot        require_approval hooks: dispatch independent LLM call to
                      evaluate false positive (confidence ≥ 0.9 → allow, else block).
                      Writes audit entry to .vibeflow/knowledge/hook-audit.log.
  --yolo              Auto-allow ALL require_approval hooks (blind). Audit logged.
  --allow-all         Alias for --yolo.
  --goal-eval <goal>  (opt-in, phase 2) Behavioral goal-eval gate: after toolchain
                      passes, an LLM checks whether <goal> is covered by the changes.
                      Stub wired in ADR-003; real LLM integration in a future release.

Modes: `--yes` → CLI, else `$VIBEFLOW_AI` → bridge, else dry. Dispatches units in
parallel, runs an independent reviewer (pass only at confidence `1.0` with evidence),
then prints the goal-eval verdict (`met | partial | blocked`).

## Work units (ledger)

```bash
vf units status            # board: status, gates, owner, confidence
vf units show <name>       # one unit as JSON
vf units resources         # token / cost / wall-time totals
vf units evidence <name>   # recorded evidence paths
```

## Settings (config)

```bash
vf config memory status     # print the current memory setting (default: false/off)
vf config memory builtin    # enable built-in BM25/FTS5 recall (zero deps)
vf config memory claude-mem # enable claude-mem recall (requires claude-mem installed)
vf config memory off        # disable memory recall

vf config env-policy status          # print the env-scrub policy for spawned engines (#556)
vf config env-policy deny 'MY_APP_*' # drop a glob from the env handed to spawned agent CLIs
vf config env-policy allow 'MY_*'    # allowlist a glob (non-empty allow = strict pass-only mode)
vf config env-policy reset           # clear the policy, back to the conservative default
```

Reads/toggles `memory` in `.vibeflow/SETTINGS.json`. Default is `false` (off).
Three modes:

| Mode | Behaviour |
|------|-----------|
| `false` / `off` | No recall injected |
| `builtin` | bun:sqlite FTS5 index of `.vibeflow/knowledge/decisions.md`; generates `.vibeflow/knowledge/memory.db` (gitignored) |
| `claude-mem` | Shells `claude-mem search`; requires separate `claude-mem` install |

The setting does **not** gate the `vf init` prompt (init always asks on a TTY).
It is the switch `dispatchPrompt` and `buildPlanPrompt` honour for recall injection.

## Skills (demand-driven)

```bash
vf skills list             # skills discovered under .vibeflow/.claude/.agents/.github skills dirs
vf skills show <name>      # show detailed info for one skill (owners, changelog, deprecation)
vf skills search <term>    # rank local skills against a task term
vf skills resolve          # derive NEEDS from scan + intake; satisfied vs must-acquire
vf skills telemetry        # print aggregate skill-usage summary from local JSONL telemetry
vf skills validate         # validate every canonical skill against the Anthropic standard
vf skills sync             # sync .vibeflow/skills → engine mirrors (default mode: pointer)
vf skills sync --mode pointer|full   # pointer = stub SKILL.md pointing at canonical; full = copy
vf skills verify-sync      # verify each mirror has a SKILL.md for every canonical skill
vf skills verify-freshness # check sourceAnchors against current disk content (SHA-256)
vf skills impact <fact-or-path> # list affected skills and required evals from domain facts
vf skills audit-duplicates # find duplicate fact ownership, triggers, and procedures
vf skills draft [--new] <name> # resolve existing domain before creating a draft
vf skills propose-merge <a> <b> # print non-destructive merged skill proposal
vf skills propose-split <skill> # print non-destructive section split proposal
vf skills crystallize <run-id>  # extract recurring patterns; if they match an existing skill, print PATCH PROPOSAL (stdout only), else write crystallized-run-* draft
vf skills curator scan    # scan skills for stale anchors, duplicate owners, unpinned registry entries; writes .vibeflow/curator/findings.json
vf skills import <dir>     # import a local skill dir into .vibeflow/skills/
vf skills import context7:<query>  # import a Context7 skill (approval-gated) into the canonical store
```

### Skill registries (git-backed)

```bash
vf skills registry add <git-url> --name <id> --ref <tag-or-commit>   # dry-run: show plan, no network
vf skills registry add <git-url> --name <id> --ref <tag-or-commit> --yes  # clone + checkout + pin commit
vf skills registry list                # show pinned registries with commit OID
vf skills registry update              # re-fetch and re-pin all registries (dry-run)
vf skills registry update --yes        # re-fetch and re-pin all registries
vf skills registry update <id> --yes   # re-fetch and re-pin a single registry
vf skills registry install <registry-id>/<skill-name> [--version <v>] [--on-collision skip|replace|rename] [--yes]
                                       # install a verified skill from a cached registry
```
# Collision policies:
#   skip    — leave existing untouched (default)
#   replace — backup existing to .backup/<ts>/, then overwrite
#   rename  — copy with a new slug, rewrite SKILL.md name: frontmatter

Registries are remote git repos containing skill definitions. The lock file
(`.vibeflow/SKILL_REGISTRY.lock.json`) records each pinned commit so updates are
deterministic. On update failure, the prior valid commit is preserved in the lock.

### Security scan on registry install

`vf skills registry install` runs an optional static security scan (NVIDIA
SkillSpector) after frontmatter/path validation, before catalog copy and lock
update:

| scanner status    | gate action                                           |
| ----------------- | ----------------------------------------------------- |
| absent            | install proceeds, `scan_summary: {scanned:false}` in lock |
| HIGH / CRITICAL   | **blocked** — exit 1, finding `rule_id`/`message` shown, no catalog/lock mutation |
| MEDIUM            | warns, install continues                              |
| LOW / NONE        | passes                                                |

`--no-llm` is hard-coded: static analysis only, no network egress. See
`docs/SKILL_SECURITY_SCAN.md` for details.

VibeFlow does not pre-install skills. Needs are reported with a suggested on-demand
acquisition command. Imported skills start `experimental` and must be validated +
approved before promotion to `verified`.

The canonical store is `.vibeflow/skills/<name>/` (one `SKILL.md` plus optional
`scripts/`, `references/`, `assets/`). The three engine mirrors
(`.claude/skills/`, `.agents/skills/`, `.github/skills/`) are kept in sync by
`src/skills/sync.ts`: `pointer` mode writes a stub `SKILL.md` that points at the
canonical file (default; cheap, no duplication); `full` mode copies the whole skill
tree. `vf skills verify-sync` checks every canonical skill has a matching
`SKILL.md` in every mirror.

## Optional tools (code navigation)

```bash
vf tools status                  # enabled/installed/priority per tool + detected languages
vf tools enable <codegraph|lsp>  # turn a tool on and (re)write engine MCP config
vf tools disable <codegraph|lsp> # turn it off and remove its MCP servers
vf tools install <codegraph|lsp> # print the install plan (add --yes to execute)
```

Two opt-in tools give engines better code navigation, both off by default:

- **codegraph** — a 100% local code-graph MCP server (tree-sitter + SQLite),
  installed via `npm i -g @colbymchenry/codegraph`.
- **lsp** — an MCP↔language-server bridge (`mcp-language-server`), one server per
  detected language (TypeScript, Python, Go, Rust).

`enable`/`disable` flip the flag in `.vibeflow/SETTINGS.json` **and** wire MCP config per
engine: merge `.mcp.json` (Claude), write `.codex/config.toml` with `disabled_tools`
gating (Codex), and print the exact `copilot mcp add` commands for you to run (VibeFlow
never touches Copilot's secret config). The priority ladder **codegraph > lsp > native**
is injected into `CLAUDE.md`/`AGENTS.md`/`copilot-instructions.md`, and on Codex the
lower-priority LSP tools are structurally disabled when codegraph is on. `install` only
runs commands when you pass `--yes`; otherwise it just prints the plan. Re-run `vf init`
after changing tools to regenerate the instructions.

## Discovery (Context7, approval-gated)

```bash
vf discover docs <library>          # prints "approval required"
vf discover docs <library> --yes    # Context7 docs lookup over HTTP
vf discover skills <query> --yes    # Context7 skill search (imports are experimental)
```

Discovery calls the Context7 HTTP API (`https://context7.com/api/v2`) with the built-in
`fetch` — no external `ctx7` binary is needed. The network is touched only with `--yes`,
every request is bounded by a timeout, and offline/error responses fail gracefully. An
optional `CONTEXT7_API_KEY` env var raises the rate limit (keyless is allowed).

## Hooks (guardrails)

```bash
vf hooks status     # show core.hooksPath
vf hooks install    # wire core.hooksPath → .githooks
vf hooks emit       # write engine hook configs (Claude/Codex/Copilot + git pre-commit)
echo '<json-event>' | vf hook       # → {"decision":"allow|warn|require_approval|block",...}
```

### require_approval in web UI context
When VF_HOOK_MODE=default and .vibeflow/.ui-port exists, require_approval
pauses the engine indefinitely until the user responds via the web UI modal.

### VF_HOOK_MODE env var
Set automatically by vf orchestrate based on flags:
- default: ask user via web UI modal
- auto-pilot: independent LLM false-positive evaluation
- yolo: blind allow-all

## PR queue & merge

```bash
vf pr merge-when-green                 # claim head of queue, poll CI, merge on green
vf pr merge-when-green --head <branch> # target a specific queued branch
vf pr merge-when-green --no-notify     # suppress the desktop notification for this run
```

Claims the head of the PR queue, polls CI every 30s (up to 5 min), then merges on
green, requeues on red, or releases the claim on timeout. Because the poll can run
unattended, VibeFlow fires a best-effort **OS desktop notification** when the poll
settles — merged, CI red (requeued), CI timed out, merge failed, or ship-tamper —
so you can walk away and get pinged with the outcome (macOS `osascript`, Linux
`notify-send`; a silent no-op when neither is on `PATH`).

Suppression precedence (any one silences the ping):

- `--no-notify` — suppress for a single run.
- `VF_NO_NOTIFY=1` — env override for a single run (or a whole shell/CI session).
- **Settings → Desktop notifications** (`notifications` in `.vibeflow/SETTINGS.json`,
  default `true`) — the persistent toggle, also editable in the web UI Settings panel.

The notifier is best-effort and never changes the command's exit code: a missing or
failing notifier is swallowed so it can't break the merge flow.

## Verification

```bash
vf verify
vf verify --allow-unverified-evidence  # skip ADR-004 evidence format gate (migration escape hatch)
```

Runs `typecheck`/`lint`/`test` (when declared) plus the policy gates: confidence `< 1`,
missing evidence on a `done` unit, and overlapping work-unit scopes all fail.

## Eval (Telemetry Success-Rate Gate)

```bash
vf eval                                # report only
vf eval --min-pass-rate 0.9            # exit 1 if verdict pass-rate < 90% (enough samples)
vf eval --min-samples 20               # raise the thin-sample floor (default 10)
vf eval --json                         # emit the report as JSON to stdout
vf eval --json --out eval-report.json  # also write the JSON report to a file
```

`vf eval` is a **passive** regression gate: it reads the telemetry vf already writes
during normal use — verdict events on the logbus (`.vibeflow/logs/current.log`, from
#542) and verify pass/fail entries in `.vibeflow/knowledge/log.md` — and aggregates a
real success-rate, gate-failure breakdown, average goal score, and cost/token totals.
No LLM, no network, no fixtures to maintain: it measures whether vf is doing well on
the tasks you actually ran, not a fixed benchmark.

With a threshold (`--min-pass-rate`, or `eval.minPassRate` in `.vibeflow/SETTINGS.json`)
it becomes a one-job-two-outcomes gate you can wire into pre-push/CI:

- **exit 0** — pass-rate at/above the threshold, no threshold set, or too few samples
  (below `--min-samples` it warns instead of failing, so a handful of hard tasks never
  trips a false regression).
- **exit 1** — pass-rate below the threshold with enough samples.

Empty telemetry prints a friendly note and exits 0.

## Help / Version

```bash
vf help
vf --version
```

---

**Related:** [User Guide](./USER_GUIDE.md) · [npm CLI Design](./NPM_CLI_DESIGN.md)
[Edit this page on GitHub](https://github.com/magicpro97/vibeflow/edit/main/docs/COMMAND_REFERENCE.md)
