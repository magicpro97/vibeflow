# Brainstorm & Debate Feature Design

**Date:** 2026-08-17
**Status:** Draft v7 (contract-complete)
**Approach:** Phased (0→1→2→3)

## Overview

Brainstorm/debate la orchestration policy trong VibeFlow's existing architecture. Khong tao vertical stack rieng. Coordinator thuoc `src/orchestrator/`, journal la generic trace events, chat/API la generic conversation surface.

**V7 integration invariants (normative):** one existing dispatch pipeline serves legacy/chat/workflow entrypoints; no parallel vertical stack. One canonical RoleSpec loader and one canonical skill resolver are authoritative. Trace journal is canonical conversation history; logbus alone is its mirror. Existing `WORKFLOW_STATE` remains canonical workflow ledger; confidence, evidence, review, and verify gates remain authoritative. All entrypoints share conversation, workflow, operation, and attempt identities.

**Architecture:**
```
Chat UI / vf chat
        │
        ▼
Conversation Orchestrator (src/orchestrator/)
        │
        ├── direct/ask policy
        ├── brainstorm/debate policy     ← THIS FEATURE
        ├── plan policy
        ├── execute/orchestrate policy
        ├── review policy
        └── verify policy
        │
        ▼
Canonical Context + RoleSpec + Skills
        │
        ▼
Engine Session Adapter (src/dispatch/)
Claude / Codex / Copilot / OpenCode / Antigravity
        │
        ▼
Canonical Trace Events
        ├── native CLI session history
        ├── evidence/artifacts
        ├── logbus/SSE
        └── chat UI / workflow dashboard
```

## Engine Capability Matrix

| Engine | Upstream Exact Resume | Emits/Assigns ID | Adapter Captures | Adapter Consumes | Safe ReadOnly | Phase |
|--------|----------------------|------------------|------------------|------------------|--------------|-------|
| Claude | `--resume <id>` | yes | yes | yes | verified | 0 |
| Codex | `resume <id>` | yes | yes | yes | verified | 0 |
| Copilot | `--resume=<id>` / `--session-id` | yes | no | no | unverified | 3 |
| OpenCode | `--session <id>` | yes | yes | no | unverified | 3 |
| Antigravity | `--conversation <id>` | yes | no | yes | unverified | 3 |

**Resume Modes:** `exact` (by-ID) | `replay` (fresh + context) | `fresh` (always new)

## Trace Envelope + Event (Separated)

Runtime owns correlation identity and append-assigned fields. Policy/caller owns only stable `idempotency_key` and event.

```typescript
type Engine = "claude" | "codex" | "copilot" | "opencode" | "antigravity";
type ConversationLifecycle = "INIT" | "ACTIVE" | "PAUSED" | "COMPLETED" | "STOPPED" | "FAILED" | "ABORTED";
type ConversationHealth = "healthy" | "degraded";
type TerminalLifecycle = "COMPLETED" | "STOPPED" | "FAILED" | "ABORTED";

interface TraceCorrelation { workflow_id: string; conversation_id: string; revision_id: string; run_id: string; turn_id: string; operation_id: string; attempt_id: string; unit_id?: string; participant_id?: string; role_ref?: string; role_resolved_hash?: string; skill_refs?: string[]; skill_resolved_hashes?: string[]; engine?: Engine; evidence_refs?: string[]; parent_attempt_id?: string; }
interface TraceAppendInput { idempotency_key: string; event: TraceEvent; }
interface StoredTraceEvent extends TraceCorrelation { event_id: string; seq: number; ts: string; idempotency_key: string; event: TraceEvent; }
interface InternalTraceStoreRecord { stored_event: StoredTraceEvent; native_session_id: string | null; }
type PublicTraceEvent = PublicTraceProjection;
interface PublicTraceCorrelation { workflow_id: PublicText; conversation_id: PublicText; revision_id: PublicText; run_id: PublicText; turn_id: PublicText; operation_id: PublicText; attempt_id: PublicText; unit_id?: PublicText; participant_id?: PublicText; role_ref?: PublicText; role_resolved_hash?: PublicText; skill_refs?: PublicText[]; skill_resolved_hashes?: PublicText[]; engine?: Engine; evidence_refs?: OpaqueArtifactId[]; parent_attempt_id?: PublicText; }
interface PublicStoredTraceEvent extends PublicTraceCorrelation { event_id: PublicText; seq: number; ts: PublicText; public_session_ref: OpaqueSessionRef | null; event: PublicTraceEvent; }

type TraceEvent =
  | { type: "conversation_configured"; payload: ConversationConfiguredPayload }
  | { type: "coordinator_decision"; payload: CoordinatorDecisionPayload }
  | { type: "participant_bound"; payload: ParticipantBoundPayload }
  | { type: "skill_injected"; payload: SkillInjectedPayload }
  | { type: "precommit"; payload: PrecommitPayload }
  | { type: "agent_response_delta"; payload: AgentResponseDeltaPayload }
  | { type: "tool_action"; payload: ToolActionPayload }
  | { type: "evaluator_assessment"; payload: EvaluatorAssessmentPayload }
  | { type: "user_message"; payload: UserMessagePayload }
  | { type: "consensus_update"; payload: ConsensusUpdatePayload }
  | { type: "round_boundary"; payload: RoundBoundaryPayload }
  | { type: "state_change"; payload: StateChangePayload }
  | { type: "baseline_result"; payload: BaselineResultPayload }
  | { type: "synthesis_completed"; payload: SynthesisCompletedPayload }
  | { type: "conversation_terminal"; payload: ConversationTerminalPayload }
  | { type: "dry_run_result"; payload: DryRunResultPayload }
  | { type: "error"; payload: ErrorPayload }
  | { type: "operation_lifecycle"; payload: OperationLifecyclePayload }
  | { type: "approval_requested"; payload: ApprovalRequestedPayload }
  | { type: "approval_resolved"; payload: ApprovalResolvedPayload }
  | { type: "caller_cancelled"; payload: CallerCancelledPayload }
  | { type: "artifact_created"; payload: ArtifactCreatedPayload }
  | { type: "artifact_updated"; payload: ArtifactUpdatedPayload }
  | { type: "native_history_reconciled"; payload: NativeHistoryReconciledPayload };

declare const publicTextBrand: unique symbol;
declare const opaqueArtifactIdBrand: unique symbol;
declare const opaqueSessionRefBrand: unique symbol;
type PublicText = string & { readonly [publicTextBrand]: "PublicText" };
type OpaqueArtifactId = string & { readonly [opaqueArtifactIdBrand]: "OpaqueArtifactId" };
type OpaqueSessionRef = string & { readonly [opaqueSessionRefBrand]: "OpaqueSessionRef" };
type PublicProjection<T> = T extends string ? PublicText : T extends number | boolean | null ? T : T extends readonly (infer U)[] ? PublicProjection<U>[] : T extends object ? { [K in keyof T as K extends "native_session_id" | "prompt_template" | "raw_env" ? never : K]: K extends "public_session_ref" ? OpaqueSessionRef : K extends "ref" | "previous_ref" | "input_ref" | "output_ref" | "decision_matrix_ref" | "baseline_comparison_ref" ? OpaqueArtifactId | null : K extends "evidence_refs" | "provenance_refs" ? OpaqueArtifactId[] : PublicProjection<T[K]> } : never;
type PublicTraceProjection = { [T in TraceEvent as T["type"]]: { type: T["type"]; payload: PublicProjection<T["payload"]> } }[TraceEvent["type"]];
// Sole public constructor/redactor: brands public text, artifact IDs, and session references.
declare function projectPublicTrace<T extends TraceEvent>(event: T): Extract<PublicTraceProjection, { type: T["type"] }>;

type Participant = { participant_id: string; role_ref: string; engine: Engine; model: string | null };
interface ConversationConfiguredPayload { topic: string; participants: Participant[]; policy: string; max_rounds: number; }
interface CoordinatorDecisionPayload { selected_policy: string; reason: string; }
interface ParticipantBoundPayload { participant_id: string; engine: Engine; model: string | null; prompt_hash: string; tools: string[]; sandbox: string; }
interface SkillInjectedPayload { skill_refs: string[]; resolved_hashes: string[]; source: "repo" | "shared" | "builtin"; }
interface PrecommitPayload { round_id: string; participant_id: string; answer: string; evidence: string[]; }
interface AgentResponseDeltaPayload { round_id: string; participant_id: string; content_delta: string; final_claim: string | null; final_evidence: string[]; completes_response: boolean; }
interface ToolActionPayload { tool: string; action: string; status: "started" | "completed" | "failed"; input_ref: string | null; output_ref: string | null; }
interface EvaluatorAssessmentPayload { round_id: string; stage: "blind" | "full"; assessment: EvaluatorOutput; }
interface UserMessagePayload { content: string; target_participants: string[] | "all"; }
interface ConsensusUpdatePayload { round_id: string; decision: RoundDecision; }
interface RoundBoundaryPayload { round_id: string; phase: "start" | "end"; }
interface NativeHistoryReconciledPayload { public_session_ref: string; status: "reconciled" | "partial" | "unavailable"; imported_turn_count: number; imported_tool_count: number; provenance_refs: string[]; evidence_refs: string[]; completeness_reason: string; }
interface StateChangePayload { lifecycle: ConversationLifecycle; health: ConversationHealth; terminal: boolean; reason: string | null; }
interface BaselineResultPayload { status: "success" | "failed" | "skipped"; answer: string | null; confidence: number | null; skip_reason: string | null; }
interface SynthesisCompletedPayload { decision_matrix_ref: string; baseline_comparison_ref: string; }
interface ConversationTerminalPayload { lifecycle: TerminalLifecycle; terminal: true; final_score: number | null; }
interface DryRunResultPayload { participants: Array<Participant & { engine_available: boolean; model_valid: boolean }>; evaluator_auto_added: boolean; engines_available: Engine[]; models_valid: boolean; }
interface ErrorPayload { agent_id: string | null; code: string; message: string; }
interface OperationLifecyclePayload { operation_id: string; attempt_id: string; state: "requested" | "dispatched" | "acknowledged" | "completed" | "ambiguous"; }
interface ApprovalRequestedPayload { token: ApprovalToken; description: string; }
interface ApprovalResolvedPayload { decision: ApprovalDecision; }
interface CallerCancelledPayload { operation_id: string; actor: string; reason: string | null; }
interface ArtifactCreatedPayload { artifact_id: string; artifact_type: "decision_matrix" | "plan" | "diff" | "tests" | "synthesis" | "transcript"; ref: string; }
interface ArtifactUpdatedPayload { artifact_id: string; artifact_type: string; ref: string; previous_ref: string; }
```

Only write path: `PolicyEmission -> existing dispatch runtime -> ConversationOrchestrator store append`. Policies, routes, and callers cannot call store. Runtime supplies `TraceCorrelation`; emission supplies `TraceAppendInput`. Under store lock, append first looks up `(conversation_id, idempotency_key)`: byte-equivalent `TraceAppendInput` duplicate returns original `StoredTraceEvent`; different input with same key is conflict. New append assigns fresh `event_id`, next monotonic conversation `seq`, and append-time ISO-8601 `ts`. Raw `native_session_id` exists only in `InternalTraceStoreRecord` and internal resume channel; projection creates opaque `public_session_ref`.

Fold deltas by ascending `seq` per `(round_id,participant_id)`: concatenate `content_delta`, require exactly one completion and no later delta, permit claim/evidence only on completion, and stable-first deduplicate evidence. Any violation fails projection closed. Completed Round requires all responses complete, blind/full assessment, `consensus_update`, then end boundary.

```typescript
interface PolicyEmission { idempotency_key: string; event: TraceEvent; }
```

## Consensus — Single Normative Contract

```typescript
interface BooleanGate { value: boolean; evidence: string; }
interface ConvergenceGate { value: boolean | "not_applicable"; evidence: string; }
interface EvaluatorOutput { agreement: BooleanGate; conflict_resolution: BooleanGate; evidence_quality: BooleanGate; convergence: ConvergenceGate; }
type RoundDecision =
  | { outcome: "abort"; score: null; reason: "invalid_assessment" }
  | { outcome: "consensus" | "continue" | "exhausted"; score: number };

function decideRound(input: unknown, round: unknown, maxRounds: unknown): RoundDecision {
  const invalid = (): RoundDecision => ({ outcome: "abort", score: null, reason: "invalid_assessment" });
  if (typeof round !== "number" || typeof maxRounds !== "number" || !Number.isInteger(round) || !Number.isInteger(maxRounds) || round < 1 || maxRounds < 1 || round > maxRounds || typeof input !== "object" || input === null) return invalid();
  const a = input as Record<string, unknown>;
  const names = ["agreement", "conflict_resolution", "evidence_quality", "convergence"];
  const gate = (x: unknown, convergence = false): x is { value: boolean | "not_applicable"; evidence: string } => typeof x === "object" && x !== null && Object.keys(x).length === 2 && "value" in x && "evidence" in x && typeof (x as Record<string, unknown>).evidence === "string" && (convergence ? (typeof (x as Record<string, unknown>).value === "boolean" || (x as Record<string, unknown>).value === "not_applicable") : typeof (x as Record<string, unknown>).value === "boolean");
  if (Object.keys(a).length !== 4 || !names.every(name => name in a) || !gate(a.agreement) || !gate(a.conflict_resolution) || !gate(a.evidence_quality) || !gate(a.convergence, true) || (round > 1 && a.convergence.value === "not_applicable")) return invalid();
  const active = round === 1 ? [a.agreement.value, a.conflict_resolution.value, a.evidence_quality.value] : [a.agreement.value, a.conflict_resolution.value, a.evidence_quality.value, a.convergence.value as boolean];
  const score = active.filter(Boolean).length / active.length;
  if (active.every(Boolean)) return { outcome: "consensus", score };
  return round === maxRounds ? { outcome: "exhausted", score } : { outcome: "continue", score };
}
```

Validation is exact: `input` has only required `agreement`, `conflict_resolution`, `evidence_quality`, `convergence` fields; each has boolean `value` and string `evidence`, except convergence may be `"not_applicable"`; evidence strings may be empty. `round` and `maxRounds` are positive integers and `round <= maxRounds`. Any failure, including extra or missing fields, aborts. Round 1 ignores V. Round 2+ requires boolean V; `not_applicable` aborts.

### 64-case generator oracle (normative)

Vectors, lexicographic (`T` before `F`): `TTTT, TTTF, TTFT, TTFF, TFTT, TFTF, TFFT, TFFF, FTTT, FTTF, FTFT, FTFF, FFTT, FFTF, FFFT, FFFF`. For vector index `v` (1..16), round class `r` (`0=round1`, `1=round2+`), and finality `f` (`0=nonfinal`, `1=final`), unique case number is `1 + 4*(v-1) + 2*r + f`. Generator order is vector × `round1|round2+` × `nonfinal|final`.

For each case, set `round=1,maxRounds=2` when `r=0,f=0`; `round=1,maxRounds=1` when `r=0,f=1`; `round=2,maxRounds=3` when `r=1,f=0`; `round=2,maxRounds=2` when `r=1,f=1`. Round 1 active gates are A,C,E, so `count=A+C+E` and stored score is exact raw quotient `count/3`; V remains supplied but ignored. Round 2+ active gates are A,C,E,V, so `count=A+C+E+V` and stored score is exact raw quotient `count/4`. Presentation rounding is not stored oracle data. All active gates true gives `consensus`; otherwise `final` gives `exhausted` and `nonfinal` gives `continue`.

Malformed-input aborts and round-2+ `V="not_applicable"` aborts are separate unnumbered tests: `{ outcome: "abort", score: null, reason: "invalid_assessment" }`. They are not members of the 64.

**Final Score:** Last completed round raw score. Average is UI trend only.

**Two-Stage Evaluator:**
1. Blind: fresh context, sees ONLY precommits + evidence. Immutable.
2. Full: sees blind assessment + anonymized peer positions. Drives decideRound().

**Baseline:** Divergence/robustness signal, NOT correctness oracle.

## State Machine

**Independent enums:** `ConversationLifecycle`, `ConversationHealth`, and `TerminalLifecycle` are declared once in Trace Envelope + Event. Degraded is health, never lifecycle.

**Lifecycle transitions:**

| From | To | Trigger |
|---|---|---|
| INIT | ACTIVE | first round starts |
| INIT | STOPPED | user stop command |
| ACTIVE | PAUSED | user pause command, regardless of health |
| ACTIVE | COMPLETED | consensus reached |
| ACTIVE | STOPPED | user stop command |
| ACTIVE | FAILED | terminal policy/runtime failure |
| ACTIVE | ABORTED | abort/interruption |
| PAUSED | ACTIVE | user resume command, regardless of health |
| PAUSED | STOPPED | user stop command |
| PAUSED | FAILED | terminal policy/runtime failure |
| PAUSED | ABORTED | abort/interruption |

Health may change between `healthy` and `degraded` while ACTIVE or PAUSED. It emits health data, not a lifecycle transition.

**Terminal states:** COMPLETED, STOPPED, FAILED, ABORTED (immutable). Stop against terminal state returns 409.

**User reject:** Creates new `run_revision` (new conversation_id, linked via parent).

## Phase 1 Decision Freeze

**Effective until Phase 1 complete. Changes require explicit user approval.**

### 1. Final Round: consensus vs exhausted?

Valid assessment → consensus gates → if reached → consensus. If not reached and round >= maxRounds → exhausted.

### 2. JSON dry-run shape?

Discriminated union. `--json` always outputs exactly one document.

```typescript
// --- Constituent types ---

interface DryRunParticipant {
  participant_id: string;
  role_ref: string;
  engine: Engine;
  model: string | null;
  engine_available: boolean;
  model_valid: boolean;
}

interface DryRunResult {
  participants: DryRunParticipant[];
  evaluator_auto_added: boolean;
  engines_available: Engine[];
  models_valid: boolean;
}

interface RoundResponse {
  participant_id: string;
  content: string;
  claim: string;
  evidence: string[];
}

interface RoundAssessment {
  stage: "blind" | "full";
  assessment: EvaluatorOutput;
}

interface Round {
  round_id: string;
  participant_responses: RoundResponse[];
  evaluator_assessments: RoundAssessment[];
  decision: RoundDecision;
}

// score:null only when outcome is "abort"
// (RoundDecision defined above in Consensus section)

interface DecisionMatrixRow {
  option: string;
  scores: Record<string, number>;
  aggregate: number;
  rank: number;
}

interface DecisionMatrix {
  rows: DecisionMatrixRow[];
  method: "weighted_sum";
  generated_at: string;  // ISO-8601
}

interface BaselineComparison {
  status: "success" | "failed" | "skipped";
  baseline_answer: string | null;
  debate_answer: string | null;
  divergence: number | null;  // 0..1, null when skipped
  skip_reason: string | null;
}

interface BrainstormOutput {
  version: "1.0";
  conversation_id: string;
  status: "completed" | "stopped" | "failed" | "aborted";
  dry_run: false;
  rounds: Round[];
  consensus_score: number | null;
  consensus_average: number | null;  // UI trend only
  decision_matrix: DecisionMatrix | null;
  baseline_comparison: BaselineComparison;
  transcript_path: string | null;
  error: null | { error_kind: "validation" | "engine_start" | "transport"; code: string; message: string };
}

type BrainstormCLIOutput =
  | { status: "dry_run"; dry_run: true } & DryRunResult
  | { status: "completed"; dry_run: false } & Omit<BrainstormOutput, "status" | "dry_run">
  | { status: "stopped";   dry_run: false } & Omit<BrainstormOutput, "status" | "dry_run">
  | { status: "failed";    dry_run: false } & Omit<BrainstormOutput, "status" | "dry_run">
  | { status: "aborted";   dry_run: false } & Omit<BrainstormOutput, "status" | "dry_run">
  | { status: "error"; error: { error_kind: "validation" | "engine_start" | "transport"; code: string; message: string } };
```

**Exit codes:**

| output result | exit_code |
|---|---:|
| dry_run, completed, stopped | 0 |
| error.error_kind = validation | 1 |
| error.error_kind = engine_start (pre-conversation engine spawn or startup timeout) | 2 |
| error.error_kind = transport (API/transport) | 3 |
| failed (terminal policy/runtime failure) | 4 |
| aborted (abort/interruption) | 5 |

### 3. Phase 1 has profiles?

No separate profile system. `role@engine` is optional engine override; omitted participants use coordinator defaults. RoleSpec overlays/profile UX start Phase 3 by extending canonical `.vibeflow/roles/` resolution.

### 4. Crash after engine receives prompt but before journal logs response?

Mark `ambiguous` state. Do NOT auto-resend. User must explicit `--resume` or retry.

**Lifecycle per operation:** `requested -> dispatched -> acknowledged | completed | ambiguous`

### 5. Multi-turn command semantics (frozen)

| Command       | State transition       | Resumable? | Notes |
|---------------|------------------------|------------|-------|
| `pause`       | ACTIVE→PAUSED | Yes | Regardless of health; preserves all AttemptHandles; participant native sessions remain internal |
| `resume`      | PAUSED→ACTIVE | N/A | `--resume` takes `conversation_id`; rehydrates persisted bindings; ambiguous ops never replay |
| `stop`        | INIT/ACTIVE/PAUSED→STOPPED | No | Terminal; aborts AttemptHandles; terminal stop returns 409 |
| `user inject` | stays ACTIVE           | N/A        | Targeted to participant list or "all" |
| `user reject` | stays COMPLETED        | N/A        | Creates new revision (new conversation_id, parent link) |

Participant native sessions are internal implementation detail — never exposed in CLI output or API response.

### 6. Single-writer API + double-append prevention

**Policy:** ConversationOrchestrator is sole trace append authority. No external caller writes to the event store directly.

**Idempotency:** Caller supplies `idempotency_key` in TraceAppendInput. Under store lock, a byte-equivalent `TraceAppendInput` duplicate for `(conversation_id, idempotency_key)` returns the original `StoredTraceEvent` without append; same key with different input is conflict.

**Persisted response deltas:** Each `agent_response_delta` event includes only the delta since the participant's last response (not full conversation context). Context reconstruction is the projector's job.

### 7. Conversation request/response DTOs

```typescript
// --- API DTOs ---

interface ConversationCreateRequest {
  topic: string;
  policy?: string;  // explicit override
  participants?: Array<{ role_ref: string; engine: string; model?: string }>;
  max_rounds?: number;
}

interface ConversationCreateResponse {
  conversation_id: string;
  stream_token: string;       // conversation-bound, expires in 15min
  stream_token_expires_at: string;  // ISO-8601
}

interface MessageRequest {
  content: string;
  target_participants?: string[] | "all";
}

interface MessageResponse {
  message_id: string;
  accepted: true;
}

interface StopRequest {}  // empty body

interface StopResponse {
  stopped: true;
  terminal_state: "STOPPED";
}

interface ResumeRequest {}  // URL :id keys resume

interface ResumeResponse {
  resumed: true;
  active_state: "ACTIVE";
}

interface PauseRequest {}
interface PauseResponse { paused: true; lifecycle: "PAUSED"; }
type ApprovalOutcome = "approve" | "reject";
interface ApprovalToken { approval_id: string; operation_id: string; actor: string; }
interface ApprovalDecision extends ApprovalToken { outcome: ApprovalOutcome; reason: string | null; }
interface ApprovalResolveRequest extends ApprovalDecision {}
interface ApprovalResolveResponse extends ApprovalDecision { resolved: true; }
interface OperationCancelCommand { conversation_id: string; operation_id: string; actor: string; reason: string | null; }
type ApprovalResolveResult =
  | { status: 202; body: ApprovalResolveResponse }
  | { status: 404; body: { code: "approval_not_found" } }
  | { status: 409; body: { code: "approval_route_body_mismatch" | "approval_operation_mismatch" | "approval_conflict" } };
type OperationCancelResult =
  | { status: 202; body: { operation_id: string; cancelled: true } }
  | { status: 404; body: { code: "operation_not_found" } }
  | { status: 409; body: { code: "operation_route_body_mismatch" | "operation_conversation_mismatch" | "operation_not_cancellable" } };

interface StreamTokenRenewalResponse {
  stream_token: string;
  stream_token_expires_at: string;
}

// --- Snapshot projection ---

interface ConversationSnapshot {
  conversation_id: string;
  lifecycle: ConversationLifecycle;
  health: ConversationHealth;
  policy: string;
  topic: string;
  participants: Array<{ participant_id: string; role_ref: string; engine: string; model: string | null; public_session_ref: OpaqueSessionRef | null }>;
  rounds: Round[];
  consensus_score: number | null;
  last_seq: number;
}

// --- SSE frames ---

type SSEFrame =
  | { id: string; event: "trace";     data: PublicStoredTraceEvent } // id = seq as string
  | { id: string; event: "snapshot";  data: ConversationSnapshot }
  | { event: "error"; data: { code: string; message: string } }
  | { event: "heartbeat"; data: "" };

// SSE cursor: client sends `Last-Event-ID` header (or `?since=<seq>`); reject conflicting values.
// Server deterministically replays ascending events with seq > cursor, then live PublicStoredTraceEvent frames.
```

### 8. CLI exit code mapping

Exit code maps only to Decision Freeze #2 table above. Failed and aborted are distinct terminal outputs.

### 9. Baseline selection/skip rules

- **Run:** Single-agent answer using same topic, first participant's engine+model, no debate context.
- **Projection input:** Ascending-`seq` `StoredTraceEvent` only. A completed round has `round_boundary.phase="end"` and a non-abort `consensus_update`; response material is its persisted `agent_response_delta` records, ordered by `(seq, participant_id)`. No wall clock, randomness, locale-sensitive ordering, or model call.
- **DecisionMatrix:** Null when no completed non-empty claim exists. Otherwise normalize each non-empty claim with Unicode NFKC, Unicode trim, whitespace-collapse to ASCII space, then locale-independent lowercase. Group equal keys. Display `option` is smallest normalized original claim by Unicode code-point order. Response score is grouped response count divided by total grouped responses; evidence score is grouped evidence-entry count divided by total grouped evidence entries; zero denominator yields 0. Each evaluator gate score is its applicable full-assessment true count divided by its applicable full-assessment count (`not_applicable` excluded); empty population is 0. Thus every component score is 0..1. Fixed weights sum to 1: responses .20, evidence .10, agreement .25, conflict_resolution .20, evidence_quality .15, convergence .10. Aggregate is weighted sum, 0..1. Round decimal half-up to 6 places. `generated_at` is highest consumed event `ts`. Sort aggregate descending, raw response count descending, option key ascending; assign ordinal rank 1..n.
- **Skip precedence:** `--no-baseline` (`disabled`), then one non-evaluator participant (`single_participant`), then unavailable selected engine (`engine_unavailable`). First match returns skipped with null divergence. Otherwise: no completed debate answer returns failed with `no_debate_answer`; a missing persisted `baseline_result` returns failed with `baseline_missing`; a persisted failed baseline event returns failed with its persisted reason; a persisted success event supplies the baseline answer and computes divergence. Debate answer is rank-1 option only when a completed non-empty claim exists.
- **Divergence:** Normalize both answers as option text; split on `/[^\p{L}\p{N}]+/u`, discard empties, form token sets. `1 - intersection/union`; both empty=0, exactly one empty=1; decimal half-up to 6 places. Same ordered journal produces byte-equivalent semantic projection.

### 10. AgentBinding materialization

```typescript
type SessionMode = "exact" | "replay" | "fresh";
interface EnvPolicy { allow?: string[]; deny?: string[]; } // existing filter-compatible rules
type ToolIntent = "read" | "write" | "edit" | "bash" | "grep" | "glob" | "web";
type RoleModel = "haiku" | "sonnet" | "opus" | "gpt-5.4" | "gpt-5.4-mini" | "gpt-5.3-codex-spark" | "gpt-5.4-codex";
type RoleSandbox = "read-only" | "workspace-write" | "danger-full-access";
interface RoleSpec { name: string; description: string; body: string; tools: ToolIntent[]; model: RoleModel; sandbox?: RoleSandbox; }
interface ResolvedRole { spec: RoleSpec; source: string; resolved_hash: string; metadata: Record<string, string>; }
interface ResolvedSkill { ref: string; source: "repo" | "shared" | "builtin"; version: string | null; resolved_hash: string; }

interface AgentBinding {
  roleRef: string;
  engine: Engine;
  modelOverride?: string;
  sessionMode: SessionMode;
  additionalSkillRefs?: string[];
}
interface ResolvedAgentBinding {
  role: ResolvedRole; skills: ResolvedSkill[]; engine: Engine; model: string | null; sessionMode: SessionMode;
  tool_intents: ToolIntent[]; sandbox: RoleSandbox | null; env_policy: EnvPolicy;
  provenance: { roleSource: string; roleHash: string; skillHashes: string[]; };
  trace_metadata: { role_resolved_hash: string; skill_resolved_hashes: string[]; };
}
interface SpawnOptionsProjection {
  engine: Engine; model: string | null; sessionMode: SessionMode; rendered_prompt: string; rendered_tools: string[]; sandbox: RoleSandbox | null; env_policy: EnvPolicy;
  provenance: ResolvedAgentBinding["provenance"]; trace_metadata: ResolvedAgentBinding["trace_metadata"];
}
```

Resolution order: canonical existing RoleSpec loader; canonical existing repo/shared/builtin skill discovery/resolution plus dispatch selection; modelOverride then required RoleModel through existing engine renderer; canonical env filter. `sessionMode` carries unchanged from `AgentBinding` to `ResolvedAgentBinding` to `SpawnOptionsProjection`. Resolved bindings retain canonical `tool_intents`; engine renderer creates internal `rendered_prompt` and `rendered_tools`; public trace retains prompt hash only. No second profile system. Skill provenance maps existing roots to `repo|shared|builtin`; `resolved_hash` covers effective `resolvedBody` plus ordered base/dependency hashes. Phase 1 adds dedicated built-in conversation/debate RoleSpecs with read-only sandbox; existing write-enabled roles are not mutated. Conversation launch extends canonical env filter/spawn with selected Engine context: retain selected-engine auth, scrub unrelated provider/GitHub credentials; non-conversation default unchanged.

### 11. Service seams (structured)

```typescript
interface PlanService {
  createPlan(context: ConversationContext): Promise<PlanArtifact>;
  updatePlan(context: ConversationContext, revision: PlanRevision): Promise<PlanArtifact>;
}

interface ReviewService {
  requestReview(context: ConversationContext, artifact: PlanArtifact): Promise<ReviewResolution>;
  // Legacy human-only guard remains. This does not repurpose `vf review evidence`.
}

interface VerifyService {
  runVerify(context: ConversationContext, artifact: PlanArtifact): Promise<PolicyVerifyReport>;
}

interface OrchestrateService {
  dryRun(context: ConversationContext): Promise<DryRunResult>;
  execute(context: ConversationContext, approval: ApprovalDecision | null): Promise<ConversationOrchestrationResult>;
  cancel(command: OperationCancelCommand): Promise<OperationCancelResult>;
}

interface ConversationContext {
  correlation: TraceCorrelation;
  topic: string;
  policy: string;
  bindings: ResolvedAgentBinding[];
  signal: AbortSignal; // runtime-owned operation controller
  emit: (emission: PolicyEmission) => Promise<StoredTraceEvent>; // sole runtime PolicyEmission path
}
interface PlanArtifact { artifact_id: string; revision_id: string; ref: string; }
interface PlanRevision { revision_id: string; content: string; reason: string | null; }
interface ReviewResolution { artifact_id: string; reviewer: string; outcome: "approved" | "changes_requested"; evidence_refs: string[]; }
interface VerifyGateResult { status: "pass" | "fail" | "warn" | "skipped"; details: string; evidence_refs: string[]; }
interface PolicyVerifyReport {
  toolchain: VerifyGateResult; confidence: VerifyGateResult; goal: VerifyGateResult; evidence: VerifyGateResult; test_evidence: VerifyGateResult; scope: VerifyGateResult; skill: VerifyGateResult; canary: VerifyGateResult; implementation_drift: VerifyGateResult; coverage: VerifyGateResult; sandbox: VerifyGateResult; waiver: VerifyGateResult; registry_lock: VerifyGateResult; review_evidence: VerifyGateResult; advisory_e2e: VerifyGateResult;
  marker_result: VerifyGateResult; journal_result: VerifyGateResult;
}
interface ConversationOrchestrationResult { operation_id: string; status: "completed" | "aborted" | "failed" | "awaiting_approval"; artifact_refs: string[]; }
```
Services are dependency-injection seams returning structured results; CLI compatibility facades are adapters. `dryRun` never requires approval. Runtime owns exactly one `AbortController` per operation, passes its signal through `ConversationContext`, and may link external caller signal once only. Cancel validates conversation/route/body identity, aborts only that controller once, terminates only its AttemptHandles, emits correlated `caller_cancelled`, and returns `OperationCancelResult`. Conversation DTO adapts existing `src/orchestrator/run.ts` `OrchestrationResult`; it does not replace it. VerifyService calls one extracted authoritative full structured verify core shared by CLI/API/policy, never partial `collectVerifyReportAsync`.

## CLI

`vf chat "request"` accepts topic alone. Phase 1 topic-only defaults to direct read-only chat; coordinator records `coordinator_decision`, selecting default built-in roles, preferred ready engine, and existing skills. Phase 2 routes representative natural-language plan/debate/review/verify/execute intents through registered policies. Explicit policy or participant overrides win. `vf ask` preserves file-range syntax and existing `--resume latest-native-session` through compatibility/internal resume channel. Only `vf chat` and `vf brainstorm --resume` take `conversation_id`; `vf ask --conversation <conversation-id>` is non-ambiguous.

**Converged invocation:**
```
vf chat              canonical conversational entry
vf ask               compatibility alias → direct policy
vf brainstorm        compatibility alias → debate policy
vf orchestrate       explicit automation/execution entry
```

All share same engine-session adapter. Coordinator selects policy; user doesn't need to understand modes.

**vf brainstorm syntax:**
```bash
vf brainstorm "topic"
  --participant believer@claude
  --participant skeptic@codex
  --participant domain-expert@claude
  --max-rounds 3
  --resume <conversation-id>
  --no-baseline
  --json
  --yes
```

**Rules:**
- Repeated `--participant role@engine[:model]`
- Exactly 1 evaluator auto-added if not explicit
- Minimum 2 non-evaluator participants
- Dry-run by default (`--yes` to dispatch)
- `--json`: single JSON document, suppress banners
- Exit codes per Decision Freeze #2

Claude/Codex adapters reconcile supported native CLI history on reload/resume and emit `native_history_reconciled`; unsupported history emits `unavailable`, never implicit completeness.

## Chat/API — Generic Conversation Surface

```
POST /api/conversations                    # create conversation
POST /api/conversations/:id/messages       # inject user message
POST /api/conversations/:id/pause          # pause session
POST /api/conversations/:id/stop           # stop session
POST /api/conversations/:id/resume         # resume session
POST /api/conversations/:id/approvals/:approval_id/resolve # resolve approval
POST /api/conversations/:id/operations/:operation_id/cancel # cancel operation
POST /api/conversations/:id/stream-token   # renew stream token (authenticated)
GET  /api/conversations/:id/events         # SSE stream (requires stream_token)
GET  /api/conversations/:id/snapshot       # full state (requires auth)
GET  /api/conversations/:id/artifacts/:artifact_id # authenticated allowed opaque artifact ID fetch
```

Each conversation stores current policy/mode. Generic, not brainstorm-specific.

**Approval/cancel semantics:** Resolve route `:approval_id` and body `approval_id` must match; body `operation_id` must match token's operation and conversation. Mismatch returns typed 409. First valid resolve emits correlated `approval_resolved`. Repeating byte-equivalent `ApprovalDecision` returns same typed 202 result without another emission; any other second decision returns typed 409. Cancel route `:operation_id` and body `operation_id` must match; operation must belong to `:id`. Runtime then uses only that operation's owned controller and handles as specified in Decision Freeze #11. Success emits one correlated `caller_cancelled` and returns typed 202; unknown operation returns typed 404; identity mismatch or terminal/non-cancellable operation returns typed 409.

**Auth/status matrix:** Session auth required for create, message, pause, stop, resume, approval resolve, operation cancel, snapshot, and stream-token renewal. SSE accepts only a 15-minute conversation-bound stream token. Invalid, expired, or cross-conversation token is 401; renewal only uses session-authenticated POST. Mutation success is 202 accepted; 401 is auth failure; 404 is unknown conversation, operation, or approval; 409 is invalid lifecycle, route/body identity mismatch, conflicting approval resolution, or non-cancellable operation.

**SSE:** Replay from conversation trace journal. Logbus is mirror only. Auth via short-lived stream credential (conversation-bound, 15min expiry). Renewal via authenticated POST endpoint.

**Stream token:** Issued in ConversationCreateResponse. Bearer token scoped to single conversation. Expired tokens get 401. Renewal requires session auth (not stream token).

**UI:** Upgrade AskCard → ChatWorkspace/ConversationPanel. Plan, work units, decision matrix, diff, tests as artifact cards. Workflow dashboard, log pane, skill panel as trace/detail drawer.

## Agent/Role Integration

**No separate profile system.** Use existing RoleSpec binding (AgentBinding defined above).

If inheritance/overlay needed → extend `.vibeflow/roles/` resolution, not separate namespace.

## Skills Integration (Phase 1)

**Must use existing skill resolver** (`src/commands/dispatch-runtime.ts:184`).

Phase 1 requirements:
- Use existing skill discovery/selection/injection
- Log `skill_injected` trace event with refs and hashes
- Store skill source/version/hash for traceability

## Security

**Phase 1:** Claude/Codex read-only + built-in roles only.

**Phase 2+:** Untrusted project profiles require verified engines + isolated context + scrubbed env.

**Credential and projection policy:** raw session IDs stay internal resume-only. `projectPublicTrace` is sole constructor/redactor for branded public text, artifact IDs, and session refs. `PublicTraceEvent` is explicit redacted projection, never raw intersection: `native_session_id`, `prompt_template`, and `raw_env` are removed; user/agent/evaluator text and errors pass public-text redaction; only `ref`, `previous_ref`, `input_ref`, `output_ref`, `decision_matrix_ref`, `baseline_comparison_ref`, `evidence_refs`, and `provenance_refs` become conversation-scoped opaque artifact IDs; `public_session_ref` becomes a distinct opaque session ref. SSE/snapshot/UI redact known credentials, tokens, native IDs, and control data before emission.

## Implementation Phases

### Phase 0 — Shared Integration Foundation

- Separate TraceEnvelope + TraceEvent types (`src/orchestrator/trace/types.ts`)
- Durable trace store with cross-process lock (`src/orchestrator/trace/store.ts`)
- AttemptHandle + resume fix (consolidate `ask.ts` + `dispatch.ts`)
- Canonical AgentBinding → ResolvedAgentBinding materialization
- Skill resolution from turn 1
- Evidence by immutable attempt_id
- Acceptance: 64 consensus cases, exact resume test, journal roundtrip

### Phase 1 — Chat Vertical Slice

- `vf chat` (canonical entry)
- Minimal chat UI (ChatWorkspace/ConversationPanel)
- Claude/Codex engine adapters
- Direct request → agent/skill resolution → CLI execution → streamed response
- Trace drawer: role, skills, engine, opaque public session reference/status, evidence
- `vf ask` migrated to shared path (compatibility facade preserved)
- `vf brainstorm` as alias → debate policy (stub, not full debate yet)

### Phase 2 — Orchestration Policies

- Brainstorm/debate policy (consensus, evaluator, precommit, baseline)
- Plan, review, verify policies
- Multi-agent participants
- User injection, stop/resume, approval
- Decision matrix artifact
- Acceptance: normal chat → plan artifact → correlated approval → existing orchestrate core/work units → review → full verify → UI artifacts/trace.

### Phase 3 — Expansion

- Copilot, OpenCode, Antigravity adapters
- Role overlays/profile UX (extend `.vibeflow/roles/`)
- Advanced routing heuristics only; initial natural-language routing is Phase 2
- Decision matrix visualization
- Richer trace UI

## Trace Acceptance Criterion

A user message must trace through:
```
conversation
→ coordinator decision
→ selected policy
→ participant/role
→ injected skills
→ engine invocation
→ native CLI session
→ tool/action events
→ evidence
→ final response/artifact
```

Acceptance tests must prove: safe correlation (`workflow_id`, `conversation_id`, `revision_id`, `run_id`, `turn_id`, `operation_id`, `attempt_id`, optional `unit_id`, participant/role, skills, engine, evidence, and `parent_attempt_id`) survives public projection, preserving trace-drawer role/skills/engine and full conversation → policy → participant/role → skills → engine → evidence chain; raw `native_session_id`, `prompt_template`, `raw_env`, and raw tool/artifact refs cannot enter public shapes; CLI/API/snapshot/SSE/marker/evidence expose only redacted `PublicTraceEvent` and opaque `public_session_ref`; authenticated artifact fetch resolves allowed opaque IDs; supported history reconciles and unsupported history is explicitly unavailable; lifecycle, auth, approval, and cancellation status contracts hold; cancellation owns one AbortController/signal and emits once; DecisionMatrix scores/aggregate stay 0..1; SSE replay is deterministic; ambiguous operations never auto-replay; full verify reports every required gate; and every CLI output maps to exactly one exit code.

## Research References

- arXiv:2509.05396 — Multi-agent debate failure modes
- Superpowers #1245 — Naive time estimates
- Superpowers #1120 — Review loop spiral
- ThinkTank — Believer/Skeptic/Neutral pattern
