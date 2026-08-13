---
title: Workflow
description: End-to-end workflow — intake questions, context normalization, and output report for VibeFlow task orchestration.
category: how-to
last_updated: 2026-08-13
---

# Workflow

![VibeFlow orchestrate loop — plan, dispatch, review, gate, verdict](/diagrams/orchestrate-loop.svg)

## Contents

- [End-to-End Flow](#end-to-end-flow)
- [Intake Questions](#intake-questions)
- [Context Normalization](#context-normalization)
- [Output Report](#output-report)
- [Methodology checkpoints → hard gates](#methodology-checkpoints--hard-gates)

## End-to-end flow

```text
1. User runs npm CLI
2. CLI starts local server and opens web UI
3. User selects repo or enters repo URL
4. Tool scans repo structure
5. User provides project document source and task management source
6. Tool resolves source skills and file reader skills
7. Tool reads and normalizes documents
8. Tool creates project context
9. Main orchestrator plans the work
10. Specialist agents investigate uncertain parts
11. Agents debate high-risk decisions
12. Orchestrator splits tasks into non-overlapping scopes
13. Tool generates engine-specific instruction files
14. User selects Claude Code, Codex, or Copilot CLI
15. Tool dispatches selected engine
16. Hooks validate commands, writes, diffs, and final output
17. Tool shows logs, diffs, test results, risk report
18. Tool proposes skill updates based on problems encountered
```

## Intake questions

The web UI should ask:

```text
Repository:
- Where is the repo?
- Which branch should be used?
- Is the tool allowed to create a new branch?

Project documents:
- Where are the documents stored?
- Google Drive, Confluence, Notion, local folder, GitHub wiki, S3, other?
- Which files are important?

Task management:
- Where is work managed?
- Jira, Linear, GitHub Issues, Trello, Notion, other?
- Which ticket/task should be used?

Task intent:
- What should be done?
- Expected output?
- Any sample output?
- Definition of Done?
- What must not be changed?

Execution:
- Which engine should run?
- Claude Code, Codex, Copilot CLI?
- Permission mode?
- Allowed commands?
```

## Context normalization

Raw sources should be converted into normalized files:

```text
PROJECT_CONTEXT.md
REQUIREMENTS.md
TASK_CONTEXT.md
ARCHITECTURE_CONTEXT.md
API_CONTEXT.md
WORKFLOW_STATE.json
```

Example normalized document record:

```json
{
  "source": "google-drive",
  "file_name": "BRD.docx",
  "file_type": "docx",
  "content_type": "business_requirement",
  "summary": "...",
  "key_requirements": [],
  "open_questions": [],
  "confidence": 0.86
}
```

## Output report

Every run should produce:

```text
- Task summary
- Files changed
- Skills used
- Agents used
- Commands run
- Tests run
- Verification result
- Remaining uncertainty
- Recommended next action
- Skill updates proposed
```

## Methodology checkpoints → hard gates

`vf verify` enforces the outcomes described by upstream methodology skills; it does not vendor or
rewrite their content. These gates apply by default, whether or not an advisory skill is installed.

| Methodology checkpoint | vf hard gate | Block condition |
|---|---|---|
| `test-driven-development` (RED → GREEN) | `policyGates` test-evidence gate | Any work unit marked `done` whose `gates.test` is not `pass`. Generic commit, file, or CI evidence cannot substitute for a passing test gate. |
| `requesting-code-review` | current-HEAD review-evidence gate | `.vibeflow/review-evidence/v1/<HEAD>.json` is missing, unreadable, stale, has a SHA/manifest mismatch, lacks required source + test anchors, or records reviewer failure/findings. The existing no-applicable-checklist exemption remains. |
| `finishing-a-development-branch` | `policyGates` confidence + scope gates | Computed confidence is below the risk threshold, a unit is still running, evidence is missing/unverifiable, or work-unit scopes overlap. |

Skill prose remains advisory; hard gates are code in `src/gates.ts` and
`src/hooks/review-evidence.ts`. Skills do not carry an enforcement class. When duplicate skill names
are discovered, first-root-wins remains deterministic and vf warns with both the winning and ignored
paths rather than silently pretending one skill is a hard gate.

This is an intentional behavior break: current-HEAD review evidence and a passing test gate for every
done unit are required by default. Fix the evidence or unit gate; do not bypass the methodology with
free-text evidence.

---

**Related:** [User Guide](./USER_GUIDE.md) · [Architecture](./ARCHITECTURE.md)
[Edit this page on GitHub](https://github.com/magicpro97/vibeflow/edit/main/docs/WORKFLOW.md)
