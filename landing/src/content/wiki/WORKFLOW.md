---
title: Workflow
description: End-to-end workflow — intake questions, context normalization, conversation runtime, and output report for VibeFlow task coordination.
category: how-to
last_updated: 2026-08-27
---

# Workflow

## Contents

- [End-to-End Flow](#end-to-end-flow)
- [Intake Questions](#intake-questions)
- [Context Normalization](#context-normalization)
- [Conversation Turn Delivery](#conversation-turn-delivery)
- [Owned CLI Lifecycle](#owned-cli-lifecycle)
- [Output Report](#output-report)
- [Methodology checkpoints → hard gates](#methodology-checkpoints--hard-gates)

## End-to-end flow

```text
1. User runs npm CLI
2. CLI starts local server and opens AI-first Home
3. User selects a prior session or starts a new conversation in the central pane
4. User adds/removes agents, sends or queues messages, and optionally stages private file ranges
5. Failed unacknowledged admission stays retryable with its exact idempotency-bound request
6. User edits the latest queued human message with ArrowUp, or adds ordered quotes/reactions
7. Tool scans the repo and resolves source, reader, and capability skills when needed
8. Tool reads and normalizes documents, then creates canonical project context
9. Coordinator plans work; specialist agents investigate/debate uncertain decisions
10. Runtime delivers structured public turns and separate one-shot private file context
11. Exact Claude/Codex/OpenCode resumes get new user/peer deltas; other turns get bounded own history
12. Coordinator splits tasks into non-overlapping scopes and generates engine instructions
13. Tool dispatches the selected CLI through the canonical owned async route
14. Inline Home cards resolve approvals, installs, repair, cancellation, and lifecycle actions
15. Hooks validate commands, writes, diffs, and final output
16. Tool shows contextual loading, logs, diffs, tests, risk, and conversation trace
17. Tool verifies completion and proposes skill updates from encountered problems
```

## Intake questions

`vf init` asks these questions when stdin is a TTY; `--no-ask` skips them. AI-first Home
does not switch into an intake wizard.

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

Private context:
- Do you need an exact private file range staged for this turn?
- Which file and line range should be attached?

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

## Conversation turn delivery

Public participant input is canonical JSON prefixed by `VF-TURN/1`. Claude, Codex, and
OpenCode are the only exact by-id engines. When native binding,
public cursor, and interaction cursor are all proved, `exact-delta` mode reuses the CLI's own
session and sends only newly applicable user messages plus peer-agent responses/reactions.
The recipient's own previous output is already in native history and is not sent again.
Without valid exact proof, `full-history` adds the recipient's last eight public responses to
applicable user/peer context. Each own-history summary is capped at 2 KiB UTF-8 and includes
source digest, provenance, and count/truncation metadata. It may include
the content-addressed `VF-HANDOFF/1` shared handoff.

Private file ranges travel separately as `VF-PRIVATE-FILE-RANGES/1` canonical JSON and are
cleared after the turn. They never enter public trace/browser persistence. Large Copilot
work-unit prompts may use `.vibeflow/dispatch/<unit>.md` plus a short argv read pointer; this
is transport only, not memory. Antigravity rejects UTF-8 prompts at or above 30 KiB because
its native print mode has no supported prompt-file/stdin replacement.

## Owned CLI lifecycle

Each canonical async launch stores supervisor and CLI PIDs, host, operation/attempt, and exact
process-start identity. Windows installs a kill-on-close Job Object before receipt/spawn and
reports `kernel-contained` proof. Linux/macOS create an isolated process group and report
`cooperative-lineage`, because descendants can escape it. Terminal release waits for process
exit/quiescence plus `streams-drained`.

`vf doctor` reports active, recovered, or uncertain records. `vf doctor --fix` acts only on
an exact proved orphan; live or identity-unprovable owners stay fail-closed. Injected platform
tests cover the Windows contract. Live Windows evidence is accepted only from a green, exact-SHA
`windows-latest` CI smoke job.

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
