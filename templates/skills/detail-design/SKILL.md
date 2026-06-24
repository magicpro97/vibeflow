---
name: detail-design
description: Transform a high-level functional design into an implementation-ready specification with interfaces, schemas, and method signatures.
version: 1.0.0
status: template
requires: []
triggers:
  - workflow-phase:detail-design
  - needs:implementation-ready-spec
  - transform:high-level-to-detail
---

# detail-design — {{PROJECT_NAME}}

## Purpose

Take a high-level design and produce an implementation-ready specification that a
developer can implement without making design decisions. Every interface signature,
DB column, error code, edge case, and call sequence is specified.

The gap between high-level design and code is closed here. A design is incomplete if
the implementer has to make a decision.

## When to Use

- High-level design is approved.
- Implementation will start (or resume) soon.
- The team needs a contract before coding to avoid re-work.

## When NOT to Use

- The work is a small bug fix with known scope (use implement directly).
- The system is being prototyped (use basic-design only).
- Requirements are still changing (re-run basic-design first).

## Inputs

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `{{INPUT_PATH}}` | file path(s) — high-level design | yes | Output of basic-design phase. |
| `{{TEMPLATE}}` | file path or format hint | no | Optional reference (OpenAPI stub, sequence-diagram template, class-table template). |
| Project context | auto-discovered | yes | Read `.vibeflow/PROJECT_CONTEXT.md` and `.vibeflow/ai-context/stack-evidence.md`. |

## Execution Logic

1. **Read input** from `{{INPUT_PATH}}` — list every module, feature, and interface.
2. **Specify interfaces** — for each API endpoint: method, path, request/response shape, auth, error codes. For each UI screen: layout, state, inputs.
3. **Specify data schemas** — tables (columns, types, indexes, FK), entities (fields, validation, lifecycle states).
4. **Specify sequences** — for each non-trivial flow, draw a sequence diagram (text-form ok) covering happy path + main error paths.
5. **Specify edge cases** — empty inputs, concurrent access, timeout, retry, partial failure. Cross-reference with non-functional requirements.
6. **Write output** to `{{OUTPUT_PATH}}`.
7. **Self-review** — every feature has a detail section, every interface has all 6 fields, no design decision left for the implementer.
8. **Verify against DoD** in `.vibeflow/WORKFLOW_STATE.json` (`work_units[name=detail-design].success_criteria`).
9. **Record evidence** in `.vibeflow/knowledge/log.md` (output path, interface/schema/sequence counts).

## Outputs

| Name | Type | Notes |
|------|------|-------|
| `{{OUTPUT_PATH}}` | markdown | Detail design doc with interfaces, schemas, sequences, edge cases. |
| Evidence log | `.vibeflow/knowledge/log.md` | Counts + paths. |

## Constraints

- Do NOT invent APIs, fields, or error codes not implied by the high-level design.
- Do NOT leave ambiguity — every design decision must be explicit.
- Do NOT skip edge cases (they surface as bugs at implement time).
- Do NOT modify files outside the declared input/output set.

## Guardrails

- **Completeness guard**: every feature from basic-design must have a detail section.
- **Interface guard**: every interface must specify method/path/req/res/auth/errors.
- **Edge-case guard**: every interface must have at least 1 error-path documented.
- **Consistency guard**: data schemas must reference the same field names used in interfaces.
- **Convention guard**: when project has naming conventions, use them.

## Error Handling

| Failure | Action |
|---------|--------|
| Input file missing | Stop, log error, return blocked. |
| High-level design has unresolved ambiguity | Flag it in the output, do NOT silently pick. |
| Conflicting requirements from different sources | Surface the conflict, do not silently pick one. |
| Output path not writable | Stop, log error, return blocked. Do not write partial. |
| `{{TEMPLATE}}` provided but unreadable | Warn, fall back to a generic structure. |

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

- Templates: `.vibeflow/skills/detail-design/references/templates/`
- Examples: `.vibeflow/skills/detail-design/references/examples/`
- ANTHROPIC_SKILL_STANDARD.md — required frontmatter format.
- `.vibeflow/PROJECT_CONTEXT.md` — project domain and conventions.
- `.vibeflow/ai-context/stack-evidence.md` — detected stack/framework list.
- `.vibeflow/knowledge/log.md` — evidence log.

---

Powered by VibeFlow v{{VERSION}}
