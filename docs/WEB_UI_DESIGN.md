---
title: Web UI Design
description: Design specification for the web UI — main screens, UX principles, approval flow, and real-time updates.
category: explanation
last_updated: 2026-06-24
---

# Web UI Design

## Contents

- [Purpose](#purpose)
- [Main Screens](#main-screens)
- [UI Principle](#ui-principle)
- [Approval UX](#approval-ux)
- [Real-Time Updates](#real-time-updates)

## Purpose

The web UI is the visual workflow console for non-linear AI SDLC orchestration.

It should help the user configure repo, sources, skills, engine, permissions, execution, review, and skill evolution.

> **Implementation status.** Phase 1 of this console is implemented in `src/server.ts`: an
> interactive **intake wizard** with a **repo path picker** (auto-detects which engines a repo
> already carries and which CLIs are installed), constrained inputs with `<datalist>`
> autocomplete, **multi-file sample attachments** (any number; each mapped to a reader skill the
> AI should use), an **editable work-unit board** (add/update/delete), and a **dispatch**
> control. The intake posts to `POST /api/init` to generate the canonical context + per-engine
> files and seed `WORKFLOW_STATE.json` in the chosen repo; `POST /api/detect`, `/api/units`, and
> `POST`/`DELETE /api/upload` back the detection, CRUD, and attachment flows; the live dashboard
> renders the ledger. All write endpoints are loopback-only and CSRF-protected (see
> `SECURITY_MODEL.md`). The motion layer is a small inline count-up/entrance animation — no
> third-party CDN script is loaded, because the page is same-origin with the write API and a
> compromised CDN must not be able to reach it.

## Main screens

### 1. Setup

Fields:

```text
- Repo path or GitHub URL
- Branch
- Create new branch yes/no
- Preferred engine: Claude Code / Codex / Copilot CLI
- Permission mode
- Workspace path
```

### 2. Sources

Fields:

```text
- Project documentation source
- Task management source
- Credentials/connectors status
- Local folder selection
- Files selected for context
```

Supported source types:

```text
GitHub
GitLab
Google Drive
Confluence
Notion
Jira
Linear
Slack
Local folder
S3/R2
```

### 3. Skills

(Implementation: Skills Catalog panel via SkillPanel.vue — modal overlay from TopBar Skills button.)

Shows:

```text
- Verified skills
- Missing skills
- External skills found
- Skills requiring approval
- Skill versions
- Capabilities
- Required permissions
```

Actions:

```text
- Enable skill
- Disable skill
- Verify skill
- Promote draft to verified
- View SKILL.md
- View changelog
```

**Panel behaviour.** The Skills Catalog panel (`SkillPanel.vue`) is a modal overlay
controlled by `store.skillPanelOpen`. On close, it emits a `close` event; App.vue
sets `skillPanelOpen = false` and returns keyboard focus to the Skills launcher
button in the TopBar (matching the Settings panel pattern). Short error messages
from the store (`skillError`) are displayed inline in the panel and cleared before
each fetch. Skills loaded from the server are rendered with security-scan dots,
origin, version, and deprecated styling. The panel auto-loads skills on mount when
the list is empty.

**Attachment skill badges.** In Stage1Describe, each uploaded attachment shows its
assigned reader skill label. When that skill exists in the loaded catalog (`store.skills`),
a coloured status badge (verified, enriched, experimental, etc.) is shown next to
the skill label.

### 4. Context

Shows generated context files:

```text
PROJECT_CONTEXT.md
REQUIREMENTS.md
TASK_CONTEXT.md
ARCHITECTURE_CONTEXT.md
API_CONTEXT.md
SKILL_INDEX.md
```

User should be able to inspect and edit context before execution.

### 5. Plan and Debate

Shows:

```text
- Orchestrator interpretation
- Confidence scores
- Assumptions
- Risks
- Investigation results
- Debate summary
- Recommended plan
- Parallel task split
```

### 6. Generated Instructions

Shows generated files:

```text
CLAUDE.md
AGENTS.md
.github/copilot-instructions.md
.github/instructions/*.instructions.md
.claude/agents/*.md
.claude/skills/*/SKILL.md
```

### 7. Run

Shows:

```text
- Selected engine
- Active agent
- Skills used
- Commands running
- Logs
- Hook decisions
- Warnings
- Approval requests
```

The Run screen includes a live **orchestration dashboard** that renders the work-unit
ledger from `.vibeflow/WORKFLOW_STATE.json` (see `WORK_UNIT_ORCHESTRATION.md`) so quality
and resource use are visible without reading raw logs:

```text
- Work-unit board: one card per unit with status, owner agent, and confidence
- Gate strip: build / lint / test / review shown as pass / fail / running / pending
- Resource meter: tokens, estimated cost, and elapsed time per unit and rolled up to totals
- Evidence drawer: links to recorded gate output under each unit's evidence/ folder
- Triage banner: any BLOCKED / TOO_BIG / AMBIGUOUS / REGRESSED unit is surfaced first
```

### 8. Review

Shows:

```text
- Git diff
- Files changed
- Tests run
- Lint/build status
- Risk report
- Skill compliance report
- Final recommendation
```

### 9. Skill Evolution

Shows:

```text
- Problems encountered
- Workarounds used
- Proposed skill updates
- Draft skill changes
- Validation prompt
- Promote / reject action
```

## UI principle

The UI should reduce user burden. It should not ask “What should I do next?”

It should show:

```text
Recommended next action
Reason
Evidence
Risk
Safety control
Approval button if required
```

## Approval UX

Approval prompts should support:

```text
Approve once
Approve for this task
Approve for this repo policy
Reject
Edit policy
```

## 10. Diff Preview (#641)

The Diff Preview shows code changes at the workflow or work-unit level,
synchronized with the selected pipeline node.

**Workflow-level summary**: changed-file count, additions/deletions totals,
and baseline label (dispatch checkpoint when available, otherwise `HEAD`).
Binary files are flagged; untracked files are reported separately from
`git status --porcelain`.

**Work-unit preview**: scope-limited unified diff filtered to the selected
unit's declared paths. Capped at 200 KB / 2,000 lines with `truncated: true`
and a local-command hint on overflow. No-diff, unsupported, binary, and
truncated states are clearly labeled.

**API contract** (`GET /api/dashboard/diff`):
- Validates repo is a registry member, `workflowId` matches `task_id`,
  unit exists.
- Uses `git diff --no-ext-diff --binary <baseline> -- <validated scope>` —
  never shell-interpolates input.
- Rendition via `{{ }}` interpolation, never `v-html`.
- Baseline defaults to the pre-dispatch checkpoint's base ref; falls back
  to `HEAD`.

**Integration points**:
- Workflow Dashboard (stage 0): diff panel above the pipeline graph.
  Selecting a pipeline node filters to that unit's scope.
- Verify screen (stage 4): full workflow diff summary above the task table.

## Pipeline dashboard (ADR-006)

The Home screen (stage 0) now shows a **Workflow Dashboard** listing every
registered workflow. Each card displays repo, task ID, goal, done/total,
running/blocked count, and latest activity. Selecting a card reveals:

1. A **dependency pipeline** (CSS Grid + SVG) with one column per wave.
   Nodes are keyboard-focusable `<button>` elements with status-based coloring:
   pending (neutral), running (animated blue), verifying (animated amber),
   done (green), blocked (red). An ordered text list provides screen-reader
   access. No external graph library is used.

2. A **scoped log drawer** showing only events for that workflow. When a unit
   is selected, filters narrow to that unit while retaining workflow-level
   lifecycle events. The existing active-session log pane
   (`/api/logs/stream`) is unchanged.

Dashboard polling interval: 2 s while any workflow is running, 15 s otherwise.
One selected workflow gets a durable-log SSE stream.

### Layout

Desktop: pipeline graph on the left, log drawer on the right (lg breakpoint).
Mobile: stacked vertically. The "Recent projects" section (Resume/Reuse/Delete)
remains but is secondary to the active workflow cards.

## 11. Interactive Plan Review (PR1)

The Plan Review panel (Stage 2 of the intake wizard) is a file-backed plan-markdown
review surface with three components:

**PlanReview.vue** — parent container. Loads revisions via `store.loadRevisions()`
when `repoPath` resolves (watches `store.repoPath`). Renders a split layout:
revision rail on the left, canvas on the right.

**PlanRevisionRail.vue** — left sidebar listing all stored revisions by creator name
and timestamp. Click to select; the initial state shows a textarea for creating the
first draft. When an anchor is active, displays the anchor blockId + quote preview
with the note "Comment storage not implemented" (PR2).

**PlanCanvas.vue** — right content area rendering typed blocks via `{{ }}`
interpolation (never `v-html`). Each block type renders distinctly:
- heading → styled by level (h1-h3 mapped to size classes)
- paragraph → `<p>` with relaxed leading
- list-run → `<ul><li>` with disc markers
- fenced-code → `<pre><code>` with monospace
- fenced-mermaid → fallback label + `<pre><code>` source (no mermaid runtime)

Each block has a hover-reveal "Comment" button and mouseup selection handler — both
emit a `BlockAnchor` (blockId, quote, selection range) as groundwork for threaded
comments (PR2).

**API surface** (`docs/adr/ADR-007-interactive-plan-review.md`):
- `GET /api/plan-review?repoPath=&workflowId=` — fetch current revision + blocks
- `POST /api/plan-review/revisions` — create new revision from markdown (CSRF-guarded)

**Deferred to PR2:** threaded comment storage, dispatch gate, revision diff.
**Deferred to PR3:** AI replan from review feedback.

See `src/ui/src/components/PlanReview.vue`, `PlanCanvas.vue`, `PlanRevisionRail.vue`,
`src/ui/src/lib/plan-render.ts`, `src/ui/src/lib/plan-anchor.ts`.

## Real-time updates

Use Server-Sent Events for:

```text
- command logs
- agent status
- hook decisions
- skill usage
- diff updates
- verification progress
- (dashboard) selected workflow durable log tail
```

---

**Related:** [Architecture](./ARCHITECTURE.md) · [Workflow](./WORKFLOW.md)
[Edit this page on GitHub](https://github.com/magicpro97/vibeflow/edit/main/docs/WEB_UI_DESIGN.md)
