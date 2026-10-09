---
title: Web UI Design
description: Design specification for the web UI — AI-first Home surfaces, UX principles, approval flow, and real-time updates.
category: explanation
last_updated: 2026-10-09
---

# Web UI Design

## Contents

- [Purpose](#purpose)
- [Primary Surfaces](#primary-surfaces)
- [UI Principle](#ui-principle)
- [Approval UX](#approval-ux)
- [Contextual Loading and Empty States](#contextual-loading-and-empty-states)
- [Real-Time Updates](#real-time-updates)
- [System One (Jev) Section](#system-one-jev-section)

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
> The control center is the single workspace configuration surface. Open `Control center`
> from the Home top bar to detect a repository, initialize the harness with or without AI,
> initialize an agent, enable or disable CLI engines, toggle Memory/CodeGraph/LSP, inspect
> capabilities and skills, and view configured MCP server names. Harness detection reads the
> existing `/api/detect` contract; settings persist through `/api/settings`; initialization
> uses `/api/init`. The existing Capabilities drawer remains the reviewed install/repair
> surface; the control center links users to it instead of duplicating mutation actions.
> Unchecked engines are not dispatched by control-center init, but their binaries remain
> installed. Empty MCP inventory is an honest state, not a simulated server list.

## Primary surfaces

### 1. AI-first Home

The default surface is the searchable session rail plus the central conversation pane.
It keeps the current conversation visible, shows participant state and live stream
status, and makes new conversation creation obvious. Search filters sessions in place;
selecting a result opens it directly without a resume dialog. The rail collapses to
zero width via its collapse toggle (`.home-rail__collapse`), hiding it with
`aria-hidden=true` so keyboard focus skips it; the toggle restores it.

#### Engine picker

The composer's engine chip (above the message queue) opens a menu with **Auto** plus
one row per installed-or-known CLI: claude, copilot, codex, opencode, antigravity.
- **Auto** probes each CLI's readiness and picks a live engine for the conversation
  (the engine chip shows the resolved pick, e.g. `Engine: Copilot`).
- A concrete pick applies to **new conversations** (the chip reads `localStorage
  vf-engine`; values: `auto | claude | copilot | codex | opencode | antigravity`).
  The currently open conversation keeps its bound engine until it ends.
- A CLI whose binary is missing shows a disabled row with the install hint
  (`agy CLI not found — install the Antigravity CLI …`) and is skipped by Auto.
- The menu re-checks engine binaries when opened; the row subtitle shows `Ready`
  or the probe detail.
- Model selection is not exposed in Home: the engine runs its default/configured
  model (per-role model ranks apply to coordinator roles, not the Home engine picker).

#### Opening a conversation (restore)

Selecting a session in the rail verifies its active head, public trace, and durable
queue before the transcript unlocks. The restore placeholder ("Verifying the active
head …") shows while that read completes; a completed/failed conversation has no live
engine stream, so the transcript renders from the verified timeline alone. Once the
timeline is loaded the composer unlocks (terminal conversations can still be extended
with a follow-up message). A conversation that failed mid-turn shows the terminal
failure in the thread — `[<engine> failed: <reason>]` — instead of a silent empty
"Complete"; the thread keeps the failure notice and state labels (`*Failed*`,
`*Complete*`) in both the rail and the transcript.

#### New conversation button

`+ New conversation` in the rail always returns to the composer on the home surface;
typing the first message creates the conversation with the picked engine. The composer
toolbar (agent, remove participant, attach, mention, private range, capabilities,
engine chip, send) is available before a session exists — the creation flow needs
`+ Agent`, private range, and the engine picker before the first send.

### 2. Composer

The composer is conversation-first, not form-first. It owns the durable FIFO queue, ArrowUp editing for the latest queued human message, private file range capture, typed capability selection, and file attachments. Typing `+`/`-`/`@` (no space) opens a suggestion listbox (agents, participants, commands). Before any conversation exists there are no participants, so a lone `@` or `-` shows a dashed hint — "Chưa có tác nhân để nhắc — thêm bằng nút +Agent trước" — instead of a dead-empty listbox; the hint disappears as soon as a participant exists, and Escape closes suggestions without touching the draft. Sends made while an agent is busy queue automatically. Real-user QA of the composer must exercise token suggestions, attachment upload/remove, private-range source selection, drawer focus/Escape, 320-390px widths, and 200% zoom — asserting a stable composer height, zero horizontal overflow, no console leakage, and a clean aXe pass. ArrowUp starts an edit only for the latest queued human message; Escape cancels, and a lost dispatch/edit race preserves the draft for explicit send-as-new. Typed add-participant actions promote a direct route into coordinate through proposal/review/commit, and removing the last executor collapses it back to direct. Picking a chip from the toolbar or suggestion list always appends a trailing space, so typing after a mention keeps the token separate (the chip never merges with following text); the toolbar menus render through a Teleport so the composer wrap's overflow cannot clip them. Suggestion listboxes also render through a Teleport to `body` as fixed viewport overlays positioned from live composer bounds; this avoids the scrollable timeline stacking context intercepting pointer events. Opening or picking an agent does not add listbox height to form or push conversation upward. Real-user QA must hit-test first option with `elementFromPoint` and perform actual click, not only assert visibility. Mention chips render as bordered, tinted pills colored per kind (`--agent` amber, participant/mention variants) and display the agent label rather than the raw token — no special characters in the visible chip. The draft itself keeps the raw token (e.g. `+web_ui@codex`), so the highlight overlay shows labels while the textarea holds the token; while a token is being edited (backspace/typing), the chip keeps the full label as long as the token is still a prefix of a known agent/participant key, so it never flickers into raw text. The private-range panel offers a git-diff-style preview. By default, attach a text file first, then choose it in the panel's `Private range file` selector; preview reads `.vibeflow/attachments/<name>` through guarded `GET /api/file?preview=1`, and selecting lines stages only requested line window. Images/documents stay excluded because they have no text lines. A visible `Path fallback` remains for repo files not uploaded. Missing previews answer `{ok:false, reason:"not found"}` with HTTP 200, so a mistyped path does not spam the browser console. Numbered lines show around selection; clicking line picks start then end (auto-swapping inverted pair). The Attach button sits in toolbar and is hidden without engine support: claude accepts text (`--append-system-prompt-file`), copilot image+document (`--attachment`), codex image (`--image`), opencode any (`--file`), antigravity none. Auto file dialog accepts union of all engine kinds, then per-file gate picks first capable ready engine or support-matrix fallback while probe runs. Picked files upload through `POST /api/upload`, render removable chips, and delete through `DELETE /api/upload`; argv uses `.vibeflow/attachments/<name>` before prompt (`copilot` flags before `-p`).
## Attachment support matrix

Uploads are stored as `.vibeflow/attachments/<name>`. The UI classifies allowed
extensions into text, image, and document kinds, then projects the repo-relative
path into engine argv. Auto mode accepts the union of supported kinds, chooses a
ready capable engine for one file, and keeps one engine capable of every selected
kind for mixed files. Mixed image + text uses OpenCode when available. Readiness
gates dispatch, not picker visibility. Private ranges require text: select an
uploaded text file from `Private range file`, preview numbered lines, select the
range, and stage `VF-PRIVATE-FILE-RANGES/1`; `Path` remains explicit fallback for
repo files not uploaded. Image/document attachments cannot provide line ranges.

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

## System One (Jev) section

The Home Control Center drawer carries one **System One (Jev)** section, labelled
*Optional decision judge*, for the optional TypeSafe judge. It is always rendered (it is
the on-demand disclosure surface) and it renders these states in priority order, so the
most consequential one wins:

1. **loading** - `Loading System One settings...`, `role="status"`, `aria-busy="true"`;
2. **view request failed** - `System One connection failed - <error>`, `role="alert"`;
3. **unconfigured** - `No System One key configured - key missing: set the environment
   variable or run vf config typesafe key`;
4. **breaker open** - `Circuit open - judge calls are paused until <cooldownUntil>`,
   `role="alert"`;
5. **otherwise** - the read-only list below.

The read-only list is `enabled`, `configured`, `state` (carrying a `data-state`
attribute), `key source`, `model`, `timeout`, and `last call` (caller, status, ms) when a
call has been recorded. The controls are the enable toggle, the two confidence thresholds
(`Run judge at confidence`, `Accept verdict at confidence`, both `0..1` step `0.05` with
an inline threshold error), a toggle per call site with a one-line description of what
that site does, **Test connection** in the section heading, and a save button. The breaker
tuning numbers (`failStreakLimit`, `cooldownBaseMs`, `cooldownCapMs`, `hookTimeoutMs`,
`hookBusLockRetries`) are settings-only: they are visible in `vf config typesafe status`
and in the DOM-less settings view, not as UI fields.

`settingsView` returns a redacted `typesafe` object: `enabled`, `configured`, `state`,
`keySource`, `model`, `timeoutMs`, and `lastCall`. **The API key is never part of the
response**, so it can never reach the DOM; the section states that the key stays on the
machine. The one-line note at the top of the section carries the authority rule, in
product language: the judge can only reject a change sooner or raise a risk tier; it never
opens a gate or skips a review, and it can only suggest an engine from the pool preflight
already admitted.

## 12. Orca-native transcript affordances (#830)

Conversation Home keeps the transcript calm with seven Orca-native affordances:

**Tool groups**: consecutive `tool_action` items in a transcript collapse into a
single `<details>` batch instead of one row per action. A lone tool action stays
an ordinary row, unchanged. The collapsed summary reports how many tool actions
ran and the statuses present, with the distinct tool names listed in the group
body, so a folded batch still says what ran and whether it succeeded.

**Turn timers**: while an assistant turn streams, a live `Working · 0m 05s`
timer renders in the assistant message header; on completion it freezes to
`Worked for 0m 05s` (durations past an hour render as `1h 05m`). Both are
computed from the item timestamps the transcript already carries, so a reload
reconstructs the same durations.

**Collapsed answers**: a completed assistant answer of at least 600 characters
that is not the conversation tail — an answer a later user message has already
superseded, with tool or boundary rows ignored — collapses behind a
`Show full answer` / `Show less` toggle with the opening excerpt visible. Short
answers, the streaming turn, and the tail answer render in full.

**Attention dots**: a session that transitions into a terminal lifecycle state
while it is not the active session gets a dot in the session rail. Dots are
persisted by session id under the `vf-attention` localStorage key and clear when
the session is opened.

**Prompt rail**: when a transcript holds at least two anchored user prompts, jump
ticks render at the top of the transcript, one per prompt. Clicking a tick scrolls
the prompt into view and moves focus to it.

**Agent panel**: the panel above the transcript lists every AI participant with its live
state from the same rendered projection as the transcript, sorted working agents first
and completed agents last, with a count line that summarizes running and done agents.
Each row carries the agent's latest action and a ticking clock while that agent works,
and the clock freezes when the agent completes. Clicking a row opens the agent drawer
for that participant.

**Agent drawer**: the drawer lists one agent's public activity — its tool actions and
assistant answers in timeline order. Each row carries its time, a kind icon, a truncated
body of at most 200 characters, and a status pill for tool rows. The last row also
reports the agent's state — `Working`, `Complete`, or `Failed` — so the drawer and the
panel agree; × or Escape closes it and returns focus to the panel.

## 13. Resources drawer

The TopBar `Open resources` button opens a repo-scoped drawer — an
`<aside aria-label="Resources">`, not conversation-scoped — that reads
`GET /api/resources`, the same `ResourceSnapshot` that `vf resources --json` prints.
The drawer refetches when it opens and then polls every 10 seconds while open; a
transient fetch failure keeps the last snapshot on screen instead of blanking the
drawer.

Sections, in order:

- **Totals** — one summary line over the ledger totals (`done/units` done, tokens, cost,
  wall seconds).
- **Per engine** — one row per engine rollup: units, tokens, cost.
- **Top units** — the eight most expensive units by cost, each with tokens and cost.
- **Quota** — one row per probed engine. Appears **only when probe data is present**
  (`vf resources --probe`); a plain snapshot carries an empty `quota` array, so the
  section is absent rather than empty.
- **Warnings** — units with no recorded resources plus quota states at the warning,
  exhausted, or rate-limited level;
  hidden when the list is empty.

Until a snapshot arrives the drawer shows `No workflow state yet.` — shown when the repo
has no workflow state (and until the first successful fetch).

---

**Related:** [Architecture](./ARCHITECTURE.md) · [Workflow](./WORKFLOW.md)
[Edit this page on GitHub](https://github.com/magicpro97/vibeflow/edit/main/docs/WEB_UI_DESIGN.md)
