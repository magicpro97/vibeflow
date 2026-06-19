# Command Reference

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

Checks node, git (required) and bun, claude, codex, copilot, docker (optional), plus
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
vf run <claude|codex|copilot>   # write .vibeflow/dispatch/<engine>.md (dry)
vf run <engine> --yes           # launch the engine CLI
```

## Orchestrate

```bash
vf orchestrate                         # plan + dispatch work units (dry: prompts only)
vf orchestrate --engine codex          # choose the engine
vf orchestrate --concurrency 4         # bound the parallel pool (default 3)
vf orchestrate --yes                   # real dispatch via the engine CLI
```

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
vf config memory status    # print the current memory setting (default: on)
vf config memory on        # enable the claude-mem memory feature
vf config memory off       # disable the claude-mem memory feature
```

Reads/toggles `memory` in `.vibeflow/SETTINGS.json`. The setting records your
claude-mem opt-in; it does **not** gate the `vf init` prompt (init always asks on a
TTY). It is the forward-compatible switch a later orchestrate-side memory query
will honour.

## Skills (demand-driven)

```bash
vf skills list             # skills discovered under .vibeflow/.claude/.agents/.github skills dirs
vf skills search <term>    # rank local skills against a task term
vf skills resolve          # derive NEEDS from scan + intake; satisfied vs must-acquire
vf skills validate         # validate every canonical skill against the Anthropic standard
vf skills sync             # sync .vibeflow/skills → engine mirrors (default mode: pointer)
vf skills sync --mode pointer|full   # pointer = stub SKILL.md pointing at canonical; full = copy
vf skills verify-sync      # verify each mirror has a SKILL.md for every canonical skill
vf skills import <dir>     # import a local skill dir into .vibeflow/skills/
vf skills import context7:<query>  # import a Context7 skill (approval-gated) into the canonical store
```

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

## Verification

```bash
vf verify
```

Runs `typecheck`/`lint`/`test` (when declared) plus the policy gates: confidence `< 1`,
missing evidence on a `done` unit, and overlapping work-unit scopes all fail.

## Help / version

```bash
vf help
vf --version
```
