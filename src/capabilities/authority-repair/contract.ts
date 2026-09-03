import { PUBLIC_ACTION_SCHEMA_VERSION } from "../../actions/public-action-contract.js";
import { ACTION_AUTHORITY_BINDING_MODE } from "../../actions/public-action-vocabulary-contract.js";
import { PUBLIC_OPERATION_AUTHORITY_REPAIR_PHASE } from "../../actions/public-operation-contract.js";

/** Closed protocol vocabulary for authority repair and its isolated bootstrap root. */
export const AUTHORITY_REPAIR_SCHEMA_VERSION = PUBLIC_ACTION_SCHEMA_VERSION;
export const AUTHORITY_REPAIR_BINDING_MODE = ACTION_AUTHORITY_BINDING_MODE;

export const AUTHORITY_REPAIR_STRATEGY = Object.freeze({
  REPLACE_JSON_HEAD: "replace-json-head",
  NEW_JOURNAL_GENERATION: "new-journal-generation",
  RESTORE_CONTENT_ADDRESSED_OBJECT: "restore-content-addressed-object",
  REPLACE_AUTHORITY_EPOCH_COMPOUND: "replace-authority-epoch-compound",
} as const);

export const AUTHORITY_REPAIR_EVENT_STATE = PUBLIC_OPERATION_AUTHORITY_REPAIR_PHASE;

export const AUTHORITY_REPAIR_TERMINAL_STATE = Object.freeze({
  VERIFIED: AUTHORITY_REPAIR_EVENT_STATE.VERIFIED,
  FAILED: AUTHORITY_REPAIR_EVENT_STATE.FAILED,
  NEEDS_RECOVERY: AUTHORITY_REPAIR_EVENT_STATE.NEEDS_RECOVERY,
} as const);

export const AUTHORITY_REPAIR_GUIDED_STATUS = Object.freeze({
  DENIED: "denied",
  VERIFIED: AUTHORITY_REPAIR_TERMINAL_STATE.VERIFIED,
  FAILED: AUTHORITY_REPAIR_TERMINAL_STATE.FAILED,
  NEEDS_RECOVERY: AUTHORITY_REPAIR_TERMINAL_STATE.NEEDS_RECOVERY,
} as const);

export const AUTHORITY_REPAIR_REASON_CODE = Object.freeze({
  CHECKPOINT_INVALID: "checkpoint-invalid",
  PREIMAGE_CHANGED: "preimage-changed",
  QUARANTINE_WRITE_FAILED: "quarantine-write-failed",
  ABSENCE_EVIDENCE_WRITE_FAILED: "absence-evidence-write-failed",
  RESTORE_WRITE_FAILED: "restore-write-failed",
  POST_RESTORE_MISMATCH: "post-restore-mismatch",
  CURRENT_STATE_AMBIGUOUS: "current-state-ambiguous",
  RECONCILIATION_INCONCLUSIVE: "reconciliation-inconclusive",
} as const);

export const RECOVERY_BOOTSTRAP_PAYLOAD_KIND = Object.freeze({
  PROPOSAL_CREATED: "proposal-created",
  APPROVAL_DECISION: "approval-decision",
  REPAIR_DISPATCH: "repair-dispatch",
  TERMINAL_MIRROR: "terminal-mirror",
} as const);

export const AUTHORITY_REPAIR_JOURNAL_SOURCE_KIND = Object.freeze({
  CANONICAL: "canonical-source",
  RECOVERY_GENERATION: "selected-recovery-generation",
} as const);

export const AUTHORITY_REPAIR_JSON_HEAD_TARGET_KIND = Object.freeze({
  CONVERSATION_MANIFEST: "conversation-manifest",
  LINEAGE_HEAD: "lineage-head",
  LINEAGE_RESERVATION: "lineage-reservation",
  CAPABILITY_LOCK: "capability-lock",
  SCOPE_IDENTITY: "scope-identity",
  AUTHORITY_EPOCH_ZERO_HEAD: "authority-epoch-zero-head",
} as const);

export const AUTHORITY_REPAIR_CONTENT_TARGET_KIND = Object.freeze({
  CONVERSATION_OBJECT: "conversation-object",
  LINEAGE_ASSOCIATION: "lineage-association",
  REVISION_OPERATION_HEADER: "revision-operation-header",
  ACTION_RECORD: "action-record",
  ACTION_BLOB: "action-blob",
  CAPABILITY_GENERATION: "capability-generation",
  CAPABILITY_OBJECT: "capability-object",
  CAPABILITY_RUNTIME_EVIDENCE_BLOB: "capability-runtime-evidence-blob",
  CAPABILITY_RUNTIME_EVIDENCE_BINDING: "capability-runtime-evidence-binding",
  CAPABILITY_OPERATION_HEADER: "capability-operation-header",
  CAPABILITY_OUTBOX_PAYLOAD: "capability-outbox-payload",
  AUTHORITY_CHANGE_OPERATION_HEADER: "authority-change-operation-header",
  AUTHORITY_REPAIR_HEADER: "authority-repair-header",
  AUTHORITY_REPAIR_OBJECT: "authority-repair-object",
} as const);

export const AUTHORITY_REPAIR_OBJECT_SCHEMA_ID = Object.freeze({
  STEPS: "vf.authority-repair-steps/1",
  AUTHORITY_EPOCH_BASE: "vf.authority-epoch-repair-base/1",
} as const);

export const AUTHORITY_REPAIR_ACTION_OBJECT_SCHEMA_ID = Object.freeze({
  ACTION_PLAN: "vf.action-plan/1",
  REPAIR_PLAN: "vf.authority-repair-plan/1",
  REPAIR_AUTHORIZATION: "vf.repair-authorization-binding/1",
} as const);

export const RECOVERY_BOOTSTRAP_APPROVAL_TRANSITION = Object.freeze({
  FROM: "pending_review",
  APPROVED: "approved",
  DENIED: "denied",
} as const);

export const RECOVERY_BOOTSTRAP_IDENTITY_KIND = "recovery-bootstrap" as const;
export const RECOVERY_BOOTSTRAP_ID_PREFIX = "vf-recovery-bootstrap-" as const;

export const AUTHORITY_REPAIR_DIGEST_DOMAIN = Object.freeze({
  AUTHORIZATION_BINDING: "VF-REPAIR-AUTHORIZATION-BINDING\0v1\0",
  PLAN: "VF-AUTHORITY-REPAIR-PLAN\0v1\0",
  STEPS: "VF-AUTHORITY-REPAIR-STEPS\0v1\0",
  EPOCH_BASE: "VF-AUTHORITY-EPOCH-REPAIR-BASE\0v1\0",
  OPERATION: "VF-AUTHORITY-REPAIR-OPERATION\0v1\0",
  EVENT: "VF-AUTHORITY-REPAIR-EVENT\0v1\0",
  ABSENCE_EVIDENCE: "VF-AUTHORITY-REPAIR-ABSENCE-EVIDENCE\0v1\0",
  QUARANTINE: "VF-AUTHORITY-REPAIR-QUARANTINE\0v1\0",
  RESTORE_SOURCE: "VF-AUTHORITY-REPAIR-RESTORE-SOURCE\0v1\0",
  OBSERVATION: "VF-AUTHORITY-REPAIR-OBSERVATION\0v1\0",
  BOOTSTRAP_IDENTITY: "VF-RECOVERY-BOOTSTRAP-IDENTITY\0v1\0",
  ACTIVATION_RECEIPT: "VF-FABRIC-ACTIVATION-RECEIPT\0v1\0",
  BOOTSTRAP_EVENT: "VF-RECOVERY-BOOTSTRAP-EVENT\0v1\0",
  ACTION_PLAN: "VF-ACTION-PLAN\0v1\0",
  PROPOSED_STATE: "VF-AUTHORITY-REPAIR-PROPOSED-STATE\0v1\0",
  COMPOUND_PROPOSED_STATE: "VF-AUTHORITY-EPOCH-RESTORED-AUTHORITY\0v1\0",
  JSON_HEAD_CURRENT: "VF-AUTHORITY-REPAIR-JSON-HEAD-CURRENT\0v1\0",
  JSON_HEAD_ABSENT: "VF-AUTHORITY-REPAIR-JSON-HEAD-ABSENT\0v1\0",
  LOST_TAIL: "VF-AUTHORITY-REPAIR-LOST-TAIL\0v1\0",
} as const);

export const AUTHORITY_REPAIR_CONTROL_STATE = Object.freeze({
  CURRENT_VALID: "current-valid",
  RECOVERY_CHECKPOINT_ONLY: "recovery-checkpoint-only",
} as const);

export const AUTHORITY_REPAIR_PLAN_KIND = "authority-repair" as const;

export const AUTHORITY_REPAIR_OWNER_PATH_NAME = Object.freeze({
  RECOVERY: "recovery",
  VERSION_ROOT: "v1",
  OPERATIONS: "authority-repair-operations",
  HEADER: "header.json",
  EVENTS: "events.frames",
  OBJECTS: "repair-objects",
  OBSERVATIONS: "repair-observations",
  ABSENCE: "repair-absence-evidence",
  QUARANTINE: "quarantine",
  RESTORE_SOURCES: "restore-sources",
  WRITER_LOCK: "writer.lock",
} as const);

export const AUTHORITY_REPAIR_LIMIT = Object.freeze({
  JSON_BYTES: 2 * 1024 * 1024,
  RESTORE_BYTES: 64 * 1024 * 1024,
  JOURNAL_BYTES: 64 * 1024 * 1024,
  FRAME_BYTES: 2 * 1024 * 1024,
  FRAMES: 10_000,
  APPROVAL_TTL_MS: 5 * 60_000,
  PLAN_TTL_MS: 30 * 60_000,
} as const);

export const RECOVERY_BOOTSTRAP_PATH_NAME = Object.freeze({
  IDENTITY: "BOOTSTRAP_IDENTITY.json",
  VERSION_ROOT: "v1",
  ACTIVATION: "bootstrap-activation.json",
  JOURNAL: "authority-repairs.frames",
  PENDING_JOURNAL: "authority-repairs.frames.pending",
  WRITER_LOCK: "writer.lock",
  ACTION_ROOTS: "bootstrap-action-roots",
  ACTIONS: "actions",
  OBJECTS: "objects",
} as const);

export const RECOVERY_BOOTSTRAP_EMPTY_JOURNAL = Object.freeze({
  BYTE_LENGTH: 0,
  SHA256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
} as const);

type ValueOf<T> = T[keyof T];

export type AuthorityRepairBindingModeV1 = ValueOf<typeof AUTHORITY_REPAIR_BINDING_MODE>;
export type AuthorityRepairStrategyV1 = ValueOf<typeof AUTHORITY_REPAIR_STRATEGY>;
export type AuthorityRepairEventStateV1 = ValueOf<typeof AUTHORITY_REPAIR_EVENT_STATE>;
export type AuthorityRepairTerminalStateV1 = ValueOf<typeof AUTHORITY_REPAIR_TERMINAL_STATE>;
export type AuthorityRepairGuidedStatusV1 = ValueOf<typeof AUTHORITY_REPAIR_GUIDED_STATUS>;
export type AuthorityRepairReasonCodeV1 = ValueOf<typeof AUTHORITY_REPAIR_REASON_CODE>;
export type RecoveryBootstrapPayloadKindV1 = ValueOf<typeof RECOVERY_BOOTSTRAP_PAYLOAD_KIND>;
export type AuthorityRepairJournalSourceKindV1 = ValueOf<
  typeof AUTHORITY_REPAIR_JOURNAL_SOURCE_KIND
>;
export type AuthorityRepairJsonHeadTargetKindV1 = ValueOf<
  typeof AUTHORITY_REPAIR_JSON_HEAD_TARGET_KIND
>;
export type AuthorityRepairContentTargetKindV1 = ValueOf<
  typeof AUTHORITY_REPAIR_CONTENT_TARGET_KIND
>;
export type AuthorityRepairObjectSchemaIdV1 = ValueOf<typeof AUTHORITY_REPAIR_OBJECT_SCHEMA_ID>;
