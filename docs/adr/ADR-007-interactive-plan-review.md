# ADR-007: Interactive Plan Review — file-backed plan revisions with safe block rendering

## Status

Accepted (PR1). Threaded comments, dispatch gate, and AI replan deferred to PR2/PR3.

## Context

After orchestration produces a plan (work-unit decomposition, scopes, dependencies), the operator needs a lightweight review surface before dispatch. No persistent plan-revision store existed — the plan was ephemeral in the intake wizard. Requirements:

- Plan markdown must be stored immutably per revision so reviewers reference a fixed artifact.
- Block-level anchors are needed for future threaded comments (PR2).
- Mermaid diagram source must be preserved without requiring a runtime Mermaid renderer (no JS dependency, no CDN).
- Render output must be safe by construction — no `v-html`, no unescaped user content.
- API must enforce scope caps to prevent unbounded store growth.

## Decision

### 1. File-backed immutable revision/index store

`.vibeflow/plan-review/` holds two artifact types:

- `index.json` — workflow-scoped pointer: `workflowId`, `currentRevisionId`, `acceptedRevisionId?`, `updatedAt`.
- `revisions/<uuid>.json` — write-once revision files: `id`, `workflowId`, `parentId?`, `markdown`, `blocks[]`, `createdAt`, `createdBy`, `status`.

`createRevision()` validates: workflowId non-empty, parent exists (if provided), parent workflowId matches, index workflowId is consistent (or creates first entry). Once written, a revision file is never mutated — the next revision gets a new UUID. `status` tracks lifecycle (`draft` | `accepted` | `superseded`) but PR1 provides no automated status transitions.

See `src/plan-review/store.ts`, `src/plan-review/types.ts`.

### 2. Safe semantic Markdown block renderer

The UI never renders raw markdown HTML. Instead, markdown is parsed server-side into typed blocks (`heading`, `paragraph`, `list-run`, `fenced-code`, `fenced-mermaid`), then the client `plan-render.ts` maps these to typed `RenderDescriptor` objects with HTML-escaped text (`esc()` replaces `&<>"'`). Vue templates use `{{ }}` interpolation only — no `v-html`.

See `src/ui/src/lib/plan-render.ts`, `src/ui/src/components/PlanCanvas.vue`.

### 3. Explicit and derived block anchors

Two anchor modes:

- **Derived** (no markers in source): `deriveBlockId(type, content, ordinal)` produces a deterministic SHA-256 hex ID. `insertMarkers()` inserts derived `<!-- vf:block:<id> -->` comments at unmarked block boundaries.
- **Explicit** (user-supplied markers carry over): pre-existing `<!-- vf:block:<id> -->` comments in the markdown source are preserved as canonical IDs. `parseMarkers()` extracts them; `resolveNearestBlock()` finds a block by line number (containing or nearest-center fallback).

See `src/plan-review/blocks.ts`, `src/ui/src/lib/plan-anchor.ts`.

### 4. Mermaid source fallback — no runtime dependency

`fenced-mermaid` blocks render a `MermaidFallback` descriptor with `reason` (`"no-engine"` | `"too-large"`) and the raw source text. The UI displays the reason label and a `<pre><code>` block. No mermaid JS runtime is loaded, keeping the page dependency-free and same-origin secure.

See `src/ui/src/lib/plan-render.ts`. Cap: `MAX_MERMAID_BYTES = 32 × 1024`.

### 5. Selection anchor groundwork (PR2 prep)

`BlockAnchor` interface carries `blockId`, `quote` (selected text), and `range` (start/end offsets). `buildBlockAnchor()` constructs one; `handleAnchorKeydown()` emits on Enter/Space for keyboard users. PlanCanvas emits anchors on mouseup text selection or via the "Comment" button. The PlanRevisionRail shows the anchor and stamps "Comment storage not implemented". Threaded comment storage is PR2.

See `src/ui/src/lib/plan-anchor.ts`, `src/ui/src/components/PlanCanvas.vue`, `src/ui/src/components/PlanRevisionRail.vue`.

### 6. API routes

| Method | Path | Handler | Guard |
|--------|------|---------|-------|
| GET | `/api/plan-review?repoPath=&workflowId=` | `handlePlanReviewGet()` — returns `{index, revision, blocks}` | CSRF (guarded) |
| POST | `/api/plan-review/revisions` | `handlePlanReviewPost()` — validates + parses + stores | CSRF (`handleMutationRoute`) |

Both validate: repoPath via registry lookup, workflowId via state.task_id match, createdBy shape (type `"user" | "agent"`, id/name non-empty). POST additionally validates markdown non-empty.

See `src/server/plan-review.ts`, registered in `src/server/routes.ts` (POST) and `src/server.ts` (GET).

### 7. Scope and security caps

| Cap | Value | Location |
|-----|-------|----------|
| Blocks per revision | 1,000 | `MAX_BLOCKS_PER_REVISION` |
| Markdown total (UTF-8 bytes) | 1,000,000 | `MAX_MARKDOWN_LENGTH` |
| Per-block content (UTF-8 bytes) | 100,000 | `MAX_BLOCK_CONTENT_LENGTH` |
| Block ID length | 64 chars | `MAX_BLOCK_ID_LENGTH` |
| Revision ID length | 64 chars | `MAX_REVISION_ID_LENGTH` |
| Block ID format | `/^[A-Fa-f0-9-]{1,64}$/` | `isValidBlockId()` |
| Revision ID format | UUID v4 | `isValidRevisionId()` |
| createdBy discriminator | `"user"` or `"agent"` | `CreatedBy` union |

`assertCap()` throws on overflow. `assertInputValid()` guards all create inputs. `assertValidBlockId()` / `assertValidRevisionId()` provide branded type narrowing. Workflow consistency: index.workflowId must match revision.workflowId on create.

## Consequences

Positive:
- Plan revisions are persistent, immutable, and individually addressable by UUID.
- Block rendering is safe by construction — no HTML injection surface.
- Mermaid source is preserved without a runtime dependency.
- Selection anchors are primed for threaded comments (PR2) without re-architecture.
- API is capped and validated at every trust boundary.

Negative:
- No threaded comment storage (PR2) — the groundwork exists but comments are not persisted.
- No dispatch gate (PR2) — plan review is read-only; acceptance does not gate dispatch.
- No AI replan pipeline (PR3) — the orchestrator does not consume plan-review output to regenerate plans.
- No revision diff — comparing two plan revisions is not implemented.

## Deferred

| Feature | PR | Status |
|---------|----|--------|
| Threaded comment storage | PR2 | Groundwork done (BlockAnchor, UI anchor emission) |
| Dispatch gate (accept plan before dispatch) | PR2 | `status: "accepted"` exists unutilized |
| AI replan from review feedback | PR3 | Not started |

## Related

- `src/plan-review/` — store, blocks, types
- `src/server/plan-review.ts` — GET/POST handlers
- `src/ui/src/lib/plan-render.ts` — safe renderer
- `src/ui/src/lib/plan-anchor.ts` — selection anchors
- `src/ui/src/components/PlanReview.vue` — parent component
- `src/ui/src/components/PlanCanvas.vue` — block display
- `src/ui/src/components/PlanRevisionRail.vue` — revision list + anchor display
