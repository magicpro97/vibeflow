import type {
  ActionAuthorityResolverV1,
  ActionProposalDraftV1,
  ActionRequestAuthorityV1,
  CanonicalActionRequestV1,
  PublicActor,
} from "../../src/actions/index.js";
import {
  EMPTY_ADAPTER_SET_DIGEST,
  EMPTY_PERMISSION_DIGEST,
  EMPTY_SOURCE_AUTHORITY_SET_DIGEST,
  actionIdempotencyScopeDigest,
  canonicalActionRequestDigest,
  materializeDispatchPreparationProof,
  materializeDomainPreparedProof,
  materializeDomainTerminalProof,
  materializeProposalPublicationProof,
  materializeReviewAuthorityProof,
} from "../../src/actions/index.js";
import { digestV1 } from "../../src/durability/index.js";

export const testDigest = (label: string): string =>
  digestV1("VF-ACTION-TEST-FIXTURE\0v1\0", { label });

export const fixedNow = Date.parse("2026-08-25T00:01:00.000Z");

export function testAuthorityResolver(
  terminal: "succeeded" | "failed" | "needs_recovery" = "succeeded",
): ActionAuthorityResolverV1 {
  return {
    validateProposalPublication: ({ proposal, canonical_request_digest, now }) =>
      materializeProposalPublicationProof(
        proposal,
        canonical_request_digest,
        testDigest("referenced-publication-closure"),
        now,
      ),
    review: ({ proposal, authority: liveAuthority, now }) =>
      materializeReviewAuthorityProof(
        proposal,
        liveAuthority,
        now,
        new Date(
          Math.min(Date.parse(proposal.expires_at), Date.parse(now) + 20 * 60_000),
        ).toISOString(),
      ),
    prepareDispatch: ({ proposal, approval, now }) => {
      const headerRequired =
        proposal.domain === "capability" ||
        [
          "conversation.add_participant",
          "conversation.remove_participant",
          "conversation.update_participant",
          "conversation.update_settings",
          "conversation.continue_message",
          "conversation.abandon_revision_operation",
          "conversation.retry_revision_operation",
          "conversation.reconcile_revision_operation",
          "authority.repair",
        ].includes(proposal.action.type);
      return materializeDispatchPreparationProof(
        proposal,
        approval,
        headerRequired ? testDigest("domain-header") : null,
        now,
      );
    },
    proveDomainPrepared: ({ dispatch }) =>
      materializeDomainPreparedProof(
        dispatch,
        testDigest("domain-prepared"),
        new Date(Date.parse(dispatch.created_at) + 60_000).toISOString(),
      ),
    resolveTerminal: ({ dispatch }) =>
      materializeDomainTerminalProof(
        dispatch,
        terminal,
        testDigest(`domain-terminal-${terminal}`),
        new Date(Date.parse(dispatch.created_at) + 120_000).toISOString(),
      ),
    validateRecordedTerminal: ({ dispatch, outcome, domain_terminal_digest, recorded_at }) =>
      materializeDomainTerminalProof(dispatch, outcome, domain_terminal_digest, recorded_at),
  };
}

export const human: PublicActor = {
  kind: "human-browser",
  public_actor_id: "actor-browser-1",
  credential_class: "loopback-session",
};

export const authority: ActionRequestAuthorityV1 = {
  schema_version: "1.0",
  principal_digest: testDigest("principal"),
  authority_scope_digest: actionIdempotencyScopeDigest({
    kind: "conversation",
    root_session_id: "root-1",
  }),
  control_session_digest: testDigest("session"),
  csrf_epoch_digest: testDigest("csrf-1"),
  actor: human,
};

type ConversationCanonicalRequestV1 = Extract<CanonicalActionRequestV1, { origin: "conversation" }>;

export function canonicalRequest(
  overrides: Partial<ConversationCanonicalRequestV1> = {},
): ConversationCanonicalRequestV1 {
  return {
    schema_version: "1.0",
    origin: "conversation",
    principal_digest: authority.principal_digest,
    authority_scope_digest: authority.authority_scope_digest,
    planning_options: { mode: "durable", network_read: "ordinary-host-policy" },
    request: {
      schema_version: "1.0",
      anchor_event_id: "event-1",
      expected: {
        mode: "writable-revision",
        conversation_id: "conversation-1",
        revision_id: "revision-1",
        last_seq: 7,
        conversation_lock_digest: testDigest("conversation-lock"),
      },
      candidate: { type: "conversation.stop_operation", operation_id: "old-operation" },
    },
    ...overrides,
  };
}

export function proposalDraft(
  overrides: Partial<ActionProposalDraftV1> = {},
): ActionProposalDraftV1 {
  return {
    schema_version: "1.0",
    idempotency_key: "request-1",
    origin_event_id: "event-1",
    domain: "conversation",
    action_root_locator: { kind: "conversation", root_session_id: "root-1" },
    producer_request_binding: {
      kind: "canonical-action-request",
      digest: canonicalActionRequestDigest(canonicalRequest()),
    },
    planning_options: { mode: "durable", network_read: "ordinary-host-policy" },
    execution_object_closure_digest: null,
    base: {
      root_session_id: "root-1",
      conversation_id: "conversation-1",
      revision_id: "revision-1",
      last_seq: 7,
      conversation_lock_digest: testDigest("conversation-lock"),
      lineage_head_digest: testDigest("lineage-head"),
      lineage_head_epoch: 3,
      capability_scope: null,
      capability_generation_ordinal: null,
      capability_generation_id: null,
      capability_lock_digest: null,
      capability_parent_generation_digests: [],
      user_prerequisites: [],
      authority_binding_mode: "current",
      authority_epoch: 8,
      authority_head_digest: testDigest("authority-head"),
      repair_authorization_binding_digest: null,
    },
    action: { type: "conversation.stop_operation", operation_id: "old-operation" },
    requested_by: human,
    risk: "medium",
    effect_classes: ["project-write"],
    target_set: [],
    package_pins: [],
    source_authority_set_digest: EMPTY_SOURCE_AUTHORITY_SET_DIGEST,
    adapter_set_digest: EMPTY_ADAPTER_SET_DIGEST,
    plan_digest: testDigest("plan"),
    handoff_selection_digest: null,
    policy_digest: testDigest("policy"),
    grant_digest: testDigest("grant"),
    permission_digest: EMPTY_PERMISSION_DIGEST,
    reversibility: "reversible",
    preview: {
      title: "Stop operation",
      summary: "Stop the selected operation safely.",
      action_type: "conversation.stop_operation",
      planning_options: { mode: "durable", network_read: "ordinary-host-policy" },
      review_fields: [],
      targets: [],
      target_dispositions: [],
      package_pins: [],
      permission_delta: [],
      dependency_delta: [],
      config_diffs: [],
      effect_classes: ["project-write"],
      enforcement: [],
      reversibility: "reversible",
      health_plan: [],
      recovery_actions: ["retry"],
      projector_version: "vf-public-projector/1",
      rules_digest: testDigest("redaction-rules"),
      redaction_manifest_digest: testDigest("redaction-manifest"),
    },
    created_at: "2026-08-25T00:00:00.000Z",
    expires_at: "2026-08-25T01:00:00.000Z",
    ...overrides,
  };
}
