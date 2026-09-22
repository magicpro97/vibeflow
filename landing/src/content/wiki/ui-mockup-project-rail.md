---
title: Rail Redesign for Project-Grouped Conversations
description: Approved design spec for project-grouped conversation folders, the suggestion chip, and the project classification settings panel.
category: explanation
last_updated: 2026-09-22
---

# Rail redesign — project-grouped conversations (Task 5 Step 0, design only)

**Surface profile:** App / Product UI (B3) + Dashboard density (B2) for the settings table.
Engine: existing `home.css` token layer (Hanken Grotesk, warm paper palette). No new dependency.

**Concept:** *a paper card index.* Projects are tabbed dividers in a warm ledger; each divider
carries a name, a hairline rule, and a muted count; conversations are entries filed under the
nearest tab. Expressed through: layout (indented entries under a full-width divider), type
(name 0.72rem/650 uppercase-tracked vs entry title 0.78rem/610 sentence case — the divider is
*quieter and smaller* than the content, unlike every project-header-in-bold reflex), color
(dividers stay neutral ink; ONLY the `Ideas` divider tints amber), motion (unfiled→filed
entries slide 8px and fade on confirm).

**Category-reflex check:** the guessable move is "bold caps header + colored folder emoji".
Rejected: no emoji icons, no per-group accent hues, no disclosure chevrons-in-circles. Counts
are muted numerals, not badges — the rail stays a list, not a dashboard.

---

## 1. Token deltas (append to `home.css :root`, and both dark blocks)

Nothing hardcodes a value; all of these are derived from existing tokens.

| Token | Light | Dark (`prefers-color-scheme` / `[data-color-scheme=dark]`) | Role |
|---|---|---|---|
| `--rail-group-rule` | `var(--home-line)` | `var(--home-line)` | 1px divider under group header |
| `--rail-group-name` | `var(--home-ink)` | `var(--home-ink)` | divider label |
| `--rail-group-goal` | `var(--home-muted)` | `var(--home-muted)` | goal excerpt |
| `--rail-group-count` | `var(--home-muted)` | `var(--home-muted)` | "3" count (dark uses muted, NOT faint: faint = 4.08:1, fails AA) |
| `--rail-group-ideas-ink` | `var(--home-amber-ink)` `#7f451f` | `var(--home-amber)` `#d98a4a` | `Ideas` divider only |
| `--rail-group-ideas-wash` | `var(--home-tone-warm-panel)` | `var(--home-tone-warm-panel)` | `Ideas` divider 1.15:1 wash |
| `--rail-entry-indent` | `0.5rem` | — | entries sit inboard of the divider |
| `--rail-chip-bg` | `var(--home-amber-soft)` | `var(--home-amber-soft)` | suggestion chip fill |
| `--rail-chip-border` | `var(--home-amber)` `#9c4d18` | `var(--home-amber)` `#d98a4a` | 1px chip outline (5.76:1 / 5.08:1 vs paper) |
| `--rail-chip-ink` | `var(--home-ink)` | `var(--home-ink)` | chip sentence |
| `--rail-chip-action` | `#fffefa` on `var(--home-amber)` | `var(--home-ink)` `#29251f` on `#d98a4a` | confirm button (5.97:1 / 5.57:1) |
| `--rail-chip-ghost` | `var(--home-muted)` | `var(--home-muted)` | dismiss text (4.49:1 / 4.58:1 on amber-soft) |
| `--rail-chip-shadow` | `var(--home-shadow)` scaled to `0 6px 18px rgb(58 47 33 / 0.10)` | `0 6px 18px rgb(0 0 0 / 0.35)` | it floats above the composer |

**Spacing scale** (multiples of the existing 0.25rem rhythm — no new unit):

| Step | Value | Used for |
|---|---|---|
| `xs` | 0.15rem | divider ↔ first entry |
| `sm` | 0.3rem | goal line ↔ name; chip sentence ↔ actions |
| `md` | 0.55rem | between groups (after last entry of a group) |
| `lg` | 0.75rem | rail top padding ↔ first group |
| `xl` | 1rem | rail list bottom padding (unchanged) |

**Type scale used** (existing steps only, no one-offs):

| Role | Size / weight / tracking | Contrast (light / dark) |
|---|---|---|
| Group name | 0.68rem / 650 / 0.06em uppercase | 12.34 / 12.21 |
| Group goal excerpt | 0.64rem / 500, 1 line, ellipsis | 4.71 / 5.42 |
| Group count | 0.62rem / 600 tabular | 5.65 / 5.42 |
| Entry title (unchanged) | 0.78rem / 610 | 9.97 / 9.55 |
| Chip sentence | 0.74rem / 600 | 10.31 (dark-on-amber-soft) / 13.56 |
| Chip button | 0.68rem / 650 | ≥5.5:1 both themes |

Every pair above was computed, not eyeballed (WCAG AA ≥4.5:1; the group *rule* is decorative,
not a UI boundary — separation comes from the label + spacing, so its 1.2:1 is fine).

---

## 2. Folder-grouped rail — mockup

Ordering: groups are ordered by their newest entry (`sort_updated_at` desc), ties broken by
project name; **`Ideas` always last** (it is a catch-all, not a peer). Sessions keep catalog
order (`sort_updated_at` desc) *inside* each group — the group never re-sorts entries.

```
┌─ Conversations grouped by project ────────────────┐
│  [+ New conversation]                        [ ‹ ]│
│  [ Search conversations…                ]         │
│                                                   │
│  VIBEFLOW-HERMES-EXECUTION              3    ▾    │   ← divider (0.68rem, tracked)
│  Complete Draft v7 brainstorming…                 │   ← goal excerpt, 1 line
│  ├─────────────────────────────────────────────┤   ← --rail-group-rule
│     ▌Draft v7 debate round 2              12m     │   ← entry (unchanged markup)
│      ● ACTIVE · 4 rev                             │
│      Fix SSE reconnect ordering            2h     │
│      ○ COMPLETED · 2 rev                          │
│                                                   │
│  VIBEFLOW-V0.15                                  │   ← goal empty → divider is single-line
│  ├─────────────────────────────────────────────┤
│      Polish orchestrate gate               1d     │
│                                                   │
│  IDEAS                                      4  ▸  │   ← amber, collapsed
│  ├─────────────────────────────────────────────┤
│                                                   │
│  ● Local runtime connected                        │
└───────────────────────────────────────────────────┘
```

Rules:
- **Divider is a button** (collapse/expand), sticky at the top of its scroll segment
  (`position: sticky; top: 0; background: var(--home-panel)`), because the rail scrolls as one
  list — sticky dividers are what make grouping legible at 18rem width.
- **Count = visible sessions in that group.** Hidden when 0 (collapsed) → show count always, it
  is the collapsed affordance; Omit when the group is empty and therefore not rendered.
- **Divider state:** default / hover (`--rail-group-rule` → `--home-line-strong`, label → ink) /
  focus-visible (existing ring) / collapsed (glyph `▸`, entries `hidden`). Selection is never
  conveyed on the divider; the active session keeps `--home-session--active` on its own row.
- **Groups with zero sessions are not rendered** (registry may hold up to 256 projects — an
  empty group is a dead row). With an empty registry the rail degrades to exactly today's flat
  list under a single `Ideas` divider; that is the default state, not an edge case.
- **Search:** groups with no match collapse out; matching groups auto-expand during a query and
  restore their prior collapsed state when the query clears. Zero matches keeps today's
  "No matches" rail state.
- **Loading:** 2 skeleton dividers (hairline + 22px bar) + 5 skeleton entries, same shapes as
  `home-loading-rail`, so nothing shifts when data lands (CLS ≈ 0).
- **No new icon set.** The collapse glyph is a text/`svg` chevron consistent with
  `.home-rail__collapse`; no emoji, no Lucide.

---

## 3. Suggestion chip — placement, states, keyboard

**Placement.** A sibling of `<form class="home-composer">` inside `.home-composer-wrap`, placed
*after* the form in DOM but rendered *above* it with `order: -1` (the wrap is already a grid with
`align-content: start`). Consequences, all deliberate:
- It never interrupts typing — the textarea stays the first focus stop in the wrap.
- It reads as the newest event in the composer column, above the queue/quote stacks.
- It is a floating element: `position: relative` inside the wrap (not `fixed`), so it never
  collides with the viewport; the wrap already owns `max-height` + `overflow-y: auto`, so a tall
  chip can never be clipped off-screen.

```
        ┌──────────────────────────────────────────────┐
        │ → Move to vibeflow-hermes-execution?         │   ← --rail-chip-bg, 1px amber
        │   [ Move ]   [ Keep in Ideas ]               │
        └──────────────────────────────────────────────┘
                     ↕ 0.55rem
   ┌──────────────────────────────────────────────────────┐
   │  Message                                             │
   │  [ textarea …                                        │
   └──────────────────────────────────────────────────────┘
```

No-match variant (project creation suggested):

```
        ┌──────────────────────────────────────────────┐
        │ Tạo project mới "hermes-retry"?              │
        │   [ Tạo ]   [ Bỏ qua ]                       │
        └──────────────────────────────────────────────┘
```

Strings are verbatim from the brief for the confirm/no-match cases; the dismiss label is
`Keep in Ideas` (confirms the outcome, not "No" — "No" would read as rejecting the message).

**When it appears at all.** Only when the classifier result is *proposable and uncertain*:

| Classifier outcome | Rail behaviour |
|---|---|
| tier `repo` / `mention` (exact, confidence 1) | **no chip** — the conversation was already bound deterministically at creation |
| tier `fts` confident (score > 30 and margin > 10) | chip, `--rail-chip-*` default |
| tier `ai` ≥ 0.6 | chip, with `· 72% chắc chắn` trail in `--rail-group-goal` |
| tier `ai` < 0.6, FTS near-tie, fallback | **nothing.** No chip, no toast, no log line in the UI |

That table is the whole "MUST NOT auto-move on low confidence" contract: nothing under the
acceptance floor ever renders a control that moves a conversation, and confirming is always an
explicit click/keypress.

**States.**

| State | Visual | Behaviour |
|---|---|---|
| `hidden` | not rendered | no live proposal for the active session |
| `pending` | fill + amber hairline + shadow | buttons enabled |
| `committing` | confirm button label → `Moving…` + inline spinner, both buttons disabled | single in-flight move per session; a second send queues a new proposal behind it |
| `confirmed` | chip leaves; rail row relocates to the target divider with the 8px/fade enter (140ms, `ease-out`, transform+opacity only) | toast `Đã chuyển sang {name}` with `Undo` (5s) — Undo is the guaranteed reversal, not the animation |
| `dismissed` | chip leaves, no toast | dismissal remembered per `(root_session_id, project_id)`; the same proposal never re-renders. A later *higher* tier (repo/mention) for the same session clears the memory |
| `error` | chip stays; sentence swapped to `Không chuyển được: {reason}` in `--home-red`, buttons re-enabled | reason is the sanitized server message; no fake success |

Also: one chip at a time in the composer column; while a message is queued/streaming the chip is
suppressed (the send is still settling) and re-evaluated when the turn completes.

**Keyboard + announce.**
- Live region: `<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">` carries
  `Đề xuất project: {name}. Nhấn Tab để chuyển.` Focus is **never** stolen from the textarea.
- The chip is a `role="group"` with `aria-label="Project suggestion"`; Tab order: confirm button,
  then dismiss. Enter/Space activate (native buttons). `Esc` while focus is inside the chip
  dismisses it and returns focus to the textarea.
- No global hotkey is invented (the composer already claims ↑/↓/Enter/Tab for its suggestion
  listbox — a new chord would collide). `aria-keyshortcuts` is deliberately omitted.
- `role="status"` wrapper is the same element that already exists in `HomeComposerStatus.vue`;
  the chip reuses it rather than adding a second live region.
- Reduced motion: relocation is instant, content fully visible.
- Pointer: all targets ≥28px tall (rail is a desktop-dominant surface, mouse+keyboard; the chip
  buttons use the existing `.home-button` minimum), cursor pointer, `:focus-visible` ring only.

---

## 4. Settings layout

Two surfaces, one authority — no duplicated controls:
- **`ProjectSettingsPanel.vue`** (mounted by `HomePreferencesDrawer.vue`) hosts a `Project
  classification` fieldset: the global switch and the global engine.
- **Per-project overrides** live in the same fieldset, one collapsible row per registry project,
  because the registry is unbounded (256) and the drawer is scrollable.

```
┌ Project classification ──────────────────┐
│ Tier ladder: repo → @mention →            │
│ index → AI (chỉ khi mơ hồ)                │
│  [x] Auto-classify new conversations      │   ← global switch; OFF ⇒ classifier never runs,
│      no chip, everything stays in Ideas   │
│                                          │
│  Global engine                           │
│   CLI      [ Auto (recommended)  ▾ ]     │
│   Model    [ engine default       ]      │
│   Thinking [ low ▾ ] medium high xhigh   │
│                                          │
│  Per-project engine override (1)       ▸ │   ← collapsed; header shows overridden count
│   ┌ vibeflow-hermes-execution  [inherit] │   ← empty = inherit (placeholder, not "None")
│   │  CLI [ codex ▾ ]  Model [ gpt-x ]    │
│   │  Thinking [ high ▾ ]                 │
│   └ vibeflow-v0.15            [inherit]  │
│      CLI [ — ]  Model [ — ]  Thinking [—]│   ← placeholders mirror "Theo mặc định"
│                                          │
│              [ Save project settings ]   │
└──────────────────────────────────────────┘
```

- Row: the project `name` (or `id`) as an emphasized leading label beside three controls (CLI /
  model / thinking); the disclosure is one shared `Per-project engine override ({n})` button
  (`aria-expanded`, `aria-controls`) that collapses every row at once — rows are plain `<div>`s,
  not per-row buttons.
- **Inherit is the empty state**, shown as a placeholder `Theo mặc định` — never a literal
  "none"/"null" option and never a fake value. An override only persists when the user types one.
- Thinking is a bounded text input with a datalist (`low|medium|high|xhigh|max`) because the
  engine vocabulary differs per CLI (`PROJECT_THINKING_MAX_LENGTH` — the backend deliberately
  does not close the set). No `<select>` that would reject a value a CLI accepts.
- CLI is the closed set from the engine contract; model stays free text (same reason).
- States (as built): no loading branch — `onMounted` awaits `loadSettings()` before `seedDraft`, so
  the fields appear seeded and never flash an empty value; a load failure lands in the same alert
  paragraph as a save failure (inline `<p role="alert">` under the fieldset, no separate banner and
  no Retry control); save → the button disables and reads `Saving…`, then an inline
  `<p role="status">Saved</p>` appears (no toast); **failed save keeps the form values** and shows
  the reason in that alert paragraph (never a silent revert).
- Disabled-with-reason: with auto-classify OFF, the engine rows stay enabled (they are stored
  config; the CLI is applied when classification is next enabled, while model/thinking are stored
  for a future dispatch surface — see §8.6) but carry a muted note
  `Không dùng khi tự động phân loại đang tắt`.

---

## 5. A11y patterns

| Element | Pattern |
|---|---|
| Rail nav | `<nav class="home-session-list" aria-label="Conversations grouped by project">` — label updated; `aria-label="Recent conversations"` retires |
| Group | `<div role="group" aria-labelledby="rail-group-{id}">`, one per rendered project |
| Group name | `<h3 id="rail-group-{id}" class="home-session-group__name">` — real heading, so screen-reader heading navigation walks the projects; contains `<span class="sr-only">, {n} conversations</span>` so the count is announced without a badge |
| Goal excerpt | `aria-describedby` on the group, or plain text inside the h3's sibling — kept out of the accessible name so the name stays short |
| Divider control | `<button aria-expanded="true|false" aria-controls="rail-entries-{id}">`; glyph is `aria-hidden`; `title` mirrors the label |
| Entries list | `<div id="rail-entries-{id}" role="list">` with a `role="listitem"` wrapper around each row — role added because the rows are `<button>`, not `<li>`, and `listitem` is not an allowed role on `<button>`; keeps VoiceOver's count ("4 items") |
| Active session | `aria-current="page"` unchanged on the entry button |
| Roving tabindex | one entry has `tabindex="0"` (the focused one, else the active session, else the first visible); the rest `-1`, so Tab leaves the rail instead of walking every conversation |
| Arrow keys | `ArrowDown`/`ArrowUp` = next/previous **visible entry**, crossing group boundaries and skipping collapsed groups and dividers; `Home`/`End` = first/last visible entry; `ArrowLeft`/`ArrowRight` = collapse/expand the focused entry's group (divider takes focus when it collapses around a focused entry); `Enter`/`Space` = open. This traversal is **new in this implementation** — the pre-grouping rail was a flat list of buttons with no arrow handling at all |
| Chip | `role="group" aria-label="Project suggestion"`; announce via the existing polite live region; no focus steal; `Esc` dismisses |
| Settings | existing drawer semantics kept. The fieldset uses `<fieldset><legend>`; the auto-classify switch is a real `<input type="checkbox">`; the override rows are plain `<div>`s, and the disclosure is one shared `<button aria-expanded aria-controls>`; saving announces through an inline `<p role="status">Saved</p>` (no toast) |
| Zoom / text scale | 18rem rail keeps `--home-rail-width`; labels wrap-free via ellipsis, never truncating to an unreadable width; groups reflow at 200% zoom by stacking name over count |
| Motion | 140ms chip enter + 8px row slide; all `transform`/`opacity`; instant under `prefers-reduced-motion` |

---

## 6. Known limitations (state in the design doc, verbatim)

> **Known limitations — project grouping.**
> 1. **Unassigned conversations are rare by construction.** `repo_root` defaults to the process
>    working directory, so it is never empty; the classifier's `repo` tier therefore resolves a
>    project for almost every conversation created inside a registered repo. The `Ideas`
>    (unclassified) group consequently holds mostly conversations started outside any registered
>    repo, or created before the project registry existed. Its emptiness is the expected state,
>    not a bug.
> 2. **Same-basename clones may merge visually.** Grouping is derived from `repo_root` and
>    `repos[]`; two checkouts of the same upstream (e.g. `~/work/api` and `~/work/api-fork`) can
>    be classified into the same project when their basename/FTS evidence matches, so their
>    conversations appear under one divider even though they are distinct working trees. The
>    rail shows grouping, not provenance — open a conversation to confirm its actual repo.
> 3. Group membership is a *suggestion surface*: dismissing a chip is remembered per
>    (session, project), and an explicit re-send can surface a new proposal. Nothing in the rail
>    moves a conversation without a confirmed chip (or an exact `repo`/`mention` match at
>    creation time).

---

## 7. Adversarial pass (what was cut, and why)

- **Cut:** per-group accent hues, folder emoji, a "New project" button per divider, drag-to-file,
  a group-level engine badge on the divider. Each added a control the brief did not ask for;
  the engine override lives in settings where it is editable.
- **Weakest part, fixed:** the first draft made the divider the boldest text in the rail, which
  made an 18rem column read as a stack of shouting labels. Inverted it — dividers are *smaller*
  and more tracked than entries, and only `Ideas` is tinted.
- **Verified numerically:** every text pair ≥4.49:1; dark-mode count uses `--home-muted` because
  `--home-faint` on `#242428` computes to 4.08:1 and would fail AA.
- **Not verified visually:** no browser render was taken; layout claims (sticky divider overlap,
  200%-zoom reflow) are built-to-target, not screenshot-confirmed.

**Deliverable:** design + tokens only. No source files touched.

---

## 8. Implementation amendments (Task 5 Step 1+)

Six things the implementation settled differently, all recorded here so the design doc and the
code agree:
1. **No create variant.** The classifier's acceptance path (`project-classifier-authority.ts`)
   only returns *registered* project ids, so the `Tạo project mới` branch could never be reached
   with a real proposal — it was a control with no backend. Cut (YAGNI); the chip offers a move
   into a registered project only.
2. **No Undo.** The `confirmed` toast's `Undo` was cut with it: the server has no durable
   "move back" either, so an Undo would have been an affordance that cannot keep its promise. A
   second confirmed move is the reversal, and the announcement names the target
   (`Đã chuyển sang {name}`).
3. **One live region, as designed.** The chip's announcement goes through the composer's existing
   polite region (`HomeComposerStatus.vue`) via the store; it adds no `role="status"` element of
   its own — that part of §3 is honoured rather than merely sketched.
4. **Group name is the divider's accessible name.** `<h3>` cannot nest inside `<button>` (button
   takes phrasing content), so the heading is a *sibling* inside a `.home-session-group__header`
   row and the divider carries `aria-labelledby` pointing at it. Same reading order, valid content
   model. The chip is after the form in DOM with `order: -1`, as §3 specified.
5. **Create-time binding is real.** `resolveConversationProjectId` runs the deterministic
   (`repo`/`mention`) tiers at manifest materialization, so the "already bound at creation"
   premise in §6's limitations is code, not a claim. The inferred tiers (`fts`/`ai`) stay out of
   creation and remain confirmable proposals.
6. **The engine is applied; model/thinking are stored, not yet applied.** Of the three engine
   fields, only `cli` has a consumer: `resolveProjectClassificationEngine` produces it and the
   classifier's AI seam forwards it into `runOwnedAiRoute`. `model` and `thinking` are validated,
   bounded (`PROJECT_MODEL_MAX_LENGTH` / `PROJECT_THINKING_MAX_LENGTH`), persisted, and
   round-tripped to the server, but **no dispatch surface consumes them** — the owned-AI-route
   request carries no such fields, and there is no in-repo authority that maps a reasoning label
   to a CLI flag (`project-types.ts` says so explicitly). They are stored now so the settings
   document does not have to change shape when a consumer arrives; that consumer is the seam.
   §4's engine rows and the panel's two labeled inputs carry a note saying exactly this.

---

## Approval record

**Approved by user (2026-09-21).** Interactive HTML mockup reviewed at `http://127.0.0.1:8899/ui-mockup-project-rail.html` (served from `docs/ui-mockup-project-rail.html`). Design gate passed → Task 5 Steps 1+ may implement per this mockup. Known limitations box included as designed.
