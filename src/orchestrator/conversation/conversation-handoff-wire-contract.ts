/** Exact JSON object shapes owned by the durable public handoff protocol. */
export const CONVERSATION_PUBLIC_OMITTED_EVENTS_ARTIFACT_ID_PREFIX =
  "vf-omitted-public-events-" as const;
export const CONVERSATION_PUBLIC_OMITTED_EVENTS_MEDIA_TYPE =
  "application/vnd.vibeflow.public-events+json" as const;
export const CONVERSATION_PUBLIC_COMPACTION_SUMMARY_MAX_BYTES = 64 * 1024;
// A single UTF-8 byte can expand to a six-byte JSON escape (for example, `\u0000`).
export const CONVERSATION_PUBLIC_COMPACTION_SUMMARY_MAX_CANONICAL_JSON_BYTES =
  CONVERSATION_PUBLIC_COMPACTION_SUMMARY_MAX_BYTES * 6 + 2;
export const CONVERSATION_PUBLIC_OMITTED_EVENTS_PAYLOAD_FIELDS = Object.freeze([
  "events",
  "schema_version",
] as const);

export const CONVERSATION_PUBLIC_HANDOFF_SOURCE_FIELDS = Object.freeze([
  "conversation_id",
  "last_seq",
  "lock_digest",
  "revision_id",
] as const);

export const CONVERSATION_PUBLIC_HANDOFF_POLICY_FIELDS = Object.freeze([
  "policy_digest",
  "policy_id",
  "projector_version",
  "public_summary",
  "rules_digest",
  "source_conversation_lock_digest",
  "source_policy_value",
] as const);

export const CONVERSATION_PUBLIC_HANDOFF_TRANSCRIPT_FIELDS = Object.freeze([
  "final_responses",
  "omitted_public_ranges",
  "user_messages",
] as const);

export const CONVERSATION_PUBLIC_HANDOFF_CONSENSUS_FIELDS = Object.freeze([
  "score",
  "synthesis",
] as const);

export const CONVERSATION_PUBLIC_PROMPT_ARTIFACT_SELECTION_FIELDS = Object.freeze([
  "artifact",
  "delivery",
  "public_text",
] as const);

export const CONVERSATION_PUBLIC_HANDOFF_PROJECTION_FIELDS = Object.freeze([
  "artifacts",
  "bindings",
  "compaction",
  "consensus",
  "policy",
  "projection_profile",
  "schema_version",
  "source",
  "topic",
  "transcript",
] as const);

export const CONVERSATION_PUBLIC_COMPACTION_ARTIFACT_FIELDS = Object.freeze([
  "compaction_input_digest",
  "content_digest",
  "created_at",
  "omitted_public_ranges",
  "oversized_candidate_digest",
  "previous_compaction_digest",
  "profile",
  "public_summary",
  "retained_artifact_ids",
  "retained_event_ids",
  "schema_version",
  "selection_plan_digest",
  "source",
  "source_public_head_digest",
] as const);
