---
name: requirements-analysis
description: Transform raw business needs and ambiguous inputs into a structured, testable requirements specification.
version: 1.0.0
status: template
requires: []
triggers:
  - workflow-phase:requirements-analysis
  - needs:structured-requirements
  - transform:raw-needs-to-spec
---

# requirements-analysis — {{PROJECT_NAME}}

## Purpose

Take raw, unstructured, ambiguous business inputs (notes, transcripts, tickets, briefs) and
produce a structured, prioritized, testable requirements specification that downstream
phases (basic-design, detail-design, implement) can consume without re-interpreting intent.

This is NOT transcription. The work is resolving ambiguity, identifying gaps, classifying
each statement, and making every requirement traceable to its source.

## When to Use

- A new feature or change request is being shaped.
- Inputs are scattered (Slack, meetings, tickets) and need to converge.
- Downstream phases need a single source of truth for "what we are building".
- The team needs traceability from a business need back to a test case.

## When NOT to Use

- Requirements already exist and are structured (skip to basic-design).
- The work is purely a bug fix with a known cause (skip to implement).
- A re-architecture where requirements are deliberately fixed (use basic-design directly).

## Inputs

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `{{INPUT_PATH}}` | file path(s) — text/markdown/transcript | yes | One or more raw input files. Multi-file is common. |
| `{{TEMPLATE}}` | file path or format hint | no | Optional reference template (user-story, EARS, etc.). |
| Project context | auto-discovered | yes | Read `.vibeflow/PROJECT_CONTEXT.md` for domain. |

## Execution Logic

1. **Inventory inputs** — read every file in `{{INPUT_PATH}}`, build a flat list of distinct needs, tag each with source and date.
2. **Deduplicate and merge** — collapse multiple phrasings of the same need into one requirement, preserving source links.
3. **Classify each requirement** — type (functional / non-functional / constraint / assumption), priority (MoSCoW), acceptance condition.
4. **Fill gaps explicitly** — mark missing detail with `[GAP: <reason>]`, do not invent silently. Use `.vibeflow/PROJECT_CONTEXT.md` for context where it informs the gap.
5. **Structure per `{{TEMPLATE}}`** — organize by feature area or user role, add traceability table (req-id → source).
6. **Write output** to `{{OUTPUT_PATH}}`.
7. **Self-review** — every input item represented in output, every requirement testable or marked TBD, no invented requirements.
8. **Verify against DoD** in `.vibeflow/WORKFLOW_STATE.json` (`work_units[name=requirements-analysis].success_criteria`).
9. **Record evidence** in `.vibeflow/knowledge/log.md` (output path, requirement count, gap count).

## Outputs

| Name | Type | Notes |
|------|------|-------|
| `{{OUTPUT_PATH}}` | markdown | Structured requirements doc with traceability table. |
| Evidence log | `.vibeflow/knowledge/log.md` | Counts + paths. |

## Constraints

- Do NOT invent requirements beyond what input justifies.
- Do NOT remove `[GAP: ...]` markers silently — surface them.
- Do NOT skip the traceability table — downstream phases depend on it.
- Do NOT modify files outside the declared input/output set.

## Guardrails

- **Ambiguity guard**: any requirement that is not testable must be marked TBD with reason.
- **Source fidelity guard**: every requirement must cite at least one input source.
- **Scope guard**: do not pull requirements from other unrelated projects in the same repo.
- **Convention guard**: follow formatting rules in `.vibeflow/PROJECT_CONTEXT.md` if present.

## Error Handling

| Failure | Action |
|---------|--------|
| Input file missing | Mark all requirements as `[GAP: input file <path> not found]` and continue. |
| Input unreadable (binary / corrupt) | Skip that file, log a warning, continue with others. |
| Conflicting requirements from different sources | Surface the conflict in the output, do not silently pick one. |
| Output path not writable | Stop, log error, return blocked status. Do not write partial. |
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

- Templates: `.vibeflow/skills/requirements-analysis/references/templates/`
- Examples: `.vibeflow/skills/requirements-analysis/references/examples/`
- ANTHROPIC_SKILL_STANDARD.md — required frontmatter format.
- `.vibeflow/PROJECT_CONTEXT.md` — project domain and conventions.
- `.vibeflow/knowledge/log.md` — evidence log.

---

Powered by VibeFlow v{{VERSION}}
