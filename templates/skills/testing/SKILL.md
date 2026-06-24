---
name: testing
description: Transform code and design into executable test cases, run them, and report results with traceability.
version: 1.0.0
status: template
requires: []
triggers:
  - workflow-phase:testing
  - needs:test-coverage
  - transform:code-to-tested
---

# testing — {{PROJECT_NAME}}

## Purpose

Take code and design and produce executed test cases with pass/fail results, each
mapped back to a requirement. Coverage without redundancy: every requirement has
≥1 test, every test maps to a requirement.

## When to Use

- New code has been implemented and needs verification.
- A regression is suspected and tests must catch it next time.
- The team needs confidence before shipping.

## When NOT to Use

- The work is documentation-only (no code change to test).
- A small prototype where test coverage is explicitly out of scope.

## Inputs

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `{{INPUT_PATH}}` | file path(s) — code + design | yes | Code under test + spec (detail design, requirements). |
| `{{TEMPLATE}}` | file path or format hint | no | Optional reference (given-when-then, BDD, table-driven). |
| Project context | auto-discovered | yes | Test framework, command, conventions. |

## Execution Logic

1. **Read input** from `{{INPUT_PATH}}` — extract every requirement and every interface, read the code under test.
2. **Survey test framework** — identify framework from `package.json`/`build.gradle`/`requirements.txt`, read 2-3 existing tests for patterns.
3. **Plan test cases** — for each requirement: ≥1 happy-path test; for each interface: ≥1 error-path test; for each edge case in detail design: explicit test.
4. **Write test cases document** (text) — traceability table (test-id → requirement-id).
5. **Write test source files** — follow project conventions, each test independent and deterministic.
6. **Run tests** — use the project test command, capture pass/fail counts.
7. **Self-review** — every requirement has ≥1 test, no flaky tests (run twice, same result), no skipped tests without a comment explaining why.
8. **Verify against DoD** in `.vibeflow/WORKFLOW_STATE.json` (`work_units[name=testing].success_criteria`).
9. **Record evidence** in `.vibeflow/knowledge/log.md` (test cases doc, test sources, run output).

## Outputs

| Name | Type | Notes |
|------|------|-------|
| `{{OUTPUT_PATH}}` | markdown + test files | Test cases doc (text) + test source files. |
| Evidence log | `.vibeflow/knowledge/log.md` | Counts + run output. |

## Constraints

- Do NOT test implementation details that are not part of the spec.
- Do NOT write flaky tests (timing-dependent, order-dependent, network-dependent).
- Do NOT skip tests silently.
- Do NOT modify the code under test to make tests pass.
- Do NOT modify files outside the declared input/output set.

## Guardrails

- **Coverage guard**: every requirement must have ≥1 test.
- **Independence guard**: each test must be runnable in any order.
- **Determinism guard**: same result on repeated runs.
- **Convention guard**: new tests must match the style of existing tests.
- **Traceability guard**: each test must map to a requirement-id in the output doc.

## Error Handling

| Failure | Action |
|---------|--------|
| Input file missing | Stop, log error, return blocked. |
| Test framework not detected | Stop, log error, return blocked. |
| Test run fails to start | Investigate, fix infrastructure, do not skip tests. |
| Test run reveals bug in code | Mark blocked, log to evidence, do not fix in this phase. |
| Output path not writable | Stop, log error, return blocked. Do not write partial. |
| `{{TEMPLATE}}` provided but unreadable | Warn, fall back to a generic format. |

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

- **Viewpoint** (common test base knowledge): `.vibeflow/skills/testing/references/viewpoint_testing.md` — read this BEFORE generating test cases; it defines the standard test viewpoints (CRUD, validation, permissions, data, abnormal operations).
- Templates: `.vibeflow/skills/testing/references/templates/`
- Examples: `.vibeflow/skills/testing/references/examples/`
- ANTHROPIC_SKILL_STANDARD.md — required frontmatter format.
- `.vibeflow/PROJECT_CONTEXT.md` — test framework, conventions.
- `.vibeflow/knowledge/log.md` — evidence log.

---

Powered by VibeFlow v{{VERSION}}
