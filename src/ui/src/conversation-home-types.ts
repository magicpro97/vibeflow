import type { ConversationTraceRecord } from "./conversation-types.js";

export type ConversationLifecycle =
  | "INIT"
  | "ACTIVE"
  | "PAUSED"
  | "COMPLETED"
  | "STOPPED"
  | "FAILED"
  | "ABORTED";

export interface HomeParticipant {
  participant_id: string;
  role_ref: string;
  engine: Engine;
  model: string | null;
}

export interface HomeRevisionSummary {
  schema_version: "1.0";
  conversation_id: string;
  revision_id: string;
  revision_ordinal: number;
  parent_conversation_id: string | null;
  parent_revision_id: string | null;
  lineage_status: "verified" | "unverified";
  topic: string;
  policy: string;
  lifecycle: ConversationLifecycle;
  health: "healthy" | "degraded";
  participants: HomeParticipant[];
  created_at: string;
  updated_at: string;
  last_seq: number;
  lock_digest: string;
}

export interface HomeSessionSummary {
  schema_version: "1.0";
  root_session_id: string;
  head_status: "committed" | "ambiguous" | "unclaimed";
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
  schema_version: "1.0";
  items: HomeSessionSummary[];
  next_cursor: string | null;
  catalog_generation: string;
  source_watermark: string;
  catalog_health: "ready" | "rebuilding" | "degraded";
}

export interface HomeAuthoritativeHeadResponse {
  schema_version: "1.0";
  root_session_id: string;
  head_status: "committed" | "ambiguous" | "unclaimed";
  head_epoch: number;
  head_digest: string;
  active: HomeRevisionSummary | null;
}

export interface HomeLineageNode {
  conversation_id: string;
  revision_id: string;
  revision_ordinal: number;
}

export interface HomeActionProgress {
  sequence: number;
  phase: string;
  status: "pending" | "running" | "succeeded" | "failed" | "reversed";
  message_code: string;
  at: string;
}

export type HomeActionOperationState =
  | "pending_review"
  | "approved"
  | "committing"
  | "succeeded"
  | "failed"
  | "denied"
  | "canceled"
  | "expired"
  | "stale"
  | "needs_recovery";

export interface HomeActionOperation {
  schema_version: "1.0";
  operation_id: string | null;
  proposal_id: string;
  proposal_digest: string;
  approval_id: string | null;
  approval_digest: string | null;
  correlation_id: string;
  domain: "conversation" | "capability";
  state: HomeActionOperationState;
  phase_sequence: number | null;
  latest_event_cursor: string | null;
  progress: HomeActionProgress[];
  targets: Array<{
    target_id: string;
    outcome: string;
    health: string;
  }>;
  delivery: string;
  result_ref: string | null;
  error: HomeApiErrorBody | null;
  recovery_actions: string[];
  created_at: string;
  updated_at: string;
}

export interface HomeActionProposal {
  schema_version: "1.0";
  proposal_id: string;
  proposal_digest: string;
  origin_event_id: string | null;
  action_type: string;
  domain: "conversation" | "capability";
  scope: "conversation" | "project" | "user";
  risk: "low" | "medium" | "high" | "critical";
  effect_classes: string[];
  targets: unknown[];
  package_pins: Array<{ id: string; version: string; trust: string }>;
  reversibility: string;
  preview: {
    title: string;
    summary: string;
    permission_delta: Array<{
      permission_id: string;
      change: string;
      public_scope: string;
      enforcement: string;
    }>;
    target_dispositions: Array<{
      target_id: string;
      execution: string;
      reason_code: string | null;
    }>;
    recovery_actions: string[];
  };
  created_at: string;
  expires_at: string;
}

export interface HomeActionApproval {
  schema_version: "1.0";
  approval_id: string;
  approval_digest: string;
  proposal_id: string;
  proposal_digest: string;
  decision: "approved" | "denied";
  challenge_class: string;
  decided_at: string;
  expires_at: string;
}

export interface HomePendingChallenge {
  id: string;
  phrase: string;
  response: string;
  expires_at: string;
}

export interface HomeActionView {
  proposal: HomeActionProposal;
  approval: HomeActionApproval | null;
  operation: HomeActionOperation;
}

export type HomeReactionEmoji = "👍" | "👎" | "❤️" | "🎉" | "👀" | "🤔" | "✅" | "❗";

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
  target_kind: "user-message" | "completed-agent-response";
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
  state: "ready" | "degraded";
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
  target_kind: "user-message" | "completed-agent-response" | null;
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
      kind: "revision-boundary";
      boundary_id: string;
      from: HomeLineageNode;
      to: HomeLineageNode;
      handoff_id: string;
      prompt_projection_digest: string;
    }
  | {
      kind: "conversation-start";
      revision_ordinal: number;
      conversation_id: string;
      revision_id: string;
      anchor_id: string;
      action_operations: { items: HomeActionOperation[] };
    }
  | {
      kind: "conversation-event";
      revision_ordinal: number;
      event: ConversationTraceRecord & { event_id: string; public_session_ref: string | null };
      interaction: HomeTimelineInteraction;
      action_operations: { items: HomeActionOperation[] };
    };

export interface HomeTimelineResponse {
  schema_version: "1.0";
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

export type HomeConversationStreamStatus =
  | "idle"
  | "connecting"
  | "live"
  | "reconnecting"
  | "error";

export type CapabilityStatus =
  | "absent"
  | "ready"
  | "degraded"
  | "blocked"
  | "failed"
  | "unknown"
  | "stale"
  | "drifted"
  | "orphaned"
  | "unmanaged"
  | "manual"
  | "unsupported"
  | "needs-recovery";

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
import type { CapabilityScope } from "../../capabilities/manifest/types.js";
import type { Engine } from "../../core/types.js";
