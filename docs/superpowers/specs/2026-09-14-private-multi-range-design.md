# Multi-file private range picker

## Status

Approved interaction direction: inline picker with multiple files and multiple disjoint ranges.
This document defines the smallest contract and UI change needed to make that interaction real.

## Problem

Home currently stages one `repo_relative_path`, `start_line`, and `end_line` per private-context operation.
That forces users to repeat the flow when one prompt needs several unrelated code blocks, and it cannot
represent ranges from more than one file without replacing earlier context.

## Goals

- Select multiple text files in one private-context draft.
- Select multiple disjoint line ranges per file.
- Keep selections when switching the active preview file.
- Remove one range without changing other selections.
- Attach all selections atomically as one private context for the next message or new conversation.
- Keep Home public state opaque: expose only presence and aggregate counts, never path, line numbers, or content.
- Preserve current path validation, bounded reads, UTF-8 checks, snapshot/change detection, TTL, idempotency,
  cancellation, replacement, discard, and cleanup guarantees.
- Keep old single-range requests readable during migration.

## Non-goals

- Selecting arbitrary text offsets instead of whole lines.
- Mixing repository files with uploaded attachments in one range group. Uploaded text files remain selectable
  as sources only through the existing attachment path boundary.
- Persisting private paths, ranges, or content in the public timeline, Home cache, or browser telemetry.
- Reordering lines or files in the staged payload. Display order is deterministic file insertion order, then
  ascending range order.
- Supporting overlapping ranges. Adjacent ranges are normalized into one range before staging.

## Chosen interaction

The composer button keeps its current location and label semantics, but opens an inline picker.

1. `Files in this attach` shows selected files as tabs/chips. The first file is active.
2. `Add file` adds a valid text source and switches the preview to it.
3. The preview renders bounded, numbered lines.
4. The user clicks the first line and last line of a block. The active block uses a distinct focus color.
5. `Add lines` commits that block to the active file and clears only the in-progress click state.
6. The selected-ranges summary groups committed ranges by file. Each row has an independent remove action.
7. Switching files never clears committed ranges. `Start over` clears every file and range explicitly.
8. `Attach N ranges` is disabled until at least one committed range exists. It stages the complete set once.
9. After success, the summary shows only an opaque state such as `3 private ranges · 2 files`.

Manual path input remains the fallback when no uploaded text attachment exists. In multi-file mode it adds
one repository path as a source; the same preview and range controls apply. Invalid or unsupported files
never enter the selected-file list.

## Data model

Introduce a browser-safe aggregate selection type next to the existing single-range wire type:

```ts
interface ConversationPrivateRangeV2 {
  repo_relative_path: string;
  start_line: number;
  end_line: number;
}

interface ConversationPrivateRangesSelectionV2 {
  ranges: readonly ConversationPrivateRangeV2[];
}
```

The aggregate has these invariants before leaving the browser:

- `ranges.length` is between 1 and the configured aggregate maximum.
- Every range has one canonical repo-relative path and positive safe-integer bounds.
- Every range is at most 200 lines.
- Ranges are sorted by first-seen file order, then start line, then end line.
- Same-file overlapping or adjacent ranges are merged.
- Duplicate ranges disappear.
- The aggregate byte/line budget is bounded independently of each range budget.

The server remains authoritative. It repeats all validation, canonicalizes paths using the existing pinned
read boundary, reads every file under the same repository root, and rejects the complete request if any range
fails. No partial aggregate is staged.

## Wire and storage changes

Add a versioned multi-range request rather than changing the meaning of the existing V1 request:

- `StageConversationMessagePrivateContextRequestV2` extends the private-context envelope with
  `ranges: readonly ConversationPrivateRangeV2[]`.
- `StageConversationDraftPrivateContextRequestV2` uses the same aggregate payload.
- The V1 endpoints and single-range payload remain accepted for compatibility clients.
- The V2 response remains the existing public presence shape plus opaque aggregate counts only where the
  current Home API already exposes presence metadata; it never returns content or locators.

The staging authority stores one aggregate handoff containing ordered range records. Each range record keeps
its own path, bounds, content digest, byte count, and content. The aggregate record has one handoff ID,
record digest, TTL, aggregate digest, range count, and file count. Frame transitions, reservation, consume,
release, replacement, and discard operate on the aggregate handoff as one unit. A failed range read or failed
aggregate append releases nothing prematurely; unknown durability state remains reserved until authoritative
reconciliation, matching current private-context rules.

Use a deterministic aggregate digest over canonical JSON. Never use browser order or display labels as an
identity source. The idempotency key binds the entire aggregate request, so retrying the same attach cannot
create a second private context.

## UI architecture

Keep `HomePrivateRangePanel.vue` as orchestration only. Extract pure state transitions into a browser-safe
module, for example `home-private-range-selection.ts`:

- `addFile`
- `removeFile`
- `selectActiveFile`
- `beginRangeSelection`
- `commitRange`
- `removeRange`
- `mergeRanges`
- `clearSelection`
- `selectionSummary`

`useHomePrivateRangeComposer` owns request lifecycle, active scope, cancellation, focus restoration, and
public error mapping. It converts the pure aggregate into the V2 stage request. Existing stale-result guards
remain mandatory: a late response from a previous root session, composer epoch, or replaced selection cannot
mutate current state.

The component renders:

- selected-file tabs with active state and accessible labels;
- one code preview for the active file;
- first/last-line selection feedback;
- selected ranges grouped by file;
- aggregate count in the attach button and public success announcement;
- inline loading, empty, invalid-range, read, and staging errors.

Keyboard behavior: tab order follows file tabs, preview controls, range rows, then actions; Enter/Space works
for file and range controls; Escape closes the panel; focus returns to the opening composer control. Click-only
selection is not the only path: provide line controls with equivalent keyboard activation and visible focus.

## Error behavior

- Empty aggregate: `Select at least one code range.`
- Invalid line order or bounds: explain the exact active range and leave committed ranges unchanged.
- File read failure: show the existing mapped reason beside the active file; never erase other committed files.
- Aggregate validation failure: show one actionable error and keep the draft selection for correction.
- Staging failure or offline state: keep all selection state and retry with the same UI; do not silently send.
- Replacement: stage the new aggregate first, then discard the prior aggregate only after the new authority is
  confirmed, preserving current replacement safety.
- `Start over`: require no confirmation; it is local draft state and has no server side effect until attach.

## Limits

Use explicit constants in the contract module. Initial values:

- max files per aggregate: 16;
- max ranges per aggregate: 32;
- max lines per range: 200;
- max total selected lines: 1,000;
- max total content bytes: the existing private-context aggregate limit, enforced server-side;
- one active preview window at a time, bounded by the existing 2,000-line/500-line window constants.

If future usage needs larger limits, raise contract and storage limits together with focused resource-boundary
tests. Do not hide oversized requests behind longer timeouts or unbounded reads.

## Migration and compatibility

- Read V1 single-range staged records and consume/discard them unchanged.
- New UI sends V2 only when it has more than one range or more than one file; one range may continue to use
  V1 during the migration window to reduce payload churn.
- Public presence assertions accept both versions but still require exact expected presence.
- Remove V1 write behavior only after all shipped clients use V2 and compatibility tests prove no remaining caller.

## Test plan

Pure selection tests:

- add and switch files without losing ranges;
- commit two disjoint ranges in one file;
- commit ranges in two files;
- merge overlap and adjacency;
- remove one range and preserve all others;
- start over clears all state;
- deterministic ordering and aggregate summary;
- file/range/count/byte limit rejection;
- invalid line click sequence and reset behavior.

UI/composer tests:

- attach button labels and disabled states for zero, one, and many ranges;
- active file preview changes without selection loss;
- stale stage result cannot mutate a changed root/session;
- abort/dispose prevents late mutation;
- keyboard focus, Escape close, and focus restoration;
- public projection contains counts/presence only;
- every mapped server failure keeps editable selection state.

Contract/server tests:

- V2 request exact-key and shape validation;
- canonical path and symlink/traversal rejection for every range;
- invalid UTF-8, binary, changed, missing, and oversized file rejection;
- atomic all-or-nothing staging when one range fails;
- deterministic aggregate digest and idempotent replay;
- reservation/consume/release/discard/replacement crash-recovery behavior;
- V1 compatibility read path;
- aggregate limits and bounded memory.

Run focused tests, then the repository-required `bun run fix`, `bun run check`, `bun run build`, focused UI E2E,
`bun run scripts/refresh-normative-proofs.ts`, `git diff --check`, and `vf verify` before claiming completion.
