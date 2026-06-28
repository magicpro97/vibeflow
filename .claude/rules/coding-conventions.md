# Coding Conventions

## Verification (mandatory)
- After every code change: `bun run typecheck && bun run lint`
- After implementing a feature: `bun test --timeout 30000 <test-file>`
- Before committing: `bun run typecheck && bun run lint && bun run test`
- Never commit if typecheck or lint fails

## TDD
- Write failing test first
- Run test to verify failure
- Write minimal implementation
- Run test to verify pass
- Refactor if needed

## Commits
- Format: `type(scope): description`
- Always include Signed-off-by line: `Signed-off-by: magicpro97 <magicpro97@users.noreply.github.com>`
- Stage explicit paths — never `git add -A`

## Code Style
- Use inject seams for testability (not mock.module)
- Use `spawnSync` with array args (not `execSync` with string)
- Normalize path separators in assertions (`.replace(/\\/g, "/")`)
- Prefer template literals over string concatenation
- Export new types/functions from `src/commands.ts` and `src/commands/_shared.ts`
