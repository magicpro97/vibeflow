---
name: verify
description: Audit all phase artifacts against acceptance criteria and produce a sign-off verification report.
version: 1.0.0
status: template
requires: []
triggers:
  - workflow-phase:verify
  - needs:sign-off
  - transform:artifacts-to-verdict
---

# verify — {{PROJECT_NAME}}

## Purpose

Take all phase artifacts and produce a verification report that audits each deliverable
against its acceptance criteria and issues a sign-off (or lists blockers). Independent
audit, not self-confirmation: re-check the artifacts by reading them again, not by
trusting the prior phase's evidence.

## When to Use

- A workflow run is completing and the team needs a sign-off.
- An external audit is being prepared.
- A major release is being shipped.

## When NOT to Use

- The work is a draft (verify after draft is finalized).
- A single phase is being checked (do that within the phase itself).

## Inputs

| Name | Type | Required | Notes |
|------|------|----------|-------|
| `{{INPUT_PATH}}` | file path(s) — all phase outputs | yes | Every artifact from every phase. |
| `{{TEMPLATE}}` | file path or format hint | no | Optional reference (checklist, risk register). |
| Project context | auto-discovered | yes | Original requirements for cross-reference. |

## Execution Logic

1. **Inventory deliverables** from `{{INPUT_PATH}}` — list every output file from every phase with its declared DoD and recorded evidence.
2. **Re-read each artifact** — open the file, verify it exists, is non-empty, addresses its DoD. Do NOT trust prior phase's evidence.
3. **Cross-reference** — Requirements → basic design: every req covered? Basic → detail design: every feature has interfaces/schemas? Detail design → code: every interface implemented? Code → tests: every requirement has ≥1 test?
4. **Identify gaps** — missing artifacts, empty files, broken references, tests that don't actually cover the requirement, code that doesn't match the design.
5. **Risk register** — for each gap, classify: blocker / major / minor / acceptable, suggest remediation.
6. **Issue verdict** — PASS (all critical DoD met, no blockers) / CONDITIONAL (minor gaps with plan) / FAIL (≥1 blocker).
7. **Write output** to `{{OUTPUT_PATH}}`.
8. **Self-review** — every artifact was opened, every gap has severity + remediation, verdict is defensible against original requirements.
9. **Verify against DoD** in `.vibeflow/WORKFLOW_STATE.json` (`work_units[name=verify].success_criteria`).
10. **Record evidence** in `.vibeflow/knowledge/log.md` (report path, verdict, gap count by severity).

## Outputs

| Name | Type | Notes |
|------|------|-------|
| `{{OUTPUT_PATH}}` | markdown | Verification report with verdict, gaps, risk register. |
| Evidence log | `.vibeflow/knowledge/log.md` | Verdict + gap counts. |

## Constraints

- Do NOT trust prior phase's evidence — re-check by re-reading the file.
- Do NOT mark PASS when blockers exist.
- Do NOT modify the artifacts being verified.
- Do NOT modify files outside the declared input/output set.

## Guardrails

- **Independence guard**: verify by reading, not by asking the implementer.
- **Coverage guard**: every artifact must be opened and checked.
- **Severity guard**: every gap must have a severity and a remediation.
- **Defensibility guard**: the verdict must cite the original requirements.
- **No-mutation guard**: the verifier MUST NOT modify the artifacts.

## Error Handling

| Failure | Action |
|---------|--------|
| Input artifact missing | Mark as blocker, severity=blocker, remediation="re-run phase <name>". |
| Artifact exists but empty | Mark as blocker, severity=blocker. |
| Cross-reference broken | Mark as gap with severity based on impact. |
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

- Templates: `.vibeflow/skills/verify/references/templates/`
- Examples: `.vibeflow/skills/verify/references/examples/`
- ANTHROPIC_SKILL_STANDARD.md — required frontmatter format.
- `.vibeflow/PROJECT_CONTEXT.md` — original requirements.
- `.vibeflow/knowledge/log.md` — evidence log.
- `.vibeflow/WORKFLOW_STATE.json` — per-phase DoD and success criteria.

---

Powered by VibeFlow v{{VERSION}}
