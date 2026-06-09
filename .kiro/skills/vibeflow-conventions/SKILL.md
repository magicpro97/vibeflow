---
name: vibeflow-conventions
description: Coding conventions, architecture, and development guidelines for @magicpro97/vibeflow. Use when writing or reviewing code in this project.
status: verified
---

# VibeFlow CLI Conventions

## Architecture

Five source files, each one concern:

- `src/core.ts` — types, paths, ledger, `hasCommand`, flag parser, ANSI helpers. No deps beyond `node:*`.
- `src/adapters.ts` — canonical-context → per-engine file generation.
- `src/commands.ts` — one exported function per command, returns exit code.
- `src/server.ts` — local web UI on `127.0.0.1` via `node:http`.
- `src/cli.ts` — bin entry: parse argv, route to command.

## Key Rules

1. **No runtime dependencies** — `node:*` builtins only. Dev-only deps are fine.
2. **Imports use `.js` extensions** — `from "./core.js"` even though files are `.ts`.
3. **Commands return exit codes** — never call `process.exit()` in handlers.
4. **Canonical context dir is `vibeflow/`** — use `ctxPath()`/`CTX_DIR`, never hardcode.
5. **Minimal-footprint + AI-generated** — fewest files possible, no static templates.
6. **Security** — server binds `127.0.0.1` only; CSRF token guards write routes.

## Formatting (Biome)

- Double quotes, semicolons, 2-space indent, 100 cols.
- Run `bun run fix` to auto-fix.

## Testing

- `bun test` with test files in `test/`.
- Pre-commit hook runs: fix → typecheck → lint → test → build.

## Build

- `bun run build` → `dist/cli.js` (Node target, shebang banner).
- Published as `@magicpro97/vibeflow`, binary is `vf`.
