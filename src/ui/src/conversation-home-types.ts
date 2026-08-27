import type { ActionOperationState } from "../../actions/protocol-contract.js";
import type { PublicApiErrorBodyV1 } from "../../actions/public-error-contract.js";
import type {
  ActionOperationViewV1,
  ActionOperationsPageV1,
  PublicActionApprovalViewV1,
  PublicActionProposalViewV1,
} from "../../actions/public-types.js";
import type {
  CONVERSATION_CATALOG_SCHEMA_VERSION,
  CONVERSATION_TIMELINE_ITEM_KIND,
  ConversationCatalogHealth,
  ConversationHeadStatus,
  ConversationLineageStatus,
} from "../../orchestrator/conversation/conversation-catalog-contract.js";
import type {
  ConversationInteractionState,
  ReactionEmojiV1,
} from "../../orchestrator/conversation/conversation-interaction-contract.js";
import type { ConversationMessageQueueQuoteTargetKindV1 } from "../../orchestrator/conversation/conversation-message-queue-contract.js";
import type {
  ConversationHealthV1,
  ConversationLifecycleV1,
} from "../../orchestrator/conversation/conversation-public-wire-contract.js";
import type { ConversationClientStreamState } from "../../orchestrator/conversation/conversation-sse-contract.js";
import type { ConversationTraceRecord } from "./conversation-types.js";

export type ConversationLifecycle = ConversationLifecycleV1;

export interface HomeParticipant {
  participant_id: string;
  role_ref: string;
  engine: Engine;
  model: string | null;
}

export interface HomeRevisionSummary {
  schema_version: typeof CONVERSATION_CATALOG_SCHEMA_VERSION;
  conversation_id: string;
  revision_id: string;
  revision_ordinal: number;
  parent_conversation_id: string | null;
  parent_revision_id: string | null;
  lineage_status: ConversationLineageStatus;
  topic: string;
  policy: string;
  lifecycle: ConversationLifecycle;
  health: ConversationHealthV1;
  participants: HomeParticipant[];
  created_at: string;
  updated_at: string;
  last_seq: number;
  lock_digest: string;
}

export interface HomeSessionSummary {
  schema_version: typeof CONVERSATION_CATALOG_SCHEMA_VERSION;
  root_session_id: string;
  head_status: ConversationHeadStatus;
  root: HomeRevisionSummary;
  active_conversation_id: string | null;
  active_revision_id: string | null;
  active_revision_ordinal: number | null;
  revision_count: number;
  active: HomeRevisionSummary | null;
  matched_revision: HomeLineageNode | null;
  association_ids: string[];
  sort_updated_at: string;
  lineage_cursor: string;
}

export interface HomeCatalogResponse {
  schema_version: typeof CONVERSATION_CATALOG_SCHEMA_VERSION;
  items: HomeSessionSummary[];
  next_cursor: string | null;
  catalog_generation: string;
  source_watermark: string;
  catalog_health: ConversationCatalogHealth;
}

export interface HomeAuthoritativeHeadResponse {
  schema_version: typeof CONVERSATION_CATALOG_SCHEMA_VERSION;
  root_session_id: string;
  head_status: ConversationHeadStatus;
  head_epoch: number;
  head_digest: string;
  active: HomeRevisionSummary | null;
}

export interface HomeLineageNode {
  conversation_id: string;
  revision_id: string;
  revision_ordinal: number;
}

export type HomeActionProgress = ActionOperationViewV1["progress"][number];

export type HomeActionOperationState = ActionOperationState;

export type HomeActionOperation = ActionOperationViewV1;

export interface HomeActionProposal {
  schema_version: "1.0";
  proposal_id: string;
  proposal_digest: string;
  origin_event_id: string | null;
  action_type: PublicActionProposalViewV1["action_type"];
  domain: PublicActionProposalViewV1["domain"];
  scope: PublicActionProposalViewV1["scope"];
  authority_binding_mode?: PublicActionProposalViewV1["authority_binding_mode"];
  risk: PublicActionProposalViewV1["risk"];
  effect_classes: PublicActionProposalViewV1["effect_classes"];
  targets: PublicActionProposalViewV1["targets"];
  package_pins: Array<{
    id: string;
    version: string;
    trust: PublicActionProposalViewV1["package_pins"][number]["trust"];
    source_kind?: PublicActionProposalViewV1["package_pins"][number]["source_kind"];
    content_sha256?: string;
    nonportable?: boolean;
    pin_digest?: string;
  }>;
  adapter_set_digest?: string;
  plan_digest?: string;
  policy_digest?: string;
  permission_digest?: string;
  reversibility: PublicActionProposalViewV1["reversibility"];
  preview: {
    title: string;
    summary: string;
    action_type?: PublicActionProposalViewV1["action_type"];
    planning_options?: { mode: string; network_read: string };
    review_fields?: Array<{
      json_pointer: string;
      label: string;
      before: unknown;
      after: unknown;
      private_binding_digest: string | null;
    }>;
    targets?: PublicActionProposalViewV1["targets"];
    target_dispositions: Array<{
      target_id: string;
      execution: string;
      reason_code: string | null;
    }>;
    package_pins?: PublicActionProposalViewV1["package_pins"];
    permission_delta: Array<{
      permission_id: string;
      change: string;
      public_scope: string;
      enforcement: string;
    }>;
    dependency_delta?: unknown[];
    config_diffs?: unknown[];
    effect_classes?: PublicActionProposalViewV1["effect_classes"];
    enforcement?: unknown[];
    reversibility?: PublicActionProposalViewV1["reversibility"];
    health_plan?: unknown[];
    recovery_actions: ActionOperationViewV1["recovery_actions"];
    projector_version?: string;
    rules_digest?: string;
    redaction_manifest_digest?: string;
  };
  created_at: string;
  expires_at: string;
}

export type HomeActionApproval = Omit<PublicActionApprovalViewV1, "decided_by"> & {
  decided_by?: PublicActionApprovalViewV1["decided_by"];
};

export interface HomePendingChallenge {
  id: string;
  phrase: string;
  response: string;
  expires_at: string;
}

export interface HomeActionView {
  schema_version: "1.0";
  proposal: HomeActionProposal;
  approval: HomeActionApproval | null;
  operation: HomeActionOperation;
}

export type HomeActionOperationsPage = Pick<ActionOperationsPageV1, "items"> &
  Partial<Omit<ActionOperationsPageV1, "items">>;

export type HomeReactionEmoji = ReactionEmojiV1;

export interface HomeReactionSummary {
  emoji: HomeReactionEmoji;
  label: string;
  count: number;
  reacted_by_recipient: boolean;
  actor_public_ids: string[];
}

export interface HomeCanonicalMessageReference {
  root_session_id: string;
  conversation_id: string;
  revision_id: string;
  target_event_id: string;
  target_kind: ConversationMessageQueueQuoteTargetKindV1;
  content_digest: string;
}

export interface HomeCanonicalQuoteReference extends HomeCanonicalMessageReference {
  author_public_id: string;
}

export interface HomeQuoteProjection extends HomeCanonicalQuoteReference {
  preview_text: string;
  created_at: string;
}

export interface HomeTimelineInteraction {
  state: ConversationInteractionState;
  message_locator: HomeCanonicalMessageReference | null;
  quote_refs: Array<{
    quoting_message_id: string;
    quote_order: number;
    target: HomeQuoteProjection;
  }>;
  reactions: HomeReactionSummary[];
  diagnostic_code: string | null;
}

export interface HomeTimelineMessageReference {
  root_session_id: string;
  source_key: string;
  conversation_id: string;
  revision_id: string;
  revision_ordinal: number;
  source_event_ids: string[];
  target_event_id: string | null;
  target_kind: ConversationMessageQueueQuoteTargetKindV1 | null;
  content_digest: string | null;
}

export interface HomeQuoteReference extends HomeTimelineMessageReference {
  author_public_id: string;
  author: string;
  excerpt: string;
  at: string | null;
}

export interface HomePendingActionsResponse {
  schema_version: "1.0";
  items: HomeActionView[];
  next_cursor: string | null;
  authority_watermark: string;
}

export type HomeTimelineItem =
  | {
      kind: typeof CONVERSATION_TIMELINE_ITEM_KIND.REVISION_BOUNDARY;
      boundary_id: string;
      from: HomeLineageNode;
      to: HomeLineageNode;
      handoff_id: string;
      prompt_projection_digest: string;
    }
  | {
      kind: typeof CONVERSATION_TIMELINE_ITEM_KIND.CONVERSATION_START;
      revision_ordinal: number;
      conversation_id: string;
      revision_id: string;
      anchor_id: string;
      action_operations: HomeActionOperationsPage;
    }
  | {
      kind: typeof CONVERSATION_TIMELINE_ITEM_KIND.CONVERSATION_EVENT;
      revision_ordinal: number;
      event: ConversationTraceRecord & { event_id: string; public_session_ref: string | null };
      interaction: HomeTimelineInteraction;
      action_operations: HomeActionOperationsPage;
    };

export interface HomeTimelineResponse {
  schema_version: typeof CONVERSATION_CATALOG_SCHEMA_VERSION;
  root_session_id: string;
  head: HomeLineageNode;
  head_epoch: number;
  head_digest: string;
  items: HomeTimelineItem[];
  next_cursor: string | null;
}

export interface HomePagingSection {
  nextCursor: string | null;
  loadingMore: boolean;
}

export interface HomePagingState {
  catalog: HomePagingSection;
  timeline: HomePagingSection;
  pending: HomePagingSection;
  capability: HomePagingSection;
}

export type HomeConversationStreamStatus = ConversationClientStreamState;

export type CapabilityStatus = CapabilityStatusV1;

export interface HomeCapabilityItem {
  package_id: string;
  display_name: string;
  summary: string;
  version: string | null;
  package_pin_digest: string | null;
  scope: CapabilityScope | null;
  status: CapabilityStatus;
  source_trust: string | null;
  scan_status: string;
  cache_status: string;
  targets: Array<{
    target_id: string;
    engine: string | null;
    required: boolean;
    status: CapabilityStatus;
  }>;
  recovery_actions: string[];
}

export interface HomeCapabilityResponse {
  schema_version: "1.0";
  items: HomeCapabilityItem[];
  next_cursor: string | null;
  source_watermark: string;
}

export interface HomeApiErrorBody {
  code: string;
  message: string;
  correlation_id?: string;
  retryable?: boolean;
  recovery_action?: string | null;
  details?: unknown;
}
import type { Engine } from "../../core/agent-contract.js";
import type { CapabilityScope, CapabilityStatusV1 } from "../../core/capability-contract.js";
