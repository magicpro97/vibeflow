# ADR-009: Named projects and four-tier conversation classification

## Status

Accepted (2026-09-22)

## Context

Conversations are already grouped for the user, but the grouping key was `repo_root`: the
working directory a conversation was created in. That key is a filesystem fact, not an
identity. It cannot be named, cannot hold a goal or context, cannot span two checkouts of the
same product, and cannot carry an engine preference. The `vf ui` rail consequently renders one
flat list of sessions, and nothing in the runtime can answer "which body of work does this
conversation belong to?" with a value that survives a folder move.

Two constraints shaped every decision below.

First, **classification must not spend a model call by default.** Sorting a message into a
filing folder is a retrieval problem; the repository a conversation is opened in, or an
`@project` mention, already answers it exactly. A classifier that consults a model first would
add latency and cost to every send, and would make the same message classify differently on two
runs.

Second, **the surface is the rail, not a console.** Projects exist so the web workspace can draw
dividers and offer a confirmed move. A CLI CRUD surface would be a second, weaker way to edit
the same document, and the deletion/rename semantics a CLI needs (what happens to conversations
filed under a deleted project?) are not designed yet.

`Project` is also durable state: it crosses the security boundary as a public label, and it is
written by the server process, so its storage must survive a crash or a concurrent writer
without a half-written registry.

## Decision

### 1. A project is a named entity in a per-repo file registry, not a derived path

`ProjectV1` is `{ id, name, goal, context, repos[], engine { cli, model, thinking }, created_at }`,
stored as one private JSON document per repository root:

```text
<repoRoot>/.vibeflow/projects/registry.json   # document
<repoRoot>/.vibeflow/projects/registry.lock   # write lock
```

The store (`project-registry-store.ts`) writes the whole document through a process lock plus an
atomic stage-then-rename compare-and-swap, and callers hand it a **mutator** rather than a
computed list, so the compare-and-swap preimage and its payload come from one lock-scoped read.
An absent document reads as the empty registry; a present-but-corrupt one raises
`ProjectRegistryCorruptError` instead of silently resetting a user's projects.

The registry root is repo-local, matching `.vibeflow/conversation`, so two checkouts never share
a project list and no global path can collide with a machine-wide config file. Bounds are
explicit: 256 projects, 64 repos per project, 4 MiB document, name 160 chars, goal 4 000,
context 16 000, one repo path 4 096, model 200, thinking 64. `repos[]` entries are absolutized
and deduped order-preservingly; relative entries resolve against the importing process's cwd,
because import is a folder-picker operation.

The registry authority (`project-registry-authority.ts`) owns the invariants: slug ids
(`^[a-z0-9][a-z0-9-]{0,63}$`), unique id, immutable `id`/`created_at` on update, and rejection of
every reserved id.

### 2. Classification is a four-tier ladder; the model is consulted last, and only when ambiguous

`ProjectClassifierAuthority.classify()` runs one fixed order, first hit wins:

| Tier | Evidence | Confidence | Model call |
|------|----------|------------|------------|
| 1 `repo` | the conversation's `repo_root` sits inside a project's `repos[]` (an explicit import); the most specific import wins | `1` | never |
| 2 `mention` | the message names a registered project as `@project-slug` at a word boundary | `1` | never |
| 3 `fts` | the FTS5 index returns a winner: score > `FTS_MIN_SCORE` (30) **and** ahead of the runner-up by > `FTS_MIN_MARGIN` (10) | `score / 100` | never |
| 4 `ai` | the injected proposal seam (the curator bridge) names a registered project with confidence ≥ `AI_MIN_CONFIDENCE` (0.6) | model probability | once |
| 5 `fallback` | nothing resolved it | `0` | never |

The **minimize-AI invariant** is the tier order itself: tiers 1–2 are exact, so `confidence` is
`1` and no later tier — retrieval included — ever runs. Tier 3 is deterministic; a near-tie is
deliberately inconclusive, because moving a conversation on a coin flip is worse than asking.
Tier 4 is reached only with an inconclusive retrieval result, and an abstention, a spawn failure,
or an unparseable verdict falls back to the default project rather than guessing. A runtime with
no `bun:sqlite` and no `VIBEFLOW_AI` bridge therefore still classifies every message
deterministically.

`confidence` is **per-tier evidence, not one shared scale**: `repo`/`mention` are exact, `ai` is
the model's own probability, and `fts` is normalized term coverage. An `fts` verdict may
therefore bind below 0.6 — its acceptance already happened at tier 3 — while an `ai` verdict
below 0.6 is discarded. Every consumer that needs "how sure" must read `reason`, not compare
confidences. The suggestion gate (`isProjectSuggestionVisible`) encodes exactly that:
`reason === "fts"` renders a chip at any confidence > 0, `reason === "ai"` requires ≥ 0.6, and
`repo`/`mention`/`fallback` never render one.

Every tier re-checks the live registry. The index outlives registry entries (and the model can
name anything), so retrieval hits are filtered to registered ids *before* the confidence gate —
otherwise a deleted project would win the tier and hide a real runner-up behind it.

Creation is where the deterministic tiers become facts: `resolveConversationProjectId` runs
tiers 1–2 over the new conversation's own `repo_root` and topic at manifest materialization, so a
conversation opened inside an imported repo is filed before its first message. The inferred tiers
(`fts`/`ai`) stay out of creation entirely — they are proposals the user confirms, never a silent
auto-file.

### 3. The deterministic middle tier is a bounded `bun:sqlite` FTS5 index

Tier 3 uses `bun:sqlite` FTS5 — a builtin, so zero new dependencies — over each project's
name/goal/context and (see Deferred) recent chat, with a `porter unicode61` tokenizer.

Scoring is IDF-weighted **term coverage normalized to 0–100**, not raw BM25. BM25 magnitudes
drift with corpus size and row length, so a fixed threshold on them cannot mean the same thing
for a 3-project registry and a 300-project one; coverage keeps the acceptance floors meaningful
at every registry size and makes `top − second` a real margin instead of a corpus artifact. A
descriptor row outweighs a chat row (1.0 vs 0.6) for the same term, because registry text is
authored and chat is incidental.

The index is bounded and best-effort: 32 query terms, minimum term length 2, 20 chat rows per
project, descriptors re-indexed from the live registry on every classification (which makes a
stale descriptor structurally impossible), and every operation degrades a malformed `MATCH`, a
closed handle, or an empty query to `[]` instead of failing the message turn. It is opened
in-memory, once per process, lazily `require`d so the Bun-only builtin never enters the
Node-targeted bundle.

### 4. `idea` is a reserved default project, and one id grammar holds at every boundary

`idea` is the classification fallback. It is **reserved, not registered**: the registry refuses to
create it (`PROJECT_RESERVED_IDS`), no registry entry is required for it, and every create path
that resolves an absent `project_id` resolves to it. A conversation that nothing classified is
therefore always addressable, and the rail's catch-all divider has a name (`Ideas`) without a
fake registry row.

One grammar — `isConversationProjectId` in `conversation-catalog-contract.ts`, the registry slug
pattern — is applied uniformly at six boundaries: the manifest validator, the create funnel, the
create wire, the catalog projection, the catalog DTO, and the registry. This is not ceremony: an
earlier split (a stricter projection than the registry) would have dropped registry-legal ids and
durably degraded the whole catalog to `503`, and a looser storage check would have let free text
reach a public label. Because the pattern admits no separator, a `project_id` can never carry
filesystem layout — the value is safe to project publicly and safe to use as a grouping key.

`project_id` is not derived at read time. It is written into the conversation manifest and read
back by `catalog-row.ts` for every DTO (`summary.project_id`, and a searchable field in the
catalog). The previous basename-of-`repo_root` derivation was removed; a manifest written before
the field existed falls back to the reserved default through the manifest validator.

### 5. Engine override is stored policy; surfaces are UI-first

Project classification settings live in the settings document as one feature-scoped block
(`project-classification-settings.ts`, coerced and merged by `settings.ts`):

```text
projectClassification: {
  enabled: boolean,                    # durable gate: OFF ⇒ the classifier never runs
  engine: { cli: Engine | null, model: string | null, thinking: string | null },
}
```

`null` means "auto" (the classifier's own default engine / the engine's default), and is stored
instead of a guessed engine name so a project with no opinion does not silently pin
classification to one CLI after the user changes their default. Auto-classify is ON by default
and OFF is a *durable* gate read from the settings document at first use — not at drawer mount —
so a reload cannot resurrect a chip the user turned off.

Engine precedence is `project.engine.cli` → global `projectClassification.engine.cli` → "unset"
(sent as an absent key, so the seam keeps its own `VF_REVIEW_ENGINE` fallback). Only `cli` has a
consumer today: it selects the engine the classifier's AI tier runs on. `model` and `thinking`
are validated, bounded, persisted, and round-tripped with no dispatch surface yet (see Deferred).

The shipped surfaces are the web workspace and the conversation HTTP route; there is no project
CRUD in the CLI. `GET /api/conversation-projects` (rail labels), `PATCH
/api/conversation-projects/{id}` (engine override), `POST /api/conversation-projects/classify`
(one verdict), and `POST /api/conversation-projects/move` (the chip's confirm) are all
session-authorized and CSRF-guarded for writes. The rail DTO deliberately projects only
`id`/`name`/`goal`/`engine`; `repos[]` and `context` never cross the wire. The registry
authority's `create`/`delete` exist server-side but are not yet exposed by any route or command —
a phase gate, not an oversight: creation needs the folder-import flow, and deletion needs a
decided answer for the conversations filed under the deleted project.

The UI composes three surfaces over those routes: `HomeSessionRail.vue` renders one divider per
project (the pure, browser-safe `project-rail-group.ts` groups them, newest entry first, with the
catch-all pinned last), `ProjectSuggestionChip.vue` is the confirmable move inside the composer,
and `ProjectSettingsPanel.vue` (in the preferences drawer) holds the global switch, the global
engine, and one per-project override row per registry project.

## Consequences and tradeoffs

Positive:

- Grouping is stable under renames and folder moves, and a project can carry the context a
  divider, a classifier prompt, and an engine override all read.
- The common case costs nothing: an explicit import or an `@mention` classifies exactly, with no
  index lookup and no model call, and a runtime with neither FTS nor a bridge still answers.
- Classification is advisory. The catalog carries a `project_id`, never a path, and a corrupt
  registry degrades the rail to the catch-all instead of failing a message turn.
- The registry survives concurrent writers and crashes: lock-scoped mutator, atomic
  compare-and-swap, revision counter, explicit corruption error.

Costs:

- Registry scale is bounded by design (256 projects, 4 MiB). A user with more needs the deletion
  and archival semantics that are not designed yet.
- Tier 3's acceptance floors are tuned constants (`30` / `10`), not learned thresholds; the
  FTS-vs-AI split is pinned by tests rather than by evaluation data.
- The in-memory index is rebuilt per process. Descriptors are cheap to re-index at this scale,
  but a persisted index will be needed before latency over a large registry matters.
- Two labels for the same thing can diverge: an unregistered `project_id` still renders (as its
  slug) so a conversation is never invisible, which means a stale id is visible as a divider
  rather than as an error.
- `project_id` had to be added to exact-key-asserted DTOs, which touched every catalog fixture.

## Deferred and known items

These are recorded here rather than fixed in the classification change, each with its trigger.

1. **`assertConversationManifest` mutates at read time.** The validator normalizes missing
   optional fields in place (`project_id`, and pre-existing `baseline_enabled` /
   `evaluator_auto_added`), so a manifest object that has passed validation is no longer
   byte-identical to the document it was read from. Any digest computed *after* validation is
   therefore not a digest of the stored artifact. Trigger: pinning a manifest digest, or any
   second reader that compares a validated object to its file. Fix: split a pure
   `normalizeConversationManifest` from the assert.
2. **Legacy `~/.vibeflow/projects.json` versus the per-repo registry root.** The per-repo root was
   chosen deliberately (§1), but the legacy global path is unowned: nothing reads or migrates it,
   and a user who has one gets no feedback. Trigger: the first release that ships project
   creation. Fix: a one-time migration or an explicit refusal that names the legacy file.
3. **`model` and `thinking` are stored, not applied.** Validated, bounded, persisted, and
   round-tripped to the server, but no dispatch surface consumes them: the owned-AI-route request
   carries no such fields and there is no in-repo authority mapping a reasoning label to a CLI
   flag. They are stored now so the settings document does not change shape when a consumer
   arrives. Trigger: a per-project dispatch requirement. Fix: a CLI-flag mapping authority
   (`project-types.ts` says so at the constant).
4. **`POST /api/conversation-projects/classify` accepts and forwards `repo_root`, but no client
   sends it.** The parameter is validated and threaded to the tier ladder, where the creation path
   already supplies the real value; the browser does not. Pre-existing, harmless, and untested from
   the browser side. Trigger: a caller that classifies a message not yet bound to a conversation.
   Fix: send it, or drop the field from the route contract.
5. **Recent-chat indexing has a caller only in tests.** `indexProjectChat` (20 rows per project,
   oldest evicted) is implemented and covered, but production retrieval indexes descriptors only —
   no live chat feed calls it yet, so tier 3 scores registry text today. Trigger: tier 3 missing
   matches it should have found. Fix: feed committed messages into the index at the same boundary
   that invalidates the catalog.

## Rejected alternatives

- **Keep deriving the grouping key from `repo_root`:** rejected because it cannot be named, cannot
  span two checkouts of one product, cannot hold a goal or engine preference, and changes meaning
  when a folder moves.
- **Store projects in the machine-wide `~/.vibeflow/` config:** rejected because project lists are
  per-checkout, a global document invites collisions and cross-repo leakage, and the conversation
  runtime already scopes its durable state to `<repoRoot>/.vibeflow`.
- **Ask the model first, or run the model on every message:** rejected as cost and latency on the
  common path, and because it makes classification non-reproducible.
- **Persist the FTS index:** rejected for now — descriptors are re-indexed per process at 256-row
  scale, and a persisted index needs an invalidation contract on every registry mutation.
- **Raw BM25 with a score threshold:** rejected because BM25 magnitudes drift with corpus size, so
  one threshold cannot serve a small and a large registry.
- **Register `idea` as a real project:** rejected because it must exist before any user action,
  cannot be deleted, and would need special-casing in validation, deletion, and import anyway.
- **Let a lower tier bind a project the registry does not have:** rejected because the index and
  the model both outlive registry entries; an unregistered winner would file a conversation into a
  phantom project and hide the real runner-up.
- **Auto-move a conversation on a low-confidence verdict:** rejected — nothing under an
  acceptance floor renders a control that moves a conversation, and confirming is always explicit.
- **Ship CLI project CRUD in v1:** rejected as a phase gate. Creation needs the folder-import flow
  and deletion needs decided conversation semantics; the registry authority already supports both,
  so the CLI is an exposure decision, not an implementation one.

## Related

- `docs/ui-mockup-project-rail.md` (approved design, §8 implementation amendments, §6 known
  limitations)
- `src/orchestrator/conversation/project-types.ts`
- `src/orchestrator/conversation/project-registry-store.ts`
- `src/orchestrator/conversation/project-registry-authority.ts`
- `src/orchestrator/conversation/project-classifier.ts`
- `src/orchestrator/conversation/project-classifier-authority.ts`
- `src/orchestrator/conversation/project-fts.ts`
- `src/orchestrator/conversation/conversation-project-binding.ts`
- `src/skills/project-classifier-runtime.ts`, `src/skills/project-classify-skill.ts`
- `src/server/conversation-project-route.ts`
- `src/ui/src/project-rail-group.ts`, `src/ui/src/project-classification-store.ts`
- `docs/adr/ADR-008-conversation-runtime-authority.md`
