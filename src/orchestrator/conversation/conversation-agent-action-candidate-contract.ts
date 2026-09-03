import { HOST_ACTION_KIND, type HostActionKind } from "../../actions/host-action-contract.js";
import {
  ACTION_DOMAIN,
  ACTION_EXPECTED_SOURCE_MODE,
  ACTION_PLANNING_MODE,
  ACTION_PLANNING_NETWORK_READ_VALUE,
  ACTOR_KIND,
  CREDENTIAL_CLASS,
} from "../../actions/public-action-contract.js";
import { AGENT_HOST_TOOL, type AgentHostToolV1 } from "../../core/agent-contract.js";
import {
  CONVERSATION_LIFECYCLE,
  CONVERSATION_TRACE_EVENT_KIND,
} from "./conversation-public-wire-contract.js";

/**
 * Platform-independent runtime contract for durable agent action candidates.
 *
 * Persisted and cross-boundary vocabulary belongs here so validators, recovery, review, and
 * projections cannot silently drift apart through duplicated string literals. Its imports are the
 * dependency-free shared agent and host-action vocabularies.
 */
export const AGENT_ACTION_CANDIDATE_SCHEMA_VERSION = "1.0" as const;

export type AgentActionCandidateSchemaVersionV1 = typeof AGENT_ACTION_CANDIDATE_SCHEMA_VERSION;

export const AGENT_ACTION_CANDIDATE_RECORD_KIND = Object.freeze({
  STAGE: "agent_action_candidate_stage",
  RESPONSE_BINDING: "agent_action_candidate_response_binding",
  RECEIPT: "agent_action_candidate_receipt",
} as const);

export type AgentActionCandidateRecordKindV1 =
  (typeof AGENT_ACTION_CANDIDATE_RECORD_KIND)[keyof typeof AGENT_ACTION_CANDIDATE_RECORD_KIND];

export const AGENT_ACTION_CANDIDATE_RECORD_KINDS = Object.freeze(
  Object.values(AGENT_ACTION_CANDIDATE_RECORD_KIND),
) as readonly AgentActionCandidateRecordKindV1[];

export const AGENT_ACTION_CANDIDATE_FIELD = Object.freeze({
  SCHEMA_VERSION: "schema_version",
  RECORD_DIGEST: "record_digest",
  ROOT_SESSION_ID: "root_session_id",
  CONVERSATION_ID: "conversation_id",
  REVISION_ID: "revision_id",
  PARTICIPANT_ID: "participant_id",
  RESPONSE_IDEMPOTENCY_KEY: "response_idempotency_key",
  CANDIDATE: "candidate",
  GRANT_DIGEST: "grant_digest",
  RESPONSE_BINDING_KEY_DIGEST: "response_binding_key_digest",
  STAGE: "stage",
  BINDING_DIGEST: "binding_digest",
  STATE: "state",
  ORIGIN_RESPONSE_EVENT_ID: "origin_response_event_id",
  PROPOSAL_ID: "proposal_id",
  PROPOSAL_DIGEST: "proposal_digest",
  REJECTION_CODE: "rejection_code",
  RECEIPT_DIGEST: "receipt_digest",
} as const);

export type AgentActionCandidateFieldV1 =
  (typeof AGENT_ACTION_CANDIDATE_FIELD)[keyof typeof AGENT_ACTION_CANDIDATE_FIELD];

export const AGENT_ACTION_CANDIDATE_RECORD_FIELDS = Object.freeze({
  STAGE: Object.freeze([
    AGENT_ACTION_CANDIDATE_FIELD.SCHEMA_VERSION,
    AGENT_ACTION_CANDIDATE_FIELD.RECORD_DIGEST,
    AGENT_ACTION_CANDIDATE_FIELD.ROOT_SESSION_ID,
    AGENT_ACTION_CANDIDATE_FIELD.CONVERSATION_ID,
    AGENT_ACTION_CANDIDATE_FIELD.REVISION_ID,
    AGENT_ACTION_CANDIDATE_FIELD.PARTICIPANT_ID,
    AGENT_ACTION_CANDIDATE_FIELD.RESPONSE_IDEMPOTENCY_KEY,
    AGENT_ACTION_CANDIDATE_FIELD.CANDIDATE,
    AGENT_ACTION_CANDIDATE_FIELD.GRANT_DIGEST,
  ] as const),
  RESPONSE_BINDING: Object.freeze([
    AGENT_ACTION_CANDIDATE_FIELD.SCHEMA_VERSION,
    AGENT_ACTION_CANDIDATE_FIELD.CONVERSATION_ID,
    AGENT_ACTION_CANDIDATE_FIELD.REVISION_ID,
    AGENT_ACTION_CANDIDATE_FIELD.PARTICIPANT_ID,
    AGENT_ACTION_CANDIDATE_FIELD.RESPONSE_IDEMPOTENCY_KEY,
    AGENT_ACTION_CANDIDATE_FIELD.RESPONSE_BINDING_KEY_DIGEST,
    AGENT_ACTION_CANDIDATE_FIELD.RECORD_DIGEST,
    AGENT_ACTION_CANDIDATE_FIELD.STAGE,
    AGENT_ACTION_CANDIDATE_FIELD.BINDING_DIGEST,
  ] as const),
  RECEIPT: Object.freeze([
    AGENT_ACTION_CANDIDATE_FIELD.SCHEMA_VERSION,
    AGENT_ACTION_CANDIDATE_FIELD.STATE,
    AGENT_ACTION_CANDIDATE_FIELD.RECORD_DIGEST,
    AGENT_ACTION_CANDIDATE_FIELD.ORIGIN_RESPONSE_EVENT_ID,
    AGENT_ACTION_CANDIDATE_FIELD.PROPOSAL_ID,
    AGENT_ACTION_CANDIDATE_FIELD.PROPOSAL_DIGEST,
    AGENT_ACTION_CANDIDATE_FIELD.REJECTION_CODE,
    AGENT_ACTION_CANDIDATE_FIELD.RECEIPT_DIGEST,
  ] as const),
  ENVELOPE: Object.freeze([
    AGENT_ACTION_CANDIDATE_FIELD.SCHEMA_VERSION,
    AGENT_ACTION_CANDIDATE_FIELD.CANDIDATE,
  ] as const),
} as const);

export const AGENT_ACTION_CANDIDATE_RECEIPT_STATE = Object.freeze({
  MATERIALIZED: "materialized",
  REJECTED: "rejected",
} as const);

export type DurableAgentActionCandidateReceiptStateV1 =
  (typeof AGENT_ACTION_CANDIDATE_RECEIPT_STATE)[keyof typeof AGENT_ACTION_CANDIDATE_RECEIPT_STATE];

export const AGENT_ACTION_CANDIDATE_RECEIPT_STATES = Object.freeze(
  Object.values(AGENT_ACTION_CANDIDATE_RECEIPT_STATE),
) as readonly DurableAgentActionCandidateReceiptStateV1[];

export const AGENT_ACTION_CANDIDATE_MATERIALIZATION_STATE = Object.freeze({
  PENDING: "pending",
  MATERIALIZED: AGENT_ACTION_CANDIDATE_RECEIPT_STATE.MATERIALIZED,
  REJECTED: AGENT_ACTION_CANDIDATE_RECEIPT_STATE.REJECTED,
} as const);

export type AgentActionCandidateMaterializationStateV1 =
  (typeof AGENT_ACTION_CANDIDATE_MATERIALIZATION_STATE)[keyof typeof AGENT_ACTION_CANDIDATE_MATERIALIZATION_STATE];

export const AGENT_ACTION_CANDIDATE_MATERIALIZATION_STATES = Object.freeze(
  Object.values(AGENT_ACTION_CANDIDATE_MATERIALIZATION_STATE),
) as readonly AgentActionCandidateMaterializationStateV1[];

export const AGENT_ACTION_CANDIDATE_REJECTION_CODE = Object.freeze({
  TERMINAL_NOT_COMPLETED: "terminal_not_completed",
  ORIGIN_RESPONSE_ABSENT: "origin_response_absent",
  CANDIDATE_NOT_ACTIONABLE: "candidate_not_actionable",
  SOURCE_CHANGED: "source_changed",
  GRANT_REVOKED: "grant_revoked",
} as const);

export type DurableAgentActionCandidateRejectionCodeV1 =
  (typeof AGENT_ACTION_CANDIDATE_REJECTION_CODE)[keyof typeof AGENT_ACTION_CANDIDATE_REJECTION_CODE];

export const AGENT_ACTION_CANDIDATE_REJECTION_CODES = Object.freeze(
  Object.values(AGENT_ACTION_CANDIDATE_REJECTION_CODE),
) as readonly DurableAgentActionCandidateRejectionCodeV1[];

export const AGENT_ACTION_CANDIDATE_DIAGNOSTIC_CODE = Object.freeze({
  HOST_TOOL_NOT_GRANTED: "host_tool_not_granted",
  INVALID_ACTION_CANDIDATE: "invalid_action_candidate",
  INVALID_ACTION_ORIGIN: "invalid_action_origin",
  ACTION_CANDIDATE_CONFLICT: "action_candidate_conflict",
} as const);

export type AgentActionCandidateDiagnosticV1 =
  (typeof AGENT_ACTION_CANDIDATE_DIAGNOSTIC_CODE)[keyof typeof AGENT_ACTION_CANDIDATE_DIAGNOSTIC_CODE];

export const AGENT_ACTION_CANDIDATE_DIAGNOSTIC_CODES = Object.freeze(
  Object.values(AGENT_ACTION_CANDIDATE_DIAGNOSTIC_CODE),
) as readonly AgentActionCandidateDiagnosticV1[];

export const AGENT_ACTION_CANDIDATE_REVIEW_PHASE = Object.freeze({
  REVIEW: "review",
  DISPATCH: "dispatch",
} as const);

export type AgentActionCandidateReviewPhaseV1 =
  (typeof AGENT_ACTION_CANDIDATE_REVIEW_PHASE)[keyof typeof AGENT_ACTION_CANDIDATE_REVIEW_PHASE];

export const AGENT_ACTION_CANDIDATE_REVIEW_PHASES = Object.freeze(
  Object.values(AGENT_ACTION_CANDIDATE_REVIEW_PHASE),
) as readonly AgentActionCandidateReviewPhaseV1[];

export const AGENT_ACTION_CANDIDATE_SOURCE_STALE_CODE = Object.freeze({
  CONVERSATION_SOURCE_CHANGED: "conversation-source-changed",
  AGENT_GRANT_CHANGED: "agent-grant-changed",
  AGENT_ORIGIN_CHANGED: "agent-origin-changed",
} as const);

export type AgentActionCandidateSourceStaleCodeV1 =
  (typeof AGENT_ACTION_CANDIDATE_SOURCE_STALE_CODE)[keyof typeof AGENT_ACTION_CANDIDATE_SOURCE_STALE_CODE];

export const AGENT_ACTION_CANDIDATE_SOURCE_STALE_CODES = Object.freeze(
  Object.values(AGENT_ACTION_CANDIDATE_SOURCE_STALE_CODE),
) as readonly AgentActionCandidateSourceStaleCodeV1[];

export const AGENT_ACTION_CANDIDATE_BARRIER_POINT = Object.freeze({
  AFTER_PROPOSAL_MATERIALIZED: "after-proposal-materialized",
} as const);

export type AgentActionCandidateBarrierPointV1 =
  (typeof AGENT_ACTION_CANDIDATE_BARRIER_POINT)[keyof typeof AGENT_ACTION_CANDIDATE_BARRIER_POINT];

export const AGENT_ACTION_CANDIDATE_HOST_TOOL = AGENT_HOST_TOOL;

export type AgentActionCandidateHostToolV1 = AgentHostToolV1;

export const AGENT_ACTION_CANDIDATE_EVENT_TYPE = Object.freeze({
  AGENT_RESPONSE_DELTA: CONVERSATION_TRACE_EVENT_KIND.AGENT_RESPONSE_DELTA,
} as const);

export type AgentActionCandidateEventTypeV1 =
  (typeof AGENT_ACTION_CANDIDATE_EVENT_TYPE)[keyof typeof AGENT_ACTION_CANDIDATE_EVENT_TYPE];

export const AGENT_ACTION_CANDIDATE_SOURCE_LIFECYCLE = Object.freeze({
  COMPLETED: CONVERSATION_LIFECYCLE.COMPLETED,
} as const);

export const AGENT_ACTION_CANDIDATE_ROLE = Object.freeze({
  BRAINSTORM_EVALUATOR: "brainstorm-evaluator",
} as const);

export const AGENT_ACTION_CANDIDATE_REQUEST_ORIGIN = Object.freeze({
  CONVERSATION: ACTION_DOMAIN.CONVERSATION,
} as const);

export const AGENT_ACTION_CANDIDATE_ACTOR_KIND = Object.freeze({
  AGENT: ACTOR_KIND.AGENT,
} as const);

export const AGENT_ACTION_CANDIDATE_CREDENTIAL_CLASS = Object.freeze({
  LOOPBACK_SESSION: CREDENTIAL_CLASS.LOOPBACK_SESSION,
} as const);

export const AGENT_ACTION_CANDIDATE_PLANNING_MODE = Object.freeze({
  DURABLE: ACTION_PLANNING_MODE.DURABLE,
} as const);

export const AGENT_ACTION_CANDIDATE_NETWORK_READ_POLICY = Object.freeze({
  ORDINARY_HOST_POLICY: ACTION_PLANNING_NETWORK_READ_VALUE.ORDINARY_HOST_POLICY,
} as const);

export const AGENT_ACTION_CANDIDATE_EXPECTED_SOURCE_MODE = Object.freeze({
  WRITABLE_REVISION: ACTION_EXPECTED_SOURCE_MODE.WRITABLE_REVISION,
} as const);

export const AGENT_ACTION_CANDIDATE_RESERVATION_STATE = Object.freeze({
  ACTIVE: "active",
} as const);

export const AGENT_ACTION_CANDIDATE_FAILURE_DISPOSITION = Object.freeze({
  RETRY: "retry",
} as const);

export const AGENT_ACTION_CANDIDATE_PRIVATE_OR_STAGED_ACTION_TYPE = Object.freeze({
  SELECT_LINEAGE_HEAD: HOST_ACTION_KIND.CONVERSATION_SELECT_LINEAGE_HEAD,
  PUBLISH_SUSPECTED_LITERAL: HOST_ACTION_KIND.CONVERSATION_PUBLISH_SUSPECTED_LITERAL,
  ABANDON_REVISION_OPERATION: HOST_ACTION_KIND.CONVERSATION_ABANDON_REVISION_OPERATION,
  RETRY_REVISION_OPERATION: HOST_ACTION_KIND.CONVERSATION_RETRY_REVISION_OPERATION,
  RECONCILE_REVISION_OPERATION: HOST_ACTION_KIND.CONVERSATION_RECONCILE_REVISION_OPERATION,
  COMPACT_CONTEXT: HOST_ACTION_KIND.CONTEXT_COMPACT,
  ADOPT_CAPABILITY: HOST_ACTION_KIND.CAPABILITY_ADOPT,
  UPDATE_POLICY_AUTHORITY: HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY,
  REVOKE_SECRET: HOST_ACTION_KIND.SECRET_REVOKE,
} as const satisfies Readonly<Record<string, HostActionKind>>);

export type AgentActionCandidatePrivateOrStagedActionTypeV1 =
  (typeof AGENT_ACTION_CANDIDATE_PRIVATE_OR_STAGED_ACTION_TYPE)[keyof typeof AGENT_ACTION_CANDIDATE_PRIVATE_OR_STAGED_ACTION_TYPE];

export const AGENT_ACTION_CANDIDATE_PRIVATE_OR_STAGED_ACTION_TYPES = Object.freeze(
  Object.values(AGENT_ACTION_CANDIDATE_PRIVATE_OR_STAGED_ACTION_TYPE),
) as readonly AgentActionCandidatePrivateOrStagedActionTypeV1[];

export const AGENT_ACTION_CANDIDATE_CAPABILITY_INPUT_ACTION_TYPE = Object.freeze({
  INSTALL: HOST_ACTION_KIND.CAPABILITY_INSTALL,
  CONFIGURE: HOST_ACTION_KIND.CAPABILITY_CONFIGURE,
  UPDATE: HOST_ACTION_KIND.CAPABILITY_UPDATE,
} as const satisfies Readonly<Record<string, HostActionKind>>);

export type AgentActionCandidateCapabilityInputActionTypeV1 =
  (typeof AGENT_ACTION_CANDIDATE_CAPABILITY_INPUT_ACTION_TYPE)[keyof typeof AGENT_ACTION_CANDIDATE_CAPABILITY_INPUT_ACTION_TYPE];

export const AGENT_ACTION_CANDIDATE_CAPABILITY_INPUT_ACTION_TYPES = Object.freeze(
  Object.values(AGENT_ACTION_CANDIDATE_CAPABILITY_INPUT_ACTION_TYPE),
) as readonly AgentActionCandidateCapabilityInputActionTypeV1[];

export const AGENT_ACTION_CANDIDATE_DIGEST_DOMAIN = Object.freeze({
  STAGE: "VF-AGENT-HOST-ACTION-CANDIDATE\0v1\0",
  RESPONSE_BINDING_KEY: "VF-AGENT-HOST-ACTION-RESPONSE-BINDING-KEY\0v1\0",
  RESPONSE_BINDING: "VF-AGENT-HOST-ACTION-RESPONSE-BINDING\0v1\0",
  RECEIPT: "VF-AGENT-HOST-ACTION-CANDIDATE-RECEIPT\0v1\0",
  HOST_TOOL_GRANT: "VF-CONVERSATION-HOST-TOOL-GRANT\0v1\0",
  PRINCIPAL: "VF-AGENT-HOST-ACTION-PRINCIPAL\0v1\0",
  CONTROL: "VF-AGENT-HOST-ACTION-CONTROL\0v1\0",
  GRANT_EPOCH: "VF-AGENT-HOST-ACTION-GRANT-EPOCH\0v1\0",
  MATERIALIZATION_LOCK: "VF-AGENT-ACTION-MATERIALIZATION-LOCK\0v1\0",
  OPAQUE_ID: "VF-ID\0v1\0",
} as const);

export const AGENT_ACTION_CANDIDATE_STORAGE_SEGMENT = Object.freeze({
  ACTIONS: "actions",
  VERSION: "v1",
  ROOT: "agent-action-candidates",
  RESPONSE_BINDINGS: "response-bindings",
  RECEIPTS: "receipts",
  MATERIALIZATION_LOCKS: "materialization-locks",
  WRITER_LOCK: "writer.lock",
} as const);

export const AGENT_ACTION_CANDIDATE_IDEMPOTENCY_PREFIX = "agent-action-" as const;
export const AGENT_ACTION_CANDIDATE_DIGEST_PREFIX = "sha256:" as const;

export const AGENT_ACTION_CANDIDATE_LOCK_OPERATION_PREFIX = Object.freeze({
  STAGE: "agent-action-stage:",
  RECEIPT: "agent-action-receipt:",
  MATERIALIZE: "agent-action-materialize:",
} as const);

const memberOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && (values as readonly string[]).includes(value);

export const isAgentActionCandidateSchemaVersion = (
  value: unknown,
): value is AgentActionCandidateSchemaVersionV1 => value === AGENT_ACTION_CANDIDATE_SCHEMA_VERSION;

export const isAgentActionCandidateRecordKind = (
  value: unknown,
): value is AgentActionCandidateRecordKindV1 =>
  memberOf(AGENT_ACTION_CANDIDATE_RECORD_KINDS, value);

export const isAgentActionCandidateReceiptState = (
  value: unknown,
): value is DurableAgentActionCandidateReceiptStateV1 =>
  memberOf(AGENT_ACTION_CANDIDATE_RECEIPT_STATES, value);

export const isAgentActionCandidateMaterializationState = (
  value: unknown,
): value is AgentActionCandidateMaterializationStateV1 =>
  memberOf(AGENT_ACTION_CANDIDATE_MATERIALIZATION_STATES, value);

export const isAgentActionCandidateRejectionCode = (
  value: unknown,
): value is DurableAgentActionCandidateRejectionCodeV1 =>
  memberOf(AGENT_ACTION_CANDIDATE_REJECTION_CODES, value);

export const isAgentActionCandidateDiagnosticCode = (
  value: unknown,
): value is AgentActionCandidateDiagnosticV1 =>
  memberOf(AGENT_ACTION_CANDIDATE_DIAGNOSTIC_CODES, value);

export const isAgentActionCandidateReviewPhase = (
  value: unknown,
): value is AgentActionCandidateReviewPhaseV1 =>
  memberOf(AGENT_ACTION_CANDIDATE_REVIEW_PHASES, value);

export const isAgentActionCandidateSourceStaleCode = (
  value: unknown,
): value is AgentActionCandidateSourceStaleCodeV1 =>
  memberOf(AGENT_ACTION_CANDIDATE_SOURCE_STALE_CODES, value);

export const isAgentActionCandidatePrivateOrStagedActionType = (
  value: unknown,
): value is AgentActionCandidatePrivateOrStagedActionTypeV1 =>
  memberOf(AGENT_ACTION_CANDIDATE_PRIVATE_OR_STAGED_ACTION_TYPES, value);

export const isAgentActionCandidateCapabilityInputActionType = (
  value: unknown,
): value is AgentActionCandidateCapabilityInputActionTypeV1 =>
  memberOf(AGENT_ACTION_CANDIDATE_CAPABILITY_INPUT_ACTION_TYPES, value);
