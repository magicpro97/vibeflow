# Brainstorm & Debate Complete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`; use `superpowers:test-driven-development` for every production behavior. Every task has an implementer, an independent spec reviewer, and an independent quality reviewer before it is accepted.

**Goal:** Deliver the approved Draft v7 brainstorming architecture end-to-end: one traced conversation runtime shared by `vf chat`, `vf ask`, `vf brainstorm`, workflow policies, authenticated API/SSE, and the Vue workspace, including Phase 1–3 behavior and whole-repository confidence 1.0 evidence.

**Authority:** [`docs/specs/2026-08-17-brainstorm-debate-design.md`](../../specs/2026-08-17-brainstorm-debate-design.md), Draft v7. The Phase 1 Decision Freeze and Trace Acceptance Criterion are normative. This plan does not change those decisions.

**Architecture:** Extend existing dispatch, RoleSpec, skill resolver, trace journal, logbus, workflow ledger, review, and verify code. `ConversationOrchestrator` is the sole trace writer. Policies emit structured events through runtime context; CLI and HTTP are adapters. Semantic outputs are deterministic projections of ordered journal events. The server projects and authenticates data but never appends trace events or resolves raw artifact paths itself.

**Tech stack:** TypeScript, Node/Bun standard APIs, Bun tests, existing `proper-lockfile`, Vue 3/Pinia, native Claude/Codex/Copilot/OpenCode/Antigravity CLIs, Playwright.

## Frozen findings and baseline

- Foundation merge at `80e69ae7ab1db499de035fc9ad5363afa1f1c547` contains trace/store/fold/consensus primitives, not a production conversation feature.
- `vf chat`, `vf brainstorm`, `ConversationOrchestrator`, `AttemptHandle`, binding materialization, debate policy, conversation routes, and conversation UI do not exist.
- Existing `src/orchestrator/debate.ts` is a legacy prompt-profile helper and is not the v7 debate policy.
- Existing `vf ask` owns a second spawn path and must become a compatibility adapter over the shared session path.
- Existing trace public projection is event-only, opaque IDs are not conversation-scoped, and no authenticated reverse artifact resolver exists.
- Baseline full suite: 5,837 pass / 9 skip / 4 fail. All four failures were PATH-dependent real-process fixtures using literal `node`; Task 0 repairs only those fixtures with `process.execPath`.
- `vf doctor`: git guardrail ON, live guardrail ON; Claude, Codex, Copilot, Bun, Git, GitHub CLI, and Docker detected; Antigravity absent. Feature tests must therefore use injected engines and never depend on live provider spend.

## Global constraints

- Do not create another dispatch, role, skill, trace, artifact, workflow, review, or verify authority.
- Policies and HTTP routes must not import or call `TraceStore.append`; only `ConversationOrchestrator` may append.
- A durable append completes before subscriber/logbus notification.
- Correlation is runtime-owned and immutable to policies. Retries create a new `attempt_id` with `parent_attempt_id`.
- One operation owns exactly one `AbortController`; pause preserves handles, while stop/cancel terminates only the relevant handles once.
- An `ambiguous` operation is never automatically resent.
- Raw native session IDs, prompts, environment data, credentials, local paths, idempotency keys, and raw artifact references never enter public DTOs.
- Opaque artifact/session IDs are conversation-scoped. Artifact resolution is allowlisted and authenticated.
- Debate matrix/baseline results depend only on ascending journal sequence; no model call, locale-sensitive ordering, randomness, or current clock enters semantic projection.
- Default `vf brainstorm` is dry-run. `--json` emits exactly one JSON document and no banner/update noise.
- Existing `vf ask` file-range syntax and latest-native-session `--resume` behavior remain compatible; explicit conversation resume is separate.
- Conversation Phase 1 admission is built-in read-only roles on Claude/Codex. Phase 2+ project roles require verified engine admission, isolation, and selected-engine credential filtering.
- Existing `WORKFLOW_STATE`, review evidence, and full `vf verify` remain authoritative.
- No live engine or external network call in deterministic unit/integration/E2E tests.
- Keep new source files at or below the repository file-size limit; extract rather than extending files already at/near 400 lines.

## Dependency graph

```text
Task 0 baseline repair

Task -1 authority/state freeze

Task 1 public trace/artifacts ─┐
Task 2 attempt/session         ├─> Task 3 role/skill binding
                               └──────────> Task 4 conversation runtime
Task 3 role/skill binding ─────────────────> Task 4 conversation runtime
                                                   │
                                                   └─> Task 6 debate policy
                                                              │
                                                     Task 7 workflow policies/router/bootstrap
                                                              │
                                                     Task 5 direct/chat/ask/CLI
                                                              │
                                                     Task 8 API/SSE/auth/artifacts
                                                     │
                                      Task 9 Vue workspace/visualization
                                                     │
                                      Task 10 acceptance/docs/ship gates
```

---

### Task -1: Freeze executable workflow authority without replaying consumed epochs

**Artifacts:**

- Create: `docs/evidence/2026-08-22-brainstorm-foundation-epoch.json`, a sanitized immutable manifest containing only the ignored state SHA, source HEAD, consumed unit names/status/confidence, evidence counts/hashes, and commit refs.
- Keep ignored/untracked: `.vibeflow/WORKFLOW_STATE.json` and machine-specific evidence. Never force-add them.
- Regenerate: `.vibeflow/*` and managed engine context through the canonical authenticated `/api/init` intake path (the same `applyIntake` authority used by `vf init`).
- Create through CLI: ten fresh, uniquely named VibeFlow units with exact dependencies and non-overlapping ownership scopes.

- [ ] Hash the ignored old state/evidence arrays, write the sanitized manifest, and verify it contains no absolute path, credential, prompt, raw evidence text, or native session ID.
- [ ] Commit Task 0, the sanitized manifest, and this implementation plan first. Do not force-add the ignored workflow state or per-machine evidence.
- [ ] Record the old state SHA and each consumed unit/commit in the coordinator brief. Do not dispatch or ingest those unit names again.
- [ ] Run the canonical init/intake path once with goal: `Complete Draft v7 brainstorming/debate end-to-end across runtime, CLI, policies, API/SSE, UI, and verification.` Add success criteria for Phase 0–3, Trace Acceptance, compatibility, and confidence 1.0. This begins a new workflow epoch and intentionally does not import old done units.
- [ ] Confirm init regenerated context/engine files and guardrails remain ON; do not hand-edit generated files afterward.
- [ ] Add units named `brainstorm-trace-public`, `brainstorm-session`, `brainstorm-bindings`, `brainstorm-runtime`, `brainstorm-debate`, `brainstorm-policies`, `brainstorm-cli`, `brainstorm-api`, `brainstorm-ui`, and `brainstorm-acceptance` with `vf units add`. Never reuse numeric consumed names `0a`, `0b`, `1`, or `2`.
- [ ] Apply dependencies in that order, except `brainstorm-trace-public` and `brainstorm-session` may start independently; use disjoint exact file ownership. Shared integration files belong to the latest dependent unit only.
- [ ] Before dispatch/ingest, prove no stale result, marker, evidence, or workunit directory for any fresh name exists. Ingest requires the fresh unit name plus current-epoch commit/evidence and must reject any artifact associated with the consumed foundation names.
- [ ] Run `vf units status` and archive its output in the brief before any production edit. This is the executable authority used by final confidence/goal gates.

---

### Task 0: Repair the runtime-dependent baseline fixture

**Files:**

- Modify: `test/commands-ask.test.ts`

**Task contract:**

- Scope is test-only. Do not modify production code or skip a test.
- Real-process fixtures use the executable running the suite, not a PATH assumption.

- [x] Replace every literal `cmd: "node"` in the two real-process describe blocks with `process.execPath`; update comments/descriptions to say active runtime.
- [x] Run `/opt/homebrew/bin/bun test test/commands-ask.test.ts` — 62 pass / 0 fail / 89 assertions.
- [x] Run `git diff --check -- test/commands-ask.test.ts` — exit 0.
- [x] Independent repair review approved after replacing empty Bun eval scripts with explicit `process.exit(0)` no-ops.

---

### Task 1: Complete safe public trace and artifact primitives

**Files:**

- Modify: `src/orchestrator/trace/types.ts`
- Modify: `src/orchestrator/trace/project.ts`
- Modify: `src/orchestrator/trace/store.ts`
- Modify: `src/orchestrator/trace/validation.ts`
- Modify: `src/logbus.ts`
- Create: `src/orchestrator/trace/artifacts.ts`
- Test: `test/orchestrator/trace-contracts.test.ts`
- Test: `test/orchestrator/trace-store.test.ts`
- Create: `test/orchestrator/trace-artifacts.test.ts`

**Interfaces:**

```ts
export interface PublicProjectionContext {
  conversationId: string;
  artifactRegistry?: ArtifactRegistry;
}

export interface ArtifactRegistry {
  register(conversationId: string, internalRef: string): OpaqueArtifactId;
  resolve(conversationId: string, opaqueId: string): ArtifactResolution | null;
}

export function projectPublicTrace<T extends TraceEvent>(
  event: T,
  context: PublicProjectionContext,
): Extract<PublicTraceProjection, { type: T["type"] }>;

export function projectPublicStoredTrace(
  record: InternalTraceStoreRecord,
  context: PublicProjectionContext,
): PublicStoredTraceEvent;
```

- [ ] Add RED tests proving identical raw refs in different conversations produce different opaque IDs, reverse resolution is conversation-bound, unknown/cross-conversation IDs fail closed, and IDs/resolution survive a clean process restart.
- [ ] Add RED tests proving the stored-envelope projector preserves every safe correlation field and sequence while dropping `idempotency_key` and replacing `native_session_id` with an opaque public session reference.
- [ ] Add recursive hostile-value tests for credentials, token-like strings, private keys, control/format characters, absolute/relative paths, prototype-pollution keys, prompt/env fields, artifact arrays, and non-mutation.
- [ ] Widen public/internal participant model fields to a validated bounded engine model string (`string | null`) so explicit overrides are not truncated to the canonical RoleSpec union. Add validation RED tests accepting normal provider model IDs and rejecting empty, overlong, control-bearing, or hostile values.
- [ ] Implement a private, deterministic HMAC/domain-separated opaque mapping with a mode-0600, no-symlink per-repository key and a registry-owned reverse table rebuilt from durable artifact events on reload. Never infer or decode an internal ref from the public ID; key creation/rotation must be cross-process safe.
- [ ] Make `projectPublicTrace` require conversation context for artifact/session domains while preserving its only-constructor role.
- [ ] Project full stored trace envelopes before mirroring to logbus; logbus stays best-effort and cannot become replay authority.
- [ ] Verify durable journal append still precedes mirror notification and idempotent duplicate behavior is unchanged.
- [ ] Run focused trace tests, typecheck, Biome on owned files, and `git diff --check`.

---

### Task 2: Add cancellable attempts and one canonical engine-session adapter

**Files:**

- Modify: `src/dispatch/types.ts`
- Modify: `src/dispatch/spawners.ts`
- Modify: `src/dispatch.ts`
- Modify: `src/dispatch/prompt.ts`
- Modify: `src/dispatch/env-filter.ts`
- Create: `src/dispatch/attempt-handle.ts`
- Create: `src/dispatch/isolation.ts`
- Create: `src/dispatch/session-types.ts`
- Create: `src/dispatch/session.ts`
- Modify: `src/orchestrator/marker.ts`
- Modify: `src/orchestrator/run.ts`
- Test: `test/dispatch.test.ts`
- Test: `test/orchestrator/run.test.ts`
- Test: `test/orchestrator/resume-policy.test.ts`
- Create: `test/dispatch-session.test.ts`

**Interfaces:**

```ts
export type SessionMode = "exact" | "replay" | "fresh";

export interface AttemptHandle<T = EngineSessionResult> {
  readonly attemptId: string;
  readonly completion: Promise<T>;
  terminate(reason?: string): Promise<void>;
}

export interface EngineSessionRequest {
  attemptId: string;
  spawn: SpawnOptionsProjection;
  nativeSessionId?: string;
  signal: AbortSignal;
  onChunk?: (chunk: EngineChunk) => void;
}

export interface IsolationLeaseProjection {
  kind: "worktree" | "container";
  cwd: string;
  evidence_ref: string;
}

export interface SessionProvenance {
  roleSource: string;
  roleHash: string;
  skillHashes: string[];
}

export interface SessionTraceMetadata {
  role_resolved_hash: string;
  skill_resolved_hashes: string[];
}

export interface SpawnOptionsProjection {
  engine: Engine;
  model: string | null;
  sessionMode: SessionMode;
  rendered_prompt: string;
  rendered_tools: string[];
  sandbox: RoleSandbox | null;
  env_policy: EnvPolicy;
  isolation: IsolationLeaseProjection | null;
  provenance: SessionProvenance;
  trace_metadata: SessionTraceMetadata;
}

export interface EngineSessionAdapter {
  start(request: EngineSessionRequest): AttemptHandle;
  reconcileHistory(request: HistoryReconcileRequest): Promise<HistoryReconcileResult>;
}
```

- [ ] Write RED tests for one handle per process, terminate idempotency, external abort linkage once, timeout/idle-timeout cleanup, and no orphan process.
- [ ] Write RED tests for `requested → dispatched → acknowledged|completed|ambiguous`; crash after dispatch but before acknowledgement becomes ambiguous and is not auto-replayed.
- [ ] Capture native session identity as soon as parser evidence permits. Persist immutable evidence under `attempt_id`, not `evidence/<engine>` overwrite paths.
- [ ] Read an exact resume binding before creating/updating a marker so the old session cannot be hidden. Claude/Codex exact resume must retain existing argv contracts.
- [ ] Implement Claude/Codex supported-history reconciliation and explicit `unavailable` for Copilot/OpenCode/Antigravity when completeness cannot be proven.
- [ ] Preserve an adapter-compatible result seam for the existing workflow `runDispatchAsync`; Task 4 performs the shared integration after binding materialization is available.
- [ ] Make `spawn.rendered_prompt` the only executable prompt and `spawn.env_policy` the only credential/environment authority; there is no parallel request-level prompt or scrub flag. Add contradiction-impossibility type/tests.
- [ ] Add selected-engine credential filtering when materializing the conversation `env_policy`: keep only the selected provider’s required auth and minimum runtime variables; retain the existing non-conversation default.
- [ ] Enforce every `SpawnOptionsProjection` field at execution, not only in trace: engine/model/session mode, rendered tools, sandbox, env policy, provenance, and trace metadata. Add per-engine argv/process tests, including a Claude read-only denial path because the existing RoleSandbox renderer alone does not enforce Claude permissions.
- [ ] Implement canonical isolation leases using an existing VibeFlow worktree or container boundary. Resolve/realpath the lease, pass its `cwd` to the child process, attach immutable evidence, and release it after terminal completion. Reject project-role launches when the lease is absent, unsafe, outside its root, or already released; unit tests must observe the actual spawned cwd.
- [ ] Remove raw native session IDs from public status JSON and dispatch evidence while keeping them in internal resume storage.
- [ ] Run focused dispatch/session/resume/run tests, typecheck, Biome, and diff check.

---

### Task 3: Materialize canonical role, skill, and Phase admission bindings

**Files:**

- Modify: `src/agents/role.ts`
- Modify: `src/agents/role-loader.ts`
- Modify: `src/agents/role-templates.ts`
- Modify: `src/agents/render.ts`
- Create: `src/agents/binding.ts`
- Create: `src/agents/role-overlay.ts`
- Create: `src/skills/dispatch-resolution.ts`
- Modify: `src/skills/discovery.ts`
- Modify: `src/skills/registry.ts`
- Modify: `src/skills/adapter.ts`
- Test: `test/role.test.ts`
- Test: `test/role-templates.test.ts`
- Test: `test/skill-type-543.test.ts`
- Create: `test/agent-binding.test.ts`
- Create: `test/role-overlay.test.ts`

**Interfaces:**

```ts
export interface AgentBinding {
  roleRef: string;
  engine: Engine;
  modelOverride?: string;
  sessionMode: SessionMode;
  additionalSkillRefs?: string[];
}

export interface ResolvedSkill {
  ref: string;
  source: "repo" | "shared" | "builtin";
  version: string | null;
  resolved_hash: string;
}

export interface ResolvedAgentBinding {
  role: ResolvedRole;
  skills: ResolvedSkill[];
  engine: Engine;
  model: string | null;
  sessionMode: SessionMode;
  tool_intents: ToolIntent[];
  sandbox: RoleSandbox | null;
  env_policy: EnvPolicy;
  isolation: IsolationLeaseProjection | null;
  provenance: SessionProvenance;
  trace_metadata: SessionTraceMetadata;
}
```

- [ ] Add RED tests for one role resolution order: repo role/overlay → canonical built-in fallback; unknown/malformed/cyclic overlays fail closed.
- [ ] Add built-in direct, brainstorm participant, skeptic/domain-expert, and evaluator RoleSpecs with `sandbox: "read-only"`; do not mutate existing write-enabled roles.
- [ ] Add RED tests for model override precedence, `sessionMode` preservation, tool/sandbox projection, and engine renderer output.
- [ ] Import and satisfy Task-2 `SessionMode`, `SessionProvenance`, `SessionTraceMetadata`, `IsolationLeaseProjection`, and `SpawnOptionsProjection` contracts; do not redeclare parallel binding/session transport types.
- [ ] Extract shared skill resolution from workflow dispatch. Materialize source/version/hash plus effective body for injection.
- [ ] Hash the effective resolved body and ordered base/dependency hashes deterministically; prove dependency order changes the hash and identical inputs do not.
- [ ] Map actual discovery roots to `repo|shared|builtin`; reuse existing selection and adapter inheritance.
- [ ] Implement Phase admission tests: Phase 1 allows only built-in read-only Claude/Codex bindings; later project overlays require a verified engine, a live canonical isolation lease, and selected-engine environment scrub. Fail closed rather than admitting an overlay with metadata-only isolation.
- [ ] Expose a workflow-compatible materialized resolver without changing selected skill names or prompt content; Task 4 owns the single integration edit.
- [ ] Run focused binding/role/skill tests, typecheck, Biome, and diff check.

---

### Task 4: Build the sole-writer ConversationOrchestrator domain runtime

**Files:**

- Create: `src/orchestrator/conversation/types.ts`
- Create: `src/orchestrator/conversation/fold.ts`
- Create: `src/orchestrator/conversation/artifact-store.ts`
- Create: `src/orchestrator/conversation/operation-registry.ts`
- Create: `src/orchestrator/conversation/runtime.ts`
- Create: `src/orchestrator/conversation/service.ts`
- Create: `src/orchestrator/conversation/policy-registry.ts`
- Create: `src/orchestrator/conversation/direct-policy.ts`
- Modify: `src/commands/dispatch-runtime.ts`
- Create: `test/orchestrator/conversation-fold.test.ts`
- Create: `test/orchestrator/conversation-runtime.test.ts`
- Create: `test/orchestrator/conversation-controls.test.ts`

**Interfaces:**

```ts
export interface ConversationContext {
  correlation: TraceCorrelation;
  topic: string;
  policy: string;
  bindings: ResolvedAgentBinding[];
  signal: AbortSignal;
  emit(emission: PolicyEmission): Promise<StoredTraceEvent>;
  launchAttempt(request: PolicyAttemptRequest): PolicyAttempt;
}

declare const attemptRefBrand: unique symbol;
export type AttemptRef = string & { readonly [attemptRefBrand]: "AttemptRef" };

export interface PolicyAttemptRequest {
  participantId: string;
  bindingIndex: number;
  purpose: "direct" | "participant" | "evaluator" | "baseline" | "plan" | "review" | "verify" | "orchestrate";
  promptInput: string;
  parent?: AttemptRef;
}

export interface PolicyAttempt {
  readonly ref: AttemptRef;
  readonly completion: Promise<EngineSessionResult>;
  emit(emission: PolicyEmission): Promise<StoredTraceEvent>;
}

export interface ConversationPolicy {
  readonly name: string;
  dryRun(context: ConversationContext): Promise<DryRunResult>;
  execute(context: ConversationContext): Promise<ConversationOrchestrationResult>;
}

export interface ConversationService {
  create(request: ConversationCreateRequest): Promise<ConversationCreateResult>;
  message(id: string, request: MessageRequest): Promise<MessageResponse>;
  pause(id: string): Promise<PauseResponse>;
  resume(id: string): Promise<ResumeResponse>;
  stop(id: string): Promise<StopResponse>;
  resolveApproval(id: string, decision: ApprovalDecision): Promise<ApprovalResolveResult>;
  cancelOperation(command: OperationCancelCommand): Promise<OperationCancelResult>;
  snapshot(id: string): Promise<ConversationSnapshot | null>;
  events(id: string, afterSeq: number): Promise<PublicStoredTraceEvent[] | null>;
  subscribe(id: string, listener: ConversationListener): Unsubscribe | null;
}
```

CLI compatibility adapters may expose typed convenience methods, but they must delegate into this service/runtime; they may not invoke a policy or `EngineSessionAdapter` directly.

- [ ] Start with RED lifecycle fold tests for every legal/illegal transition, independent health, terminal immutability, participant/session reconstruction, completed-round validity, and monotonic sequence.
- [ ] Implement runtime-owned correlation factories. Policies may add operation-level events through `context.emit`; reject correlation mutation or direct-store injection.
- [ ] Implement `context.launchAttempt` as the only policy launch path. It allocates the attempt ID, binds participant/role/skills/engine, renders the sole executable prompt, registers the handle/controller, and returns a branded opaque attempt ref plus an attempt-bound emitter. Policies never mint attempt IDs or call `EngineSessionAdapter` directly.
- [ ] Add RED concurrency tests with two simultaneous participants/evaluator and retry tests using a branded parent ref; every delta/tool/evidence event must retain one unambiguous participant/attempt chain and the retry must carry the runtime-resolved `parent_attempt_id`.
- [ ] Emit configuration, coordinator decision, participant binding, skill injection, operation lifecycle, responses/actions/evidence, state, terminal, and artifacts as the canonical chain.
- [ ] Maintain a conversation existence/index record independent of journal creation so unknown IDs return null/404 rather than creating an empty journal.
- [ ] Add live subscribers after durable append; replay and live delivery must dedupe on conversation `seq`.
- [ ] Add an operation registry with exactly one controller and a set of owned attempt handles. Pause preserves, stop aborts all conversation operations, and cancel aborts only the named operation once.
- [ ] Implement idempotent approval resolution: byte-equivalent repeat returns the original 202 result without emission; conflicting repeat returns typed 409.
- [ ] Implement exact route/body/conversation/operation checks and exactly-once `caller_cancelled` emission.
- [ ] Resume rehydrates persisted bindings; ambiguous operations remain visible and require explicit user action, never replay.
- [ ] Treat an authenticated `message` on a COMPLETED conversation as the frozen user-reject/revise action: create a new child conversation/revision with parent correlation, append the user message there, leave the parent terminal, and return the child location through the service result/HTTP `Location` header. ACTIVE messages remain injections. Test idempotency and parent/child identities.
- [ ] Implement direct policy with one binding and structured streamed deltas through `context.launchAttempt`.
- [ ] Integrate workflow dispatch with the canonical session adapter and materialized skill resolver in one edit, preserving existing workflow public results and prompt content.
- [ ] Run focused conversation tests, typecheck, Biome, file-size check on new files, and diff check.

---

### Task 5: Converge chat, ask, and brainstorm CLI adapters

**Execution dependency:** Run only after Task 7 has composed the production service bootstrap. Task 5 owns the CLI wiring once and imports that bootstrap; Task 7 never edits Task 5 CLI files afterward.

**Files:**

- Create: `src/commands/conversation-args.ts`
- Create: `src/commands/chat.ts`
- Create: `src/commands/brainstorm.ts`
- Create: `src/commands/help-conversation.ts`
- Modify: `src/commands/ask.ts`
- Modify: `src/commands.ts`
- Modify: `src/cli.ts`
- Modify: `src/commands/help.ts`
- Modify: `src/commands/help-commands.ts`
- Create: `test/commands-chat.test.ts`
- Create: `test/commands-brainstorm.test.ts`
- Modify: `test/commands-ask.test.ts`
- Modify: `test/cli.test.ts`
- Modify: `test/help-text.test.ts`

**Contract:**

```text
vf chat         canonical conversational entry
vf ask          compatibility facade → direct policy
vf brainstorm   compatibility facade → debate policy
vf orchestrate  explicit automation entry
```

- [ ] Write RED parser tests using raw argv so repeated `--participant` values survive; do not change global `parseFlags` semantics for other commands.
- [ ] Import the production `createConversationService` bootstrap from Task 7 for real command execution; injection remains a unit-test seam only. Prove CLI smoke tests traverse the real runtime/policy registry with a fake engine process seam.
- [ ] Materialize coordinator defaults for a bare `vf brainstorm "topic"` before validation, then validate `role@engine[:model]`, max rounds, resume ID, minimum two non-evaluator participants, exactly one evaluator auto-add, explicit override precedence, and unknown flags. Defaults must yield at least two non-evaluator bindings even when they share one ready engine.
- [ ] Write RED output/exit tests for every discriminant: dry-run/completed/stopped=0, validation=1, engine-start=2, transport=3, failed=4, aborted=5.
- [ ] Ensure `--json` emits one document only and suppresses banners, passive update notices, spinner/log text, and partial JSON on failure.
- [ ] Wire `vf chat` topic-only through `ConversationService` to coordinator routing/direct default. Explicit policy/participants override the coordinator; `--resume <conversation-id>` sends a message through the service and a completed parent creates the child revision described in Task 4.
- [ ] Wire `vf brainstorm` through `ConversationService` to debate policy with dry-run default and `--yes` dispatch. `--resume` accepts only a persisted conversation ID; the facade never calls the debate policy directly.
- [ ] Replace `vf ask` spawning with a typed ConversationService compatibility call while preserving file slicing, framing, engine selection, injected test seams, and legacy `--resume` latest-native behavior. Only the direct policy inside the runtime may call `EngineSessionAdapter`.
- [ ] Add `vf ask --conversation <id>` as the unambiguous conversation path; never overload legacy `--resume` with a conversation ID.
- [ ] Add CLI/help exports without growing capped help/dispatch files; move conversation help to the new module.
- [ ] Run chat/brainstorm/ask/CLI/help tests, typecheck, Biome, file-size check, and diff check.

---

### Task 6: Implement deterministic debate projection and real multi-agent policy

**Files:**

- Create: `src/orchestrator/conversation/debate-projection.ts`
- Create: `src/orchestrator/conversation/baseline.ts`
- Create: `src/orchestrator/conversation/debate-policy.ts`
- Refactor: `src/orchestrator/debate.ts`
- Test: `test/orchestrator/consensus.test.ts`
- Create: `test/orchestrator/debate-projection.test.ts`
- Create: `test/orchestrator/baseline.test.ts`
- Create: `test/orchestrator/debate-policy.test.ts`

**Projection contract:**

- A completed round has end boundary plus non-abort consensus and persisted response deltas.
- Normalize options with NFKC, Unicode trim, ASCII-space collapse, and locale-independent lowercase.
- Weights: responses `.20`, evidence `.10`, agreement `.25`, conflict resolution `.20`, evidence quality `.15`, convergence `.10`.
- Decimal half-up to six places; rank by aggregate desc, raw response count desc, option key asc.

- [ ] Write table-driven RED tests for empty data, incomplete rounds, Unicode equivalence, whitespace/case grouping, evidence zero denominator, evaluator `not_applicable`, all component bounds, half-up boundaries, deterministic `generated_at`, tie ordering, and byte-equivalent replay.
- [ ] Implement DecisionMatrix as a pure ordered-journal projector. It returns null if no completed non-empty claim exists.
- [ ] Write RED baseline tests for exact skip precedence (`disabled`, `single_participant`, `engine_unavailable`), missing/failed/success events, debate answer selection, and token-set divergence edge cases.
- [ ] Implement baseline launch with the first participant’s engine/model and no debate context; persist the result before projection.
- [ ] Write policy RED tests for evaluator auto-add, precommit before response, blind assessment isolation, full assessment, malformed evaluator abort, final-round consensus before exhaustion, maximum rounds, and deterministic emission keys.
- [ ] Replace the legacy parallel profile notion with bindings resolved by Task 3. Keep any still-used review prompt helpers as compatibility-only exports.
- [ ] Run participants/evaluator/baseline through runtime-owned `context.launchAttempt`, never the raw session adapter or direct spawn. Persist delta-only response events through each attempt-bound emitter.
- [ ] Emit decision matrix, baseline comparison, transcript, and synthesis artifacts through runtime artifact authority.
- [ ] Prove baseline is reported as a comparison signal and never overrides consensus gates.
- [ ] Run focused debate tests, typecheck, Biome, file-size check, and diff check.

---

### Task 7: Adapt plan, review, verify, orchestrate, and natural-language routing

**Files:**

- Create: `src/orchestrator/conversation/services.ts`
- Create: `src/orchestrator/conversation/plan-policy.ts`
- Create: `src/orchestrator/conversation/review-policy.ts`
- Create: `src/orchestrator/conversation/verify-policy.ts`
- Create: `src/orchestrator/conversation/orchestrate-policy.ts`
- Create: `src/orchestrator/conversation/router.ts`
- Create: `src/orchestrator/conversation/bootstrap.ts`
- Create: `src/verify/core.ts`
- Create: `scripts/assert-vf-confidence.ts`
- Modify: `src/commands/verify.ts`
- Modify: `src/commands/tools-detect.ts`
- Modify: `src/commands/plan.ts`
- Modify: `src/commands/review.ts`
- Modify: `src/commands/orchestrate.ts`
- Create: `test/orchestrator/conversation-services.test.ts`
- Create: `test/orchestrator/conversation-router.test.ts`
- Create: `test/verify-core.test.ts`
- Create: `test/orchestrator/conversation-acceptance.test.ts`

- [ ] Extract one full structured verify core whose manifest includes toolchain, confidence, goal, evidence, test evidence, scope, skill, canary, implementation drift, coverage, sandbox, waiver, registry lock, review evidence, advisory E2E, marker, and journal results.
- [ ] Make the CLI and policy adapters consume the same verify core. Do not call the existing partial async collector as an authority.
- [ ] Add `scripts/assert-vf-confidence.ts`, a thin machine oracle over the same structured verify core. `--expected 1` reruns the authoritative calculation, prints the exact computed confidence and gate JSON, and exits nonzero unless it equals `1`; it does not create a second verifier or change existing CLI threshold behavior.
- [ ] Add injected structured wrappers around existing plan, review, and orchestrate library functions; never spawn nested `vf` processes.
- [ ] Preserve the existing human-only review guard and current-head review evidence semantics.
- [ ] Add plan artifact create/update and review resolution events with opaque evidence references.
- [ ] Orchestrate dry-run never requires approval. Execute requests a correlated approval token and runs existing work units only after a matching approval.
- [ ] Operation cancel delegates to the runtime-owned controller/handles and returns typed results.
- [ ] Implement deterministic Phase-2 intent routing for representative direct, plan, brainstorm/debate, review, verify, and execute phrases. Explicit policy always wins; unknown intent defaults to direct.
- [ ] Implement concrete Phase-3 routing signals: explicit role/participant overrides first; then execute verbs plus ready workflow state; verify/test/gate intents; review/audit intents; plan/design/spec intents; debate/compare/options/trade-off intents or multiple requested roles; attachment/skill-domain role matching; finally direct. Normalize without locale-sensitive comparison, use a frozen tie precedence, consider only ready/admitted engines, and table-test every tie/fallback.
- [ ] Compose the production service in `bootstrap.ts`: one trace/artifact authority, canonical binding/session adapters, and registered direct/debate/plan/review/verify/orchestrate policies. CLI and server receive this same service factory; tests may inject process/service dependencies but not replace its authority layers in end-to-end acceptance.
- [ ] Add acceptance tests with injected services: chat → plan artifact → approval → existing work units → review → full verify → artifacts/trace.
- [ ] Prove no duplicate ledger, review, or verification state is introduced.
- [ ] Run focused service/router/verify/acceptance tests, legacy plan/review/orchestrate/verify tests, typecheck, Biome, file-size check, and diff check.

---

### Task 8: Add authenticated conversation HTTP, SSE, and artifact routes

**Files:**

- Create: `src/server/conversation-auth.ts`
- Create: `src/server/conversation-route.ts`
- Create: `src/server/conversation-sse.ts`
- Create: `src/server/conversation-artifact.ts`
- Modify: `src/server.ts`
- Create: `test/server-conversation-auth.test.ts`
- Create: `test/server-conversation-route.test.ts`
- Create: `test/server-conversation-sse.test.ts`
- Create: `test/server-conversation-artifact.test.ts`

**Routes:**

```text
POST /api/conversations
POST /api/conversations/:id/messages
POST /api/conversations/:id/pause
POST /api/conversations/:id/stop
POST /api/conversations/:id/resume
POST /api/conversations/:id/approvals/:approval_id/resolve
POST /api/conversations/:id/operations/:operation_id/cancel
POST /api/conversations/:id/stream-token
GET  /api/conversations/:id/events
GET  /api/conversations/:id/snapshot
GET  /api/conversations/:id/artifacts/:artifact_id
```

- [ ] Build strict, bounded DTO parsers with exact keys and 400 validation results. Avoid the shared JSON parse in the capped legacy mutation router.
- [ ] Add a process-local HttpOnly/SameSite session capability plus existing CSRF requirement on loopback. Fail closed for conversation routes on LAN unless an explicit server-side session capability is supplied; never call the public HTML meta token authentication.
- [ ] Require session auth for create/mutations/snapshot/artifact/token renewal. Return 401/404/409 exactly as frozen; mutation success is 202.
- [ ] On `POST /messages`, ACTIVE means injection while COMPLETED means reject/revise: create the child revision through the service, return 202 with the frozen MessageResponse body plus a child-conversation `Location` header, and never mutate/reopen the parent. Other terminal states return 409.
- [ ] Issue random conversation-bound stream credentials with at least 256 bits, store only digests, expire after 15 minutes, compare in constant time, and never log/render/persist token values.
- [ ] SSE accepts only the stream token. Reject invalid, expired, and cross-conversation tokens with 401.
- [ ] Validate `Last-Event-ID`/`since` as safe nonnegative integers; reject conflicting cursors. Replay canonical journal events `seq > cursor` ascending, then live events exactly once.
- [ ] Emit typed `trace`, `snapshot`, `error`, and `heartbeat` frames with correct IDs/headers; clean timer/subscription on abort and stream cancellation.
- [ ] Route artifact reads only through the runtime registry; reject unknown, cross-conversation, traversal, symlink, non-regular, and over-size targets without exposing internal paths.
- [ ] Keep server glue minimal: one injected `ConversationService`/authority and one early route delegation after pathname parse.
- [ ] Run focused server tests, full legacy server/SSE tests, typecheck, Biome, file-size check, and diff check.

---

### Task 9: Replace the Ask launcher with a generic conversation workspace

**Files:**

- Create: `src/ui/src/conversation-types.ts`
- Create: `src/ui/src/conversation-api.ts`
- Create: `src/ui/src/conversation-store.ts`
- Create: `src/ui/src/composables/useConversationStream.ts`
- Create: `src/ui/src/components/ChatWorkspace.vue`
- Create: `src/ui/src/components/ConversationPanel.vue`
- Create: `src/ui/src/components/TraceDrawer.vue`
- Create: `src/ui/src/components/DecisionMatrix.vue`
- Create: `src/ui/src/components/ArtifactCard.vue`
- Modify: `src/ui/src/App.vue`
- Modify: `src/ui/src/components/TopBar.vue`
- Preserve: `src/ui/src/components/AskCard.vue`
- Create: `src/ui/src/test/ui-conversation-store.test.ts`
- Create: `src/ui/src/test/ui-conversation-components.test.ts`
- Create: `test/ui-conversation-contract.test.ts`

- [ ] Write RED reducer tests for ordered sequence application, duplicate/out-of-order suppression, stale snapshot refusal, lifecycle controls, approval/operation updates, and reconnect cursor preservation.
- [ ] Keep the session/stream tokens in memory only. Renewal closes/reopens EventSource with the prior cursor and never serializes a token into state, DOM text, log, or error.
- [ ] Build API functions only for public DTOs and opaque artifact IDs; do not call legacy `readFile(path)` for conversation artifacts.
- [ ] Render messages/rounds and direct streamed deltas in `ConversationPanel`.
- [ ] Render artifact cards for plan/work units/diff/tests/synthesis/transcript using authenticated opaque fetches.
- [ ] Render a trace drawer preserving role, skill, engine, public session status, evidence, operation, and attempt correlation without raw control fields.
- [ ] Render decision matrix rank/components/aggregate in `[0,1]`, baseline status/divergence, and null/empty states deterministically.
- [ ] Add pause/resume/stop/inject/approval/cancel controls gated by lifecycle and operation state; surface server 202/409 outcomes without optimistic illegal transitions.
- [ ] Add a completed-conversation “revise/reject” message control that follows the returned child `Location`, switches the store to the new conversation, and visibly preserves the parent link.
- [ ] Replace the top-level `AskCard` launcher with `ChatWorkspace`; retain AskCard as compatibility code and reuse established drawer/artifact visual patterns.
- [ ] Use Vue text interpolation only, preserve keyboard/focus behavior, label mutation controls, and support reduced motion.
- [ ] Run UI unit/contract tests, `bun run --cwd src/ui build`, root typecheck/Biome, and diff check.

---

### Task 10: Prove Phase 3, full trace acceptance, docs, and ship gates

**Files:**

- Create: `test/brainstorm-e2e.test.ts`
- Create or modify: `e2e/conversation.spec.ts`
- Modify: `playwright.config.ts` only to point the real app at deterministic fake engine executables/process seams
- Modify: `docs/COMMAND_REFERENCE.md`
- Modify: `docs/USER_GUIDE.md`
- Modify: `README.md`
- Create: `docs/adr/ADR-008-conversation-runtime-authority.md`
- Create via CLI: `.vibeflow/skills/runtime-portable-process-fixtures/SKILL.md` (DRAFT only)

- [ ] Drive the production adapters for all five engines through injected fake process executables/spawners. Assert real production argv/stdin/cwd/tool/sandbox/env/capability parsing for Claude, Codex, Copilot, OpenCode, and Antigravity; prove Claude/Codex exact resume/history reconciliation and explicit `unavailable` status for unsupported history. Do not replace `EngineSessionAdapter` or call live providers.
- [ ] Test role overlay inheritance, model/tool/sandbox execution (not metadata only), Phase admission, selected-engine credential scrub, and every frozen advanced-routing precedence/fallback.
- [ ] Add a full trace-chain assertion: conversation → coordinator → policy → participant/role → skill → engine → native-session status → tool/action → evidence → response/artifact.
- [ ] Assert every required safe correlation field survives public projection and every forbidden raw field/reference is absent from CLI/API/snapshot/SSE/marker/evidence.
- [ ] Add control/recovery/concurrency tests: crash ambiguity, explicit resume, pause preservation, stop terminality, targeted inject, reject-as-new-revision, idempotent approval, operation-owned cancel, reconnect replay, no gap/duplicate.
- [ ] Run Playwright against the real `ConversationService`, runtime, trace store, HTTP/SSE/auth, and Vue UI, injecting only the engine process seam. Cover create → streamed response, forced reconnect, plan/approval/verify artifacts, debate trace, decision matrix, focus, keyboard, and mutation controls; a fake ConversationService is forbidden because it would bypass the acceptance path.
- [ ] Document exact CLI syntax, dry-run/JSON/exit mapping, conversation routes/auth/token expiry, UI flow, policies, resume semantics, engine capability matrix, and security limitations.
- [ ] Record the single-writer/opaque-artifact/session-auth decision with `vf decision add`.
- [ ] Capture one reusable recovery/procedure as a DRAFT skill with `vf skills draft`; do not promote/install automatically.
- [ ] Run independent spec review followed by independent quality/security review. Reproduce every finding before changing code; rerun focused tests after each fix.
- [ ] Run the fresh full gate set on final HEAD:

```bash
bun run build
bun run typecheck
bun run lint
bun run file-size:check
bun run waiver:check
bun run test
bun run coverage:check
bun run test:e2e
git diff --check
```

- [ ] Record current-HEAD independent review evidence against the full `origin/main` SHA.
- [ ] Ingest only newly completed units; do not re-dispatch or re-ingest already-consumed foundation epochs. Add fresh, machine-verifiable evidence and set confidence to 1.0 only after the corresponding acceptance is green.
- [ ] Run `vf verify --coverage --review-base <full-origin-main-sha>` for the repository gate, then `/opt/homebrew/bin/bun run scripts/assert-vf-confidence.ts --expected 1 --coverage --review-base <full-origin-main-sha>` and require JSON proving computed confidence is exactly `1.0` over the same structured core.
- [ ] Commit with Conventional Commits, push the branch, open a feature PR, watch final-SHA CI/reviews, reproduce and fix findings, resolve only addressed threads, and merge when required checks are green and repository authority permits.

## Task-contract handoff template

Every implementer prompt must contain:

- Goal: one-sentence behavior outcome.
- Scope: exact owned files; other workers are active and their edits must not be reverted.
- Forbidden: no writes outside ownership and no parallel authority.
- File pointers: relevant spec section, interfaces above, existing seams/tests.
- Must-haves: the checked behaviors for that task.
- Non-goals: later dependent tasks.
- Verify oracle: exact focused commands plus diff check.
- Budget: advisory time/scope target; never invent cost/token telemetry.
- Output: changed files, RED/GREEN evidence, risks, and open questions.

## Review and acceptance protocol

For every task:

1. Implementer demonstrates a failing RED test for the missing behavior.
2. Implementer makes the minimum cohesive implementation and demonstrates GREEN focused tests.
3. A different agent checks only Draft v7/spec compliance and returns approve/findings.
4. After spec approval, a different agent checks code quality, security, tests, and repository conventions.
5. The coordinator verifies the real diff and commands, records evidence, and commits the accepted unit.
6. Later integration changes that touch an accepted unit require a focused regression run and fresh current-HEAD review evidence; they do not re-consume the old dispatch epoch.
