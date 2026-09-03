# AI-first Home and CLI Capability Fabric Implementation Plan

> **Execution rule:** every production behavior is implemented test-first in a bounded work unit, independently reviewed, and accepted only from current-HEAD evidence. The approved design is frozen; this plan selects module boundaries and sequencing without changing product authority.

**Goal:** Make AI conversation the default VibeFlow Home and ship one dynamic, durable Capability Fabric that safely extends the connected AI CLIs with skills, tools, MCP servers, hooks, roles, and settings.

**Authority:** [`../specs/2026-08-24-ai-first-home-capability-fabric-design.md`](../specs/2026-08-24-ai-first-home-capability-fabric-design.md). The design is approved and fresh-reader tested. The merged brainstorming epoch and its ten consumed units are historical input only and must never be re-dispatched or re-ingested.

**Product boundary:** VibeFlow remains a local-first AI-CLI harness. The browser renders host-owned typed actions and health views. Capability packages do not ship arbitrary browser code or become plugin microfrontends.

**Tech stack:** TypeScript, Node/Bun, Vue 3, Pinia, UnoCSS, native CLI adapters, durable local files, Vitest/Bun tests, Playwright.

## Global constraints

- Reuse the existing conversation, trace, dispatch, role, skill, hook, tool, settings, server, and verify authorities; replace duplicate writers deliberately instead of creating permanent parallel stacks.
- New production TypeScript/Vue files stay below the repository's 400-line ceiling. Existing files at or near the limit receive narrow delegation only.
- Existing manifests and semantic journals are reader-compatible and byte-identical. Migration is additive, restart-safe, and never guesses authority from timestamps, display text, paths, or merely-present binaries.
- All mutations share one typed action envelope, idempotency authority, approval/challenge model, permission witness, operation journal, and recovery contract.
- Read/status/discovery and dry-run paths do not create a capability lock or grant mutation authority.
- Secrets, raw prompts, native session IDs, credentials, local absolute paths, private receipts, and unredacted engine config never enter public DTOs, portable locks, logs, CLI JSON, or exports.
- A capability adapter returns typed inspection/plan/receipt/health data and cannot execute arbitrary package code or receive an unrestricted path/shell interface.
- An operation cannot publish a lock generation before required effects, receipts, rollback inventory, and health evidence are durable.
- The old modal Conversation Workspace, manual Resume form, and competing direct mutation surfaces are deleted after parity; they are not retained as a fallback.
- Deterministic tests use injected engines and fixtures; they never consume live model or external network spend.
- Completion requires current-HEAD independent review and whole-repository `vf verify` confidence `1.0`.

## Dependency graph

```text
foundation-durability-actions
       |                 |
       v                 v
conversation-catalog     capability-core
       |                 |
       v                 v
conversation-revisions   capability-runtime
       |                 |
       +--------+--------+
                v
          capability-cli
                |
                v
            ai-home-ui
                |
                v
       product-acceptance-ship
```

Catalog DTOs and read APIs may land while Capability core is built. The UI may implement against committed public DTOs after those contracts are frozen. No UI action card is accepted until it calls the real shared action/Fabric service.

## Unit 1 — `foundation-durability-actions`

**Goal:** Provide the single crash-safe canonical storage and typed action authority used by conversation revisions and capabilities.

**Owns:**

- `src/durability/**`
- `src/actions/**`
- `test/durability/**`
- `test/actions/**`

**Must implement:**

- RFC 8785-compatible canonical JSON and domain-separated `digestV1` with golden vectors and one-field tamper detection.
- VFFR dense chained frames with bounded readers, truncation/corruption classification, version negotiation, and no silent repair.
- Content-addressed canonical/raw object creation, exact-preimage CAS replace, directory fsync, no-follow path safety, and process-owner lock/owner-death handling.
- Versioned action request/proposal/approval/challenge/dispatch/operation/receipt DTOs, strict validation, state fold, exact idempotency replay/conflict behavior, principal/scope/CSRF bindings, public projection, and stable errors.
- Pending actions and operation progress survive restart independently of chat delivery.

**Forbidden:** conversation-specific planning, capability-specific permission semantics, browser code, legacy direct writers.

**Verify:** focused canonical/framing/CAS/lock/action store/idempotency/approval/dispatch/fault tests, typecheck, Biome, and diff check.

## Unit 2 — `conversation-catalog-lineage`

**Goal:** Build a durable, rebuildable, searchable root-session catalog and safe lineage/timeline read APIs over existing conversation authority.

**Owns:**

- `src/orchestrator/conversation/catalog-*.ts`
- `src/orchestrator/conversation/lineage-*.ts`
- `src/orchestrator/conversation/source-inventory.ts`
- `src/orchestrator/conversation/timeline-service.ts`
- `src/server/conversation-list-route.ts`
- `src/server/conversation-lineage-route.ts`
- `src/server/conversation-timeline-route.ts`
- `test/orchestrator/conversation-{catalog,catalog-rebuild,lineage,timeline}.test.ts`
- `test/server-conversation-{list,lineage,timeline}.test.ts`

**Must implement:**

- Safe inventory that validates hashed manifest filenames and existing journals without creating missing authority.
- Durable lineage heads/reservations/associations and deterministic legacy initialization: one eligible leaf commits; multiple leaves are ambiguous; an explicit single deferred leaf is unclaimed; zero valid leaves is unrecoverable.
- Atomic catalog generations/deltas/current pointer, single-flight rebuild, safe degraded mode, independent direct recovery by conversation ID, stable cursor/query/filter semantics, and invalidation watermark.
- Root timeline with deterministic conversation-start and revision-boundary items while preserving revision-scoped semantic sequences.
- Authenticated no-store list, lineage, and timeline endpoints with nested public errors and recovery hints.

**Forbidden:** rewriting old manifests/journals, choosing by timestamp, calling a reader that creates a missing journal, participant mutation, UI edits.

**Verify:** legacy/empty/malformed/newer-schema fixtures; restart/rebuild/cursor/race/property tests; server contract tests.

## Unit 3 — `conversation-revisions-api`

**Goal:** Replace direct child mutation with generalized, crash-recoverable child revisions and canonical context continuity through the shared action service.

**Owns:**

- new `src/orchestrator/conversation/{conversation-lock,handoff-*,revision-*,turn-delivery-*,conversation-interaction-*,conversation-action-*,conversation-home-authorities}.ts`
- additive trace projection changes in `src/orchestrator/trace/{types,validation,store}.ts`
- narrow delegation changes in `src/orchestrator/conversation/{bootstrap,service,continuation-runtime,runtime,fold,policy-registry,types}.ts`
- `src/server/{public-api-error,conversation-handoff-route,conversation-action-route,conversation-action-events,conversation-principal}.ts`
- narrow composition changes in `src/server/conversation-{route,sse,artifact}.ts`, `src/server.ts`, and `src/commands/conversation-http.ts`
- corresponding conversation revision/handoff/action/SSE/artifact tests

**Must implement:**

- Semantic conversation lock excluding projection-only records.
- Deterministic canonical handoff selection, budget/compaction, content-addressed bytes, ancestry-bound resolution, and identical handoff for every fresh child participant.
- Receipt-bound `VF-TURN/1` delivery: exact native resumes receive only newly applicable user messages and concise peer deltas, while fresh/unproved sessions receive complete public context; combined handoff+turn bytes obey the participant budget. Public and interaction sequence/head cursors advance independently and survive restart, so a new reaction on an older message is not lost or replayed as self context. Interaction delivery carries an explicit `ready|degraded` state: ready digests are receipt-bound, while degraded uses null digests/zero sequences and forces full-history without hiding conversation messages.
- A separate append-only social interaction authority for the closed emoji reaction set and immutable one-to-eight multi-source quote locators, with lineage/visibility/content-digest validation, agent anti-spam limits, no HostAction authority, and quote-occurrence bindings that preserve the quoting message plus dense source order.
- Complete binding deltas, immutable revision plans/headers, hidden child preparation, root reservation, WAL, source lock checks, head CAS, participant-start barrier, cancellation/quiescence, honest unsupported reconciliation, and restart recovery.
- Shared action planning/execution for add/remove agent, settings changes, selection/association, stop, compaction, retry/reconcile/abandon, with stale-plan rejection and approval semantics.
- Pending/action/operation APIs and exact operation SSE cursor behavior; artifact download requires expected SHA and validated ancestry.
- Existing terminal-message child behavior delegates to the new revision authority; the duplicate direct writer is deleted.

**Forbidden:** retaining native sessions across changed bindings, mutating participants in place, exposing caller-selected trace IDs, changing semantic state from projection-only events.

**Verify:** source-lock, handoff/turn determinism and exact/full public-plus-interaction resume boundaries, old-target reaction delivery/self exclusion, multi-source quote occurrence order, lineage continuity, reaction/quote authorization and restart folds, crash-boundary, duplicate-start, unsupported-adapter, action/API/SSE/artifact and existing child-race regression tests.

## Unit 4 — `capability-core`

**Goal:** Implement exact package, source, permission, authority, and portable lock foundations for the Capability Fabric.

**Owns:**

- `src/capabilities/wire/**`
- `src/capabilities/canonical/**` as thin imports/re-exports over `src/durability/**` where appropriate
- `src/capabilities/manifest/**`
- `src/capabilities/source/**`
- `src/capabilities/permissions/**`
- `src/capabilities/authority/**`
- `src/capabilities/storage/**`
- focused `test/capabilities/**` core suites and fixtures

**Must implement:**

- Strict versioned manifest/component/input/source/authenticity/permission/lock/operation/query/CLI wire DTOs and bounds.
- Universal package-tree hash, safe materialization, registry Ed25519 envelope/index verification, immutable Git/local/legacy pins, canonical source access, safe network/archive policy, deterministic bounded SemVer dependency resolution, and no verified-to-unverified fallback.
- Canonical permission union/delta/containment across every discriminant, grant/trust/policy/secret-revocation authority frames, exact witness/enforcement equality, and scope identity rules.
- Project/user path placement, mode/no-follow/fsync rules, immutable objects/history/cache, current portable lock CAS, operation/health stores, and exclusive scope locks.
- Status/read paths that leave no new authority bytes.

**Forbidden:** reusing legacy bundle hashes/cache keys as normative Fabric identity, arbitrary lifecycle scripts, credentials in URLs, best-effort config writes, hidden user-scope mutation in a project operation.

**Verify:** golden vectors, malformed/oversized/path/link fixtures, signature rotation/revocation, resolver conflict/cycle/complexity, permission properties, authority/lock/storage crash tests and secret canaries.

## Unit 5 — `capability-runtime`

**Goal:** Implement deterministic adapters and the complete install/configure/update/remove/rollback/repair/adopt lifecycle.

**Owns:**

- `src/capabilities/adapters/**`
- `src/capabilities/planning/**`
- `src/capabilities/operations/**`
- `src/capabilities/query/**`
- `src/capabilities/legacy/**`
- `src/capabilities/{service,index}.ts`
- focused adapter/planning/runtime/query/migration tests

**Must implement:**

- Checked-in adapter registry and fingerprints for skill, tool, MCP, hook, role, engine setting, and legacy adoption; all declared host/manual/native/external/unsupported outcomes are honest.
- Inspection and plan snapshots with exact preimages/owned keys, immutable execution closure, zero-write transient preview, authority revalidation before every effect, WAL receipts, health inventory, lock publication, rollback, recovery, and `needs-recovery` handling.
- Install, configure, retarget, update, remove, rollback, repair, status, discovery, and deterministic legacy adoption for all five VF-owned marker classes; arbitrary external state remains unmanaged.
- Fabric active writer fence and one service facade for CLI/server/chat compatibility frontends.
- Four-part mutation proof: final generation, exact live projection bytes, terminal operation/audit, and live health.

**Forbidden:** calling legacy direct writers for effects, auto-adopting a merely present tool or arbitrary config, publishing partial required targets, silently granting a new permission under `--yes`.

**Verify:** every adapter support outcome, preimage conflict, fault boundary, required/optional rollback, drift/repair/adopt/restart/status/discovery and secret-redaction tests.

## Unit 6 — `capability-cli-compat`

**Goal:** Expose a friendly, strict CLI and route existing mutation commands through the Fabric.

**Owner:** `cli-engine` specialist.

**Owns:**

- `src/commands/capability.ts`, `src/commands/authority.ts`
- `src/commands/capability/**`, `src/commands/authority/**`
- narrow routing/help changes in `src/{cli,commands}.ts` and `src/commands/{help,help-commands}.ts`
- deliberate compatibility/fence changes in `src/commands/{skills,tools,hooks,doctor,verify}.ts` and `src/settings.ts`
- capability CLI/help/compatibility/doctor tests

**Must implement:**

- Dedicated raw-argv parser before generic flag collapse; repeatable `--for`, `--set`, `--private`, and `--input`; duplicate singleton rejection; strict unknowns and suggestions; direct/request-file/stdin exclusivity and bounded JSON+EOF.
- Friendly human flow plus exact versioned `--json` result and stable exits 0/1/2/3/4; correct TTY/non-TTY, dry-run, yes, offline, and network-read behavior.
- Secret values accepted only through private input staging and absent from argv, stdout, logs, plans, locks, and exports.
- Existing skill/tool/MCP/hook install/configure commands become thin Fabric frontends when Fabric is active. Authoring/evaluation-only skill commands remain independent.

**Verify:** argv fuzz/table tests, snapshot help, TTY/non-TTY/request-file/JSON/exits, compatibility writer fence, doctor and end-to-end CLI fixtures.

## Unit 7 — `ai-home-ui`

**Goal:** Replace the workflow dashboard/modal with a polished, persistent AI-first conversation Home that uses the real catalog, action, and Capability APIs.

**Owner:** `web-ui` specialist.

**Owns:**

- new UI catalog/action/capability types and clients
- new `conversation-home-store.ts`, activation/action/composer composables
- `ConversationHome.vue`, session rail/header/state, timeline/message/revision/system, composer/autocomplete/action, drawer/health components and `home.css`
- focused narrow changes in `App.vue`, `TopBar.vue`, conversation stream/store/API, trace/artifact/matrix drawers, Uno/Vite styling
- deletion of modal ChatWorkspace/ConversationPanel and ask-modal ownership after parity
- UI unit/component tests (E2E is Unit 8)

**Must implement:**

- Persistent searchable session rail, safe generation-bound A-to-B switching that aborts every stale fetch/token/SSE/timer callback, center timeline, sticky memory-only composer, first-run inline onboarding, and drawers for secondary evidence/settings.
- Natural `+`, `@`, optional slash autocomplete with IME-safe keyboard behavior; proposals/permissions/approvals/progress/recovery inline in chat; no mutation auto-replay while offline.
- Accessible restrained emoji reactions plus ordered multi-source quote selection/previews/jump-to-source; UI references canonical target event IDs and content digests and remains disabled with an explicit typed-backend blocker rather than simulating either feature in Markdown.
- Real pending action recovery, operation streaming, capability search/status/health and all manual/unsupported/partial/rollback/drift states.
- Warm stone/amber production visual system, readable ~65ch timeline, explicit loading/empty/no-results/offline/error/degraded states, 18rem/collapsed/narrow/320px layouts, 200% zoom, reduced motion, keyboard order, focus restoration, labeled landmarks/log/listbox/live regions, and 44px touch targets.

**Forbidden:** a modal workspace, Create/Resume tabs, permanent technical forms, terminal-style error toast, arbitrary capability UI, mock installer action paths.

**Verify:** API/store/activation/shell/timeline/action/capability component suites, DOM/a11y checks, build/typecheck/Biome and visual review.

## Unit 8 — `product-acceptance-ship`

**Goal:** Prove the integrated product, remove duplicate code, and ship only from live confidence evidence.

**Owns:**

- `e2e/conversation-home.spec.ts` and necessary fixture/runner support
- migration/release fixtures
- `docs/capability-normative-matrix.json`
- machine-checking matrix and whole-product acceptance tests
- release documentation/evidence only

**Must implement/prove:**

- First-run and populated Home; search/pagination/restart; rapid-switch stale suppression; offline draft and explicit resend; proposal reload/edit/stale/double-confirm; revision lineage/context; exact-resume peer-only deltas and fresh full handoff; bounded reactions and multi-author/multi-revision quotes; capability success/manual/unsupported/partial/undo/drift/repair.
- Desktop/collapsed/narrow/320px/200%/reduced-motion screenshots, zero console errors, axe automation, keyboard/IME/focus, and recorded manual screen-reader evidence.
- Legacy fixture migration/rollback rehearsal, newer/corrupt read-only handling, active writer fencing, restart/crash/fault injection, secret-canary scan, and no machine-specific tracked paths.
- A machine-checked matrix mapping every normative design clause/state/action/domain/digest/negative rule to current live test/evidence IDs; no missing, stale, skipped, or unconsumed row.
- Independent correctness/security/UI reviews on final HEAD; focused tests; full test/lint/typecheck/build; review evidence; `vf verify` confidence `1.0`; PR, required CI/review resolution, and merge when repository authority permits.

## Dispatch and review protocol

1. Add the eight uniquely named units above to the fresh workflow ledger with exact scopes and dependencies. Do not import or ingest any historical brainstorming unit.
2. For each unit, dispatch a compact task contract containing goal, allowed scope, forbidden paths, first-read pointers, must-haves, non-goals, real verify oracle, and evidence output.
3. The implementer writes RED tests, then production code, then focused verification. A different engine/agent performs spec and quality/security review.
4. The coordinator inspects actual diff and test output, records evidence, and only then marks the unit done/confidence 1.0. Agent self-report alone is not evidence.
5. Integration changes that span ownership are applied by the latest dependent unit; earlier units expose typed seams and do not edit a shared integration file opportunistically.
6. At final HEAD, regenerate review evidence after every code change, run the full whole-repository gate, then push/create PR/monitor CI/fix/re-review/merge. No stale review artifact may satisfy `vf verify`.

## Completion definition

This plan is complete only when every design completion criterion is implemented by the real authority path, duplicate/modal/direct-writer paths are removed, all eight units have live evidence and independent review, the full repository passes `vf verify` at confidence `1.0`, and the resulting PR is green and merged whenever current repository authority allows it.
