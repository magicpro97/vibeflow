# VibeFlow

<p align="center">
  <strong>The local-first harness connecting AI coding CLIs.</strong><br>
  Coordinate Claude Code, Codex, GitHub Copilot CLI, OpenCode & Antigravity CLI with a confidence gate, source protection, and verified completion.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@magicpro97/vibeflow"><img src="https://img.shields.io/npm/v/@magicpro97/vibeflow?color=cb3837&logo=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@magicpro97/vibeflow"><img src="https://img.shields.io/npm/dm/@magicpro97/vibeflow?color=cb3837&logo=npm" alt="npm downloads"></a>
  <a href="https://github.com/magicpro97/vibeflow/actions"><img src="https://img.shields.io/github/actions/workflow/status/magicpro97/vibeflow/ci.yml?branch=main&logo=github&label=CI" alt="CI status"></a>
  <a href="https://github.com/magicpro97/vibeflow/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@magicpro97/vibeflow?color=blue" alt="license"></a>
  <a href="https://github.com/magicpro97/vibeflow/stargazers"><img src="https://img.shields.io/github/stars/magicpro97/vibeflow?style=social" alt="GitHub stars"></a>
</p>

<p align="center">
  <a href="https://vibeflow-landing.web.app">🌐 Website</a> ·
  <a href="https://vibeflow-landing.web.app/wiki/">📚 Wiki</a> ·
  <a href="./docs/README.md">📖 Docs</a> ·
  <a href="https://www.npmjs.com/package/@magicpro97/vibeflow">📦 npm</a> ·
  <a href="https://vibeflow-landing.web.app/#demo-h">🎬 Demo</a>
</p>

## Purpose

VibeFlow is a local-first npm CLI tool that opens AI-first Home and helps users coordinate existing AI coding CLIs — Claude Code, Codex CLI, GitHub Copilot CLI, OpenCode, and Antigravity CLI — instead of replacing them.

It collects task context, reads project sources, selects skills, generates tool-specific instruction files, dispatches the canonical owned async route to the selected CLI, verifies results, and keeps the conversation and review surfaces inside VibeFlow.

On a fresh clone, arm the guardrail before any human edit:

```bash
./scripts/guardrail-on.sh
```

See issue #162 for the original rationale.

## Recommended name and command

Product name: **VibeFlow**

Recommended npm package and command:

```bash
npx @magicpro97/vibeflow
```

After global install:

```bash
npm install -g @magicpro97/vibeflow
vf
```

`vf` is the short command for day-to-day use.

## Commands

| Command | What it does |
| --- | --- |
| `vf` / `vf ui` | Open AI-first Home on stable port `7799` (`--port 0` chooses a free port) |
| `vf doctor` | Check required and optional tools; `--probe` runs a live round-trip |
| `vf init` | Scan the repo and generate canonical context + engine files |
| `vf run <engine>` | Dispatch one engine: `claude`, `codex`, `copilot`, `opencode`, or `antigravity` |
| `vf ask` | Inline file-range Q&A backed by the durable conversation runtime |
| `vf chat` | Canonical persisted conversation entry |
| `vf brainstorm` | Compatibility facade over the shared debate policy |
| `vf orchestrate` | Plan and dispatch work units in parallel |
| `vf review evidence\|check` | Create or validate local commit-anchored evidence |
| `vf demo` | Run a fixed corpus through dry-run orchestration |
| `vf workflow [sub]` | Manage workflow files and imported worktrees |
| `vf canary [sub]` | List, link, or check human-authored canary tests |
| `vf units [sub]` | Inspect and manage work-unit state |
| `vf status` | Open the crash-recovery view for per-unit markers |
| `vf config [sub]` | Read or toggle per-repo settings |
| `vf capability [sub]` | Search, inspect, and mutate the typed capability fabric |
| `vf authority [sub]` | Control capability-fabric authority and trust |
| `vf skills [sub]` | Resolve, validate, sync, and curate skills |
| `vf superpowers sync` | Install exact registry-locked Superpowers into supported CLIs |
| `vf tools [sub]` | Inspect or install optional code-navigation tools |
| `vf discover <kind>` | Run approval-gated Context7 docs or skill discovery |
| `vf hook` | Evaluate a JSON hook event from stdin |
| `vf hooks [sub]` | Inspect, install, or emit engine hook configs |
| `vf pr [sub]` | Create, queue, or merge GitHub PRs |
| `vf decision [sub]` | Record durable architecture decisions |
| `vf state [sub]` | Read the coordinator brief |
| `vf coord` | Consult the brief and enforce freshness before non-trivial actions |
| `vf verify` | Run typecheck, lint, test, and confidence/evidence/scope gates |
| `vf eval` | Report success rate and gate breakdown from telemetry |
| `vf update-check` | Check npm for a newer VibeFlow release |
| `vf help` / `vf --version` | Show help or version |

## Install and use

```bash
npx @magicpro97/vibeflow            # run without installing
npm install -g @magicpro97/vibeflow # or install globally, then use `vf`
```

```bash
vf                # open AI-first Home on 127.0.0.1:7799
vf ui --port 0    # same Home on an OS-selected free port
vf doctor         # check required and optional tools (--probe for a live engine round-trip)
vf init           # scan repo + generate canonical context + engine files (--engine, --no-ask, --dry-run)
vf run claude     # dispatch one engine: claude | codex | copilot | opencode | antigravity (--yes to launch)
vf ask src/x.ts:10-20 "what does this do?"   # file-range Q&A (--engine, --conversation, compatibility-only --resume)
vf chat "explain the release flow"           # persisted traced conversation (--policy, --participant, --json)
vf brainstorm "compare API designs"          # debate preview; add --yes to dispatch (--resume, --no-baseline)
vf orchestrate    # plan + dispatch work units in parallel, review, goal-eval (--engine, --yes, --concurrency)
vf units status   # work-unit board: status, gates, owner, confidence
vf skills list    # skills: list | search | resolve | sync | draft | crystallize | curator scan | registry
vf tools status   # optional code-nav tools (status | enable | disable | install <tool>)
vf discover docs <lib> --yes   # Context7 docs/skills lookup (network requires approval)
vf verify         # typecheck / lint / test + confidence / evidence / scope gates
vf hooks emit     # write per-engine hook configs (--yes; `install` wires core.hooksPath)
vf eval           # passive success-rate gate over dogfood telemetry (--min-pass-rate)
vf pr merge-when-green   # poll CI and merge on green (queue + auto-merge)
vf state brief    # durable cross-session coordinator brief
```

AI-first Home is the default workspace: a searchable conversation rail, a central conversation
pane, ordered trace replay, details inspection, and drawers for capabilities and trace.
Run `vf init` in a TTY for the repository intake questionnaire (`--no-ask` skips it).
`vf` and `vf ui` both open Home on port `7799`; pass `--port 0` only when you want an
OS-selected free port. If a requested fixed port is busy, the interactive CLI offers a
free-port fallback and a non-interactive launch stops.

Home uses the same durable runtime as `vf ask`, `vf chat`, and `vf brainstorm`. Add or
remove an agent from the composer or participant details, send while agents are working,
edit the latest queued human message with ArrowUp, quote one or more visible messages, and
use restrained typed reactions. Approval and capability actions stay inline with the chat.
An unacknowledged admission failure remains visible as an explicit retryable row. Retry
reuses the exact request and idempotency key; it never clears a newer composer draft, and
offline retry is explicit rather than automatic. The rejected row is current Home UI state,
not `localStorage` or a promise that it survives a browser restart.
Public result ids remain distinct from the opaque fetch references carried by artifact
trace events.
See the [conversation guide](./docs/USER_GUIDE.md#conversation-workspace) and
[exact CLI/API contract](./docs/COMMAND_REFERENCE.md#conversations).

Exact by-id resume is supported only for Claude, Codex, and OpenCode. OpenCode uses
`opencode run --session <validated-ses-id> --format json`; Copilot and Antigravity never
silently claim exact resume. With valid exact proof, the CLI keeps its own history and
VibeFlow sends only new applicable user messages and peer-agent deltas, without echoing the
recipient's prior output. Without valid exact authority, turn delivery includes canonical
user/peer context plus a bounded structured replay of the recipient's last eight public
responses (at most 2 KiB UTF-8 each) with provenance, digest, and count fields. Own history
is therefore never silently omitted. Private file ranges use a separate one-shot structured
payload and never become public trace data. A large Copilot prompt may use a short pointer
to `.vibeflow/dispatch/<unit>.md`; that file is transport, not memory.

VibeFlow remains the harness, not another coding engine. Its dynamic capability fabric
extends the selected CLI with reviewed skills, MCP servers, tools, hooks, roles, and engine
settings, then keeps install, configure, retarget, update, repair, rollback, and removal on
one typed authority path.

## Using VibeFlow as a skill

`vf init` seeds a `vf` skill into your repo and syncs it to Claude Code, Codex, GitHub
Copilot, OpenCode, and Antigravity — one cross-engine skill, no per-tool wiring.

```bash
npx @magicpro97/vibeflow init   # seed the `vf` skill + sync to every engine
vf skills resolve               # inspect / search / resolve demand-driven skills
```

Activate it inside any supported CLI tool:

- Type **`<your task> + vf`** in a prompt to pull the VibeFlow workflow into the request.
- Type **`/vf`** in a CLI tool (Claude Code / Codex / Copilot / OpenCode) to run the skill directly.
- Run **`/vf`** with no args and it grills you toward a spec from the chat context.

See the [Skills system](https://vibeflow-landing.web.app/wiki/skills_system) wiki page for the
full reference.

## Develop

Built with **Bun 1.4** + **TypeScript** and two runtime dependencies: `proper-lockfile` for
file locking and `koffi` for native process identity and containment boundaries. The
published CLI otherwise uses Node-compatible APIs. The web UI applies the `taste-skill` design read
with a small inline motion layer (no third-party CDN script, since the page is same-origin
with the write API).

Closed persisted/API/config vocabularies follow one coding standard: declare a dependency-light
`Object.freeze({ ... } as const)` authority, infer the TypeScript union and frozen values from
it, validate external data with prototype-safe guards, and import that authority in backend and
UI consumers. Do not introduce TypeScript `enum`, duplicate wire literals, mutable vocabulary
sets, or blind casts. Ordinary prose and genuinely local one-off strings are not protocol
vocabulary.

The Windows PID/Job Object live-smoke job is configured in CI but must pass on a real
`windows-latest` runner before anyone claims live Windows evidence; a local macOS/Linux run is
not that evidence. Coverage likewise comes only from a fresh `bun run coverage:check` result,
not from the Bun version or an ordinary test pass.

```bash
bun install       # install dev tooling and set up git hooks (core.hooksPath)
bun run dev       # run the CLI from source (src/cli.ts)
bun run check     # typecheck + lint + file-size + waiver + test + coverage
bun run build     # bundle to dist/cli.js (Node-compatible, with shebang)
```

A `v*` git tag triggers the npm publish workflow (requires the `NPM_TOKEN` secret).

## Core idea

The system should not let an AI coding engine operate blindly. Instead, it should build a structured coordination flow:

```text
User prompt
  ↓
VibeFlow Coordinator
  ↓
Questionnaire / Context Intake
  ↓
Source + Skill Resolution
  ↓
Repository + Document Analysis
  ↓
Plan / Debate / Task Split
  ↓
Tool-specific adapter generation
  ↓
Claude Code / Codex / Copilot / OpenCode / Antigravity CLI execution
  ↓
Diff / log / test verification
  ↓
Skill evolution proposal
```

## Main goals

- Provide one npm command to start a local web UI.
- Open AI-first Home and support Claude Code, Codex CLI, GitHub Copilot CLI, OpenCode, and Antigravity CLI without replacing them.
- Generate `CLAUDE.md`, `AGENTS.md`, and Copilot instruction files automatically.
- Use Anthropic-style Skills based on `SKILL.md`.
- Manage a skill registry (git-backed, pinned) plus a curator that turns findings into reviewable proposals.
- Search trusted external skills/docs when local knowledge may be stale.
- Read project documents from sources such as GitHub, Jira, Google Drive, Confluence, Notion, local folders, and others.
- Process files such as Markdown, DOCX, XLSX, PPTX, PDF, OpenAPI, Postman, Mermaid, and Draw.io.
- Use hooks as guardrails across all supported engines.
- Avoid hallucination through evidence, verification, confidence thresholds, and reviewer agents.
- Generate the fewest files possible, all produced by AI from canonical context rather than static templates.
- Continuously improve internal skills from real execution lessons.

## Repository layout

This repo is the `@magicpro97/vibeflow` tool itself. It is kept deliberately minimal — every file
earns its place; the rest is generated on demand.

```text
/
  package.json tsconfig.json biome.json   # toolchain config
  src/
    cli.ts core.ts commands.ts           # entry + command router
    commands/                             # one file per `vf` subcommand
    server/  server.ts                    # local web UI + API routes
    skills/                               # registry, resolver, sync, curator, validator
    hooks/                                # runner, risk, adapters, apply-gate
    orchestrator/                         # investigate, plan, run, agent, debate, marker
    plan-review/  eval/  logbus/  memory/ # review, telemetry, durable stream, recall
    dispatch/  preflight/  safety/        # engine dispatch, readiness, checkpoint/quota
    tools/  discovery/  workflow/         # codegraph/lsp, context7, lifecycle/merge
    ui/                                   # Vue web UI (workspace)
  test/       190+ test files
  docs/       *.md (the specification this tool implements)
  landing/    Astro marketing site + wiki (deployed to Firebase)
  .githooks/  pre-commit + pre-push (format-fix → typecheck → lint → test → build)
  .github/    copilot-instructions.md, workflows/{ci,release,deploy-landing,skill-curator}.yml
```

When run against a target project, `vf init` generates only what that engine/task needs
(maximum surface shown below; the minimal-footprint principle keeps it lean):

```text
CLAUDE.md                              # Claude Code
AGENTS.md                              # Codex + Copilot + OpenCode + Antigravity
.github/copilot-instructions.md        # Copilot
.vibeflow/PROJECT_CONTEXT.md REQUIREMENTS.md TASK_CONTEXT.md
.vibeflow/WORKFLOW_POLICY.md SKILL_INDEX.md WORKFLOW_STATE.json
.vibeflow/SETTINGS.json                 # per-repo tool settings (tools, toolPriority)
.vibeflow/dispatch/<engine>.md          # on `vf run`
.vibeflow/workunits/<name>/             # only when a task is decomposed
```

## Documentation

📚 **[Full documentation index →](./docs/README.md)** — organized by the [Diátaxis](https://diataxis.fr/) framework (Tutorials · How-to · Reference · Explanation), also browsable as a [searchable wiki](https://vibeflow-landing.web.app/wiki/).

Quick links:
- [User Guide](./docs/USER_GUIDE.md) — get started
- [Command Reference](./docs/COMMAND_REFERENCE.md) — every `vf` command
- [Architecture](./docs/ARCHITECTURE.md) — how it works
- [Security Model](./docs/SECURITY_MODEL.md) — guardrails & source protection

## Star History

<a href="https://star-history.com/#magicpro97/vibeflow&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=magicpro97/vibeflow&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=magicpro97/vibeflow&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=magicpro97/vibeflow&type=Date" />
  </picture>
</a>

---

<p align="center"><sub>Powered by VibeFlow · MIT License</sub></p>
