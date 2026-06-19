# VibeFlow

## Purpose

## Guardrail (arm before editing)

On a fresh clone, arm the guardrail before any human edit:

```bash
./scripts/guardrail-on.sh
```

See issue #162 (orchestrator-first / F1) for the full rationale.


VibeFlow is a local-first npm CLI tool that opens a visual web UI and helps users run AI-assisted software development workflows using Claude Code, Codex CLI, and GitHub Copilot CLI out-of-the-box.

The tool acts as the main orchestrator. It collects task context, reads project sources, selects skills, generates tool-specific instruction files, dispatches AI coding engines, verifies results, and continuously improves local skills based on lessons learned.


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
vf hooks install  # wire the pre-commit gate (core.hooksPath → .githooks; `emit` writes engine configs)
vf workflow delete|import  # manage/combine workflows
vf hook            # evaluate a JSON hook event from stdin (for engine guardrails)
```

The web UI is where you **initialize a workflow**: fill in goal, engines, doc/task sources,
file types, and expected result, then **Generate workflow** (writes the canonical context +
engine files) and **Write dispatch prompt** for the chosen engine. Prefer the terminal? Use
`vf init --interactive` for the same questions, or `vf init` for a non-interactive scaffold.

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

## Documentation index

- [User Guide](./docs/USER_GUIDE.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Workflow](./docs/WORKFLOW.md)
- [Agent Orchestration Policy](./docs/AGENT_ORCHESTRATION_POLICY.md)
- [Work-Unit Orchestration](./docs/WORK_UNIT_ORCHESTRATION.md)
- [Skills System](./docs/SKILLS_SYSTEM.md)
- [Skill Discovery and Evolution](./docs/SKILL_DISCOVERY_AND_EVOLUTION.md)
- [Skill Providers](./docs/SKILL_PROVIDERS.md)
- [Command Reference](./docs/COMMAND_REFERENCE.md)
- [Tool Adapters](./docs/TOOL_ADAPTERS.md)
- [Hooks and Guardrails](./docs/HOOKS_AND_GUARDRAILS.md)
- [npm CLI Design](./docs/NPM_CLI_DESIGN.md)
- [Web UI Design](./docs/WEB_UI_DESIGN.md)
- [Security Model](./docs/SECURITY_MODEL.md)
- [Generated Files](./docs/GENERATED_FILES.md)
- [Deployment (git + npm)](./docs/DEPLOYMENT.md)
