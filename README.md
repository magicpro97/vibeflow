# VibeFlow

<p align="center">
  <strong>The local-first orchestrator for AI coding agents.</strong><br>
  Drive Claude Code, Codex & GitHub Copilot CLI with a confidence gate, source protection, and verified completion.
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

VibeFlow is a local-first npm CLI tool that opens a visual web UI and helps users run AI-assisted software development workflows using Claude Code, Codex CLI, and GitHub Copilot CLI out-of-the-box.

The tool acts as the main orchestrator. It collects task context, reads project sources, selects skills, generates tool-specific instruction files, dispatches AI coding engines, verifies results, and continuously improves local skills based on lessons learned.

On a fresh clone, arm the guardrail before any human edit:

```bash
./scripts/guardrail-on.sh
```

See issue #162 (orchestrator-first / F1) for the full rationale.

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

## Install and use

```bash
npx @magicpro97/vibeflow            # run without installing
npm install -g @magicpro97/vibeflow # or install globally, then use `vf`
```

```bash
vf                # open the local web UI — intake wizard + live dashboard
vf doctor         # check required and optional tools
vf init           # scan repo + generate canonical context + engine files (--engine, --interactive, --dry-run)
vf run claude     # dispatch Claude Code (codex | copilot; --yes to launch)
vf orchestrate    # plan + dispatch work units in parallel, review, goal-eval (--engine, --yes, --concurrency)
vf units status   # work-unit board: status, gates, owner, confidence
vf skills resolve # demand-driven skill needs (list | search <term> | resolve)
vf tools status   # optional code-nav tools (status | enable | disable | install <tool>)
vf discover docs <lib> --yes   # Context7 docs/skills lookup (network requires approval)
vf verify         # typecheck / lint / test + confidence / evidence / scope gates
vf hooks install  # wire fail-closed pre-commit + pre-push gates (core.hooksPath → .githooks)
vf workflow delete|import  # manage/combine workflows
vf hook            # evaluate a JSON hook event from stdin (for engine guardrails)
```

The web UI is where you **initialize a workflow**: fill in goal, engines, doc/task sources,
file types, and expected result, then **Generate workflow** (writes the canonical context +
engine files) and **Write dispatch prompt** for the chosen engine. Prefer the terminal? Use
`vf init --interactive` for the same questions, or `vf init` for a non-interactive scaffold.

## Using VibeFlow as a skill

`vf init` seeds a `vf` skill into your repo and syncs it to Claude Code, Codex, and GitHub
Copilot — one cross-engine skill, no per-tool wiring.

```bash
npx @magicpro97/vibeflow init   # seed the `vf` skill + sync to every engine
vf skills resolve               # inspect / search / resolve demand-driven skills
```

Activate it inside any supported CLI tool:

- Type **`<your task> + vf`** in a prompt to pull the VibeFlow workflow into the request.
- Type **`/vf`** in a CLI tool (Claude Code / Codex / Copilot) to run the skill directly.
- Run **`/vf`** with no args and it grills you toward a spec from the chat context.

See the [Skills system](https://vibeflow-landing.web.app/wiki/skills_system) wiki page for the
full reference.

## Develop

Built with **Bun** + **TypeScript**, zero runtime dependencies (Node stdlib only, so the
published CLI runs anywhere `node` does). The web UI applies the `taste-skill` design read
with a small inline motion layer (no third-party CDN script, since the page is same-origin
with the write API).

```bash
bun install       # install dev tooling and set up git hooks (core.hooksPath)
bun run dev       # run the CLI from source (src/cli.ts)
bun run check     # typecheck + lint + test
bun run build     # bundle to dist/cli.js (Node-compatible, with shebang)
```

A `v*` git tag triggers the npm publish workflow (requires the `NPM_TOKEN` secret).

## Core idea

The system should not let an AI coding engine operate blindly. Instead, it should build a structured workflow:

```text
User prompt
  ↓
Main Orchestrator Agent
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
Claude Code / Codex / Copilot CLI execution
  ↓
Diff / log / test verification
  ↓
Skill evolution proposal
```

## Main goals

- Provide one npm command to start a local web UI.
- Support Claude Code, Codex CLI, and GitHub Copilot CLI.
- Generate `CLAUDE.md`, `AGENTS.md`, and Copilot instruction files automatically.
- Use Anthropic-style Skills based on `SKILL.md`.
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
  src/        cli.ts core.ts commands.ts adapters.ts server.ts
              scanner.ts dispatch.ts gates.ts frontmatter.ts
              ai-init.ts journal.ts preflight.ts settings.ts ui.ts
              server.html
              skills/{registry,resolver,maintainer}.ts
              hooks/{runner,risk,adapters,selftest}.ts
              orchestrator/{investigate,plan,run,agent,debate,marker}.ts
              discovery/context7.ts
              tools/{codegraph,lsp,index}.ts
              workflow/{lifecycle,merge}.ts
              safety/{checkpoint,quota}.ts
              assets/
  test/       23+ test files
  docs/       *.md (the specification this tool implements)
  .githooks/  pre-commit (format-fix → typecheck → lint → test → build)
  .github/    copilot-instructions.md, workflows/{ci,release}.yml
```

When run against a target project, `vf init` generates only what that engine/task needs
(maximum surface shown below; the minimal-footprint principle keeps it lean):

```text
CLAUDE.md                              # Claude Code
AGENTS.md                              # Codex + Copilot
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
