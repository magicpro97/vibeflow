---
title: npm CLI Design
description: Reference for the npm CLI design — startup flow, commands, package layout, dependency policy, and local server rules.
category: reference
last_updated: 2026-08-27
---

# npm CLI Design

## Contents

- [Goal](#goal)
- [Startup Flow](#startup-flow)
- [Commands](#commands)
- [Package Layout](#package-layout)
- [Example package.json](#example-packagejson)
- [Dependency Installation Policy](#dependency-installation-policy)
- [Local Server Rules](#local-server-rules)
- [Skill Format](#skill-format)

## Goal

The user should be able to run one command and open a local web UI.

```bash
npx @magicpro97/vibeflow
```

or:

```bash
npm install -g @magicpro97/vibeflow
vf
```

## Startup flow

```text
1. Check Node.js version
2. Check Git
3. Check optional tools: Claude Code, Codex CLI, Copilot CLI, OpenCode, Antigravity CLI, Docker, GitHub CLI
4. Ask before installing missing optional tools
5. Start local web server on 127.0.0.1
6. Open browser automatically
7. Load AI-first Home
```

## Commands

```bash
vf                       # open AI-first Home on 127.0.0.1:7799
vf ui                    # same stable default; --port 0 selects a free port
vf doctor                # presence/auth check (--probe for a live engine round-trip)
vf init                  # TTY questionnaire + context (--engine, --no-ask, --dry-run)
vf run claude            # dispatch claude | codex | copilot | opencode | antigravity
vf orchestrate           # plan + dispatch work units (--engine, --yes, --concurrency)
vf units status          # ledger: status | show <name> | resources | evidence <name>
vf skills list           # skills: list | search <term> | resolve
vf tools status          # optional tools: status | enable | disable | install <tool>
vf discover docs <lib>   # Context7 docs|skills lookup (--yes approves network)
vf hook                  # evaluate a JSON hook event from stdin
vf hooks install         # hooks: status | install | emit
vf verify                # typecheck/lint/test + confidence/evidence/scope gates
```

## Package layout

The implementation is modular under `src/commands/`, `src/core/`, `src/dispatch/`,
`src/orchestrator/`, `src/capabilities/`, `src/server/`, and `src/ui/`. The single binary
entry is `src/cli.ts`, bundled to `dist/cli.js`.

```text
/
  package.json tsconfig.json biome.json
  src/
    cli.ts core.ts commands.ts adapters.ts server.ts
    scanner.ts dispatch.ts gates.ts frontmatter.ts settings.ts preflight.ts
    skills/{registry,resolver,maintainer}.ts
    hooks/{runner,risk,adapters}.ts
    orchestrator/{investigate,plan,run}.ts
    tools/{index,codegraph,lsp}.ts
    discovery/context7.ts
  test/   *.test.ts
  docs/   *.md
  .githooks/  pre-commit
```

## Example package.json

The CLI ships with **one runtime dependency** (`proper-lockfile`, for file locking) —
otherwise it runs on the Node/Bun standard library only (e.g. the built-in `fetch` for
Context7, `node:child_process` `spawn` for git and engine CLIs). Everything below is
dev-only tooling.

```json
{
  "name": "@magicpro97/vibeflow",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "vf": "./dist/cli.js"
  },
  "engines": { "node": ">=18" },
  "scripts": {
    "dev": "bun run src/cli.ts",
    "build": "bun build ./src/cli.ts --target=node --outfile=dist/cli.js --banner='#!/usr/bin/env node' && chmod +x dist/cli.js",
    "check": "bun run typecheck && bun run lint && bun run test"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.4",
    "@playwright/test": "^1.60.0",
    "@types/bun": "^1.3.14",
    "@types/node": "^22.10.0",
    "typescript": "^5.7.0"
  }
}
```

## Dependency installation policy

### One runtime dependency

The published CLI installs one runtime dependency (`proper-lockfile`) beyond itself —
otherwise it uses only the Node/Bun stdlib plus `git` (invoked via `spawn`). There are no
`commander`/`execa`/`fastify`/`open`/`ws`/`zod` runtime deps to pull in.

### Ask before installing

Optional engines and tools are only installed after explicit approval — e.g.
`vf tools install <tool> --yes` runs the printed plan; without `--yes` it just prints it.

```text
Claude Code
Codex CLI
GitHub Copilot CLI
Docker
GitHub CLI
MCP servers
Project dependencies
```

### Never install silently

```text
- global packages
- project dependencies
- tools that execute install scripts
- packages needing credentials
- external skills with shell/network/write permissions
```

## Local server rules

```text
- bind to 127.0.0.1 by default
- stable port 7799 for `vf` and `vf ui`; explicit `--port 0` asks the OS for a free port
- no public tunnel by default
- no remote telemetry by default
- no source upload by default
```

## Skill format

Each skill must follow the Anthropic `skill-creator` standard: a directory with
`SKILL.md` (YAML frontmatter `name` + `description` + body) plus optional
`scripts/`, `references/`, and `assets/` folders. The reference standard lives
at `src/skills/ANTHROPIC_SKILL_STANDARD.md` and is the only validator in
`src/skills/validator.ts`; an imported skill that fails validation is never
promoted. The canonical store is `.vibeflow/skills/<name>/`; the four engine
mirrors (`.claude/skills/`, `.agents/skills/`, `.github/skills/`, `.opencode/skills/`) are regenerated
by `vf skills sync` (see `src/skills/sync.ts`, `pointer` | `full` mode).

---

**Related:** [Command Reference](./COMMAND_REFERENCE.md) · [Architecture](./ARCHITECTURE.md)
[Edit this page on GitHub](https://github.com/magicpro97/vibeflow/edit/main/docs/NPM_CLI_DESIGN.md)
