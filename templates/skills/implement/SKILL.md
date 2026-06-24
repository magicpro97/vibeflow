---
name: implement
description: Transform a detail design specification into working, compilable, project-convention-compliant code.
version: 1.0.0
status: template
requires: []
triggers:
  - workflow-phase:implement
  - needs:working-code
  - transform:design-to-code
---

# implement — {{PROJECT_NAME}}

## Purpose

Take an implementation-ready specification and produce working code that compiles,
follows project conventions, and passes existing tests. The design has been settled
upstream — this phase is translation, not invention.

## When to Use

- Detail design is approved.
- Code is being created or modified according to spec.
- The team needs a working build to demo or test.

## When NOT to Use

- The design is still changing (re-run detail-design first).
- The change is exploratory (no spec yet, use basic-design).
- The work is pure research (no deliverable code).

## Inputs

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `{{INPUT_PATH}}` | file path(s) — detail design + codebase | yes | Detail design + relevant existing source files. |
| `{{TEMPLATE}}` | file path or scaffold | no | Optional code scaffold or template. |
| Project context | auto-discovered | yes | Build/test/lint commands, conventions, stack. |
| Stack skills | auto-discovered | yes | Read `.vibeflow/skills/<stack>/SKILL.md` for stack rules. |

## Execution Logic

1. **Read input** from `{{INPUT_PATH}}` — extract every interface, schema, sequence from the detail design.
2. **Survey existing codebase** — read top-level config, list packages, sample 2-3 similar files for style.
3. **Survey project conventions** — read `.vibeflow/PROJECT_CONTEXT.md` and stack skills for naming, error handling, logging, persistence patterns.
4. **Plan file changes** — for each spec item: file to create/modify, function/method to add, shared utilities to reuse.
5. **Implement incrementally** — for each file: minimum viable code → compile → fix errors → add next layer; write unit test alongside each new function.
6. **Run project build** — use the build command from `.vibeflow/PROJECT_CONTEXT.md`. Fix all errors before moving on.
7. **Run project tests** — existing test suite. New tests pass; existing tests do not regress.
8. **Self-review** — every spec item implemented, no lint/style violations, no unused imports/dead code.
9. **Verify against DoD** in `.vibeflow/WORKFLOW_STATE.json` (`work_units[name=implement].success_criteria`).
10. **Record evidence** in `.vibeflow/knowledge/log.md` (files changed, build output, test output).

## Outputs

| Name | Type | Notes |
|------|------|-------|
| Source files | in-repo | New or modified files per detail design. |
| Test files | in-repo | Unit/integration tests alongside code. |
| Evidence log | `.vibeflow/knowledge/log.md` | Build + test output. |

## Constraints

- Do NOT make design decisions — the design is already done.
- Do NOT introduce new dependencies without justification in the spec.
- Do NOT skip writing tests for new public functions.
- Do NOT break existing tests (regressions = blocked).
- Do NOT commit secrets, credentials, or `.env` files.

## Guardrails

- **Build guard**: code must compile before phase is marked done.
- **Test guard**: all existing tests must still pass.
- **Convention guard**: new code must match the style of existing code in the same module.
- **DRY guard**: do not duplicate utilities that already exist in the codebase.
- **Spec guard**: do not implement anything outside the spec without flagging it.

## Error Handling

| Failure | Action |
|---------|--------|
| Build failure | Fix code, do not bypass. Mark blocked if unfixable in scope. |
| Test failure (existing) | Treat as regression, do not modify test to make it pass. Investigate cause. |
| Test failure (new) | Fix the code, not the test (unless test is wrong). |
| Missing dependency | Flag in output, do not silently `npm install` or modify lockfile. |
| Spec ambiguity discovered | Stop, flag in output, return blocked. Re-run detail-design. |
| Out-of-scope bug discovered | Log to evidence, do not fix in this phase. |

## Examples & References

Concrete values from the `vf init` questionnaire (reference; actual dispatch uses `{{INPUT_PATH}}`/`{{OUTPUT_PATH}}`):

- **Input**: `{{phase.inputs path}}`
- **Output**: `{{phase.outputs path}}`
- **Template**: `{{template if provided}}`


## MCP Tools

This project has codegraph MCP tools configured by `vf init`. Use them for code navigation:

| Tool | When to use |
|------|-------------|
| `codegraph_explore` | Browse directory structure, find files by pattern |
| `codegraph_node` | Read a file or directory listing |
| `codegraph_search` | Search for symbols, patterns, or keywords across the codebase |
| `codegraph_callers` | Find all callers of a function or method |

Priority: `codegraph_explore` > `codegraph_node` > `codegraph_search` > `codegraph_callers` > native `grep`/`glob`/`read`/`bash`.

When you know the full file path, use `read` directly. Use `codegraph_node` when you need to explore a directory. For symbol lookup, use `codegraph_search`.


## References

- Templates: `.vibeflow/skills/implement/references/templates/`
- Examples: `.vibeflow/skills/implement/references/examples/`
- ANTHROPIC_SKILL_STANDARD.md — required frontmatter format.
- `.vibeflow/PROJECT_CONTEXT.md` — build/test/lint commands and conventions.
- `.vibeflow/skills/<stack>/SKILL.md` — stack-specific rules.
- `.vibeflow/knowledge/log.md` — evidence log.

---

Powered by VibeFlow v{{VERSION}}
