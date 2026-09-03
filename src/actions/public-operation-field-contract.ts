export const PUBLIC_OPERATION_PROGRESS_FIELD = Object.freeze({
  SEQUENCE: "sequence",
  PHASE: "phase",
  STATUS: "status",
  MESSAGE_CODE: "message_code",
  AT: "at",
} as const);

export const PUBLIC_OPERATION_PROGRESS_FIELDS = Object.freeze(
  Object.values(PUBLIC_OPERATION_PROGRESS_FIELD),
);

export const PUBLIC_TARGET_RESULT_FIELD = Object.freeze({
  TARGET_ID: "target_id",
  TARGET: "target",
  SUBJECT: "subject",
  OUTCOME: "outcome",
  HEALTH: "health",
  EVIDENCE_DIGEST: "evidence_digest",
} as const);

export const PUBLIC_TARGET_RESULT_FIELDS = Object.freeze(Object.values(PUBLIC_TARGET_RESULT_FIELD));

export const PUBLIC_ACTION_TARGET_FIELD = Object.freeze({
  SCOPE: "scope",
  ENGINE: "engine",
  PARTICIPANT_ID: "participant_id",
  REQUIRED: "required",
  ON_APPLY_FAILURE: "on_apply_failure",
  ON_HEALTH_FAILURE: "on_health_failure",
} as const);

export const PUBLIC_ACTION_TARGET_FIELDS = Object.freeze(Object.values(PUBLIC_ACTION_TARGET_FIELD));

export const PUBLIC_ACTION_TARGET_SUBJECT_FIELD = Object.freeze({
  KIND: "kind",
  ACTION_TYPE: "action_type",
  PARTICIPANT_ID: "participant_id",
  PACKAGE_ID: "package_id",
  COMPONENT_ID: "component_id",
} as const);

export const PUBLIC_ACTION_TARGET_CONVERSATION_SUBJECT_FIELDS = Object.freeze([
  PUBLIC_ACTION_TARGET_SUBJECT_FIELD.KIND,
  PUBLIC_ACTION_TARGET_SUBJECT_FIELD.ACTION_TYPE,
  PUBLIC_ACTION_TARGET_SUBJECT_FIELD.PARTICIPANT_ID,
] as const);

export const PUBLIC_ACTION_TARGET_CAPABILITY_SUBJECT_FIELDS = Object.freeze([
  PUBLIC_ACTION_TARGET_SUBJECT_FIELD.KIND,
  PUBLIC_ACTION_TARGET_SUBJECT_FIELD.PACKAGE_ID,
  PUBLIC_ACTION_TARGET_SUBJECT_FIELD.COMPONENT_ID,
] as const);
