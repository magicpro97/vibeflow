/** Browser-safe runtime vocabulary for public operation progress and target projections. */
export {
  PUBLIC_ACTION_TARGET_CAPABILITY_SUBJECT_FIELDS,
  PUBLIC_ACTION_TARGET_CONVERSATION_SUBJECT_FIELDS,
  PUBLIC_ACTION_TARGET_FIELD,
  PUBLIC_ACTION_TARGET_FIELDS,
  PUBLIC_ACTION_TARGET_SUBJECT_FIELD,
  PUBLIC_OPERATION_PROGRESS_FIELD,
  PUBLIC_OPERATION_PROGRESS_FIELDS,
  PUBLIC_TARGET_RESULT_FIELD,
  PUBLIC_TARGET_RESULT_FIELDS,
} from "./public-operation-field-contract.js";

export const PUBLIC_OPERATION_PROGRESS_STATUS = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  REVERSED: "reversed",
} as const);

export type PublicOperationProgressStatusV1 =
  (typeof PUBLIC_OPERATION_PROGRESS_STATUS)[keyof typeof PUBLIC_OPERATION_PROGRESS_STATUS];

export const PUBLIC_OPERATION_PROGRESS_STATUSES = Object.freeze(
  Object.values(PUBLIC_OPERATION_PROGRESS_STATUS),
);

export const PUBLIC_OPERATION_FIXED_PHASE = Object.freeze({
  DISPATCH: "dispatch",
  OPERATION_STARTED: "operation-started",
  TARGET_APPLIED: "target-applied",
  TARGET_OMITTED: "target-omitted",
  TARGET_REVERSED: "target-reversed",
  TARGET_DEGRADED: "target-degraded",
  TARGET_FAILED: "target-failed",
  TARGET_BLOCKED: "target-blocked",
  TARGET_NEEDS_RECOVERY: "target-needs-recovery",
  OPERATION_SUCCEEDED: "operation-succeeded",
  OPERATION_FAILED: "operation-failed",
  OPERATION_NEEDS_RECOVERY: "operation-needs-recovery",
  LINEAGE_HEAD_COMMITTED: "lineage-head:committed",
  LINEAGE_ASSOCIATION_COMMITTED: "lineage-association:committed",
  CONTEXT_COMPACTION_COMMITTED: "context-compaction:committed",
  PUBLIC_LITERAL_PUBLISHED: "public-literal:published",
} as const);

export type PublicOperationFixedPhaseV1 =
  (typeof PUBLIC_OPERATION_FIXED_PHASE)[keyof typeof PUBLIC_OPERATION_FIXED_PHASE];

export const PUBLIC_OPERATION_REVISION_PHASE = Object.freeze({
  PREPARING: "preparing",
  PREPARED: "prepared",
  PUBLISHED: "published",
  STARTING: "starting",
  STARTED: "started",
  ABANDONED: "abandoned",
  START_FAILED: "start_failed",
  NEEDS_RECOVERY: "needs_recovery",
} as const);

export const PUBLIC_OPERATION_PARTICIPANT_START_PHASE = Object.freeze({
  PREPARED: "prepared",
  EFFECT_IN_PROGRESS: "effect_in_progress",
  OBSERVED: "observed",
  ACCEPTED: "accepted",
  CANCEL_IN_PROGRESS: "cancel_in_progress",
  CANCELED: "canceled",
  FAILED: "failed",
  UNCERTAIN: "uncertain",
} as const);

export const PUBLIC_OPERATION_AUTHORITY_CHANGE_PHASE = Object.freeze({
  PREPARED: "prepared",
  EFFECT_IN_PROGRESS: "effect_in_progress",
  OBSERVED: "observed",
  EPOCH_COMMITTED: "epoch-committed",
  FAILED: "failed",
  NEEDS_RECOVERY: "needs-recovery",
} as const);

export const PUBLIC_OPERATION_AUTHORITY_REPAIR_PHASE = Object.freeze({
  PREPARED: "prepared",
  PREIMAGE_FSYNCED: "preimage_fsynced",
  RESTORE_IN_PROGRESS: "restore_in_progress",
  RESTORED: "restored",
  VERIFIED: "verified",
  FAILED: "failed",
  NEEDS_RECOVERY: "needs_recovery",
} as const);

export const PUBLIC_OPERATION_CONVERSATION_RECEIPT_PHASE = Object.freeze({
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  NEEDS_RECOVERY: "needs_recovery",
} as const);

export const PUBLIC_OPERATION_PHASE_PREFIX = Object.freeze({
  REVISION: "revision",
  PARTICIPANT_START: "participant-start",
  AUTHORITY_CHANGE: "authority-change",
  AUTHORITY_REPAIR: "authority-repair",
  CONVERSATION_RECEIPT: "conversation-receipt",
} as const);

const prefixPhaseContract = <
  const Prefix extends string,
  const Segments extends Readonly<Record<string, string>>,
>(
  prefix: Prefix,
  segments: Segments,
): Readonly<{ [Key in keyof Segments]: `${Prefix}:${Segments[Key]}` }> =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(segments).map(([key, segment]) => [key, `${prefix}:${segment}`]),
    ) as { [Key in keyof Segments]: `${Prefix}:${Segments[Key]}` },
  );

const phaseValueMap = <
  const Segments extends Readonly<Record<string, string>>,
  const Prefixed extends Readonly<Record<keyof Segments, string>>,
>(
  segments: Segments,
  prefixed: Prefixed,
): Readonly<Record<Segments[keyof Segments], Prefixed[keyof Prefixed]>> =>
  Object.freeze(
    Object.fromEntries(
      Object.keys(segments).map((key) => [
        segments[key as keyof Segments],
        prefixed[key as keyof Prefixed],
      ]),
    ) as Readonly<Record<Segments[keyof Segments], Prefixed[keyof Prefixed]>>,
  );

export const PUBLIC_OPERATION_PREFIXED_PHASE = Object.freeze({
  REVISION: prefixPhaseContract(
    PUBLIC_OPERATION_PHASE_PREFIX.REVISION,
    PUBLIC_OPERATION_REVISION_PHASE,
  ),
  PARTICIPANT_START: prefixPhaseContract(
    PUBLIC_OPERATION_PHASE_PREFIX.PARTICIPANT_START,
    PUBLIC_OPERATION_PARTICIPANT_START_PHASE,
  ),
  AUTHORITY_CHANGE: prefixPhaseContract(
    PUBLIC_OPERATION_PHASE_PREFIX.AUTHORITY_CHANGE,
    PUBLIC_OPERATION_AUTHORITY_CHANGE_PHASE,
  ),
  AUTHORITY_REPAIR: prefixPhaseContract(
    PUBLIC_OPERATION_PHASE_PREFIX.AUTHORITY_REPAIR,
    PUBLIC_OPERATION_AUTHORITY_REPAIR_PHASE,
  ),
  CONVERSATION_RECEIPT: prefixPhaseContract(
    PUBLIC_OPERATION_PHASE_PREFIX.CONVERSATION_RECEIPT,
    PUBLIC_OPERATION_CONVERSATION_RECEIPT_PHASE,
  ),
} as const);

export const PUBLIC_OPERATION_PREFIXED_PHASE_BY_VALUE = Object.freeze({
  REVISION: phaseValueMap(
    PUBLIC_OPERATION_REVISION_PHASE,
    PUBLIC_OPERATION_PREFIXED_PHASE.REVISION,
  ),
  PARTICIPANT_START: phaseValueMap(
    PUBLIC_OPERATION_PARTICIPANT_START_PHASE,
    PUBLIC_OPERATION_PREFIXED_PHASE.PARTICIPANT_START,
  ),
  AUTHORITY_CHANGE: phaseValueMap(
    PUBLIC_OPERATION_AUTHORITY_CHANGE_PHASE,
    PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_CHANGE,
  ),
  AUTHORITY_REPAIR: phaseValueMap(
    PUBLIC_OPERATION_AUTHORITY_REPAIR_PHASE,
    PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR,
  ),
  CONVERSATION_RECEIPT: phaseValueMap(
    PUBLIC_OPERATION_CONVERSATION_RECEIPT_PHASE,
    PUBLIC_OPERATION_PREFIXED_PHASE.CONVERSATION_RECEIPT,
  ),
} as const);

export const PUBLIC_OPERATION_PREFIXED_REVISION_PHASE_BY_VALUE =
  PUBLIC_OPERATION_PREFIXED_PHASE_BY_VALUE.REVISION;

type ValueOf<Contract> = Contract[keyof Contract];

export type PublicOperationPhaseV1 =
  | PublicOperationFixedPhaseV1
  | ValueOf<typeof PUBLIC_OPERATION_PREFIXED_PHASE.REVISION>
  | ValueOf<typeof PUBLIC_OPERATION_PREFIXED_PHASE.PARTICIPANT_START>
  | ValueOf<typeof PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_CHANGE>
  | ValueOf<typeof PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR>
  | ValueOf<typeof PUBLIC_OPERATION_PREFIXED_PHASE.CONVERSATION_RECEIPT>;

export const PUBLIC_OPERATION_STATE_DEPENDENT_STATUS_PHASES = Object.freeze([
  PUBLIC_OPERATION_PREFIXED_PHASE.REVISION.STARTED,
  PUBLIC_OPERATION_PREFIXED_PHASE.REVISION.START_FAILED,
  PUBLIC_OPERATION_PREFIXED_PHASE.REVISION.NEEDS_RECOVERY,
  PUBLIC_OPERATION_PREFIXED_PHASE.REVISION.ABANDONED,
] as const);

export type PublicOperationStateDependentStatusPhaseV1 =
  (typeof PUBLIC_OPERATION_STATE_DEPENDENT_STATUS_PHASES)[number];

export const PUBLIC_OPERATION_MESSAGE_CODE_PREFIX = "operation." as const;

export const PUBLIC_TARGET_RESULT_OUTCOME = Object.freeze({
  APPLIED: "applied",
  FAILED: "failed",
  MANUAL: "manual",
  REQUIRED_USER_ACTION: "required-user-action",
  UNSUPPORTED: "unsupported",
  OMITTED: "omitted",
  REVERSED: "reversed",
  DEGRADED: "degraded",
  BLOCKED: "blocked",
  NEEDS_RECOVERY: "needs-recovery",
} as const);

export type PublicTargetResultOutcomeV1 = ValueOf<typeof PUBLIC_TARGET_RESULT_OUTCOME>;
export const PUBLIC_TARGET_RESULT_OUTCOMES = Object.freeze(
  Object.values(PUBLIC_TARGET_RESULT_OUTCOME),
);

export const PUBLIC_TARGET_RESULT_HEALTH = Object.freeze({
  READY: "ready",
  DEGRADED: "degraded",
  UNKNOWN: "unknown",
  STALE: "stale",
  FAILED: "failed",
} as const);

export type PublicTargetResultHealthV1 = ValueOf<typeof PUBLIC_TARGET_RESULT_HEALTH>;
export const PUBLIC_TARGET_RESULT_HEALTHS = Object.freeze(
  Object.values(PUBLIC_TARGET_RESULT_HEALTH),
);

export const PUBLIC_OPERATION_PARTICIPANT_TARGET_PHASE = Object.freeze({
  ACCEPTED: PUBLIC_OPERATION_PREFIXED_PHASE.PARTICIPANT_START.ACCEPTED,
  FAILED: PUBLIC_OPERATION_PREFIXED_PHASE.PARTICIPANT_START.FAILED,
  CANCELED: PUBLIC_OPERATION_PREFIXED_PHASE.PARTICIPANT_START.CANCELED,
  UNCERTAIN: PUBLIC_OPERATION_PREFIXED_PHASE.PARTICIPANT_START.UNCERTAIN,
} as const);

export type PublicOperationParticipantTargetPhaseV1 = ValueOf<
  typeof PUBLIC_OPERATION_PARTICIPANT_TARGET_PHASE
>;

export const PUBLIC_OPERATION_TARGET_OUTCOMES_BY_PHASE = Object.freeze({
  [PUBLIC_OPERATION_FIXED_PHASE.TARGET_APPLIED]: Object.freeze([
    PUBLIC_TARGET_RESULT_OUTCOME.APPLIED,
  ] as const),
  [PUBLIC_OPERATION_FIXED_PHASE.TARGET_OMITTED]: Object.freeze([
    PUBLIC_TARGET_RESULT_OUTCOME.OMITTED,
  ] as const),
  [PUBLIC_OPERATION_FIXED_PHASE.TARGET_REVERSED]: Object.freeze([
    PUBLIC_TARGET_RESULT_OUTCOME.REVERSED,
  ] as const),
  [PUBLIC_OPERATION_FIXED_PHASE.TARGET_DEGRADED]: Object.freeze([
    PUBLIC_TARGET_RESULT_OUTCOME.DEGRADED,
  ] as const),
  [PUBLIC_OPERATION_FIXED_PHASE.TARGET_FAILED]: Object.freeze([
    PUBLIC_TARGET_RESULT_OUTCOME.FAILED,
  ] as const),
  [PUBLIC_OPERATION_FIXED_PHASE.TARGET_BLOCKED]: Object.freeze([
    PUBLIC_TARGET_RESULT_OUTCOME.BLOCKED,
    PUBLIC_TARGET_RESULT_OUTCOME.MANUAL,
    PUBLIC_TARGET_RESULT_OUTCOME.REQUIRED_USER_ACTION,
    PUBLIC_TARGET_RESULT_OUTCOME.UNSUPPORTED,
  ] as const),
  [PUBLIC_OPERATION_FIXED_PHASE.TARGET_NEEDS_RECOVERY]: Object.freeze([
    PUBLIC_TARGET_RESULT_OUTCOME.NEEDS_RECOVERY,
  ] as const),
  [PUBLIC_OPERATION_PARTICIPANT_TARGET_PHASE.ACCEPTED]: Object.freeze([
    PUBLIC_TARGET_RESULT_OUTCOME.APPLIED,
  ] as const),
  [PUBLIC_OPERATION_PARTICIPANT_TARGET_PHASE.FAILED]: Object.freeze([
    PUBLIC_TARGET_RESULT_OUTCOME.FAILED,
  ] as const),
  [PUBLIC_OPERATION_PARTICIPANT_TARGET_PHASE.CANCELED]: Object.freeze([
    PUBLIC_TARGET_RESULT_OUTCOME.REVERSED,
  ] as const),
  [PUBLIC_OPERATION_PARTICIPANT_TARGET_PHASE.UNCERTAIN]: Object.freeze([
    PUBLIC_TARGET_RESULT_OUTCOME.NEEDS_RECOVERY,
  ] as const),
} satisfies Partial<
  Readonly<Record<PublicOperationPhaseV1, readonly PublicTargetResultOutcomeV1[]>>
>);

export type PublicOperationTargetBearingPhaseV1 =
  keyof typeof PUBLIC_OPERATION_TARGET_OUTCOMES_BY_PHASE;

export const PUBLIC_ACTION_TARGET_SCOPE = Object.freeze({
  PROJECT: "project",
  USER: "user",
} as const);
export type PublicActionTargetScopeV1 = ValueOf<typeof PUBLIC_ACTION_TARGET_SCOPE>;

export const PUBLIC_ACTION_TARGET_APPLY_FAILURE = Object.freeze({
  ABORT_SCOPE: "abort-scope",
  OMIT_AFTER_ROLLBACK: "omit-after-rollback",
} as const);
export type PublicActionTargetApplyFailureV1 = ValueOf<typeof PUBLIC_ACTION_TARGET_APPLY_FAILURE>;

export const PUBLIC_ACTION_TARGET_HEALTH_FAILURE = Object.freeze({
  ABORT_SCOPE: PUBLIC_ACTION_TARGET_APPLY_FAILURE.ABORT_SCOPE,
  OMIT_AFTER_ROLLBACK: PUBLIC_ACTION_TARGET_APPLY_FAILURE.OMIT_AFTER_ROLLBACK,
  COMMIT_DEGRADED: "commit-degraded",
} as const);
export type PublicActionTargetHealthFailureV1 = ValueOf<typeof PUBLIC_ACTION_TARGET_HEALTH_FAILURE>;

export const PUBLIC_ACTION_TARGET_SUBJECT_KIND = Object.freeze({
  CONVERSATION: "conversation",
  CAPABILITY: "capability",
} as const);
export type PublicActionTargetSubjectKindV1 = ValueOf<typeof PUBLIC_ACTION_TARGET_SUBJECT_KIND>;

const PUBLIC_OPERATION_PREFIX_PHASES = Object.freeze({
  [PUBLIC_OPERATION_PHASE_PREFIX.REVISION]: Object.freeze(
    Object.values(PUBLIC_OPERATION_REVISION_PHASE),
  ),
  [PUBLIC_OPERATION_PHASE_PREFIX.PARTICIPANT_START]: Object.freeze(
    Object.values(PUBLIC_OPERATION_PARTICIPANT_START_PHASE),
  ),
  [PUBLIC_OPERATION_PHASE_PREFIX.AUTHORITY_CHANGE]: Object.freeze(
    Object.values(PUBLIC_OPERATION_AUTHORITY_CHANGE_PHASE),
  ),
  [PUBLIC_OPERATION_PHASE_PREFIX.AUTHORITY_REPAIR]: Object.freeze(
    Object.values(PUBLIC_OPERATION_AUTHORITY_REPAIR_PHASE),
  ),
  [PUBLIC_OPERATION_PHASE_PREFIX.CONVERSATION_RECEIPT]: Object.freeze(
    Object.values(PUBLIC_OPERATION_CONVERSATION_RECEIPT_PHASE),
  ),
} as const);

const memberOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && values.some((candidate) => candidate === value);

export const isPublicOperationProgressStatus = (
  value: unknown,
): value is PublicOperationProgressStatusV1 => memberOf(PUBLIC_OPERATION_PROGRESS_STATUSES, value);

export function isPublicOperationPhase(value: unknown): value is PublicOperationPhaseV1 {
  if (typeof value !== "string") return false;
  if (memberOf(Object.values(PUBLIC_OPERATION_FIXED_PHASE), value)) return true;
  const separator = value.indexOf(":");
  if (separator < 1) return false;
  const prefix = value.slice(0, separator);
  if (!Object.hasOwn(PUBLIC_OPERATION_PREFIX_PHASES, prefix)) return false;
  const phases = PUBLIC_OPERATION_PREFIX_PHASES[
    prefix as keyof typeof PUBLIC_OPERATION_PREFIX_PHASES
  ] as readonly string[];
  return memberOf(phases, value.slice(separator + 1));
}

export const isPublicTargetResultOutcome = (value: unknown): value is PublicTargetResultOutcomeV1 =>
  memberOf(PUBLIC_TARGET_RESULT_OUTCOMES, value);

export const isPublicTargetResultHealth = (value: unknown): value is PublicTargetResultHealthV1 =>
  memberOf(PUBLIC_TARGET_RESULT_HEALTHS, value);

export const isPublicActionTargetScope = (value: unknown): value is PublicActionTargetScopeV1 =>
  memberOf(Object.values(PUBLIC_ACTION_TARGET_SCOPE), value);

export const isPublicActionTargetApplyFailure = (
  value: unknown,
): value is PublicActionTargetApplyFailureV1 =>
  memberOf(Object.values(PUBLIC_ACTION_TARGET_APPLY_FAILURE), value);

export const isPublicActionTargetHealthFailure = (
  value: unknown,
): value is PublicActionTargetHealthFailureV1 =>
  memberOf(Object.values(PUBLIC_ACTION_TARGET_HEALTH_FAILURE), value);

export const isPublicActionTargetSubjectKind = (
  value: unknown,
): value is PublicActionTargetSubjectKindV1 =>
  memberOf(Object.values(PUBLIC_ACTION_TARGET_SUBJECT_KIND), value);

export function publicOperationTargetOutcomes(
  phase: PublicOperationPhaseV1,
): readonly PublicTargetResultOutcomeV1[] | null {
  if (!Object.hasOwn(PUBLIC_OPERATION_TARGET_OUTCOMES_BY_PHASE, phase)) return null;
  return PUBLIC_OPERATION_TARGET_OUTCOMES_BY_PHASE[
    phase as PublicOperationTargetBearingPhaseV1
  ] as readonly PublicTargetResultOutcomeV1[];
}

export const isPublicOperationParticipantTargetPhase = (
  phase: unknown,
): phase is PublicOperationParticipantTargetPhaseV1 =>
  memberOf(Object.values(PUBLIC_OPERATION_PARTICIPANT_TARGET_PHASE), phase);

export const isPublicOperationStateDependentStatusPhase = (
  phase: unknown,
): phase is PublicOperationStateDependentStatusPhaseV1 =>
  memberOf(PUBLIC_OPERATION_STATE_DEPENDENT_STATUS_PHASES, phase);
