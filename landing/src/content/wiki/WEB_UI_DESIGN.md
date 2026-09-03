---
title: Web UI Design
description: Design specification for the web UI — AI-first Home surfaces, UX principles, approval flow, and real-time updates.
category: explanation
last_updated: 2026-08-27
---

# Web UI Design

## Contents

- [Purpose](#purpose)
- [Primary Surfaces](#primary-surfaces)
- [UI Principle](#ui-principle)
- [Approval UX](#approval-ux)
- [Contextual Loading and Empty States](#contextual-loading-and-empty-states)
- [Real-Time Updates](#real-time-updates)

## Purpose

The web UI is AI-first Home: the visual conversation workspace for the local harness.
It should keep the user in the current thread, make the searchable session rail and
central conversation pane the default surfaces, and surface details, trace, and
capabilities without forcing a mode switch.

> **Implementation status.** `src/ui/src/components/ConversationHome.vue` implements the
> AI-first Home shell: searchable session rail, central conversation pane, details inspector,
> and the composer-driven conversation flow. `HomeSessionRail.vue`, `HomeTimeline.vue`,
> `HomeComposer.vue`, `HomeCapabilityDrawer.vue`, and `HomeTraceDrawer.vue` provide the
> rail, timeline, composer, capability, and trace surfaces. Repository intake is not a Home
> mode: `vf init` asks its questionnaire when stdin is a TTY, and `--no-ask` skips it.
> On a LAN bind, legacy mutations require the authorized LAN page session plus CSRF token.
> Conversation Home uses a separate conversation session that is issued only on loopback,
> so its JSON, artifact, and stream-token routes fail closed on LAN even after page
> bootstrap (see `SECURITY_MODEL.md`).
> The motion layer is a small inline count-up/entrance animation — no third-party CDN script
> is loaded, because the page is same-origin with the write API and a compromised CDN must not
> be able to reach it.

## Primary surfaces

### 1. AI-first Home

The default surface is the searchable session rail plus the central conversation pane.
It keeps the current conversation visible, shows participant state and live stream
status, and makes new conversation creation obvious. Search filters sessions in place;
selecting a result opens it directly without a resume dialog.

### 2. Composer

The composer is conversation-first, not form-first. It owns the durable FIFO queue, ArrowUp editing for the latest queued human message, private file range capture, and typed capability selection. Sends made while an agent is busy queue automatically. ArrowUp starts an edit only for the latest queued human message; Escape cancels, and a lost dispatch/edit race preserves the draft for explicit send-as-new. Typed add-participant actions promote a direct route into coordinate through proposal/review/commit, and removing the last executor collapses it back to direct. Sent messages remain ordered and reviewable. Only a transport-ambiguous request, or a typed admission error with `retryable: true` and `recovery_action: retry`, becomes retryable and may replay the exact request and idempotency key. Typed failures wait for an explicit retry. An in-flight admission interrupted by browser offline remains **Reconciling** and automatically replays the same idempotency key only after authoritative refresh. A non-retryable collision retains the exact rejected payload as **Needs action**, outside the waiting count. Its typed action restores an unsent edit/new draft, refreshes the active conversation before restore, or gives CLI authority-repair guidance; confirmed dismissal settles retained private context first. No typed recovery auto-resends or overwrites newer composer state. Rejected rows are current Home state and are not persisted through `localStorage` or promised across a browser restart.

### 3. Details inspector

The details inspector shows the active conversation's participants, continuity, lineage, and health so the user can verify who is involved before adding more context or changing route authority. Participants can be mentioned or removed from this surface. The visible `−` action prepares `-@participant` in the composer so removal remains a chat event instead of hidden settings.

### 4. Trace / capabilities drawers

The trace drawer shows ordered public trace and evidence. The capabilities drawer
shows typed capability actions and their current state without leaving the thread.

### 5. Message interactions

Users can quote one through eight currently visible messages from one or more sources.
Ordered quote chips can move earlier/later, be removed, and jump back to their source.
Messages accept only 👍, 👎, ❤️, 🎉, 👀, 🤔, ✅, and ❗ reactions. Reactions are typed
records rather than prompt syntax; an agent may add at most three distinct non-self
reactions so the affordance does not become noise.

### 6. Repository intake

Run `vf init` in a TTY for first-run repository intake; it asks the goal, engine, sources,
and Definition of Done before generating canonical context. `vf init --no-ask` is the
non-interactive path. `vf ui` always stays on AI-first Home.

### 7. Secondary workflow/review surfaces

The work-unit board, orchestration dashboard, generated instructions, review surfaces,
and skill-evolution panels remain available, but they are secondary to the home-first
conversation flow.

## UI principle

The UI should reduce user burden. It should not ask “What should I do next?” or send
the user away from the current conversation unless it is necessary.

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

Approval, cancellation, install, repair, and lifecycle proposals render as typed action cards
in the central timeline. A card shows the target, reason, bounded evidence, risk, and exact
operation id. The browser only resolves a guarded decision endpoint; it never installs or
mutates capability state directly. Approve remains disabled for HIGH/CRITICAL findings,
Reject keeps an explicit gap, errors are assertive, and completion returns focus to the
composer. A `409` triggers a state refresh because another operation already won.
Skill-acquisition cards additionally name the pinned registry commit and bounded
security scan result; rejection or a blocked install leaves an explicit skill gap.

Approval prompts should support:

```text
Approve once
Approve for this task
Approve for this repo policy
Reject
Edit policy
```

## Contextual Loading and Empty States

Loading copy names the operation that is actually pending: reconnecting a stream, loading a
session, waiting for an agent, applying a queued edit, resolving an action, searching
capabilities, or fetching trace. The active conversation stays visible while a scoped region
loads. New users see a simple session rail plus composer prompt; empty drawers explain what
will appear there and do not block chat. Reduced-motion preference disables decorative motion
without removing status text or progress semantics.

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
- Workflow Dashboard (secondary view): diff panel above the pipeline graph.
  Selecting a pipeline node filters to that unit's scope.
- Verify screen (stage 4): full workflow diff summary above the task table.

## Pipeline dashboard (ADR-006)

The workflow dashboard is a secondary view surfaced from the home shell; the default
stage 0 surface remains AI-first Home. The dashboard still lists every registered
workflow. Each card displays repo, task ID, goal, done/total, running/blocked count,
and latest activity. Selecting a card reveals:

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

The Plan Review panel (Stage 2 of the legacy repository workflow surface, not
AI-first Home) is a file-backed plan-markdown review surface with three components:

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
- queued send and edit reconciliation
  - participant add/remove proposal/review/commit and collapse events
- typed quote and reaction changes
- inline approval/capability operation state
- contextual reconnect/loading state
- hook decisions
- skill usage
- diff updates
- verification progress
- (dashboard) selected workflow durable log tail
```

---

**Related:** [Architecture](./ARCHITECTURE.md) · [Workflow](./WORKFLOW.md)
[Edit this page on GitHub](https://github.com/magicpro97/vibeflow/edit/main/docs/WEB_UI_DESIGN.md)
