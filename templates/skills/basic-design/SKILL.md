---
name: basic-design
description: Transform structured requirements into a high-level functional design with modules, features, and data flow.
version: 1.0.0
status: template
requires: []
triggers:
  - workflow-phase:basic-design
  - needs:high-level-design
  - transform:requirements-to-design
---

# basic-design — {{PROJECT_NAME}}

## Purpose

Take structured requirements and produce a high-level functional design that decomposes
the system into modules, features, and data flow without going into implementation
details. The output is a navigable map of the system, not code.

This phase makes boundary decisions: which requirements cluster into one feature, which
features share a module, where data lives. It does NOT specify APIs, schemas, or
sequences — those come in detail-design.

## When to Use

- Requirements are stable and signed off.
- The team needs alignment on scope before committing to implementation.
- Multiple modules or teams will share the work and need clear ownership.

## When NOT to Use

- Requirements are still being clarified (use requirements-analysis first).
- The system is small enough to skip directly to detail-design.
- A re-design of a single module (work in-place, do not re-design the whole system).

## Inputs

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `{{INPUT_PATH}}` | file path(s) — requirements doc | yes | Output of requirements-analysis phase. |
| `{{TEMPLATE}}` | file path or format hint | no | Optional reference (4+1 view, C4, feature list). |
| Project context | auto-discovered | yes | Read `.vibeflow/PROJECT_CONTEXT.md` and `.vibeflow/ai-context/stack-evidence.md`. |

## Execution Logic

1. **Read input** from `{{INPUT_PATH}}` — extract every requirement, identify actors, note non-functional constraints.
2. **Group into features** — cluster related requirements into user-facing features, each feature = a coherent capability set.
3. **Group features into modules** — identify natural boundaries (by actor, by data, by lifecycle), use DDD bounded contexts when in doubt.
4. **Map data flow** — for each feature, trace input → processing → output → storage, identify shared data stores, ensure acyclic.
5. **Document tech layer** — for each module, mark UI / API / service / data using existing project conventions.
6. **Write output** to `{{OUTPUT_PATH}}`.
7. **Self-review** — every requirement owned by ≥1 feature, every feature in exactly 1 module, data flow is acyclic.
8. **Verify against DoD** in `.vibeflow/WORKFLOW_STATE.json` (`work_units[name=basic-design].success_criteria`).
9. **Record evidence** in `.vibeflow/knowledge/log.md` (output path, module/feature counts).

## Outputs

| Name | Type | Notes |
|------|------|-------|
| `{{OUTPUT_PATH}}` | markdown | High-level design doc with module/feature/data-flow sections. |
| Evidence log | `.vibeflow/knowledge/log.md` | Counts + paths. |

## Constraints

- Do NOT specify API signatures, DB columns, or sequence diagrams (those belong in detail-design).
- Do NOT add features that no requirement justifies.
- Do NOT merge unrelated domains into one module.
- Do NOT modify files outside the declared input/output set.

## Guardrails

- **Coverage guard**: every requirement from input must be owned by ≥1 feature.
- **Modularity guard**: every feature must live in exactly 1 module (no overlap).
- **Cycle guard**: the data-flow graph must be acyclic. If a cycle appears, refactor before writing.
- **Convention guard**: when project already has modules, prefer extending them over creating new ones.

## Error Handling

| Failure | Action |
|---------|--------|
| Input file missing | Stop, log error, return blocked. Cannot design without requirements. |
| Conflicting requirements | Surface the conflict in the output, do not silently pick one. |
| Existing project modules detected | Read them first, prefer extending over creating new modules. |
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

- Templates: `.vibeflow/skills/basic-design/references/templates/`
- Examples: `.vibeflow/skills/basic-design/references/examples/`
- ANTHROPIC_SKILL_STANDARD.md — required frontmatter format.
- `.vibeflow/PROJECT_CONTEXT.md` — project domain and conventions.
- `.vibeflow/ai-context/stack-evidence.md` — detected stack/framework list.
- `.vibeflow/knowledge/log.md` — evidence log.

---

Powered by VibeFlow v{{VERSION}}
