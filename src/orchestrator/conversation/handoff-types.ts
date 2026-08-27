import type { ACTION_PREVIEW_PROJECTOR_VERSION } from "../../actions/public-action-contract.js";
import type { Engine } from "../../core/agent-contract.js";
import type {
  CONVERSATION_CONTEXT_HANDOFF_FIELDS,
  CONVERSATION_HANDOFF_CONTINUITY,
  CONVERSATION_HANDOFF_OPTIONAL_GROUP_FIELDS,
  CONVERSATION_HANDOFF_SELECTION_PLAN_FIELDS,
  CONVERSATION_PUBLIC_ARTIFACT_DELIVERY,
  CONVERSATION_PUBLIC_ARTIFACT_KIND,
  CONVERSATION_PUBLIC_ARTIFACT_REFERENCE_FIELDS,
  CONVERSATION_PUBLIC_ARTIFACT_RESOLVER,
  CONVERSATION_PUBLIC_COMPACTION_ARTIFACT_FIELDS,
  CONVERSATION_PUBLIC_EVENT_RANGE_FIELDS,
  CONVERSATION_PUBLIC_HANDOFF_BINDING_FIELDS,
  CONVERSATION_PUBLIC_HANDOFF_CONSENSUS_FIELDS,
  CONVERSATION_PUBLIC_HANDOFF_MESSAGE_FIELDS,
  CONVERSATION_PUBLIC_HANDOFF_POLICY_FIELDS,
  CONVERSATION_PUBLIC_HANDOFF_PROJECTION_FIELDS,
  CONVERSATION_PUBLIC_HANDOFF_RESPONSE_FIELDS,
  CONVERSATION_PUBLIC_HANDOFF_SOURCE_FIELDS,
  CONVERSATION_PUBLIC_HANDOFF_TRANSCRIPT_FIELDS,
  CONVERSATION_PUBLIC_PROFILE,
  CONVERSATION_PUBLIC_PROMPT_ARTIFACT_SELECTION_FIELDS,
  CONVERSATION_PUBLIC_SCHEMA_VERSION,
  ConversationPublicResponseTerminalStatusV1,
} from "./conversation-public-wire-contract.js";

/** Compatibility alias for the persisted handoff wire contract. */
export type HandoffEngineName = Engine;

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
  terminal_status: ConversationPublicResponseTerminalStatusV1;
  created_at: string;
  redaction_manifest_digest: string;
}

export interface PublicArtifactReferenceV1 {
  artifact_id: string;
  artifact_kind:
    | typeof CONVERSATION_PUBLIC_ARTIFACT_KIND.CONVERSATION
    | typeof CONVERSATION_PUBLIC_ARTIFACT_KIND.OMITTED_EVENTS;
  media_type: string;
  byte_length: number;
  content_sha256: string;
  resolver: typeof CONVERSATION_PUBLIC_ARTIFACT_RESOLVER.CONVERSATION;
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
  continuity:
    | typeof CONVERSATION_HANDOFF_CONTINUITY.RETAINED
    | typeof CONVERSATION_HANDOFF_CONTINUITY.ADDED;
}

export interface PublicHandoffPolicyV1 {
  policy_id: string;
  public_summary: string;
  source_policy_value: string;
  source_conversation_lock_digest: string;
  projector_version: typeof ACTION_PREVIEW_PROJECTOR_VERSION;
  rules_digest: string;
  policy_digest: string;
}

export type PromptArtifactSelectionV1 =
  | {
      artifact: PublicArtifactReferenceV1;
      delivery: typeof CONVERSATION_PUBLIC_ARTIFACT_DELIVERY.INLINE_PUBLIC_TEXT;
      public_text: string;
    }
  | {
      artifact: PublicArtifactReferenceV1;
      delivery: typeof CONVERSATION_PUBLIC_ARTIFACT_DELIVERY.RESOLVER;
      public_text: null;
    };

export interface PublicCompactionArtifactV1 {
  schema_version: typeof CONVERSATION_PUBLIC_SCHEMA_VERSION;
  profile: typeof CONVERSATION_PUBLIC_PROFILE.COMPACTION;
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
  schema_version: typeof CONVERSATION_PUBLIC_SCHEMA_VERSION;
  projection_profile: typeof CONVERSATION_PUBLIC_PROFILE.HANDOFF;
  source: PublicHandoffSourceV1;
  topic: string | null;
  policy: PublicHandoffPolicyV1;
  bindings: PublicHandoffBindingV1[];
  transcript: PublicHandoffTranscriptV1;
  compaction: PublicCompactionArtifactV1 | null;
  consensus: PublicHandoffConsensusV1;
  artifacts: PromptArtifactSelectionV1[];
}

export interface PublicHandoffTranscriptV1 {
  user_messages: PublicHandoffMessageV1[];
  final_responses: PublicHandoffResponseV1[];
  omitted_public_ranges: PublicEventRangeV1[];
}

export interface PublicHandoffConsensusV1 {
  score: number | null;
  synthesis: string | null;
}

export interface HandoffSelectionPlanV1 {
  schema_version: typeof CONVERSATION_PUBLIC_SCHEMA_VERSION;
  source_public_head_digest: string;
  active_compaction_digest: string | null;
  prompt_budget_bytes: number;
  mandatory_artifact_ids: string[];
  optional_groups: HandoffOptionalGroupV1[];
  selection_digest: string;
}

export interface HandoffOptionalGroupV1 {
  group_id: string;
  schema_version: typeof CONVERSATION_PUBLIC_SCHEMA_VERSION;
  source_public_head_digest: string;
  anchor_revision_ordinal: number;
  anchor_public_seq: number;
  anchor_event_id: string;
  event_ids: string[];
  artifact_ids: string[];
}

export interface ContextHandoffV1 {
  schema_version: typeof CONVERSATION_PUBLIC_SCHEMA_VERSION;
  projection_profile: typeof CONVERSATION_PUBLIC_PROFILE.HANDOFF;
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

type SameKeys<Value, Fields extends readonly PropertyKey[]> = Exclude<
  keyof Value,
  Fields[number]
> extends never
  ? Exclude<Fields[number], keyof Value> extends never
    ? true
    : false
  : false;
type Assert<Condition extends true> = Condition;

export type PublicArtifactReferenceFieldParity = Assert<
  SameKeys<PublicArtifactReferenceV1, typeof CONVERSATION_PUBLIC_ARTIFACT_REFERENCE_FIELDS>
>;
export type PublicHandoffSourceFieldParity = Assert<
  SameKeys<PublicHandoffSourceV1, typeof CONVERSATION_PUBLIC_HANDOFF_SOURCE_FIELDS>
>;
export type PublicHandoffBindingFieldParity = Assert<
  SameKeys<PublicHandoffBindingV1, typeof CONVERSATION_PUBLIC_HANDOFF_BINDING_FIELDS>
>;
export type PublicHandoffMessageFieldParity = Assert<
  SameKeys<PublicHandoffMessageV1, typeof CONVERSATION_PUBLIC_HANDOFF_MESSAGE_FIELDS>
>;
export type PublicHandoffResponseFieldParity = Assert<
  SameKeys<PublicHandoffResponseV1, typeof CONVERSATION_PUBLIC_HANDOFF_RESPONSE_FIELDS>
>;
export type PublicHandoffPolicyFieldParity = Assert<
  SameKeys<PublicHandoffPolicyV1, typeof CONVERSATION_PUBLIC_HANDOFF_POLICY_FIELDS>
>;
export type PublicHandoffTranscriptFieldParity = Assert<
  SameKeys<PublicHandoffTranscriptV1, typeof CONVERSATION_PUBLIC_HANDOFF_TRANSCRIPT_FIELDS>
>;
export type PublicHandoffConsensusFieldParity = Assert<
  SameKeys<PublicHandoffConsensusV1, typeof CONVERSATION_PUBLIC_HANDOFF_CONSENSUS_FIELDS>
>;
export type PromptArtifactSelectionFieldParity = Assert<
  SameKeys<PromptArtifactSelectionV1, typeof CONVERSATION_PUBLIC_PROMPT_ARTIFACT_SELECTION_FIELDS>
>;
export type PromptHandoffProjectionFieldParity = Assert<
  SameKeys<PromptHandoffProjectionV1, typeof CONVERSATION_PUBLIC_HANDOFF_PROJECTION_FIELDS>
>;
export type PublicCompactionArtifactFieldParity = Assert<
  SameKeys<PublicCompactionArtifactV1, typeof CONVERSATION_PUBLIC_COMPACTION_ARTIFACT_FIELDS>
>;
export type PublicEventRangeFieldParity = Assert<
  SameKeys<PublicEventRangeV1, typeof CONVERSATION_PUBLIC_EVENT_RANGE_FIELDS>
>;
export type HandoffOptionalGroupFieldParity = Assert<
  SameKeys<HandoffOptionalGroupV1, typeof CONVERSATION_HANDOFF_OPTIONAL_GROUP_FIELDS>
>;
export type HandoffSelectionPlanFieldParity = Assert<
  SameKeys<HandoffSelectionPlanV1, typeof CONVERSATION_HANDOFF_SELECTION_PLAN_FIELDS>
>;
export type ContextHandoffFieldParity = Assert<
  SameKeys<ContextHandoffV1, typeof CONVERSATION_CONTEXT_HANDOFF_FIELDS>
>;
