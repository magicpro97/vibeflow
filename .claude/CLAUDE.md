# vibeflow

Drive Claude Code, Codex & GitHub Copilot CLI with a confidence gate, source protection, and verified completion.

## Key Commands
- `bun run typecheck` — TypeScript type checking
- `bun run lint` — Biome linting + formatting
- `bun run test` — Full test suite
- `bun run build` — Build the project
- `bun run coverage:check` — Coverage gate

## Architecture
- TypeScript + Bun runtime
- Biome for linting/formatting
- Inject seams for testability (not mock.module)
- `src/orchestrator/` — orchestration engine
- `src/commands/` — CLI commands
- `test/` — test files mirror src/ structure

## Conventions
- See `.claude/rules/coding-conventions.md` for full rules
- Always verify: typecheck + lint + test after changes
- Use `spawnSync` with array args (not `execSync` with string)
- Normalize path separators in test assertions
