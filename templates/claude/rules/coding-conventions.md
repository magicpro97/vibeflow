# Coding Conventions

## Verification (mandatory)
- After every code change: run typecheck + lint
- After implementing a feature: run tests
- Before committing: typecheck + lint + test
- Never commit if typecheck or lint fails

## TDD
- Write failing test first
- Run test to verify failure
- Write minimal implementation
- Run test to verify pass

## Commits
- Format: `type(scope): description`
- Include `Signed-off-by` line matching your git identity
- Stage explicit paths — never `git add -A`

## Code Style
- Use inject seams for testability
- Normalize path separators in assertions
- Prefer template literals over string concatenation
