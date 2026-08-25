export type HandoffEngineName = "claude" | "codex" | "copilot" | "opencode" | "antigravity";

export interface PublicHandoffSourceV1 {
  conversation_id: string;
  revision_id: string;
  last_seq: number;
  lock_digest: string;
}

export interface PublicHandoffMessageV1 {
  event_id: string;
  conversation_id: string;
  revision_id: string;
  revision_ordinal: number;
  public_seq: number;
  author_public_id: string;
  text: string;
  created_at: string;
  redaction_manifest_digest: string;
}

export interface PublicHandoffResponseV1 {
  event_id: string;
  conversation_id: string;
  revision_id: string;
  revision_ordinal: number;
  public_seq: number;
  participant_id: string;
  role_ref: string;
  text: string;
  terminal_status: "completed" | "stopped" | "failed";
  created_at: string;
  redaction_manifest_digest: string;
}

export interface PublicArtifactReferenceV1 {
  artifact_id: string;
  artifact_kind: "conversation-artifact" | "omitted-public-events";
  media_type: string;
  byte_length: number;
  content_sha256: string;
  resolver: "conversation-artifact-v1";
}

export interface PublicEventRangeV1 {
  revision_id: string;
  revision_ordinal: number;
  first_public_seq: number;
  last_public_seq: number;
  first_event_id: string;
  last_event_id: string;
  event_count: number;
  canonical_events_sha256: string;
  artifact: PublicArtifactReferenceV1;
}

export interface PublicHandoffBindingV1 {
  participant_id: string;
  engine: HandoffEngineName;
  model: string | null;
  role_ref: string;
  continuity: "retained" | "added";
}

export interface PublicHandoffPolicyV1 {
  policy_id: string;
  public_summary: string;
  source_policy_value: string;
  source_conversation_lock_digest: string;
  projector_version: "vf-public-projector/1";
  rules_digest: string;
  policy_digest: string;
}

export type PromptArtifactSelectionV1 =
  | {
      artifact: PublicArtifactReferenceV1;
      delivery: "inline-public-text";
      public_text: string;
    }
  | {
      artifact: PublicArtifactReferenceV1;
      delivery: "conversation-artifact-resolver";
      public_text: null;
    };

export interface PublicCompactionArtifactV1 {
  schema_version: "1.0";
  profile: "vf-public-compaction/1";
  source: PublicHandoffSourceV1;
  source_public_head_digest: string;
  oversized_candidate_digest: string;
  selection_plan_digest: string;
  previous_compaction_digest: string | null;
  compaction_input_digest: string;
  public_summary: string;
  retained_event_ids: string[];
  retained_artifact_ids: string[];
  omitted_public_ranges: PublicEventRangeV1[];
  created_at: string;
  content_digest: string;
}

export interface PromptHandoffProjectionV1 {
  schema_version: "1.0";
  projection_profile: "vf-public-handoff/1";
  source: PublicHandoffSourceV1;
  topic: string | null;
  policy: PublicHandoffPolicyV1;
  bindings: PublicHandoffBindingV1[];
  transcript: {
    user_messages: PublicHandoffMessageV1[];
    final_responses: PublicHandoffResponseV1[];
    omitted_public_ranges: PublicEventRangeV1[];
  };
  compaction: PublicCompactionArtifactV1 | null;
  consensus: { score: number | null; synthesis: string | null };
  artifacts: PromptArtifactSelectionV1[];
}

export interface HandoffSelectionPlanV1 {
  schema_version: "1.0";
  source_public_head_digest: string;
  active_compaction_digest: string | null;
  prompt_budget_bytes: number;
  mandatory_artifact_ids: string[];
  optional_groups: Array<{
    group_id: string;
    anchor_revision_ordinal: number;
    anchor_public_seq: number;
    anchor_event_id: string;
    event_ids: string[];
    artifact_ids: string[];
  }>;
  selection_digest: string;
}

export interface ContextHandoffV1 {
  schema_version: "1.0";
  projection_profile: "vf-public-handoff/1";
  handoff_id: string;
  source: PublicHandoffSourceV1;
  topic: string | null;
  policy: PublicHandoffPolicyV1;
  bindings: PublicHandoffBindingV1[];
  transcript: PromptHandoffProjectionV1["transcript"];
  compaction: PublicCompactionArtifactV1 | null;
  consensus: PromptHandoffProjectionV1["consensus"];
  artifacts: PublicArtifactReferenceV1[];
  handoff_selection_digest: string;
  prompt_projection: PromptHandoffProjectionV1;
  prompt_projection_digest: string;
  digest: string;
}
