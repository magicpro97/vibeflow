import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  type ActionProposalRequestV1,
  type ActionRequestAuthorityV1,
  EMPTY_PERMISSION_DIGEST,
  actionIdempotencyScopeDigest,
  deriveOperationId,
  materializeApproval,
  materializeDispatchRecord,
} from "../../src/actions/index.js";
import {
  AttemptStartAuthorityStore,
  createDurableAttemptStartAuthorityReaderV1,
} from "../../src/dispatch/start-authority.js";
import { canonicalJsonBytes, digestV1 } from "../../src/durability/index.js";
import { ConversationArtifactStore } from "../../src/orchestrator/conversation/artifact-store.js";
import { startAndAdmitAttempt } from "../../src/orchestrator/conversation/attempt-start-admission.js";
import { registerCapabilityConversationProposalBase } from "../../src/orchestrator/conversation/capability-proposal-base.js";
import { CatalogCursorCodec } from "../../src/orchestrator/conversation/catalog-cursor.js";
import { conversationLockDigest } from "../../src/orchestrator/conversation/catalog-lock.js";
import { projectConversationCatalog } from "../../src/orchestrator/conversation/catalog-projector.js";
import {
  catalogPageStart,
  catalogQueryInput,
  catalogRowOrder,
  queryCatalogRow,
} from "../../src/orchestrator/conversation/catalog-query.js";
import {
  closePrivateDirectorySnapshot,
  inspectPrivateDirectoryReadOnly,
  openPrivateChildDirectoryReadOnly,
} from "../../src/orchestrator/conversation/catalog-read-safety.js";
import {
  ConversationCatalogNotFoundError,
  ConversationCatalogService,
} from "../../src/orchestrator/conversation/catalog-service.js";
import {
  type ConversationSessionSummaryV1,
  normalizeConversationCatalogQuery,
} from "../../src/orchestrator/conversation/catalog-types.js";
import {
  ConversationActionTargetUnsupportedError,
  ConversationRevisionActionDomainV1,
} from "../../src/orchestrator/conversation/conversation-action-domain.js";
import { materializeContinueMessageProposal } from "../../src/orchestrator/conversation/conversation-action-planner.js";
import {
  ConversationActionReceiptStore,
  type ConversationReceiptNativePlanV1,
} from "../../src/orchestrator/conversation/conversation-action-receipt-store.js";
import { ConversationActionDomainRegistryV1 } from "../../src/orchestrator/conversation/conversation-action-registry.js";
import { ConversationActionService } from "../../src/orchestrator/conversation/conversation-action-service.js";
import { createConversationBrowserAuthorities } from "../../src/orchestrator/conversation/conversation-browser-authorities.js";
import { compactionSourceAuthorityMatches } from "../../src/orchestrator/conversation/conversation-compaction-source-authority.js";
import { resolveCompactionSourceEvents } from "../../src/orchestrator/conversation/conversation-compaction-source.js";
import { materializeRevisionControlEffectClosure } from "../../src/orchestrator/conversation/conversation-control-effect-planner.js";
import {
  rethrowTerminalMessageOverflow,
  rethrowWithOversizedCandidate,
} from "../../src/orchestrator/conversation/conversation-handoff-overflow.js";
import { ConversationHomeAuthorities } from "../../src/orchestrator/conversation/conversation-home-authorities.js";
import {
  ConversationInteractionCorruptError,
  ConversationInteractionStore,
} from "../../src/orchestrator/conversation/conversation-interaction-store.js";
import type {
  ConversationInteractionFoldV1,
  ConversationReactionOperationV1,
  PublicMessageLocatorV1,
} from "../../src/orchestrator/conversation/conversation-interaction-types.js";
import { ConversationLineageMutationReservationStoreV1 } from "../../src/orchestrator/conversation/conversation-lineage-mutation-reservation.js";
import { ConversationLiteralActionAuthority } from "../../src/orchestrator/conversation/conversation-literal-action-authority.js";
import {
  ConversationMessageAuthorityV1,
  type ResolvedPublicMessageV1,
} from "../../src/orchestrator/conversation/conversation-message-authority.js";
import { foldOrdinaryConversationOperation } from "../../src/orchestrator/conversation/conversation-operation-fold.js";
import { assertParticipantReactionTransitions } from "../../src/orchestrator/conversation/conversation-participant-reaction-validation.js";
import {
  conversationReactionChanges,
  publicReactionProjection,
} from "../../src/orchestrator/conversation/conversation-reaction-projection.js";
import {
  expectedReceiptAuthorityFacts,
  materializeReceiptAssociationRecord,
  receiptAssociationPlan,
} from "../../src/orchestrator/conversation/conversation-receipt-authority-facts.js";
import { ConversationReceiptEffectExecutor } from "../../src/orchestrator/conversation/conversation-receipt-effect-executor.js";
import { ConversationReceiptCandidateUnavailableError } from "../../src/orchestrator/conversation/conversation-receipt-errors.js";
import {
  assertReceiptSource,
  materializeAssociationPlan,
  materializeSelectionPlan,
} from "../../src/orchestrator/conversation/conversation-receipt-native-plans.js";
import {
  ConversationMessageReferenceUnavailableError,
  ConversationSocialAuthorityV1,
} from "../../src/orchestrator/conversation/conversation-social-authority.js";
import { publishDebateParticipantResponse } from "../../src/orchestrator/conversation/debate-response-publication.js";
import { conversationManifestPath } from "../../src/orchestrator/conversation/durable-operation-authority.js";
import {
  previewAgentPolicyContext,
  previewPolicyContext,
} from "../../src/orchestrator/conversation/emission-authority.js";
import {
  HandoffTooLargeError,
  buildContextHandoff,
} from "../../src/orchestrator/conversation/handoff-selection.js";
import { LineageHeadTransitionStore } from "../../src/orchestrator/conversation/lineage-head-transition-store.js";
import { deriveConversationLineages } from "../../src/orchestrator/conversation/lineage-reader.js";
import type {
  RevisionOperationV1,
  RevisionPreparationPlanV1,
} from "../../src/orchestrator/conversation/lineage-revision-operation.js";
import type {
  ConversationLineageService,
  ResolvedConversationLineageV1,
} from "../../src/orchestrator/conversation/lineage-service.js";
import { LiteralStagingStoreV1 } from "../../src/orchestrator/conversation/literal-staging-store.js";
import {
  appliesToParticipant,
  debateMessagePrompt,
  directMessagePrompt,
} from "../../src/orchestrator/conversation/message-delivery.js";
import {
  brokeredOperation,
  operationBrokerKey,
  readOperationOwnerState,
  registerBrokeredOperation,
  releaseBrokeredOperation,
} from "../../src/orchestrator/conversation/operation-owner-broker.js";
import {
  inspectRevisionRecovery,
  revisionAbandonIsProved,
  revisionRetryIsProved,
} from "../../src/orchestrator/conversation/revision-control-evidence.js";
import { proposeRevisionControlAction } from "../../src/orchestrator/conversation/revision-control-proposal.js";
import { executeRevisionRetry } from "../../src/orchestrator/conversation/revision-control-retry.js";
import { ConversationDeferredRevisionAuthority } from "../../src/orchestrator/conversation/revision-deferred-authority.js";
import { ConversationHandoffTooLargeError } from "../../src/orchestrator/conversation/revision-errors.js";
import { validateRevisionTransitionAuthority } from "../../src/orchestrator/conversation/revision-fold-validation.js";
import { InitialRevisionLaneAuthority } from "../../src/orchestrator/conversation/revision-initial-lane-authority.js";
import { RevisionLaneEvidenceStore } from "../../src/orchestrator/conversation/revision-lane-evidence-store.js";
import { revisionLaneReceiptIsProved } from "../../src/orchestrator/conversation/revision-lane-proof.js";
import { runOwnedRevisionStart } from "../../src/orchestrator/conversation/revision-owned-start-runtime.js";
import {
  type ParticipantStartReceiptV1,
  advanceParticipantReceipt,
  assertParticipantStartReceiptV1,
  materializeParticipantStartReceipt,
  participantCancelAttemptKey,
  participantStartAttemptKey,
} from "../../src/orchestrator/conversation/revision-participant-receipt.js";
import {
  type RevisionOperationEventV1,
  materializeRevisionEvent,
  materializeRevisionHead,
  materializeRevisionOperation,
  materializeRevisionPreparationPlan,
  materializeRevisionReservation,
} from "../../src/orchestrator/conversation/revision-planner.js";
import { retryPublishedRevisionStart } from "../../src/orchestrator/conversation/revision-start-finalizer.js";
import { ConversationRevisionStore } from "../../src/orchestrator/conversation/revision-store.js";
import { prepareRuntimeConversationTurn } from "../../src/orchestrator/conversation/runtime-turn-delivery.js";
import { readConversationSourceInventory } from "../../src/orchestrator/conversation/source-inventory.js";
import { timelineInteractionProjection } from "../../src/orchestrator/conversation/timeline-interaction-projection.js";
import type { MessageRequest } from "../../src/orchestrator/conversation/types.js";
import { DurableArtifactRegistry } from "../../src/orchestrator/trace/artifacts.js";
import { TraceStore } from "../../src/orchestrator/trace/store.js";
import type {
  StoredTraceEvent,
  TraceAppendInput,
  TraceCorrelation,
} from "../../src/orchestrator/trace/types.js";
import { validInput } from "../../src/orchestrator/trace/validation.js";

const STAGING_ID = `vf-literal-${"1".repeat(64)}`;
const STAGED_AT = "2026-08-25T00:00:00.000Z";

const postfreezeDigest = (label: string) =>
  digestV1("VF-CONVERSATION-POSTFREEZE-TEST\0v1\0", { label });

const actionAuthority = (rootSessionId = "root-session"): ActionRequestAuthorityV1 => ({
  schema_version: "1.0",
  principal_digest: postfreezeDigest("principal"),
  authority_scope_digest: actionIdempotencyScopeDigest({
    kind: "conversation",
    root_session_id: rootSessionId,
  }),
  control_session_digest: postfreezeDigest("control-session"),
  csrf_epoch_digest: postfreezeDigest("csrf"),
  actor: {
    kind: "human-browser",
    public_actor_id: "human-1",
    credential_class: "loopback-session",
  },
});

const resolvedLineage = (): ResolvedConversationLineageV1 => {
  const manifest = {
    version: "1.0" as const,
    conversation_id: "conversation",
    workflow_id: "workflow",
    revision_id: "revision",
    run_id: "run",
    parent_conversation_id: null,
    parent_revision_id: null,
    topic: "literal publication",
    policy: "direct",
    max_rounds: 1,
    baseline_enabled: false,
    evaluator_auto_added: false,
    repo_root: "/repo",
    phase: 3,
    task_text: "publish reviewed literal",
    bindings: [],
    created_at: STAGED_AT,
  };
  const source = {
    manifest,
    manifest_record: {
      manifest,
      binding_authorities: [],
      resume_bindings: [],
      child_revisions: {},
      artifacts: [],
      artifact_reservations: {},
    },
    manifest_digest: postfreezeDigest("manifest"),
    journal_head: {
      schema_version: "1.0" as const,
      record_id: "journal",
      record_digest: postfreezeDigest("journal-head"),
      last_seq: 0,
      updated_at: STAGED_AT,
      lifecycle: "ACTIVE" as const,
      health: "healthy" as const,
      participants: [],
    },
    journal_records: [],
  };
  const node = { conversation_id: "conversation", revision_id: "revision", revision_ordinal: 0 };
  const requested = {
    node,
    parent: null,
    source,
    manifest_digest: source.manifest_digest,
    ancestry_digest: postfreezeDigest("ancestry"),
  };
  const head = {
    schema_version: "1.0" as const,
    root_session_id: "root-session",
    head_status: "committed" as const,
    active: node,
    candidate_heads: [node],
    head_epoch: 0,
    previous_head_digest: null,
    updated_by_operation_id: null,
    updated_at: STAGED_AT,
    content_digest: postfreezeDigest("lineage-head"),
  };
  return {
    inventory: {
      schema_version: "1.0",
      state: "ready",
      authoritative: true,
      sources: [source],
      diagnostics: [],
      observed_source_digest: postfreezeDigest("inventory"),
    },
    derivation: {
      schema_version: "1.0",
      state: "ready",
      authoritative: true,
      lineages: [],
      diagnostics: [],
      observed_source_digest: postfreezeDigest("derivation"),
    },
    lineage: {
      schema_version: "1.0",
      root_session_id: "root-session",
      nodes: [requested],
      diagnostics: [],
      content_digest: postfreezeDigest("lineage"),
    },
    requested,
    head,
    revision_claim_epoch: 0,
    selected_nodes: [requested],
  } as unknown as ResolvedConversationLineageV1;
};

const receiptNativePlan = (
  actionType: ConversationReceiptNativePlanV1["action_type"],
  action: any,
  effectBinding: any,
): ConversationReceiptNativePlanV1 => ({
  schema_version: "1.0",
  action_type: actionType,
  root_session_id: "root-session",
  expected: {
    conversation_id: "conversation",
    revision_id: "revision",
    last_seq: 0,
    conversation_lock_digest: postfreezeDigest("lock"),
    lineage_head_digest: postfreezeDigest("lineage-head"),
    lineage_head_epoch: 0,
  },
  action,
  effect_binding: effectBinding,
  created_at: STAGED_AT,
  expires_at: "2026-08-25T01:00:00.000Z",
  plan_digest: postfreezeDigest(`native-plan-${actionType}`),
});

const receiptClosure = () => ({
  proposal: {
    proposal_id: `vf-proposal-${"1".repeat(64)}`,
    requested_by: actionAuthority().actor,
  } as any,
  approval: {
    approval_id: `vf-approval-${"2".repeat(64)}`,
    decided_by: actionAuthority().actor,
    decided_at: "2026-08-25T00:01:00.000Z",
  } as any,
  dispatch: {
    operation_id: `vf-operation-${"3".repeat(64)}`,
    created_at: "2026-08-25T00:01:00.000Z",
  } as any,
});

const catalogRow = (
  rootSessionId: string,
  updatedAt = STAGED_AT,
  ordinal = 0,
): ConversationSessionSummaryV1 => {
  const root = {
    schema_version: "1.0" as const,
    conversation_id: rootSessionId,
    revision_id: `revision-${rootSessionId}`,
    revision_ordinal: 0,
    parent_conversation_id: null,
    parent_revision_id: null,
    lineage_status: "verified" as const,
    topic: `Topic ${rootSessionId}`,
    policy: "direct",
    lifecycle: "ACTIVE" as const,
    health: "healthy" as const,
    participants: [
      { participant_id: "agent", role_ref: "Reviewer", engine: "codex" as const, model: null },
    ],
    created_at: STAGED_AT,
    updated_at: updatedAt,
    last_seq: 1,
    lock_digest: postfreezeDigest(`catalog-lock-${rootSessionId}`),
  };
  const active =
    ordinal === 0
      ? structuredClone(root)
      : {
          ...structuredClone(root),
          conversation_id: `${rootSessionId}-child`,
          revision_id: `revision-${rootSessionId}-child`,
          revision_ordinal: ordinal,
          parent_conversation_id: rootSessionId,
          parent_revision_id: root.revision_id,
          topic: `Child Search ${rootSessionId}`,
        };
  return {
    schema_version: "1.0",
    root_session_id: rootSessionId,
    head_status: "committed",
    root,
    active_conversation_id: active.conversation_id,
    active_revision_id: active.revision_id,
    active_revision_ordinal: active.revision_ordinal,
    revision_count: ordinal + 1,
    active,
    matched_revision: null,
    association_ids: [],
    sort_updated_at: updatedAt,
    lineage_cursor: `cursor-${rootSessionId}`,
  };
};

const oversizedHandoff = (): HandoffTooLargeError => {
  try {
    buildContextHandoff({
      source: {
        conversation_id: "conversation",
        revision_id: "revision",
        last_seq: 1,
        lock_digest: postfreezeDigest("oversized-lock"),
      },
      topic: "oversized",
      policy_value: "direct",
      bindings: [],
      user_messages: [
        {
          event_id: "oversized-event",
          conversation_id: "conversation",
          revision_id: "revision",
          revision_ordinal: 0,
          public_seq: 1,
          author_public_id: "human",
          text: "x".repeat(8_192),
          created_at: STAGED_AT,
          redaction_manifest_digest: postfreezeDigest("oversized-redaction"),
        },
      ],
      final_responses: [],
      artifacts: [],
      consensus: { score: null, synthesis: null },
      prompt_budget_bytes: 2_048,
    });
  } catch (error) {
    if (error instanceof HandoffTooLargeError) return error;
    throw error;
  }
  throw new Error("oversized handoff fixture did not overflow");
};

const revisionOperation = (): RevisionOperationV1 =>
  materializeRevisionOperation({
    operation_id: `vf-operation-${"5".repeat(64)}`,
    proposal_id: `vf-proposal-${"6".repeat(64)}`,
    proposal_digest: postfreezeDigest("revision-proposal"),
    approval_id: `vf-approval-${"7".repeat(64)}`,
    approval_digest: postfreezeDigest("revision-approval"),
    plan_digest: postfreezeDigest("revision-plan"),
    authority_epoch: 0,
    authority_head_digest: postfreezeDigest("revision-authority"),
    root_session_id: "root-session",
    parent: { conversation_id: "conversation", revision_id: "revision", revision_ordinal: 0 },
    child: {
      conversation_id: "conversation-child",
      revision_id: "revision-child",
      revision_ordinal: 1,
    },
    expected_head_digest: postfreezeDigest("revision-prior-head"),
    expected_reservation_digest: null,
    expected_reservation_epoch: 0,
    revision_claim_epoch: 1,
    expected_parent_last_seq: 0,
    expected_parent_lock_digest: postfreezeDigest("revision-parent-lock"),
    permission_digest: postfreezeDigest("revision-permission"),
    binding_set_digest: postfreezeDigest("revision-bindings"),
    handoff_digest: postfreezeDigest("revision-handoff"),
    handoff_selection_digest: postfreezeDigest("revision-selection"),
    prompt_projection_digest: postfreezeDigest("revision-prompt"),
    created_at: STAGED_AT,
  });

const revisionPlan = (): RevisionPreparationPlanV1 =>
  materializeRevisionPreparationPlan({
    root_session_id: "root-session",
    parent: { conversation_id: "conversation", revision_id: "revision", revision_ordinal: 0 },
    expected_head_digest: postfreezeDigest("revision-prior-head"),
    expected_head_epoch: 0,
    expected_reservation_digest: null,
    expected_reservation_epoch: 0,
    expected_parent_last_seq: 0,
    expected_parent_lock_digest: postfreezeDigest("revision-parent-lock"),
    permission_digest: postfreezeDigest("revision-permission"),
    revision_claim_epoch: 1,
    binding_delta_digest: postfreezeDigest("revision-delta"),
    resulting_binding_set_digest: postfreezeDigest("revision-bindings"),
    handoff_selection_plan_digest: postfreezeDigest("revision-selection"),
    participant_starts: [
      {
        participant_id: "participant-1",
        engine: "codex",
        model: "gpt-5.4",
        adapter_fingerprint: "adapter-1",
        reconciliation_mode: "provider-idempotency",
        cancellation_mode: "idempotent-cancel",
        wrapper_descriptor_digest: postfreezeDigest("revision-wrapper"),
        max_shared_prompt_bytes: 1024,
      },
    ],
    created_at: STAGED_AT,
    expires_at: "2026-08-25T01:00:00.000Z",
  });

const participantReceipt = (
  operation: RevisionOperationV1,
  state: ParticipantStartReceiptV1["state"],
  generation = 0,
  options: { native?: boolean; canceled?: boolean } = {},
): ParticipantStartReceiptV1 => {
  const identity = {
    operation_id: operation.operation_id,
    participant_id: "participant-1",
    start_generation: generation,
  };
  const base = {
    ...identity,
    attempt_key: participantStartAttemptKey(identity),
    state,
    engine: "codex" as const,
    model: "gpt-5.4",
    adapter_fingerprint: "adapter-1",
    reconciliation_mode: "provider-idempotency" as const,
    cancel_attempt_key: null as string | null,
    cancellation_mode: null as "idempotent-cancel" | null,
    shared_prompt_digest: operation.prompt_projection_digest,
    wrapper_digest: postfreezeDigest("revision-wrapper"),
    private_native_session_ref: options.native ? postfreezeDigest("native-session-ref") : null,
    private_native_session_producer_receipt_digest: options.native
      ? postfreezeDigest("native-session-receipt")
      : null,
    private_process_lease_ref: null,
    private_process_lease_producer_receipt_digest: null,
    prepared_at: STAGED_AT,
    observed_at: ["observed", "accepted", "cancel_in_progress", "canceled", "uncertain"].includes(
      state,
    )
      ? STAGED_AT
      : null,
  };
  if (options.canceled) {
    base.cancel_attempt_key = participantCancelAttemptKey(base);
    base.cancellation_mode = "idempotent-cancel";
  }
  return materializeParticipantStartReceipt(base);
};

const appendRevisionEvent = (
  operation: RevisionOperationV1,
  events: RevisionOperationEventV1[],
  payload: RevisionOperationEventV1["payload"],
) => {
  const event = materializeRevisionEvent(operation, events, payload, STAGED_AT);
  events.push(event);
  return event;
};

describe("post-freeze catalog query behavior", () => {
  test("orders rows, filters normalized fields, and returns the matching revision", () => {
    const older = catalogRow("alpha", "2026-08-25T00:00:00.000Z", 1);
    const newer = catalogRow("bravo", "2026-08-25T00:01:00.000Z");
    expect([older, newer].sort(catalogRowOrder).map((row) => row.root_session_id)).toEqual([
      "bravo",
      "alpha",
    ]);
    expect(catalogRowOrder(catalogRow("charlie"), catalogRow("bravo"))).toBeLessThan(0);

    const childMatch = queryCatalogRow(
      older,
      normalizeConversationCatalogQuery({ query: "child search", lifecycle: ["ACTIVE"] }),
    );
    expect(childMatch?.matched_revision).toEqual({
      conversation_id: "alpha-child",
      revision_id: "revision-alpha-child",
      revision_ordinal: 1,
    });
    expect(
      queryCatalogRow(older, normalizeConversationCatalogQuery({ query: "reviewer" })),
    ).toMatchObject({ root_session_id: "alpha" });
    expect(
      queryCatalogRow(older, normalizeConversationCatalogQuery({ lifecycle: ["STOPPED"] })),
    ).toBeNull();
    expect(
      queryCatalogRow(older, normalizeConversationCatalogQuery({ policy: ["debate"] })),
    ).toBeNull();
    expect(
      queryCatalogRow(older, normalizeConversationCatalogQuery({ query: "absent" })),
    ).toBeNull();
    expect(queryCatalogRow(older, normalizeConversationCatalogQuery())).toMatchObject({
      matched_revision: null,
    });
  });

  test("advances only from an exact cursor boundary and preserves optional query input", () => {
    const rows = [catalogRow("alpha"), catalogRow("bravo")];
    expect(catalogPageStart(rows, null)).toBe(0);
    expect(
      catalogPageStart(rows, {
        sort_updated_at: rows[0]?.sort_updated_at ?? "",
        root_session_id: "alpha",
      }),
    ).toBe(1);
    expect(() =>
      catalogPageStart(rows, { sort_updated_at: STAGED_AT, root_session_id: "missing" }),
    ).toThrow("catalog cursor boundary is absent");
    expect(catalogQueryInput({})).toEqual({});
    expect(catalogQueryInput({ query: "text", lifecycle: ["ACTIVE"], policy: ["direct"] })).toEqual(
      { query: "text", lifecycle: ["ACTIVE"], policy: ["direct"] },
    );
  });
});

describe("post-freeze conversation action domain registry", () => {
  const candidateRequest = (candidate: any): ActionProposalRequestV1 => ({
    schema_version: "1.0",
    idempotency_key: "registry-request",
    anchor_event_id: null,
    expected: {
      mode: "writable-revision",
      conversation_id: "conversation",
      revision_id: "revision",
      last_seq: 0,
      conversation_lock_digest: postfreezeDigest("registry-lock"),
    },
    candidate,
  });

  const actionRow = (id: string, createdAt: string) => ({
    proposal: { proposal_id: id, created_at: createdAt },
    operation: { operation_id: `operation-${id}` },
  });

  const handler = (domain: "conversation" | "capability", options: any = {}) => ({
    domain,
    supports: options.supports ?? (() => true),
    propose: options.propose ?? (async () => ({ owner: domain })),
    get: options.get ?? (async () => null),
    pending: options.pending ?? (async () => []),
    anchored: options.anchored ?? (async () => []),
    events: options.events ?? (async () => [{ kind: `events-${domain}` }]),
    subscribe: options.subscribe,
    challenge: options.challenge ?? (async () => ({ kind: `challenge-${domain}` })),
    approve: options.approve ?? (async () => ({ kind: `approve-${domain}` })),
    commit: options.commit ?? (async () => ({ kind: `commit-${domain}` })),
    cancel: options.cancel ?? (async () => ({ kind: `cancel-${domain}` })),
  });

  test("routes proposal candidates to exactly one matching domain", async () => {
    const conversation = handler("conversation");
    const capability = handler("capability");
    const registry = new ConversationActionDomainRegistryV1([conversation, capability] as any);
    expect(
      (await registry.propose({
        conversation_id: "conversation",
        request: candidateRequest({ type: "conversation.stop_operation", operation_id: "op" }),
        authority: actionAuthority(),
      })) as unknown,
    ).toEqual({ owner: "conversation" });
    expect(
      (await registry.propose({
        conversation_id: "conversation",
        request: candidateRequest({
          type: "capability.remove",
          package_id: "package",
          scope: "project",
          cascade: false,
        }),
        authority: actionAuthority(),
      })) as unknown,
    ).toEqual({ owner: "capability" });
    expect(() =>
      new ConversationActionDomainRegistryV1([]).propose({
        conversation_id: "conversation",
        request: candidateRequest({ type: "conversation.stop_operation", operation_id: "op" }),
        authority: actionAuthority(),
      }),
    ).toThrow(ConversationActionTargetUnsupportedError);
    expect(() =>
      new ConversationActionDomainRegistryV1([
        handler("conversation"),
        handler("conversation"),
      ] as any).propose({
        conversation_id: "conversation",
        request: candidateRequest({ type: "conversation.stop_operation", operation_id: "op" }),
        authority: actionAuthority(),
      }),
    ).toThrow("overlapping conversation action domain handlers");
  });

  test("sorts list results and rejects cross-domain duplicate proposals", async () => {
    const old = actionRow("proposal-old", "2026-08-25T00:00:00.000Z");
    const recentA = actionRow("proposal-a", "2026-08-25T00:01:00.000Z");
    const recentB = actionRow("proposal-b", "2026-08-25T00:01:00.000Z");
    const registry = new ConversationActionDomainRegistryV1([
      handler("conversation", {
        pending: async () => [old, recentA],
        anchored: async () => [old],
      }),
      handler("capability", {
        pending: async () => [recentB],
        anchored: async () => [recentB],
      }),
    ] as any);
    expect((await registry.pending("conversation")).map((row) => row.proposal.proposal_id)).toEqual(
      ["proposal-b", "proposal-a", "proposal-old"],
    );
    expect(
      (
        await registry.anchored({
          conversation_id: "conversation",
          revision_id: "revision",
          origin_event_id: null,
        })
      ).map((row) => row.proposal.proposal_id),
    ).toEqual(["proposal-b", "proposal-old"]);
    const duplicate = actionRow("proposal-duplicate", STAGED_AT);
    await expect(
      new ConversationActionDomainRegistryV1([
        handler("conversation", { pending: async () => [duplicate] }),
        handler("capability", { pending: async () => [duplicate] }),
      ] as any).pending("conversation"),
    ).rejects.toThrow("duplicate cross-domain action proposal");
  });

  test("finds one durable owner for reads and every mutation", async () => {
    const owned = actionRow("proposal-owned", STAGED_AT);
    let subscribed = false;
    const owner = handler("conversation", {
      get: async (_conversationId: string, proposalId: string) =>
        proposalId === "proposal-owned" ? owned : null,
      subscribe: (_conversationId: string, _proposalId: string, listener: () => void) => {
        subscribed = true;
        listener();
        return () => {
          subscribed = false;
        };
      },
    });
    const registry = new ConversationActionDomainRegistryV1([owner, handler("capability")] as any);
    expect((await registry.get("conversation", "proposal-owned")) as unknown).toEqual(owned);
    expect(await registry.get("conversation", "absent")).toBeNull();
    expect((await registry.events("conversation", "proposal-owned")) as unknown).toEqual([
      { kind: "events-conversation" },
    ]);
    const unsubscribe = await registry.subscribe("conversation", "proposal-owned", () => {});
    expect(subscribed).toBeTrue();
    expect(unsubscribe).toBeFunction();
    unsubscribe?.();
    expect(subscribed).toBeFalse();
    const context = {
      conversation_id: "conversation",
      proposal_id: "proposal-owned",
      request: {},
      authority: actionAuthority(),
    } as any;
    expect((await registry.challenge(context)) as unknown).toEqual({
      kind: "challenge-conversation",
    });
    expect((await registry.approve(context)) as unknown).toEqual({ kind: "approve-conversation" });
    expect((await registry.commit(context)) as unknown).toEqual({ kind: "commit-conversation" });
    expect((await registry.cancel(context)) as unknown).toEqual({ kind: "cancel-conversation" });

    await expect(registry.events("conversation", "absent")).rejects.toThrow(
      ConversationActionTargetUnsupportedError,
    );
    await expect(
      new ConversationActionDomainRegistryV1([
        owner,
        handler("capability", { get: async () => owned }),
      ] as any).events("conversation", "proposal-owned"),
    ).rejects.toThrow("duplicate conversation action proposal owner");
    const noSubscription = new ConversationActionDomainRegistryV1([
      handler("conversation", { get: async () => owned, subscribe: undefined }),
    ] as any);
    expect(await noSubscription.subscribe("conversation", "proposal-owned", () => {})).toBeNull();
  });
});

describe("post-freeze revision action domain", () => {
  const proposalDigest = postfreezeDigest("domain-proposal");
  const approvalId = `vf-approval-${"4".repeat(64)}`;
  const context = (candidate: any) =>
    ({
      conversation_id: "conversation",
      request: {
        schema_version: "1.0",
        idempotency_key: "domain-request",
        anchor_event_id: null,
        expected: {
          mode: "writable-revision",
          conversation_id: "conversation",
          revision_id: "revision",
          last_seq: 0,
          conversation_lock_digest: postfreezeDigest("domain-lock"),
        },
        candidate,
      },
      authority: actionAuthority(),
    }) as any;

  const mutationContext = () =>
    ({
      conversation_id: "conversation",
      proposal_id: "proposal",
      request: {
        proposal_digest: proposalDigest,
        approval_id: approvalId,
        challenge_class: "normal-confirm",
        decision: "approved",
        challenge_id: null,
        challenge_response: null,
        reason: "cancelled by user",
      },
      authority: actionAuthority(),
    }) as any;

  test("proposes revision and receipt actions only when their durable view is owned", async () => {
    let view: any = {
      proposal: { proposal_id: "proposal", proposal_digest: proposalDigest },
      approval: null,
      operation: { state: "pending_review" },
    };
    let snapshot: any = {
      proposal: {
        domain: "conversation",
        base: { conversation_id: "conversation" },
        action: { type: "conversation.update_settings", changes: { max_rounds: 2 } },
      },
    };
    const actions = {
      view: () => view,
      get: () => snapshot,
      pending: async () => [view],
      anchored: async () => [view],
      events: async () => [{ type: "event" }],
      subscribe: (_proposalId: string, listener: () => void) => {
        listener();
        return () => {};
      },
    } as any;
    const service = {
      proposeConversationAction: async () => ({ created: true, proposalId: "proposal" }),
      commitConversationAction: async () => {},
    } as any;
    const receipts = {
      supports: (candidate: any) => candidate.type === "conversation.stop_operation",
      propose: async () => ({ created: false, proposal_id: "proposal" }),
      commit: async () => {},
    } as any;
    const domain = new ConversationRevisionActionDomainV1(service, actions, receipts);
    expect(
      domain.supports({ type: "conversation.update_settings", changes: { max_rounds: 2 } }),
    ).toBeTrue();
    expect(domain.supports({ type: "conversation.stop_operation", operation_id: "op" })).toBeTrue();
    expect(
      domain.supports({
        type: "capability.remove",
        package_id: "p",
        scope: "project",
        cascade: false,
      }),
    ).toBeFalse();
    expect(
      await domain.propose(
        context({
          type: "conversation.update_settings",
          changes: { max_rounds: 2 },
        }),
      ),
    ).toEqual({ created: true, response: view });
    expect(
      await domain.propose(context({ type: "conversation.stop_operation", operation_id: "op" })),
    ).toEqual({ created: false, response: view });

    expect(await domain.get("conversation", "proposal")).toBe(view);
    expect(await domain.pending("conversation")).toEqual([view]);
    expect(
      await domain.anchored({
        conversation_id: "conversation",
        revision_id: "revision",
        origin_event_id: null,
      }),
    ).toEqual([view]);
    expect((await domain.events("conversation", "proposal")) as unknown).toEqual([
      { type: "event" },
    ]);
    expect(domain.subscribe("conversation", "proposal", () => {})).toBeFunction();

    snapshot = { ...snapshot, proposal: { ...snapshot.proposal, domain: "capability" } };
    expect(await domain.get("conversation", "proposal")).toBeNull();
    expect(await domain.events("conversation", "proposal")).toBeNull();
    expect(domain.subscribe("conversation", "proposal", () => {})).toBeNull();
    await expect(
      domain.propose(
        context({
          type: "conversation.update_settings",
          changes: { max_rounds: 3 },
        }),
      ),
    ).rejects.toThrow("published conversation action proposal is absent");
    snapshot = null;
    view = null;
    await expect(
      new ConversationRevisionActionDomainV1(service, actions).propose(
        context({ type: "conversation.stop_operation", operation_id: "op" }),
      ),
    ).rejects.toThrow(ConversationActionTargetUnsupportedError);
  });

  test("delegates review mutations and fails closed on absent or stale ownership", async () => {
    let approval: any = { approval_id: approvalId };
    let snapshot: any = {
      proposal: {
        domain: "conversation",
        base: { conversation_id: "conversation" },
        action: { type: "conversation.update_settings", changes: { max_rounds: 2 } },
      },
    };
    const view: any = {
      proposal: { proposal_id: "proposal", proposal_digest: proposalDigest },
      approval,
      operation: { state: "approved" },
    };
    const calls: string[] = [];
    const actions = {
      view: () => view,
      get: () => snapshot,
      challenge: async (input: any) => {
        calls.push(`challenge:${input.proposal_id}`);
        return { challenge_id: "challenge" };
      },
      decide: () => ({ view: { ...view, approval }, approval }),
      cancel: () => ({ ...view, operation: { state: "canceled" } }),
    } as any;
    const domain = new ConversationRevisionActionDomainV1({} as any, actions);
    const input = mutationContext();
    expect((await domain.challenge(input)) as unknown).toEqual({ challenge_id: "challenge" });
    expect(calls).toEqual(["challenge:proposal"]);
    expect(await domain.approve(input)).toEqual({
      schema_version: "1.0",
      approval,
      operation: view.operation,
    });
    expect((await domain.cancel(input)) as unknown).toEqual({
      schema_version: "1.0",
      operation: { state: "canceled" },
    });

    approval = null;
    await expect(domain.approve(input)).rejects.toThrow("action approval projection is absent");
    snapshot = {
      ...snapshot,
      proposal: { ...snapshot.proposal, base: { conversation_id: "other" } },
    };
    await expect(domain.challenge(input)).rejects.toThrow(ConversationActionTargetUnsupportedError);
    await expect(domain.approve(input)).rejects.toThrow(ConversationActionTargetUnsupportedError);
    await expect(domain.cancel(input)).rejects.toThrow(ConversationActionTargetUnsupportedError);
  });

  test("commits only the bound approval and supports terminal idempotency and recovery replay", async () => {
    let action: any = { type: "conversation.update_settings", changes: { max_rounds: 2 } };
    let operation: any = { state: "approved" };
    let snapshotMode: "present" | "vanish" = "present";
    let vanishReads = 0;
    const view = () => ({
      proposal: { proposal_id: "proposal", proposal_digest: proposalDigest },
      approval: { approval_id: approvalId },
      operation,
    });
    const actions = {
      view,
      authority: { assertMutationController: () => undefined },
      get: () => {
        const snapshot = {
          proposal: {
            domain: "conversation",
            base: { conversation_id: "conversation" },
            action,
          },
        };
        if (snapshotMode === "present") return snapshot;
        vanishReads += 1;
        return vanishReads === 1 ? snapshot : null;
      },
    } as any;
    let revisionCommits = 0;
    let receiptCommits = 0;
    const service = {
      commitConversationAction: async () => {
        revisionCommits += 1;
        operation = { state: "succeeded", operation_id: "revision-operation" };
      },
    } as any;
    const receipts = {
      supports: (candidate: any) => candidate.type === "conversation.stop_operation",
      commit: async () => {
        receiptCommits += 1;
        operation = { state: "succeeded", operation_id: "receipt-operation" };
      },
    } as any;
    const domain = new ConversationRevisionActionDomainV1(service, actions, receipts);
    const input = mutationContext();
    expect((await domain.commit(input)) as unknown).toEqual({
      schema_version: "1.0",
      operation: { state: "succeeded", operation_id: "revision-operation" },
    });
    expect(revisionCommits).toBe(1);
    expect((await domain.commit(input)) as unknown).toEqual({
      schema_version: "1.0",
      operation,
    });
    expect(revisionCommits).toBe(1);

    operation = { state: "needs_recovery" };
    await domain.commit(input);
    expect(revisionCommits).toBe(2);
    action = { type: "conversation.stop_operation", operation_id: "op" };
    operation = { state: "approved" };
    await domain.commit(input);
    expect(receiptCommits).toBe(1);

    action = { type: "capability.remove", package_id: "p", scope: "project", cascade: false };
    operation = { state: "approved" };
    await expect(domain.commit(input)).rejects.toThrow(ConversationActionTargetUnsupportedError);
    const stale = mutationContext();
    stale.request.proposal_digest = postfreezeDigest("stale");
    await expect(domain.commit(stale)).rejects.toThrow("Proposal or approval authority changed");
    snapshotMode = "vanish";
    vanishReads = 0;
    await expect(domain.commit(input)).rejects.toThrow(
      "approved conversation action authority is absent",
    );
  });
});

describe("post-freeze oversized handoff publication", () => {
  test("normalizes a raw public artifact reference into resolver delivery", () => {
    const artifact = {
      artifact_id: "public-plan",
      artifact_kind: "conversation-artifact" as const,
      media_type: "text/plain",
      byte_length: 12,
      content_sha256: "a".repeat(64),
      resolver: "conversation-artifact-v1" as const,
    };
    const built = buildContextHandoff({
      source: {
        conversation_id: "conversation",
        revision_id: "revision",
        last_seq: 0,
        lock_digest: postfreezeDigest("raw-artifact-handoff-lock"),
      },
      topic: "Deliver a public artifact",
      policy_value: "direct",
      bindings: [],
      user_messages: [],
      final_responses: [],
      artifacts: [artifact],
      consensus: { score: null, synthesis: null },
      prompt_budget_bytes: 64 * 1024,
    });

    expect(built.handoff.artifacts).toEqual([artifact]);
    expect(built.handoff.prompt_projection.artifacts).toEqual([
      { artifact, delivery: "conversation-artifact-resolver", public_text: null },
    ]);
  });

  test("rejects an omitted public message whose author authority is not text", () => {
    const invalidEvent = {
      event_id: "omitted-event",
      conversation_id: "conversation",
      revision_id: "revision",
      revision_ordinal: 0,
      public_seq: 1,
      text: "Omitted message",
      created_at: STAGED_AT,
      redaction_manifest_digest: postfreezeDigest("omitted-message-redaction"),
      author_public_id: 42,
    };
    const bytes = canonicalJsonBytes({ schema_version: "1.0", events: [invalidEvent] });
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const artifact = {
      artifact_id: "omitted-messages",
      artifact_kind: "omitted-public-events" as const,
      media_type: "application/json",
      byte_length: bytes.length,
      content_sha256: contentHash,
      resolver: "conversation-artifact-v1" as const,
    };
    const range = {
      revision_id: "revision",
      revision_ordinal: 0,
      first_public_seq: 1,
      last_public_seq: 1,
      first_event_id: "omitted-event",
      last_event_id: "omitted-event",
      event_count: 1,
      canonical_events_sha256: contentHash,
      artifact,
    };

    expect(() =>
      resolveCompactionSourceEvents({
        artifacts: { readArtifact: () => bytes } as unknown as ConversationArtifactStore,
        resolved: {
          selected_nodes: [{ node: { conversation_id: "conversation" } }],
        } as unknown as ResolvedConversationLineageV1,
        rejected: {
          prompt_projection: { transcript: { omitted_public_ranges: [range] } },
        } as any,
      }),
    ).toThrow("invalid omitted public user message");
  });

  test("rejects an unplanned artifact inside the compaction idempotency namespace", () => {
    const proposalId = `vf-proposal-${"c".repeat(64)}`;
    const suffix = proposalId.slice(-32);
    expect(() =>
      compactionSourceAuthorityMatches({
        proposalId,
        candidate: { source: {} } as any,
        construction: {
          omitted: [],
          artifact_id: "planned-compaction",
          artifact_bytes: Buffer.from("planned compaction"),
        } as any,
        resolved: {
          requested: {
            source: {
              manifest_record: {
                artifacts: [
                  {
                    idempotency_key: `compaction-omitted-${suffix}-99`,
                  },
                ],
              },
            },
          },
        } as any,
      }),
    ).toThrow("context compaction artifact closure changed");
  });

  test("issues a bound public compaction candidate for an exact overflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-overflow-postfreeze-"));
    try {
      const home = new ConversationHomeAuthorities({ artifactRoot: root, now: () => STAGED_AT });
      const authority = actionAuthority();
      const request: ActionProposalRequestV1 = {
        schema_version: "1.0",
        idempotency_key: "overflow-request",
        anchor_event_id: null,
        expected: {
          mode: "writable-revision",
          conversation_id: "conversation",
          revision_id: "revision",
          last_seq: 1,
          conversation_lock_digest: postfreezeDigest("oversized-lock"),
        },
        candidate: {
          type: "conversation.continue_message",
          content: "continue",
          target_participants: "all",
        },
      };
      let thrown: unknown;
      try {
        rethrowWithOversizedCandidate({
          error: oversizedHandoff(),
          home,
          request,
          authority,
          created_at: STAGED_AT,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ConversationHandoffTooLargeError);
      if (!(thrown instanceof ConversationHandoffTooLargeError))
        throw new Error("oversized candidate error disappeared");
      expect(thrown.candidate).toMatchObject({
        schema_version: "1.0",
        source: {
          conversation_id: "conversation",
          revision_id: "revision",
          last_seq: 1,
        },
        prompt_budget_bytes: 2_048,
      });
      expect(thrown.public_error).toMatchObject({
        schema_version: "1.0",
        error: {
          code: "handoff_too_large",
          correlation_id: thrown.candidate.candidate_id,
          retryable: false,
          recovery_action: "edit",
        },
      });

      const ordinary = new Error("ordinary failure");
      expect(() =>
        rethrowWithOversizedCandidate({
          error: ordinary,
          home,
          request,
          authority,
          created_at: STAGED_AT,
        }),
      ).toThrow(ordinary);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("binds terminal message overflow to the resolved parent revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-terminal-overflow-"));
    try {
      const home = new ConversationHomeAuthorities({ artifactRoot: root, now: () => STAGED_AT });
      const resolved = resolvedLineage();
      let thrown: unknown;
      try {
        rethrowTerminalMessageOverflow({
          error: oversizedHandoff(),
          home,
          base: {
            lineage: resolved.lineage,
            parent: resolved.requested,
            head: resolved.head,
            lock: {
              lock_digest: postfreezeDigest("terminal-lock"),
              semantic_journal_head: {
                digest: postfreezeDigest("semantic-head"),
                last_sequence: 0,
              },
            },
          } as any,
          request: {
            content: "continue with quote",
            target_participants: ["agent-1"],
            quote_refs: [
              {
                ...messageLocator("quoted"),
                author_public_id: "human",
              },
            ],
          },
          action_key: "terminal-overflow-request",
          authority: actionAuthority(),
          created_at: STAGED_AT,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ConversationHandoffTooLargeError);
      if (!(thrown instanceof ConversationHandoffTooLargeError))
        throw new Error("terminal oversized candidate error disappeared");
      expect(thrown.candidate.candidate_id).toMatch(/^vf-oversized-handoff-[0-9a-f]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("post-freeze participant start receipt authority", () => {
  test("validates same-generation edges, cancellation, and retry generations", () => {
    const operation = revisionOperation();
    const prepared = participantReceipt(operation, "prepared");
    const inProgress = participantReceipt(operation, "effect_in_progress");
    const observed = participantReceipt(operation, "observed", 0, { native: true });
    const accepted = participantReceipt(operation, "accepted", 0, { native: true });
    const canceling = participantReceipt(operation, "cancel_in_progress", 0, {
      native: true,
      canceled: true,
    });
    const canceled = participantReceipt(operation, "canceled", 0, {
      native: true,
      canceled: true,
    });
    expect(() => assertParticipantStartReceiptV1(prepared)).not.toThrow();
    expect(() => advanceParticipantReceipt(undefined, prepared)).not.toThrow();
    expect(() => advanceParticipantReceipt(prepared, inProgress)).not.toThrow();
    expect(() => advanceParticipantReceipt(inProgress, observed)).not.toThrow();
    expect(() => advanceParticipantReceipt(observed, accepted)).not.toThrow();
    expect(() => advanceParticipantReceipt(accepted, canceling)).not.toThrow();
    expect(() => advanceParticipantReceipt(canceling, canceled)).not.toThrow();
    const retry = participantReceipt(operation, "prepared", 1);
    expect(() => advanceParticipantReceipt(canceled, retry)).not.toThrow();
    expect(canceling.cancel_attempt_key).toBe(participantCancelAttemptKey(canceling));
  });

  test("rejects malformed beginnings, immutable changes, and illegal generation jumps", () => {
    const operation = revisionOperation();
    const prepared = participantReceipt(operation, "prepared");
    const failed = participantReceipt(operation, "failed");
    expect(() => advanceParticipantReceipt(undefined, failed)).toThrow(
      "participant start receipt does not begin at prepared generation zero",
    );
    expect(() =>
      advanceParticipantReceipt(prepared, {
        ...participantReceipt(operation, "effect_in_progress"),
        model: "changed-model",
      }),
    ).toThrow("invalid participant start receipt digest");
    expect(() => advanceParticipantReceipt(prepared, prepared)).toThrow(
      "illegal participant start receipt transition",
    );
    expect(() =>
      advanceParticipantReceipt(failed, participantReceipt(operation, "prepared", 2)),
    ).toThrow("illegal participant start receipt generation");
    expect(() => assertParticipantStartReceiptV1({})).toThrow("invalid participant start receipt");
    expect(() => assertParticipantStartReceiptV1({ ...prepared, attempt_key: "changed" })).toThrow(
      "invalid participant start receipt identity",
    );
  });
});

describe("post-freeze revision recovery evidence", () => {
  const transition = (
    operation: RevisionOperationV1,
    events: RevisionOperationEventV1[],
    from: any,
    to: any,
    reasonCode: string | null = null,
  ) =>
    appendRevisionEvent(operation, events, {
      kind: "state-transition",
      from,
      to,
      authorized_by_action_operation_id: operation.operation_id,
      effect_action_operation_id: operation.operation_id,
      action_terminals:
        to === "needs_recovery"
          ? [
              {
                action_operation_id: operation.operation_id,
                outcome: "needs_recovery",
                reason_code: reasonCode ?? "uncertain_start",
              },
            ]
          : to === "start_failed"
            ? [
                {
                  action_operation_id: operation.operation_id,
                  outcome: "failed",
                  reason_code: reasonCode ?? "child_start_failed",
                },
              ]
            : [],
      reason_code: reasonCode,
    });

  const priorAuthorities = (prepared = false) => {
    const operation = revisionOperation();
    const resolved = resolvedLineage();
    resolved.head = {
      ...resolved.head,
      root_session_id: operation.root_session_id,
      content_digest: operation.expected_head_digest,
    };
    const home = {
      revisions: {
        readPlan: () => revisionPlan(),
        readPreparedTransition: () => (prepared ? { prepared: true } : null),
      },
      revisionLanes: { receiptIsProved: () => true },
      publishedRevisionTransitions: () => [],
    } as unknown as ConversationHomeAuthorities;
    const lineages = {
      resolve: () => resolved,
      resolveRevisionRecovery: () => resolved,
    } as unknown as ConversationLineageService;
    return { operation, home, lineages };
  };

  const childAuthorities = () => {
    const fixture = priorAuthorities();
    const childDigest = postfreezeDigest("revision-child-head");
    fixture.lineages = {
      resolve: () => ({
        ...resolvedLineage(),
        head: {
          ...resolvedLineage().head,
          root_session_id: fixture.operation.root_session_id,
          content_digest: childDigest,
          previous_head_digest: fixture.operation.expected_head_digest,
          updated_by_operation_id: fixture.operation.operation_id,
          active: fixture.operation.child,
        },
      }),
    } as unknown as ConversationLineageService;
    fixture.home = {
      ...fixture.home,
      revisions: {
        readPlan: () => revisionPlan(),
        readPreparedTransition: () => null,
      },
      revisionLanes: { receiptIsProved: () => true },
      publishedRevisionTransitions: () => [
        {
          authority: { operation: { operation_id: fixture.operation.operation_id } },
          committed_head: { content_digest: childDigest },
        },
      ],
    } as unknown as ConversationHomeAuthorities;
    return { ...fixture, childDigest };
  };

  const recoveryFromPreparing = (operation: RevisionOperationV1) => {
    const events: RevisionOperationEventV1[] = [];
    transition(operation, events, "created", "preparing");
    transition(operation, events, "preparing", "needs_recovery", "uncertain_start");
    return events;
  };

  const publishedPrefix = (fixture: ReturnType<typeof childAuthorities>) => {
    const events: RevisionOperationEventV1[] = [];
    transition(fixture.operation, events, "created", "preparing");
    transition(fixture.operation, events, "preparing", "prepared");
    appendRevisionEvent(fixture.operation, events, {
      kind: "head-commit",
      authorized_by_action_operation_id: fixture.operation.operation_id,
      effect_action_operation_id: fixture.operation.operation_id,
      prior_head_digest: fixture.operation.expected_head_digest,
      prior_head_checkpoint_digest: fixture.operation.expected_head_digest,
      committed_head_digest: fixture.childDigest,
      directory_fsync_completed: true,
    });
    return events;
  };

  test("proves only quiescent pre-publication recovery and abandon authority", () => {
    const preparing = priorAuthorities(false);
    const events = recoveryFromPreparing(preparing.operation);
    expect(inspectRevisionRecovery({ ...preparing, events, quiescent: true })).toMatchObject({
      kind: "proved",
      state: "preparing",
    });
    const prepared = priorAuthorities(true);
    expect(inspectRevisionRecovery({ ...prepared, events, quiescent: true })).toMatchObject({
      kind: "proved",
      state: "prepared",
    });
    expect(inspectRevisionRecovery({ ...preparing, events, quiescent: false })).toEqual({
      kind: "inconclusive",
      reason_code: "revision-head-is-not-proved",
    });
    expect(inspectRevisionRecovery({ ...preparing, events: [], quiescent: true })).toEqual({
      kind: "inconclusive",
      reason_code: "state-no-longer-needs-recovery",
    });
    expect(revisionAbandonIsProved({ ...preparing, events, quiescent: true })).toBeTrue();
    expect(revisionAbandonIsProved({ ...preparing, events, quiescent: false })).toBeFalse();
    expect(revisionAbandonIsProved({ ...preparing, events: [], quiescent: true })).toBeFalse();
  });

  test("distinguishes published, started, and failed child-side recovery", () => {
    const fixture = childAuthorities();
    const published = publishedPrefix(fixture);
    transition(fixture.operation, published, "published", "needs_recovery", "uncertain_start");
    expect(
      inspectRevisionRecovery({ ...fixture, events: published, quiescent: true }),
    ).toMatchObject({
      kind: "proved",
      state: "published",
    });

    const accepted = publishedPrefix(fixture);
    transition(fixture.operation, accepted, "published", "starting");
    for (const state of ["prepared", "effect_in_progress", "observed", "accepted"] as const)
      appendRevisionEvent(fixture.operation, accepted, {
        kind: "participant-start",
        authorized_by_action_operation_id: fixture.operation.operation_id,
        effect_action_operation_id: fixture.operation.operation_id,
        receipt: participantReceipt(fixture.operation, state, 0, {
          native: state === "observed" || state === "accepted",
        }),
      });
    transition(fixture.operation, accepted, "starting", "needs_recovery", "uncertain_start");
    expect(
      inspectRevisionRecovery({ ...fixture, events: accepted, quiescent: false }),
    ).toMatchObject({
      kind: "proved",
      state: "started",
    });

    const failed = publishedPrefix(fixture);
    transition(fixture.operation, failed, "published", "starting");
    for (const state of ["prepared", "effect_in_progress", "failed"] as const)
      appendRevisionEvent(fixture.operation, failed, {
        kind: "participant-start",
        authorized_by_action_operation_id: fixture.operation.operation_id,
        effect_action_operation_id: fixture.operation.operation_id,
        receipt: participantReceipt(fixture.operation, state),
      });
    transition(fixture.operation, failed, "starting", "needs_recovery", "uncertain_start");
    expect(inspectRevisionRecovery({ ...fixture, events: failed, quiescent: true })).toMatchObject({
      kind: "proved",
      state: "start_failed",
    });
    expect(inspectRevisionRecovery({ ...fixture, events: failed, quiescent: false })).toEqual({
      kind: "inconclusive",
      reason_code: "participant-effect-is-not-quiescent",
    });

    const startFailed = publishedPrefix(fixture);
    transition(fixture.operation, startFailed, "published", "starting");
    for (const state of ["prepared", "effect_in_progress", "failed"] as const)
      appendRevisionEvent(fixture.operation, startFailed, {
        kind: "participant-start",
        authorized_by_action_operation_id: fixture.operation.operation_id,
        effect_action_operation_id: fixture.operation.operation_id,
        receipt: participantReceipt(fixture.operation, state),
      });
    transition(fixture.operation, startFailed, "starting", "start_failed", "child_start_failed");
    expect(revisionRetryIsProved({ ...fixture, events: startFailed, quiescent: true })).toBeTrue();
    expect(revisionRetryIsProved({ ...fixture, events: [], quiescent: true })).toBeFalse();
  });

  test("records an uncertain retry result for every lane when the retry runtime throws", async () => {
    const fixture = childAuthorities();
    const events = publishedPrefix(fixture);
    transition(fixture.operation, events, "published", "starting");
    for (const state of ["prepared", "effect_in_progress", "failed"] as const)
      appendRevisionEvent(fixture.operation, events, {
        kind: "participant-start",
        authorized_by_action_operation_id: fixture.operation.operation_id,
        effect_action_operation_id: fixture.operation.operation_id,
        receipt: participantReceipt(fixture.operation, state),
      });
    transition(fixture.operation, events, "starting", "start_failed", "child_start_failed");
    const retryOperationId = `vf-operation-${"8".repeat(64)}`;
    appendRevisionEvent(fixture.operation, events, {
      kind: "state-transition",
      from: "start_failed",
      to: "starting",
      authorized_by_action_operation_id: retryOperationId,
      effect_action_operation_id: retryOperationId,
      action_terminals: [],
      reason_code: null,
    });
    const appended: RevisionOperationEventV1[] = [];
    const result = await executeRevisionRetry({
      home: {
        revisions: {
          appendEvent: (_operation: RevisionOperationV1, event: RevisionOperationEventV1) =>
            appended.push(event),
        },
      } as unknown as ConversationHomeAuthorities,
      operation: fixture.operation,
      plan: revisionPlan(),
      events,
      actionOperationId: retryOperationId,
      now: () => STAGED_AT,
      retry: async () => {
        throw new Error("adapter retry crashed");
      },
    });

    expect(appended).toEqual(result.slice(events.length));
    expect(
      result.filter((event) => event.payload.kind === "participant-start").at(-1)?.payload,
    ).toMatchObject({ kind: "participant-start", receipt: { state: "uncertain" } });
    expect(result.at(-1)?.payload).toMatchObject({
      kind: "state-transition",
      from: "starting",
      to: "needs_recovery",
      reason_code: "retry_start_uncertain",
    });
  });
});

describe("post-freeze initial revision lane authority", () => {
  test("records an uncertain start failure and releases the active lane without durable authority", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "vf-initial-lane-postfreeze-"));
    try {
      const operation = revisionOperation();
      const plan = revisionPlan();
      const events: RevisionOperationEventV1[] = [];
      const transition = (
        from: "created" | "preparing" | "published",
        to: "preparing" | "prepared" | "starting",
      ) =>
        appendRevisionEvent(operation, events, {
          kind: "state-transition",
          from,
          to,
          authorized_by_action_operation_id: operation.operation_id,
          effect_action_operation_id: operation.operation_id,
          action_terminals: [],
          reason_code: null,
        });
      transition("created", "preparing");
      transition("preparing", "prepared");
      appendRevisionEvent(operation, events, {
        kind: "head-commit",
        authorized_by_action_operation_id: operation.operation_id,
        effect_action_operation_id: operation.operation_id,
        prior_head_digest: operation.expected_head_digest,
        prior_head_checkpoint_digest: operation.expected_head_digest,
        committed_head_digest: postfreezeDigest("initial-lane-child-head"),
        directory_fsync_completed: true,
      });
      transition("published", "starting");

      const revisions = {
        readOperation: () => operation,
        readPlan: () => plan,
        readEvents: () => [...events],
        appendEvent: (_operation: RevisionOperationV1, event: RevisionOperationEventV1) =>
          events.push(event),
      } as unknown as ConversationRevisionStore;
      const authority = new InitialRevisionLaneAuthority(
        artifactRoot,
        revisions,
        () => "2026-08-25T00:00:01.000Z",
      );
      const token = authority.prepare({
        operation_id: operation.operation_id,
        conversation_id: operation.child.conversation_id,
        participant_id: "participant-1",
        binding: {
          resolved: { engine: "codex", model: "gpt-5.4" },
        } as any,
        purpose: "revision participant",
      });
      expect(token).not.toBeNull();
      if (!token) throw new Error("expected an initial revision lane token");
      authority.attach(token, {} as any);
      expect(authority.isQuiescent(operation.operation_id)).toBeFalse();

      authority.startFailed(token, undefined);

      expect(authority.isQuiescent(operation.operation_id)).toBeTrue();
      expect(events.at(-1)?.payload).toMatchObject({
        kind: "participant-start",
        receipt: {
          state: "uncertain",
          attempt_key: token.attempt_key,
          observed_at: "2026-08-25T00:00:01.000Z",
          private_native_session_ref: null,
          private_native_session_producer_receipt_digest: null,
        },
      });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  test("closes a thrown owned start barrier as a durable failed revision", async () => {
    const operation = revisionOperation();
    const events: RevisionOperationEventV1[] = [];
    for (const [from, to] of [
      ["created", "preparing"],
      ["preparing", "prepared"],
    ] as const)
      appendRevisionEvent(operation, events, {
        kind: "state-transition",
        from,
        to,
        authorized_by_action_operation_id: operation.operation_id,
        effect_action_operation_id: operation.operation_id,
        action_terminals: [],
        reason_code: null,
      });
    appendRevisionEvent(operation, events, {
      kind: "head-commit",
      authorized_by_action_operation_id: operation.operation_id,
      effect_action_operation_id: operation.operation_id,
      prior_head_digest: operation.expected_head_digest,
      prior_head_checkpoint_digest: operation.expected_head_digest,
      committed_head_digest: postfreezeDigest("owned-start-child-head"),
      directory_fsync_completed: true,
    });
    appendRevisionEvent(operation, events, {
      kind: "state-transition",
      from: "published",
      to: "starting",
      authorized_by_action_operation_id: operation.operation_id,
      effect_action_operation_id: operation.operation_id,
      action_terminals: [],
      reason_code: null,
    });
    const terminalCalls: unknown[][] = [];
    let finished = 0;
    let mirrored = 0;
    let heldChecks = 0;

    await runOwnedRevisionStart({
      prepared: {
        operation,
        revisionPlan: revisionPlan(),
        proposal: { proposal_id: operation.proposal_id },
        manifest: { conversation_id: operation.child.conversation_id },
      } as any,
      options: {
        runtime: {
          startRevisionBarrier: async () => {
            throw new Error("adapter start barrier crashed");
          },
          snapshot: async () => ({ health: "healthy" }),
          terminal: async (...args: unknown[]) => {
            terminalCalls.push(args);
          },
          finish: () => {
            finished += 1;
          },
        },
        home: {
          revisions: {
            readEvents: () => [...events],
            appendEvent: (_operation: RevisionOperationV1, event: RevisionOperationEventV1) =>
              events.push(event),
          },
          revisionLanes: { finalize: () => "start_failed" },
          actions: {
            terminal: () => {
              mirrored += 1;
            },
          },
        },
        artifactStore: {},
        executeConfigured: async () => {
          throw new Error("failed start must not execute the child");
        },
      } as any,
      owner: {
        assertHeld: () => {
          heldChecks += 1;
        },
      } as any,
    });

    expect(events.at(-1)?.payload).toMatchObject({
      kind: "state-transition",
      from: "starting",
      to: "start_failed",
      action_terminals: [
        {
          action_operation_id: operation.operation_id,
          outcome: "failed",
          reason_code: "child_start_failed",
        },
      ],
    });
    expect(terminalCalls).toEqual([
      [
        operation.child.conversation_id,
        "FAILED",
        "healthy",
        "revision participant start authority failed",
        null,
      ],
    ]);
    expect({ finished, mirrored, heldChecks }).toEqual({ finished: 1, mirrored: 1, heldChecks: 3 });
  });

  test("returns false when retry cannot re-read durable revision authority", async () => {
    const operation = revisionOperation();
    const retried = await retryPublishedRevisionStart(
      {
        operation,
        revisionPlan: revisionPlan(),
        proposal: { proposal_id: operation.proposal_id },
      } as any,
      {
        home: {
          revisions: {
            readEvents: () => {
              throw new Error("durable revision authority is unavailable");
            },
          },
        } as unknown as ConversationHomeAuthorities,
        artifactStore: {} as ConversationArtifactStore,
        owner: { assertHeld: () => undefined } as any,
        executeConfigured: async () => undefined,
      },
    );

    expect(retried).toBeFalse();
  });
});

describe("post-freeze revision reconciliation effect planning", () => {
  test("binds a failed participant receipt to an exact reconciliation postcondition", () => {
    const operation = revisionOperation();
    const events: RevisionOperationEventV1[] = [];
    for (const [from, to] of [
      ["created", "preparing"],
      ["preparing", "prepared"],
    ] as const)
      appendRevisionEvent(operation, events, {
        kind: "state-transition",
        from,
        to,
        authorized_by_action_operation_id: operation.operation_id,
        effect_action_operation_id: operation.operation_id,
        action_terminals: [],
        reason_code: null,
      });
    appendRevisionEvent(operation, events, {
      kind: "head-commit",
      authorized_by_action_operation_id: operation.operation_id,
      effect_action_operation_id: operation.operation_id,
      prior_head_digest: operation.expected_head_digest,
      prior_head_checkpoint_digest: operation.expected_head_digest,
      committed_head_digest: postfreezeDigest("reconcile-child-head"),
      directory_fsync_completed: true,
    });
    appendRevisionEvent(operation, events, {
      kind: "state-transition",
      from: "published",
      to: "starting",
      authorized_by_action_operation_id: operation.operation_id,
      effect_action_operation_id: operation.operation_id,
      action_terminals: [],
      reason_code: null,
    });
    for (const state of ["prepared", "effect_in_progress", "failed"] as const)
      appendRevisionEvent(operation, events, {
        kind: "participant-start",
        authorized_by_action_operation_id: operation.operation_id,
        effect_action_operation_id: operation.operation_id,
        receipt: participantReceipt(operation, state),
      });

    const closure = materializeRevisionControlEffectClosure({
      action_type: "conversation.reconcile_revision_operation",
      operation,
      preparation: revisionPlan(),
      events,
      expected_pre_effect_fold_digest: postfreezeDigest("reconcile-pre-effect"),
    });

    expect(closure.plan.effects).toHaveLength(1);
    expect(closure.plan.effects[0]).toMatchObject({
      participant_id: "participant-1",
      adapter_fingerprint: "adapter-1",
      effect_kind: "reconcile",
      mode: "provider-idempotency",
    });
    expect(closure.native_references[0]).toMatchObject({
      participant_id: "participant-1",
      reference_kind: "participant-start-receipt",
      authority_record_digest: participantReceipt(operation, "failed").receipt_digest,
      private_reference_content_digest: null,
    });
    expect(closure.postconditions[0]?.condition).toEqual({
      kind: "reconciliation-resolution",
      allowed_outcomes: ["present", "absent", "unknown"],
    });
  });

  test("proposes reconciliation against the exact recovery fold and effect owner", async () => {
    const operation = revisionOperation();
    const events: RevisionOperationEventV1[] = [];
    appendRevisionEvent(operation, events, {
      kind: "state-transition",
      from: "created",
      to: "preparing",
      authorized_by_action_operation_id: operation.operation_id,
      effect_action_operation_id: operation.operation_id,
      action_terminals: [],
      reason_code: null,
    });
    appendRevisionEvent(operation, events, {
      kind: "state-transition",
      from: "preparing",
      to: "needs_recovery",
      authorized_by_action_operation_id: operation.operation_id,
      effect_action_operation_id: operation.operation_id,
      action_terminals: [
        {
          action_operation_id: operation.operation_id,
          outcome: "needs_recovery",
          reason_code: "uncertain_start",
        },
      ],
      reason_code: "uncertain_start",
    });
    const resolved = resolvedLineage();
    const request: ActionProposalRequestV1 = {
      schema_version: "1.0",
      idempotency_key: "reconcile-recovery-fold",
      anchor_event_id: null,
      expected: {
        mode: "writable-revision",
        conversation_id: resolved.requested.node.conversation_id,
        revision_id: resolved.requested.node.revision_id,
        last_seq: resolved.requested.source.journal_head.last_seq,
        conversation_lock_digest: conversationLockDigest(
          resolved.lineage.root_session_id,
          resolved.requested.source,
          resolved.revision_claim_epoch,
        ),
      },
      candidate: {
        type: "conversation.reconcile_revision_operation",
        revision_operation_id: operation.operation_id,
      },
    };
    let storedClosure: any;
    let storedProposalPlan: any;
    const result = await proposeRevisionControlAction({
      lineages: { resolve: () => resolved } as unknown as ConversationLineageService,
      home: {
        revisions: {
          readOperation: () => operation,
          readEvents: () => events,
          readPlan: () => revisionPlan(),
        },
        controlEffects: {
          writeClosure: (closure: unknown) => {
            storedClosure = closure;
          },
        },
        actionReceipts: {
          writePlan: (plan: unknown) => {
            storedProposalPlan = plan;
          },
        },
        actions: {
          create: (plan: any) => ({ created: true, proposal: plan.proposal }),
        },
        now: () => STAGED_AT,
      } as unknown as ConversationHomeAuthorities,
      quiescent: () => true,
      conversation_id: "conversation",
      request,
      authority: actionAuthority(),
    });

    expect(result).toEqual({ created: true, proposal_id: storedProposalPlan.proposal_id });
    expect(storedProposalPlan.proposal.action).toMatchObject({
      type: "conversation.reconcile_revision_operation",
      revision_operation_id: operation.operation_id,
      expected_header_digest: operation.header_digest,
      expected_effect_action_operation_id: operation.operation_id,
    });
    expect(storedClosure.plan).toMatchObject({
      target_operation_id: operation.operation_id,
      effects: [],
    });
  });
});

describe("post-freeze deferred revision routing", () => {
  test("rejects non-continuation proposals and commits before entering deferred execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-deferred-routing-postfreeze-"));
    try {
      const authority = new ConversationDeferredRevisionAuthority({
        artifactRoot: root,
        home: {
          actions: {
            get: () => ({
              proposal: { action: { type: "conversation.stop_operation", operation_id: "target" } },
            }),
          },
        },
      } as any);
      expect(() =>
        authority.proposeContinuation({
          conversationId: "conversation",
          snapshot: {},
          request: {
            candidate: { type: "conversation.stop_operation", operation_id: "target" },
          },
          authority: actionAuthority(),
        } as any),
      ).toThrow("deferred revision proposal is not a continuation");
      expect(() =>
        authority.commitContinuation({
          conversationId: "conversation",
          proposalId: `vf-proposal-${"d".repeat(64)}`,
        } as any),
      ).toThrow("deferred revision proposal is not a continuation");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const stageLiteral = (store: LiteralStagingStoreV1, overrides: Record<string, unknown> = {}) =>
  store.stage({
    private_staging_id: STAGING_ID,
    root_session_id: "root-session",
    conversation_id: "conversation",
    revision_id: "revision",
    source_event_id: "source-event",
    content: "prefix token=secret-value suffix",
    staged_at: STAGED_AT,
    ...overrides,
  });

const messageLocator = (eventId: string): PublicMessageLocatorV1 => ({
  root_session_id: "root-session",
  conversation_id: "conversation",
  revision_id: "revision",
  target_event_id: eventId,
  target_kind: "completed-agent-response",
  content_digest: postfreezeDigest(`message-${eventId}`),
});

const reactionOperation = (
  operationId: string,
  operation: "add" | "remove",
  actor: string,
  eventId = "event-1",
  emoji: ConversationReactionOperationV1["emoji"] = "👍",
): ConversationReactionOperationV1 => ({
  schema_version: "1.0",
  operation_id: operationId,
  root_session_id: "root-session",
  actor_kind: "participant",
  actor_public_id: actor,
  target: messageLocator(eventId),
  emoji,
  operation,
  prior_interaction_head_digest: postfreezeDigest(`prior-${operationId}`),
  created_at: STAGED_AT,
  operation_digest: postfreezeDigest(`reaction-${operationId}`),
});

const publicMessageRow = (
  eventId: string,
  author: string,
  targetKind: PublicMessageLocatorV1["target_kind"] = "completed-agent-response",
): ResolvedPublicMessageV1 => ({
  locator: { ...messageLocator(eventId), target_kind: targetKind },
  author_public_id: author,
  preview_text: `preview ${eventId}`,
  created_at: STAGED_AT,
  revision_ordinal: 0,
  public_seq: 1,
  target_participants: "all" as const,
  quote_refs: [],
});

describe("post-freeze direct and debate message delivery", () => {
  const targeted = (content: string, target?: "all" | string[]): MessageRequest => ({
    content,
    target_participants: target,
  });

  test("applies broadcast, all, and explicit participant targets without leaking peers", () => {
    expect(appliesToParticipant(targeted("implicit"), "codex")).toBeTrue();
    expect(appliesToParticipant(targeted("all", "all"), "codex")).toBeTrue();
    expect(appliesToParticipant(targeted("selected", ["claude", "codex"]), "codex")).toBeTrue();
    expect(appliesToParticipant(targeted("peer", ["claude"]), "codex")).toBeFalse();
  });

  test("renders direct messages in stable source order", () => {
    expect(directMessagePrompt([])).toBe("");
    expect(directMessagePrompt([targeted("one")])).toBe("one");
    expect(directMessagePrompt([targeted("first"), targeted("second")])).toBe(
      "Apply these user messages in order:\n\n### Message 1\n\nfirst\n\n### Message 2\n\nsecond",
    );
  });

  test("appends only applicable messages to a debate turn", () => {
    const withoutMessages = debateMessagePrompt("release safety", 2, [], [], "codex");
    const withMessages = debateMessagePrompt(
      "release safety",
      2,
      [],
      [targeted("shared", "all"), targeted("private", ["codex"]), targeted("hidden", ["claude"])],
      "codex",
    );
    expect(withMessages.startsWith(withoutMessages.trimEnd())).toBeTrue();
    expect(withMessages).toContain("## User messages");
    expect(withMessages).toContain("### Message 1\n\nshared");
    expect(withMessages).toContain("### Message 2\n\nprivate");
    expect(withMessages).not.toContain("hidden");
  });
});

describe("post-freeze runtime private turn delivery", () => {
  test("delivers a conversation-create file range only to its intended participant", async () => {
    const prepared = await prepareRuntimeConversationTurn(
      {
        traceStore: { readConversation: async () => [] },
        artifactRegistry: {},
        homeAuthorities: {
          privateTurnContexts: {
            readCreate: () => ({
              context_kind: "conversation-create",
              target_participant_ids: ["participant-1"],
              file_range: {
                repo_relative_path: "src/decision.ts",
                start_line: 4,
                end_line: 6,
                line_count: 3,
                content: "export const decision = true;",
              },
            }),
            readMessage: () => null,
          },
        },
      } as any,
      {
        manifest: { conversation_id: "conversation", revision_id: "revision" },
        resumeBindings: new Map(),
        turnDeliveries: new Map(),
        turnObservations: new Map(),
        sharedHandoff: null,
      } as any,
      {
        participant_id: "participant-1",
        instruction: { kind: "direct", topic: "Inspect the selected source" },
      },
    );

    expect(prepared.envelope).toMatchObject({
      recipient_participant_id: "participant-1",
      delivery_mode: "full-history",
      through_public_seq: 0,
    });
    expect(prepared.private_context_prompt).toContain("src/decision.ts");
    expect(prepared.private_context_prompt).toContain("export const decision = true;");
  });
});

describe("post-freeze reaction and timeline projections", () => {
  test("folds add/remove operations and hides the recipient identity from change rows", () => {
    const operations = [
      reactionOperation("op-1", "add", "bravo"),
      reactionOperation("op-2", "add", "alpha"),
      reactionOperation("op-3", "remove", "bravo"),
      reactionOperation("op-4", "add", "recipient"),
      reactionOperation("op-5", "add", "charlie", "event-2", "🎉"),
    ];
    expect(publicReactionProjection(operations, "recipient")).toEqual([
      {
        target: messageLocator("event-1"),
        emoji: "👍",
        count: 2,
        reacted_by_recipient: true,
        actor_public_ids: ["alpha", "recipient"],
      },
      {
        target: messageLocator("event-2"),
        emoji: "🎉",
        count: 1,
        reacted_by_recipient: false,
        actor_public_ids: ["charlie"],
      },
    ]);
    const fold: ConversationInteractionFoldV1 = {
      schema_version: "1.0",
      root_session_id: "root-session",
      head_digest: postfreezeDigest("interaction-head"),
      head_sequence: 5,
      head_digests_by_sequence: {
        "0": postfreezeDigest("interaction-empty"),
        "5": postfreezeDigest("interaction-head"),
      },
      reaction_sequences_by_operation_id: {
        "op-1": 1,
        "op-2": 2,
        "op-3": 3,
        "op-4": 4,
        "op-5": 5,
      },
      reactions: operations,
      participant_intents: [],
    };
    expect(conversationReactionChanges(fold, "recipient")).toEqual([
      {
        target: messageLocator("event-1"),
        emoji: "👍",
        count: 1,
        reacted_by_recipient: false,
        actor_public_ids: ["alpha"],
        last_changed_interaction_sequence: 4,
      },
      {
        target: messageLocator("event-2"),
        emoji: "🎉",
        count: 1,
        reacted_by_recipient: false,
        actor_public_ids: ["charlie"],
        last_changed_interaction_sequence: 5,
      },
    ]);
    expect(() =>
      conversationReactionChanges(
        { ...fold, reaction_sequences_by_operation_id: { "op-1": 1 } },
        null,
      ),
    ).toThrow("reaction sequence authority is absent");
  });

  test("enforces participant reaction transitions one operation at a time", () => {
    const add = reactionOperation("op-add", "add", "participant");
    const remove = reactionOperation("op-remove", "remove", "participant");
    expect(() => assertParticipantReactionTransitions([], [add, remove])).not.toThrow();
    expect(() => assertParticipantReactionTransitions([], [remove])).toThrow(
      "reaction remove lacks an active owned reaction",
    );
    expect(() => assertParticipantReactionTransitions([add], [add])).toThrow(
      "reaction is already active",
    );
    expect(() =>
      assertParticipantReactionTransitions(
        [add],
        [reactionOperation("op-other-emoji", "add", "participant", "event-1", "🎉")],
      ),
    ).toThrow("participant already reacted to target");
  });

  test("projects ready timeline interaction data and degrades without authority", () => {
    expect(timelineInteractionProjection("event-1", undefined)).toEqual({
      state: "degraded",
      message_locator: null,
      quote_refs: [],
      reactions: [],
      diagnostic_code: null,
    });
    const target = {
      ...messageLocator("quoted"),
      author_public_id: "human",
      preview_text: "quoted preview",
      created_at: STAGED_AT,
    };
    const reactionProjection = {
      target: messageLocator("event-1"),
      emoji: "👍" as const,
      count: 1,
      reacted_by_recipient: true,
      actor_public_ids: ["human"],
    };
    const projection = {
      schema_version: "1.0" as const,
      state: "ready" as const,
      root_session_id: "root-session",
      interaction_head_digest: postfreezeDigest("interaction"),
      interaction_head_sequence: 1,
      interaction_head_digests_by_sequence: { "1": postfreezeDigest("interaction") },
      reaction_changes: [],
      message_locators_by_event_id: { "event-1": messageLocator("event-1") },
      quote_projections_by_response_event_id: { "event-1": [target] },
      reaction_projections: [
        reactionProjection,
        {
          target: messageLocator("event-2"),
          emoji: "🎉" as const,
          count: 1,
          reacted_by_recipient: false,
          actor_public_ids: ["agent"],
        },
      ],
      diagnostics_by_response_event_id: { "event-1": "invalid_social_intent" },
    };
    expect(timelineInteractionProjection("event-1", projection)).toEqual({
      state: "ready",
      message_locator: messageLocator("event-1"),
      quote_refs: [{ quoting_message_id: "event-1", quote_order: 1, target }],
      reactions: [reactionProjection],
      diagnostic_code: "invalid_social_intent",
    });
    expect(timelineInteractionProjection("absent", projection)).toMatchObject({
      state: "ready",
      message_locator: null,
      quote_refs: [],
      reactions: [],
      diagnostic_code: null,
    });
  });
});

describe("post-freeze conversation social authority", () => {
  test("accepts bounded quotes and participant reactions, then projects the durable fold", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-social-postfreeze-"));
    try {
      const store = new ConversationInteractionStore(root);
      const responseRow = publicMessageRow("response", "agent-1");
      const quoteRow = publicMessageRow("quote", "human", "user-message");
      const reactionRow = publicMessageRow("reaction-target", "human", "user-message");
      const rows = [responseRow, quoteRow, reactionRow];
      responseRow.quote_refs = [
        { ...quoteRow.locator, author_public_id: quoteRow.author_public_id },
      ];
      const messages = {
        inventory: () => ({ root_session_id: "root-session", messages: structuredClone(rows) }),
        resolve: (_conversationId: string, locator: PublicMessageLocatorV1) => {
          const row = rows.find(
            (candidate) => candidate.locator.target_event_id === locator.target_event_id,
          );
          if (!row) throw new Error("message unavailable");
          return structuredClone(row);
        },
        quote: (_conversationId: string, quote: any) => {
          const row = rows.find(
            (candidate) => candidate.locator.target_event_id === quote.target_event_id,
          );
          if (!row) throw new Error("quote unavailable");
          return {
            ...structuredClone(row.locator),
            author_public_id: row.author_public_id,
            preview_text: row.preview_text,
            created_at: row.created_at,
          };
        },
      } as unknown as ConversationMessageAuthorityV1;
      const subject = new ConversationSocialAuthorityV1(
        store,
        messages,
        () => "2026-08-25T00:03:00.000Z",
      );
      const quote = { ...quoteRow.locator, author_public_id: "human" };
      expect(subject.humanQuotes("conversation", [quote])).toEqual([quote]);
      expect(
        subject.participantIntent({
          conversation_id: "conversation",
          response_event_id: "response",
          actor_participant_id: "agent-1",
          request: {
            present: true,
            quote_refs: [quote],
            reactions: [{ operation: "add", target: reactionRow.locator, emoji: "👍" }],
          },
        }),
      ).toEqual({ accepted: true, diagnostic_code: null });

      const humanReaction = subject.humanReaction({
        conversation_id: "conversation",
        actor_public_id: "human-2",
        idempotency_key: "human-reaction",
        operation: "add",
        target: responseRow.locator,
        emoji: "🎉",
      });
      expect(humanReaction).toMatchObject({
        actor_kind: "human",
        actor_public_id: "human-2",
        operation: "add",
        emoji: "🎉",
      });
      const toggled = subject.humanToggle({
        conversation_id: "conversation",
        actor_public_id: "human-2",
        idempotency_key: "human-toggle",
        target: responseRow.locator,
        emoji: "🎉",
      });
      expect(toggled.operation).toBe("remove");
      const removedAgain = subject.humanReaction({
        conversation_id: "conversation",
        actor_public_id: "human-2",
        idempotency_key: "human-remove-replay",
        operation: "remove",
        target: responseRow.locator,
        emoji: "🎉",
      });
      expect(removedAgain).toEqual(toggled);
      expect(() =>
        subject.humanReaction({
          conversation_id: "conversation",
          actor_public_id: "human-without-reaction",
          idempotency_key: "human-remove-absent",
          operation: "remove",
          target: responseRow.locator,
          emoji: "👍",
        }),
      ).toThrow("reaction remove lacks an active owned reaction");

      expect(subject.projection("conversation", "agent-1")).toMatchObject({
        schema_version: "1.0",
        state: "ready",
        root_session_id: "root-session",
        interaction_head_sequence: 3,
        message_locators_by_event_id: {
          response: responseRow.locator,
          quote: quoteRow.locator,
          "reaction-target": reactionRow.locator,
        },
        quote_projections_by_response_event_id: {
          response: [
            {
              ...quoteRow.locator,
              author_public_id: "human",
              preview_text: "preview quote",
              created_at: STAGED_AT,
            },
          ],
        },
        reaction_projections: [
          {
            target: reactionRow.locator,
            emoji: "👍",
            count: 1,
            reacted_by_recipient: true,
            actor_public_ids: ["agent-1"],
          },
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("normalizes bad references and corrupt interaction storage into stable diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-social-diagnostics-"));
    try {
      const response = publicMessageRow("response", "agent-1");
      const self = publicMessageRow("self", "agent-1", "user-message");
      const messages = {
        inventory: () => ({ root_session_id: "root-session", messages: [response, self] }),
        resolve: (_conversationId: string, locator: PublicMessageLocatorV1) => {
          const row = [response, self].find(
            (candidate) => candidate.locator.target_event_id === locator.target_event_id,
          );
          if (!row) throw new Error("missing");
          return structuredClone(row);
        },
        quote: () => {
          throw new Error("bad quote");
        },
      } as unknown as ConversationMessageAuthorityV1;
      const store = new ConversationInteractionStore(root);
      const subject = new ConversationSocialAuthorityV1(store, messages, () => STAGED_AT);
      const quote = { ...self.locator, author_public_id: "agent-1" };
      expect(() => subject.humanQuotes("conversation", [quote])).toThrow(
        ConversationMessageReferenceUnavailableError,
      );
      expect(() => subject.humanQuotes("conversation", [quote, quote])).toThrow(
        ConversationMessageReferenceUnavailableError,
      );
      expect(
        subject.participantIntent({
          conversation_id: "conversation",
          response_event_id: "missing",
          actor_participant_id: "agent-1",
          request: { present: true, quote_refs: undefined, reactions: undefined },
        }),
      ).toEqual({
        accepted: false,
        diagnostic_code: "social_intent_response_unavailable",
      });
      expect(
        subject.participantIntent({
          conversation_id: "conversation",
          response_event_id: "response",
          actor_participant_id: "agent-1",
          request: {
            present: true,
            quote_refs: undefined,
            reactions: [{ operation: "add", target: self.locator, emoji: "👍" }],
          },
        }),
      ).toEqual({ accepted: false, diagnostic_code: "invalid_social_intent" });
      expect(subject.projection("conversation", null)).toMatchObject({
        state: "ready",
        diagnostics_by_response_event_id: { response: "invalid_social_intent" },
      });

      const corruptStore = {
        commitParticipantIntent: () => {
          throw new ConversationInteractionCorruptError("corrupt authority");
        },
      } as unknown as ConversationInteractionStore;
      const corrupt = new ConversationSocialAuthorityV1(corruptStore, messages, () => STAGED_AT);
      expect(
        corrupt.participantIntent({
          conversation_id: "conversation",
          response_event_id: "response",
          actor_participant_id: "agent-1",
          request: { present: true, quote_refs: undefined, reactions: [] },
        }),
      ).toEqual({ accepted: false, diagnostic_code: "interaction_authority_corrupt" });
      expect(corrupt.projection("conversation", null)).toMatchObject({ state: "degraded" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves explicit interaction corruption from human quote resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-social-corrupt-quote-"));
    try {
      const store = new ConversationInteractionStore(root);
      const messages = {
        quote: () => {
          throw new ConversationInteractionCorruptError("corrupt quote authority");
        },
      } as unknown as ConversationMessageAuthorityV1;
      const subject = new ConversationSocialAuthorityV1(store, messages, () => STAGED_AT);
      const quote = { ...messageLocator("quote"), author_public_id: "human" };
      expect(() => subject.humanQuotes("conversation", [quote])).toThrow(
        ConversationInteractionCorruptError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("post-freeze ordinary operation fold", () => {
  const publicEvent = (seq: number, event: any, operationId = "operation") =>
    ({
      workflow_id: "workflow",
      conversation_id: "conversation",
      revision_id: "revision",
      run_id: "run",
      turn_id: "turn",
      operation_id: operationId,
      attempt_id: "attempt",
      event_id: `event-${seq}`,
      seq,
      ts: STAGED_AT,
      public_session_ref: null,
      event,
    }) as any;

  test("binds lifecycle, cancellation event, and durable cancellation claim", () => {
    const events = [
      publicEvent(1, {
        type: "operation_lifecycle",
        payload: { operation_id: "operation", attempt_id: "attempt", state: "requested" },
      }),
      publicEvent(2, { type: "unrelated", payload: {} }, "another-operation"),
      publicEvent(3, {
        type: "caller_cancelled",
        payload: { operation_id: "operation", actor: "human", reason: "stop" },
      }),
    ];
    const claimed = foldOrdinaryConversationOperation({
      root_session_id: "root-session",
      conversation_id: "conversation",
      operation_id: "operation",
      conversation_lock_digest: postfreezeDigest("lock"),
      events,
      cancellation_claimed: true,
    });
    const unclaimed = foldOrdinaryConversationOperation({
      root_session_id: "root-session",
      conversation_id: "conversation",
      operation_id: "operation",
      conversation_lock_digest: postfreezeDigest("lock"),
      events,
      cancellation_claimed: false,
    });
    expect(claimed.operation_header_digest).toBe(unclaimed.operation_header_digest);
    expect(claimed.operation_state_digest).not.toBe(unclaimed.operation_state_digest);
  });

  test("rejects reordered or mismatched operation authority", () => {
    const lifecycle = (state: string, overrides: Record<string, unknown> = {}) =>
      publicEvent(1, {
        type: "operation_lifecycle",
        payload: { operation_id: "operation", attempt_id: "attempt", state, ...overrides },
      });
    const fold = (events: any[]) =>
      foldOrdinaryConversationOperation({
        root_session_id: "root-session",
        conversation_id: "conversation",
        operation_id: "operation",
        conversation_lock_digest: postfreezeDigest("lock"),
        events,
        cancellation_claimed: false,
      });
    expect(() => fold([lifecycle("requested"), { ...lifecycle("completed"), seq: 1 }])).toThrow(
      "ordinary operation trace sequence changed",
    );
    expect(() => fold([lifecycle("unknown")])).toThrow(
      "ordinary operation lifecycle state changed",
    );
    expect(() => fold([lifecycle("requested", { operation_id: "changed" })])).toThrow(
      "ordinary operation lifecycle authority changed",
    );
    expect(() =>
      fold([
        publicEvent(1, {
          type: "caller_cancelled",
          payload: { operation_id: "changed", actor: "human", reason: null },
        }),
      ]),
    ).toThrow("ordinary operation cancellation authority changed");
  });
});

describe("post-freeze receipt-native planning", () => {
  test("binds writable and recovery source authority", () => {
    const resolved = resolvedLineage();
    const lock = conversationLockDigest("root-session", resolved.requested.source, 0);
    const writable: ActionProposalRequestV1 = {
      schema_version: "1.0",
      idempotency_key: "source-check",
      anchor_event_id: null,
      expected: {
        mode: "writable-revision",
        conversation_id: "conversation",
        revision_id: "revision",
        last_seq: 0,
        conversation_lock_digest: lock,
      },
      candidate: { type: "conversation.stop_operation", operation_id: "operation" },
    };
    expect(() => assertReceiptSource(resolved, writable)).not.toThrow();
    const recovery = {
      ...writable,
      expected: {
        ...writable.expected,
        mode: "lineage-recovery" as const,
        root_session_id: "root-session",
        lineage_head_digest: resolved.head.content_digest,
        lineage_head_epoch: resolved.head.head_epoch,
      },
    };
    expect(() => assertReceiptSource(resolved, recovery)).not.toThrow();
    expect(() =>
      assertReceiptSource(resolved, {
        ...recovery,
        expected: { ...recovery.expected, lineage_head_epoch: 1 },
      }),
    ).toThrow("lineage recovery authority changed");
    expect(() =>
      assertReceiptSource(resolved, {
        ...writable,
        expected: { ...writable.expected, last_seq: 1 },
      }),
    ).toThrow("conversation receipt expected source changed");
    expect(() =>
      assertReceiptSource(
        {
          ...resolved,
          head: { ...resolved.head, head_status: "ambiguous", active: null },
        },
        writable,
      ),
    ).toThrow("receipt action source is not the writable lineage head");
  });

  test("materializes only an eligible ambiguous lineage leaf", () => {
    const resolved = resolvedLineage();
    const ambiguous = {
      ...resolved,
      head: {
        ...resolved.head,
        head_status: "ambiguous" as const,
        active: null,
        candidate_heads: [resolved.requested.node],
      },
    };
    const candidate = {
      type: "conversation.select_lineage_head" as const,
      root_session_id: "root-session",
      candidate_conversation_id: "conversation",
      candidate_revision_id: "revision",
    };
    const plan = materializeSelectionPlan(ambiguous, candidate, STAGED_AT);
    expect(plan).toMatchObject({
      schema_version: "1.0",
      root_session_id: "root-session",
      expected_head_status: "ambiguous",
      expected_head_digest: resolved.head.content_digest,
      expected_head_epoch: 0,
      candidate: resolved.requested.node,
      created_at: STAGED_AT,
      expires_at: "2026-08-25T01:00:00.000Z",
    });
    expect(() => materializeSelectionPlan(resolved, candidate, STAGED_AT)).toThrow(
      ConversationReceiptCandidateUnavailableError,
    );
    expect(() =>
      materializeSelectionPlan(
        ambiguous,
        { ...candidate, candidate_revision_id: "absent" },
        STAGED_AT,
      ),
    ).toThrow(ConversationReceiptCandidateUnavailableError);
    expect(() =>
      materializeSelectionPlan(
        {
          ...ambiguous,
          head: {
            ...ambiguous.head,
            candidate_heads: [
              resolved.requested.node,
              { conversation_id: "missing", revision_id: "missing", revision_ordinal: 1 },
            ],
          },
        },
        candidate,
        STAGED_AT,
      ),
    ).toThrow("lineage candidate authority is absent");
  });

  test("materializes sorted association bindings and rejects aliases", () => {
    const roots = new Map(
      ["root-a", "root-b"].map((root, index) => {
        const resolved = resolvedLineage();
        return [
          root,
          {
            ...resolved,
            lineage: { ...resolved.lineage, root_session_id: root },
            head: {
              ...resolved.head,
              root_session_id: root,
              head_epoch: index,
              content_digest: postfreezeDigest(`head-${root}`),
            },
          },
        ];
      }),
    );
    const lineages = {
      resolve: (id: string) => roots.get(id) ?? resolvedLineage(),
    } as unknown as ConversationLineageService;
    const plan = materializeAssociationPlan(
      lineages,
      {
        type: "conversation.associate_lineages",
        root_session_ids: ["root-a", "root-b"],
        reason: "same operator task",
      },
      STAGED_AT,
    );
    expect(receiptAssociationPlan(plan)).toEqual(plan);
    expect(plan.root_bindings).toEqual([
      {
        root_session_id: "root-a",
        expected_head_digest: postfreezeDigest("head-root-a"),
        expected_head_epoch: 0,
      },
      {
        root_session_id: "root-b",
        expected_head_digest: postfreezeDigest("head-root-b"),
        expected_head_epoch: 1,
      },
    ]);
    expect(() =>
      materializeAssociationPlan(
        { resolve: () => resolvedLineage() } as unknown as ConversationLineageService,
        {
          type: "conversation.associate_lineages",
          root_session_ids: ["alias-a", "alias-b"],
          reason: "alias",
        },
        STAGED_AT,
      ),
    ).toThrow(ConversationReceiptCandidateUnavailableError);
  });
});

describe("post-freeze receipt effect execution", () => {
  test("selects a lineage head exactly once and classifies every observed CAS state", async () => {
    const base = resolvedLineage();
    let current = {
      ...base.head,
      head_status: "ambiguous" as const,
      active: null,
      candidate_heads: [base.requested.node],
    };
    const candidate = {
      type: "conversation.select_lineage_head" as const,
      root_session_id: "root-session",
      candidate_conversation_id: "conversation",
      candidate_revision_id: "revision",
    };
    const selection = materializeSelectionPlan({ ...base, head: current }, candidate, STAGED_AT);
    const plan = receiptNativePlan(candidate.type, candidate, selection);
    const closure = receiptClosure();
    let committed: any = null;
    let transition: any = null;
    let fault = 0;
    const home = {
      publishedRevisionTransitions: () => [],
      headTransitions: {
        readAll: () => new Map(),
        write: (digest: string, authority: any) => {
          transition = { digest, authority };
        },
      },
      actionReceipts: { readPlan: () => ({ action_plan: { step: "selection" } }) },
      lineage: {
        commitHead: (_lineage: any, prior: any, replacement: any, transitions: any) => {
          committed = { prior, replacement, transitions };
        },
      },
    } as unknown as ConversationHomeAuthorities;
    const executor = new ConversationReceiptEffectExecutor({
      lineages: {
        resolve: () => ({ ...base, head: current }),
      } as unknown as ConversationLineageService,
      home,
      service: { wakeMessageQueue: () => undefined } as any,
      fault: (point) => {
        expect(point).toBe("after-effect-publish");
        fault += 1;
      },
    });
    const result = await executor.execute({ plan, ...closure });
    expect(fault).toBe(1);
    expect(committed.replacement).toMatchObject({
      root_session_id: "root-session",
      head_status: "committed",
      active: base.requested.node,
      candidate_heads: [],
      head_epoch: 1,
      previous_head_digest: selection.expected_head_digest,
      updated_by_operation_id: closure.dispatch.operation_id,
      updated_at: closure.dispatch.created_at,
    });
    expect(transition.digest).toBe(committed.replacement.content_digest);
    expect(result).toEqual({
      facts: [
        {
          kind: "lineage-head",
          identity: "lineage:root-session",
          content_digest: committed.replacement.content_digest,
        },
      ],
    });

    current = committed.replacement;
    expect(await executor.execute({ plan, ...closure })).toEqual(result);
    expect(await executor.observe({ plan, ...closure, expectedFacts: [] })).toEqual({
      outcome: "succeeded",
      reason_code: null,
      facts: result.facts,
    });
    current = {
      ...current,
      updated_by_operation_id: null,
      content_digest: selection.expected_head_digest,
    };
    expect(await executor.observe({ plan, ...closure, expectedFacts: result.facts })).toEqual({
      outcome: "failed",
      reason_code: "effect-refused",
      facts: result.facts,
    });
    current = { ...current, content_digest: postfreezeDigest("unexpected-head") };
    expect(await executor.observe({ plan, ...closure, expectedFacts: result.facts })).toEqual({
      outcome: "needs_recovery",
      reason_code: "effect-state-unknown",
      facts: [
        {
          kind: "lineage-head",
          identity: "lineage:root-session",
          content_digest: current.content_digest,
        },
      ],
    });
    await expect(executor.execute({ plan, ...closure })).rejects.toThrow(
      "lineage head selection CAS changed",
    );
  });

  test("commits and observes association authority without guessing changed heads", async () => {
    const roots = new Map(
      ["root-a", "root-b"].map((root, index) => {
        const resolved = resolvedLineage();
        return [
          root,
          {
            ...resolved,
            lineage: { ...resolved.lineage, root_session_id: root },
            head: {
              ...resolved.head,
              root_session_id: root,
              head_epoch: index,
              content_digest: postfreezeDigest(`association-head-${root}`),
            },
          },
        ];
      }),
    );
    const lineages = {
      resolve: (id: string) => roots.get(id) ?? resolvedLineage(),
    } as unknown as ConversationLineageService;
    const native = materializeAssociationPlan(
      lineages,
      {
        type: "conversation.associate_lineages",
        root_session_ids: ["root-a", "root-b"],
        reason: "shared source",
      },
      STAGED_AT,
    );
    const plan = receiptNativePlan(
      "conversation.associate_lineages",
      {
        type: "conversation.associate_lineages",
        root_session_ids: ["root-a", "root-b"],
        reason: "shared source",
      },
      native,
    );
    const closure = receiptClosure();
    let committed: any = null;
    let persisted: any[] = [];
    const home = {
      actionReceipts: { readPlan: () => ({ action_plan: { step: "association" } }) },
      lineage: {
        commitAssociation: (authority: any, heads: any) => {
          committed = { authority, heads };
          persisted = [authority.record];
        },
        readAssociationRecords: () => ({ records: persisted }),
      },
    } as unknown as ConversationHomeAuthorities;
    const executor = new ConversationReceiptEffectExecutor({
      lineages,
      home,
      service: {} as any,
    });
    const result = await executor.execute({ plan, ...closure });
    expect(committed.heads.size).toBe(2);
    expect(result.facts.map((fact) => fact.kind)).toEqual([
      "lineage-head",
      "lineage-head",
      "lineage-association",
    ]);
    expect(await executor.observe({ plan, ...closure, expectedFacts: [] })).toEqual({
      outcome: "succeeded",
      reason_code: null,
      facts: result.facts,
    });

    persisted = [];
    const expectedFacts = expectedReceiptAuthorityFacts(
      plan,
      closure.proposal,
      closure.approval,
      closure.dispatch,
    );
    expect(await executor.observe({ plan, ...closure, expectedFacts })).toEqual({
      outcome: "failed",
      reason_code: "effect-refused",
      facts: expectedFacts,
    });
    const rootB = roots.get("root-b");
    if (!rootB) throw new Error("association fixture disappeared");
    roots.set("root-b", {
      ...rootB,
      head: { ...rootB.head, content_digest: postfreezeDigest("changed-association-head") },
    });
    const recovery = await executor.observe({ plan, ...closure, expectedFacts });
    expect(recovery).toMatchObject({
      outcome: "needs_recovery",
      reason_code: "effect-state-unknown",
    });
    expect(recovery.facts.at(-1)).toMatchObject({
      kind: "lineage-association",
      identity: expect.stringMatching(/^association:vf-lineage-association-/),
    });

    persisted = [{ ...committed.authority.record, relation: "changed" }];
    await expect(executor.observe({ plan, ...closure, expectedFacts })).rejects.toThrow(
      "lineage association durable record changed",
    );
  });

  test("requires a durable stop postcondition and reports unknown outcomes", async () => {
    const closure = receiptClosure();
    const action = { type: "conversation.stop_operation" as const, operation_id: "operation" };
    const plan = receiptNativePlan(action.type, action, {
      expected_operation_state_digest: postfreezeDigest("operation-state"),
    });
    let cancellationStatus = 202;
    let events: any[] = [
      {
        event: {
          type: "caller_cancelled",
          payload: {
            operation_id: "operation",
            actor: closure.proposal.requested_by.public_actor_id,
            reason: `action:${closure.proposal.proposal_id}`,
          },
        },
      },
    ];
    const executor = new ConversationReceiptEffectExecutor({
      lineages: {} as ConversationLineageService,
      home: {} as ConversationHomeAuthorities,
      service: {
        cancelOperation: async () => ({ status: cancellationStatus, body: { code: "refused" } }),
        events: async () => events,
      } as any,
    });
    const result = await executor.execute({ plan, ...closure });
    expect(result.facts.map((fact) => fact.kind)).toEqual([
      "conversation-lock",
      "conversation-operation",
    ]);
    expect(await executor.observe({ plan, ...closure, expectedFacts: [] })).toEqual({
      outcome: "succeeded",
      reason_code: null,
      facts: result.facts,
    });
    cancellationStatus = 409;
    expect(await executor.execute({ plan, ...closure })).toEqual(result);
    events = [];
    await expect(executor.execute({ plan, ...closure })).rejects.toThrow(
      "operation stop refused: refused",
    );
    cancellationStatus = 202;
    await expect(executor.execute({ plan, ...closure })).rejects.toThrow(
      "operation stop postcondition is not durable",
    );
    expect(await executor.observe({ plan, ...closure, expectedFacts: result.facts })).toEqual({
      outcome: "needs_recovery",
      reason_code: "effect-state-unknown",
      facts: result.facts,
    });
    await expect(
      executor.execute({
        plan: receiptNativePlan(
          "conversation.stop_operation",
          { type: "conversation.associate_lineages" },
          {},
        ),
        ...closure,
      }),
    ).rejects.toThrow("stop plan action mismatch");
    await expect(
      executor.execute({
        plan: receiptNativePlan("context.compact", { type: "context.compact" }, {}),
        ...closure,
      }),
    ).rejects.toThrow("unsupported conversation receipt effect");
    await expect(
      executor.observe({
        plan: receiptNativePlan("context.compact", { type: "context.compact" }, {}),
        ...closure,
        expectedFacts: [],
      }),
    ).rejects.toThrow("unsupported conversation receipt observation");
  });

  test("derives expected selection, association, and stop facts", () => {
    const base = resolvedLineage();
    const ambiguous = {
      ...base,
      head: {
        ...base.head,
        head_status: "ambiguous" as const,
        active: null,
        candidate_heads: [base.requested.node],
      },
    };
    const selection = materializeSelectionPlan(
      ambiguous,
      {
        type: "conversation.select_lineage_head",
        root_session_id: "root-session",
        candidate_conversation_id: "conversation",
        candidate_revision_id: "revision",
      },
      STAGED_AT,
    );
    const closure = receiptClosure();
    expect(
      expectedReceiptAuthorityFacts(
        receiptNativePlan(
          "conversation.select_lineage_head",
          { type: "conversation.select_lineage_head" },
          selection,
        ),
        closure.proposal,
        closure.approval,
        closure.dispatch,
      ),
    ).toEqual([
      {
        kind: "lineage-head",
        identity: "lineage:root-session",
        content_digest: selection.expected_head_digest,
      },
    ]);
    const association = materializeAssociationPlan(
      {
        resolve: (id: string) => {
          const resolved = resolvedLineage();
          return {
            ...resolved,
            lineage: { ...resolved.lineage, root_session_id: id },
            head: { ...resolved.head, root_session_id: id },
          };
        },
      } as unknown as ConversationLineageService,
      {
        type: "conversation.associate_lineages",
        root_session_ids: ["root-a", "root-b"],
        reason: "facts",
      },
      STAGED_AT,
    );
    const associationPlan = receiptNativePlan(
      "conversation.associate_lineages",
      { type: "conversation.associate_lineages" },
      association,
    );
    const record = materializeReceiptAssociationRecord(
      association,
      closure.proposal,
      closure.approval,
      closure.dispatch,
    );
    expect(
      expectedReceiptAuthorityFacts(
        associationPlan,
        closure.proposal,
        closure.approval,
        closure.dispatch,
      ),
    ).toHaveLength(3);
    expect(record.association_id).toMatch(/^vf-lineage-association-[0-9a-f]{64}$/);
    const stop = receiptNativePlan(
      "conversation.stop_operation",
      { type: "conversation.stop_operation", operation_id: "operation" },
      { expected_operation_state_digest: postfreezeDigest("operation-state") },
    );
    expect(
      expectedReceiptAuthorityFacts(stop, closure.proposal, closure.approval, closure.dispatch),
    ).toEqual([
      {
        kind: "conversation-lock",
        identity: "conversation:conversation",
        content_digest: postfreezeDigest("lock"),
      },
      {
        kind: "conversation-operation",
        identity: "operation:operation",
        content_digest: postfreezeDigest("operation-state"),
      },
    ]);
    expect(() =>
      expectedReceiptAuthorityFacts(
        receiptNativePlan("context.compact", { type: "context.compact" }, {}),
        closure.proposal,
        closure.approval,
        closure.dispatch,
      ),
    ).toThrow("invalid conversation stop authority plan");
  });
});

describe("post-freeze suspected-literal staging authority", () => {
  test("stages, reserves, and consumes the exact reviewed bytes idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-literal-postfreeze-"));
    try {
      const store = new LiteralStagingStoreV1(root);
      const binding = stageLiteral(store);
      const record = store.readRecord(STAGING_ID);
      expect(record).not.toBeNull();
      if (!record) throw new Error("staged record disappeared");
      expect(record?.findings).toEqual([
        {
          rule_id: "credential-assignment",
          classification: "suspected",
          start_utf8_byte: 7,
          end_utf8_byte: 25,
        },
      ]);
      expect(record?.content_byte_length).toBe(32);
      expect(record?.expires_at).toBe("2026-08-25T00:10:00.000Z");
      expect(store.binding(record)).toEqual(binding);
      expect(store.content(binding)).toBe("prefix token=secret-value suffix");
      expect(store.readFrames(STAGING_ID)).toMatchObject([
        { sequence: 0, state: "available", proposal_id: null, consumption: null },
      ]);

      expect(stageLiteral(store)).toEqual(binding);
      expect(store.readFrames(STAGING_ID)).toHaveLength(1);
      store.reserve(binding, "vf-proposal-reviewed", "2026-08-25T00:01:00.000Z");
      store.reserve(binding, "vf-proposal-reviewed", "2026-08-25T00:01:00.000Z");
      expect(store.readFrames(STAGING_ID)).toMatchObject([
        { sequence: 0, state: "available" },
        { sequence: 1, state: "reserved", proposal_id: "vf-proposal-reviewed" },
      ]);

      const eventDigest = digestV1("POSTFREEZE-PUBLICATION\0v1\0", { event_id: "event-1" });
      store.consume(
        binding,
        "vf-proposal-reviewed",
        "vf-operation-reviewed",
        eventDigest,
        "2026-08-25T00:02:00.000Z",
      );
      store.consume(
        binding,
        "vf-proposal-reviewed",
        "vf-operation-reviewed",
        eventDigest,
        "2026-08-25T00:03:00.000Z",
      );
      expect(store.readFrames(STAGING_ID)).toMatchObject([
        { sequence: 0, state: "available" },
        { sequence: 1, state: "reserved" },
        {
          sequence: 2,
          state: "consumed",
          proposal_id: "vf-proposal-reviewed",
          consumption: {
            kind: "public-literal",
            operation_id: "vf-operation-reviewed",
            publication_event_digest: eventDigest,
          },
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects invalid, empty, oversized, and non-suspected staging input", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-literal-invalid-"));
    try {
      const store = new LiteralStagingStoreV1(root);
      expect(() => stageLiteral(store, { private_staging_id: "literal-1" })).toThrow(
        "invalid literal staging id",
      );
      expect(() => stageLiteral(store, { content: "" })).toThrow(
        "literal staging content is empty or oversized",
      );
      expect(() => stageLiteral(store, { content: "x".repeat(64 * 1024 + 1) })).toThrow(
        "literal staging content is empty or oversized",
      );
      expect(() => stageLiteral(store, { content: "ordinary public text" })).toThrow(
        "literal staging content is not suspected",
      );
      expect(store.readRecord(STAGING_ID)).toBeNull();
      expect(store.readFrames(STAGING_ID)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed on changed bindings, expiry, reservations, and consumption", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-literal-conflicts-"));
    try {
      const store = new LiteralStagingStoreV1(root);
      const binding = stageLiteral(store);
      const changed = { ...binding, staged_content_digest: digestV1("CHANGED\0v1\0", {}) };
      expect(() => store.content(changed)).toThrow("literal staging binding changed");
      expect(() => store.reserve(changed, "proposal", "2026-08-25T00:01:00.000Z")).toThrow(
        "literal staging binding changed",
      );
      expect(() => store.reserve(binding, "proposal", binding.expires_at)).toThrow(
        "literal staging expired",
      );
      expect(() =>
        store.consume(
          binding,
          "proposal",
          "operation",
          digestV1("EVENT\0v1\0", {}),
          "2026-08-25T00:01:00.000Z",
        ),
      ).toThrow("literal staging reservation changed");

      store.reserve(binding, "proposal", "2026-08-25T00:01:00.000Z");
      expect(() => store.reserve(binding, "different", "2026-08-25T00:02:00.000Z")).toThrow(
        "literal staging is not available",
      );
      const eventDigest = digestV1("EVENT\0v1\0", { event: 1 });
      store.consume(binding, "proposal", "operation", eventDigest, "2026-08-25T00:02:00.000Z");
      expect(() =>
        store.consume(
          binding,
          "proposal",
          "different-operation",
          eventDigest,
          "2026-08-25T00:03:00.000Z",
        ),
      ).toThrow("literal staging consumption conflict");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("detects mutated record and content bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-literal-corrupt-"));
    try {
      const store = new LiteralStagingStoreV1(root);
      const binding = stageLiteral(store);
      const recordPath = join(root, "actions", "v1", "literal-records", `${STAGING_ID}.json`);
      const originalRecord = await readFile(recordPath);
      await chmod(recordPath, 0o600);
      const parsed = JSON.parse(originalRecord.toString("utf8"));
      parsed.source_event_id = "mutated";
      await writeFile(recordPath, JSON.stringify(parsed));
      expect(() => store.readRecord(STAGING_ID)).toThrow("literal staging record is corrupt");

      await writeFile(recordPath, originalRecord);
      const record = store.readRecord(STAGING_ID);
      if (!record) throw new Error("restored staged record disappeared");
      const blobPath = join(root, record.private_content_ref);
      await chmod(blobPath, 0o600);
      await writeFile(blobPath, "prefix token=changed suffix");
      expect(() => store.content(binding)).toThrow("literal staging content is corrupt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("post-freeze public literal action authority", () => {
  test("proposes and commits the reviewed staging binding with durable authority facts", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-literal-authority-"));
    try {
      const literalStaging = new LiteralStagingStoreV1(root);
      const binding = stageLiteral(literalStaging);
      const resolved = resolvedLineage();
      const lock = conversationLockDigest(
        resolved.lineage.root_session_id,
        resolved.requested.source,
        resolved.revision_claim_epoch,
      );
      const request: ActionProposalRequestV1 = {
        schema_version: "1.0",
        idempotency_key: "literal-publication-1",
        anchor_event_id: "source-event",
        expected: {
          mode: "writable-revision",
          conversation_id: "conversation",
          revision_id: "revision",
          last_seq: 0,
          conversation_lock_digest: lock,
        },
        candidate: {
          type: "conversation.publish_suspected_literal",
          private_staging_id: binding.private_staging_id,
          staging_record_digest: binding.staging_record_digest,
          staged_content_digest: binding.staged_content_digest,
          findings_digest: binding.findings_digest,
        },
      };
      const authority = actionAuthority();
      let storedPlan: any = null;
      let receipt: any = null;
      const bindings: any[] = [];
      const terminals: any[] = [];
      let snapshot: any = null;
      let appended: StoredTraceEvent | null = null;
      const traceStore = {
        readConversation: async () => (appended ? [{ stored_event: appended }] : []),
        append: async (correlation: any, input: any) => {
          appended = {
            ...correlation,
            event_id: "public-event",
            seq: 1,
            ts: "2026-08-25T00:02:00.000Z",
            idempotency_key: input.idempotency_key,
            event: input.event,
          } as StoredTraceEvent;
          return appended;
        },
      } as unknown as TraceStore;
      const actions = {
        create: (plan: any) => {
          storedPlan = plan;
          snapshot = {
            proposal: plan.proposal,
            approval: null,
            operation_id: null,
          };
          return { created: true, proposal: plan.proposal };
        },
        get: () => snapshot,
        dispatch: (proposalId: string, approvalId: string) => ({
          proposal_id: proposalId,
          approval_id: approvalId,
          operation_id: deriveOperationId(snapshot.proposal, approvalId),
        }),
        terminal: (_proposalId: string, operationId: string, terminal: any) => {
          terminals.push({ operationId, ...terminal });
        },
      };
      const actionReceipts = {
        writePlan: (plan: any) => {
          storedPlan = plan;
        },
        readPlan: () => storedPlan,
        read: () => receipt,
        writeBinding: (value: any) => bindings.push(value),
        append: (value: any) => {
          receipt = value;
        },
      };
      const home = {
        now: () => "2026-08-25T00:01:00.000Z",
        literalStaging,
        lineageMutations: new ConversationLineageMutationReservationStoreV1(root),
        actions,
        actionReceipts,
      } as unknown as ConversationHomeAuthorities;
      const lineages = { resolve: () => resolved } as unknown as ConversationLineageService;
      const subject = new ConversationLiteralActionAuthority({ lineages, home, traceStore });

      const proposed = await subject.propose({
        conversation_id: "conversation",
        request,
        authority,
      });
      expect(proposed).toEqual({ created: true, proposal_id: storedPlan.proposal.proposal_id });
      expect(literalStaging.readFrames(STAGING_ID).at(-1)).toMatchObject({
        state: "reserved",
        proposal_id: proposed.proposal_id,
      });
      snapshot.approval = materializeApproval(snapshot.proposal, {
        decision: "approved",
        decided_by: authority.actor,
        challenge_class: "public-literal",
        challenge_digest: postfreezeDigest("public-literal-challenge"),
        decided_at: "2026-08-25T00:01:30.000Z",
        expires_at: "2026-08-25T00:30:00.000Z",
      });

      await subject.commit(proposed.proposal_id);
      expect(appended).toMatchObject({
        workflow_id: "workflow",
        conversation_id: "conversation",
        revision_id: "revision",
        run_id: "run",
        turn_id: `action-turn-${proposed.proposal_id.slice(12, 44)}`,
        attempt_id: `action-attempt-${proposed.proposal_id.slice(12, 44)}`,
        operation_id: deriveOperationId(snapshot.proposal, snapshot.approval.approval_id),
        idempotency_key: `action-public-literal:${proposed.proposal_id}`,
        event: {
          type: "user_message",
          payload: { content: "prefix token=secret-value suffix", target_participants: "all" },
        },
      });
      expect(bindings).toHaveLength(2);
      expect(bindings.map((item) => item.phase)).toEqual(["expected", "observed"]);
      expect(bindings[0].facts.map((fact: any) => fact.kind)).toEqual([
        "conversation-lock",
        "literal-staging",
        "public-trace-head",
      ]);
      expect(receipt).toMatchObject({
        proposal_id: proposed.proposal_id,
        approval_id: snapshot.approval.approval_id,
        action_type: "conversation.publish_suspected_literal",
        outcome: "succeeded",
      });
      expect(terminals.at(-1)).toMatchObject({
        operationId: receipt.operation_id,
        outcome: "succeeded",
        digest: receipt.receipt_digest,
      });

      receipt = null;
      await subject.commit(proposed.proposal_id);
      expect(bindings).toHaveLength(4);
      await subject.commit(proposed.proposal_id);
      expect(terminals).toHaveLength(3);
      expect(bindings).toHaveLength(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects unsupported proposals, absent staging, changed bindings, and expired records", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-literal-proposal-reject-"));
    try {
      const literalStaging = new LiteralStagingStoreV1(root);
      const resolved = resolvedLineage();
      const authority = actionAuthority();
      const home = {
        now: () => "2026-08-25T00:01:00.000Z",
        literalStaging,
      } as unknown as ConversationHomeAuthorities;
      const subject = new ConversationLiteralActionAuthority({
        lineages: { resolve: () => resolved } as unknown as ConversationLineageService,
        home,
        traceStore: {} as TraceStore,
      });
      const lock = conversationLockDigest("root-session", resolved.requested.source, 0);
      const base = {
        schema_version: "1.0" as const,
        idempotency_key: "reject-literal",
        anchor_event_id: null,
        expected: {
          mode: "writable-revision" as const,
          conversation_id: "conversation",
          revision_id: "revision",
          last_seq: 0,
          conversation_lock_digest: lock,
        },
      };
      await expect(
        subject.propose({
          conversation_id: "conversation",
          request: {
            ...base,
            candidate: { type: "conversation.stop_operation", operation_id: "operation" },
          },
          authority,
        }),
      ).rejects.toThrow("not a public literal request");
      await expect(
        subject.propose({
          conversation_id: "conversation",
          request: {
            ...base,
            candidate: {
              type: "conversation.publish_suspected_literal",
              private_staging_id: STAGING_ID,
              staging_record_digest: postfreezeDigest("absent-record"),
              staged_content_digest: postfreezeDigest("absent-content"),
              findings_digest: postfreezeDigest("absent-findings"),
            },
          },
          authority,
        }),
      ).rejects.toThrow("literal staging record is absent");

      const binding = stageLiteral(literalStaging);
      const candidate = {
        type: "conversation.publish_suspected_literal" as const,
        private_staging_id: binding.private_staging_id,
        staging_record_digest: binding.staging_record_digest,
        staged_content_digest: postfreezeDigest("changed-content"),
        findings_digest: binding.findings_digest,
      };
      await expect(
        subject.propose({
          conversation_id: "conversation",
          request: { ...base, candidate },
          authority,
        }),
      ).rejects.toThrow("literal staging request binding changed");

      const expired = new ConversationLiteralActionAuthority({
        lineages: { resolve: () => resolved } as unknown as ConversationLineageService,
        home: { ...home, now: () => "2026-08-25T00:10:00.000Z" } as ConversationHomeAuthorities,
        traceStore: {} as TraceStore,
      });
      await expect(
        expired.propose({
          conversation_id: "conversation",
          request: {
            ...base,
            candidate: {
              ...candidate,
              staged_content_digest: binding.staged_content_digest,
            },
          },
          authority,
        }),
      ).rejects.toThrow("literal staging record expired");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("post-freeze revision lane proof", () => {
  test("re-resolves accepted adapter and private lane evidence without trusting receipt claims", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-lane-proof-postfreeze-"));
    try {
      const operation = revisionOperation();
      const participant = revisionPlan().participant_starts[0];
      if (!participant) throw new Error("participant fixture is absent");
      const adapterRoot = join(root, "adapter");
      const startStore = new AttemptStartAuthorityStore(adapterRoot);
      const receiptBase = participantReceipt(operation, "accepted", 0, { native: true });
      const adapterEvidencePath = join(adapterRoot, "accepted.json");
      await writeFile(adapterEvidencePath, JSON.stringify({ attempt_id: receiptBase.attempt_key }));
      await chmod(adapterEvidencePath, 0o600);
      const authority = startStore.record({
        attempt_id: receiptBase.attempt_key,
        engine: participant.engine,
        outcome: "accepted",
        native_session_id: "native-session-1",
        evidence_ref: adapterEvidencePath,
        recorded_at: STAGED_AT,
      });
      if (!authority) throw new Error("adapter authority fixture was not recorded");

      const evidence = new RevisionLaneEvidenceStore(join(root, "artifacts"));
      const binding = evidence.write({
        root_session_id: "root-session",
        operation_id: operation.operation_id,
        participant_id: participant.participant_id,
        start_generation: 0,
        attempt_key: receiptBase.attempt_key,
        native_session_id: authority.native_session_id,
        adapter_evidence_ref: authority.record_digest,
        recorded_at: STAGED_AT,
        reconciliation_mode: participant.reconciliation_mode,
        adapter_reference_utf8: authority.native_session_id ?? "",
        absence_proved: false,
      });
      if (!binding.ref || !binding.digest) throw new Error("lane evidence fixture was not bound");
      expect(evidence.readNativeReference(binding.ref, "root-session")).toMatchObject({
        owner_root_locator: { kind: "conversation", root_session_id: "root-session" },
        identifier_kind: "provider-session",
        identifier_utf8: "native-session-1",
        binding_digest: binding.ref,
      });
      const {
        schema_version: _schema,
        receipt_digest: _receiptDigest,
        ...receiptInput
      } = receiptBase;
      const receipt = materializeParticipantStartReceipt({
        ...receiptInput,
        private_native_session_ref: binding.ref,
        private_native_session_producer_receipt_digest: binding.digest,
      });
      const input = {
        evidence,
        reader: createDurableAttemptStartAuthorityReaderV1(startStore),
        operation,
        participant,
        receipt,
      };

      expect(revisionLaneReceiptIsProved(input)).toBeTrue();
      expect(
        revisionLaneReceiptIsProved({
          ...input,
          receipt: { ...receipt, state: "observed" },
        }),
      ).toBeFalse();
      expect(
        revisionLaneReceiptIsProved({
          ...input,
          operation: { ...operation, operation_id: `vf-operation-${"9".repeat(64)}` },
        }),
      ).toBeFalse();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("post-freeze continue-message proposal planning", () => {
  test("projects targeted content and quoted public authority into the reviewable action", () => {
    const quote = { ...messageLocator("quoted-event"), author_public_id: "human-1" };
    const planned = materializeContinueMessageProposal({
      root_session_id: "root-session",
      conversation_id: "conversation",
      revision_id: "revision",
      last_seq: 3,
      conversation_lock_digest: postfreezeDigest("continue-lock"),
      head: resolvedLineage().head,
      request: {
        content: "Continue from the quoted decision",
        target_participants: ["participant-1"],
        quote_refs: [quote],
      },
      anchor_event_id: "anchor-event",
      message_key: "continue-with-quote",
      authority: actionAuthority(),
      revision_plan: revisionPlan(),
      created_at: STAGED_AT,
    });

    expect(planned.proposal.action).toEqual({
      type: "conversation.continue_message",
      content: "Continue from the quoted decision",
      target_participants: ["participant-1"],
      quote_refs: [quote],
    });
    expect(planned.proposal.preview.review_fields).toEqual([
      expect.objectContaining({
        json_pointer: "/content",
        after: "Continue from the quoted decision",
      }),
    ]);
    expect(planned.canonical_request).toMatchObject({
      origin: "conversation",
      request: {
        anchor_event_id: "anchor-event",
        candidate: planned.proposal.action,
      },
    });
  });
});

describe("post-freeze isolated catalog recovery", () => {
  test("reconstructs one requested lineage without trusting a stale catalog generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-catalog-recover-postfreeze-"));
    try {
      const fixture = resolvedLineage();
      const service = new ConversationCatalogService({
        artifactRoot: join(root, "artifacts"),
        traceRoot: join(root, "traces"),
        scopeId: "postfreeze:test",
        cursorCodec: new CatalogCursorCodec(Buffer.alloc(32, 7)),
        readInventory: () => structuredClone(fixture.inventory),
      });

      expect(service.recoverByConversationId("conversation")).toMatchObject({
        schema_version: "1.0",
        root_session_id: "conversation",
        active_conversation_id: "conversation",
        active_revision_id: "revision",
        revision_count: 1,
      });
      expect(() => service.recoverByConversationId("missing")).toThrow(
        ConversationCatalogNotFoundError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("degrades one inconsistent accepted lineage without suppressing the catalog", () => {
    const source = structuredClone(resolvedLineage().inventory.sources[0]);
    if (!source) throw new Error("catalog projection source fixture is absent");
    source.journal_head.last_seq = 1;
    const inventory = {
      schema_version: "1.0" as const,
      state: "ready" as const,
      authoritative: true,
      sources: [source],
      diagnostics: [],
      observed_source_digest: postfreezeDigest("inconsistent-catalog-inventory"),
    };
    const lineages = deriveConversationLineages(inventory);
    const lineage = lineages.lineages[0];
    const head = lineage?.initial_head_candidate;
    if (!lineage || !head) throw new Error("catalog lineage head fixture is absent");

    const projection = projectConversationCatalog({
      inventory,
      lineages,
      cursorCodec: new CatalogCursorCodec(Buffer.alloc(32, 8)),
      scopeId: "postfreeze:inconsistent-catalog",
      headRecords: new Map([[lineage.root_session_id, head]]),
    });

    expect(projection.response.items).toEqual([]);
    expect(projection.response.catalog_health).toBe("degraded");
    expect(projection.diagnostics).toEqual([
      expect.objectContaining({
        code: "invalid-lineage-head",
        record_id: lineage.root_session_id,
        read_only: true,
      }),
    ]);
  });
});

describe("post-freeze lineage exclusion", () => {
  const lineageSource = (
    conversationId: string,
    revisionId: string,
    parentConversationId: string | null,
    parentRevisionId: string | null,
    childRevisions: Record<string, string> = {},
  ) => {
    const template = resolvedLineage().inventory.sources[0];
    if (!template) throw new Error("lineage source fixture is absent");
    const manifest = {
      ...structuredClone(template.manifest),
      conversation_id: conversationId,
      revision_id: revisionId,
      parent_conversation_id: parentConversationId,
      parent_revision_id: parentRevisionId,
    };
    return {
      ...structuredClone(template),
      manifest,
      manifest_record: {
        ...structuredClone(template.manifest_record),
        manifest,
        child_revisions: structuredClone(childRevisions),
      },
      manifest_digest: postfreezeDigest(`lineage-manifest-${conversationId}`),
      journal_head: {
        ...structuredClone(template.journal_head),
        record_id: conversationId,
        record_digest: postfreezeDigest(`lineage-journal-${conversationId}`),
      },
    };
  };

  test("excludes every duplicate revision and then propagates exclusion to its descendants", () => {
    const first = lineageSource("root-a", "duplicate-revision", null, null, {
      child: "child",
    });
    const duplicate = lineageSource("root-b", "duplicate-revision", null, null);
    const child = lineageSource("child", "child-revision", "root-a", "duplicate-revision");
    const result = deriveConversationLineages({
      schema_version: "1.0",
      state: "ready",
      authoritative: true,
      sources: [first, duplicate, child],
      diagnostics: [],
      observed_source_digest: postfreezeDigest("lineage-duplicate-inventory"),
    });

    expect(result.excluded_conversation_ids).toEqual(["child", "root-a", "root-b"]);
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "duplicate-revision-id",
      "duplicate-revision-id",
      "unlinked-parent",
    ]);
  });

  test("detects every member of a manifest ancestry cycle", () => {
    const first = lineageSource("cycle-a", "revision-a", "cycle-b", "revision-b", {
      child: "cycle-b",
    });
    const second = lineageSource("cycle-b", "revision-b", "cycle-a", "revision-a", {
      child: "cycle-a",
    });
    const result = deriveConversationLineages({
      schema_version: "1.0",
      state: "ready",
      authoritative: true,
      sources: [first, second],
      diagnostics: [],
      observed_source_digest: postfreezeDigest("lineage-cycle-inventory"),
    });

    expect(result.excluded_conversation_ids).toEqual(["cycle-a", "cycle-b"]);
    expect(result.diagnostics.map((item) => item.code)).toEqual(["lineage-cycle", "lineage-cycle"]);
  });
});

describe("post-freeze source inventory diagnostics", () => {
  test("projects an empty journal and rejects strict-invalid and aliased manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-source-inventory-postfreeze-"));
    try {
      const artifactRoot = join(root, "artifacts");
      const traceRoot = join(root, "traces");
      const artifacts = new ConversationArtifactStore({ dir: artifactRoot });
      const emptyManifest = {
        ...structuredClone(resolvedLineage().requested.source.manifest),
        conversation_id: "empty-journal",
        revision_id: "empty-revision",
        run_id: "empty-run",
        topic: "Empty durable journal",
        bindings: [
          {
            participant_id: "participant-1",
            input: { roleRef: "direct", engine: "codex" as const, sessionMode: "fresh" as const },
          },
        ],
      };
      const emptyAuthorities = [
        {
          participant_id: "participant-1",
          engine: "codex" as const,
          model: "gpt-5.4",
          session_mode: "fresh" as const,
          role_source: "builtin" as const,
          role_hash: "a".repeat(64),
          skill_hashes: [],
        },
      ];
      artifacts.create(emptyManifest, emptyAuthorities);
      const traces = new TraceStore({ dir: traceRoot, now: () => STAGED_AT });
      expect(await traces.readConversation(emptyManifest.conversation_id)).toEqual([]);

      const corruptManifest = {
        ...structuredClone(emptyManifest),
        conversation_id: "corrupt-manifest",
        revision_id: "corrupt-revision",
        run_id: "corrupt-run",
      };
      artifacts.create(corruptManifest, emptyAuthorities);
      const corruptPath = conversationManifestPath(artifactRoot, corruptManifest.conversation_id);
      const corruptRecord = JSON.parse(await readFile(corruptPath, "utf8"));
      corruptRecord.manifest.topic = null;
      await writeFile(corruptPath, JSON.stringify(corruptRecord), "utf8");

      const validPath = conversationManifestPath(artifactRoot, emptyManifest.conversation_id);
      const firstAlias = `${"a".repeat(64)}.json`;
      const aliasName = basename(validPath) === firstAlias ? `${"b".repeat(64)}.json` : firstAlias;
      const aliasPath = join(dirname(validPath), aliasName);
      await writeFile(aliasPath, await readFile(validPath));
      await chmod(aliasPath, 0o600);

      const inventory = readConversationSourceInventory({ artifactRoot, traceRoot });

      expect(inventory.sources).toHaveLength(1);
      expect(inventory.sources[0]?.journal_head).toMatchObject({
        record_id: emptyManifest.conversation_id,
        last_seq: 0,
        lifecycle: "INIT",
        health: "healthy",
        participants: [
          {
            participant_id: "participant-1",
            role_ref: "direct",
            engine: "codex",
            model: "gpt-5.4",
          },
        ],
      });
      expect(inventory.diagnostics.map(({ code }) => code).sort()).toEqual([
        "invalid-manifest",
        "invalid-manifest-filename",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("marks non-private and non-directory children invalid without following them", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-read-safety-postfreeze-"));
    try {
      await mkdir(join(root, "public-child"), { mode: 0o755 });
      await writeFile(join(root, "plain-file"), "not a directory", "utf8");
      const parent = inspectPrivateDirectoryReadOnly(root);
      expect(parent.state).toBe("valid");
      try {
        expect(openPrivateChildDirectoryReadOnly(parent, "public-child").state).toBe("invalid");
        expect(openPrivateChildDirectoryReadOnly(parent, "plain-file").state).toBe("invalid");
      } finally {
        closePrivateDirectorySnapshot(parent);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("post-freeze lineage head transition authority", () => {
  test("persists canonical transition authority under the committed head digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-head-transition-postfreeze-"));
    try {
      const store = new LineageHeadTransitionStore(root);
      expect(() => store.write("invalid", { kind: "transition" })).toThrow(
        "invalid committed lineage head digest",
      );
      const headDigest = postfreezeDigest("stored-head-transition");
      const authority = {
        schema_version: "1.0",
        kind: "post-freeze-test-transition",
        operation_id: `vf-operation-${"e".repeat(64)}`,
      };

      store.write(headDigest, authority);
      store.write(headDigest, structuredClone(authority));

      expect([...store.readAll()]).toEqual([[headDigest, authority]]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("post-freeze durable conversation action service reads", () => {
  test("projects anchored pending events and cancellation from one durable proposal", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-action-service-postfreeze-"));
    try {
      const revisions = new ConversationRevisionStore({ artifactRoot: root });
      const receipts = new ConversationActionReceiptStore(root);
      const service = new ConversationActionService(
        root,
        () => STAGED_AT,
        revisions,
        receipts,
        Buffer.alloc(32, 3),
      );
      revisions.bindActionAuthority(service.authority.reader);
      const authority = actionAuthority();
      const planned = materializeContinueMessageProposal({
        root_session_id: "root-session",
        conversation_id: "conversation",
        revision_id: "revision",
        last_seq: 3,
        conversation_lock_digest: postfreezeDigest("action-service-lock"),
        head: resolvedLineage().head,
        request: { content: "Review this continuation", target_participants: "all" },
        anchor_event_id: "anchor-event",
        message_key: "action-service-proposal",
        authority,
        revision_plan: revisionPlan(),
        created_at: STAGED_AT,
      });
      const created = service.create(planned, authority);
      const proposalId = created.proposal.proposal_id;

      expect(service.events("missing-proposal")).toBeNull();
      expect(service.events(proposalId)).toEqual([]);
      expect(
        service.anchored({
          conversation_id: "conversation",
          revision_id: "revision",
          origin_event_id: "anchor-event",
        }),
      ).toEqual([
        expect.objectContaining({
          proposal: expect.objectContaining({ proposal_id: proposalId }),
          operation: expect.objectContaining({ state: "pending_review" }),
        }),
      ]);
      expect(() =>
        service.challenge({
          proposal_id: proposalId,
          proposal_digest: created.proposal.proposal_digest,
          challenge_class: "fresh-user-scope",
          authority,
        }),
      ).toThrow("requested challenge class is not required by the proposal");

      const canceled = service.cancel({
        proposal_id: proposalId,
        proposal_digest: created.proposal.proposal_digest,
        authority,
        reason: "operator canceled review",
      });
      expect(canceled).toMatchObject({
        proposal: { proposal_id: proposalId },
        operation: { state: "canceled" },
      });
      expect(service.pending("conversation")).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("post-freeze revision recovery transition authority", () => {
  test("closes only the reviewed control action while retaining the suspended effect owner", () => {
    const activeEffect = revisionOperation().operation_id;
    const controlOperation = `vf-operation-${"4".repeat(64)}`;
    const valid = {
      kind: "state-transition" as const,
      from: "needs_recovery" as const,
      to: "abandoned" as const,
      authorized_by_action_operation_id: controlOperation,
      effect_action_operation_id: activeEffect,
      action_terminals: [
        {
          action_operation_id: controlOperation,
          outcome: "succeeded" as const,
          reason_code: null,
        },
      ],
      reason_code: "operator_abandoned",
    };

    expect(validateRevisionTransitionAuthority(valid, activeEffect)).toBe(activeEffect);
    expect(() =>
      validateRevisionTransitionAuthority(
        { ...valid, authorized_by_action_operation_id: activeEffect },
        activeEffect,
      ),
    ).toThrow("invalid revision recovery transition authority");
    expect(() =>
      validateRevisionTransitionAuthority({ ...valid, reason_code: null }, activeEffect),
    ).toThrow("invalid revision recovery terminal cardinality");
  });
});

describe("post-freeze operation owner brokerage", () => {
  test("distinguishes a foreign live broker owner from durable absence", () => {
    const authority = {
      scopeKey: "postfreeze-scope",
      commitCancellation: () => false,
      isCancellationClaimed: () => false,
      owner: (operationId: string) => (operationId === "durable-foreign" ? "other" : null),
    };
    const brokerKey = operationBrokerKey(authority, "shared-operation");
    if (!brokerKey) throw new Error("broker fixture key is absent");
    const entry = {
      brokerKey,
      conversationId: "other",
    } as Parameters<typeof registerBrokeredOperation>[1];
    registerBrokeredOperation(brokerKey, entry);
    try {
      expect(brokeredOperation(brokerKey)).toBe(entry);
      expect(
        readOperationOwnerState({
          local: undefined,
          authority,
          conversationId: "requested",
          operationId: "shared-operation",
        }),
      ).toBe("conversation_mismatch");
    } finally {
      releaseBrokeredOperation(entry);
    }
    expect(
      readOperationOwnerState({
        local: undefined,
        authority,
        conversationId: "requested",
        operationId: "durable-foreign",
      }),
    ).toBe("conversation_mismatch");
    expect(
      readOperationOwnerState({
        local: undefined,
        authority,
        conversationId: "requested",
        operationId: "durably-absent",
      }),
    ).toBe("absent");
  });
});

describe("post-freeze quoted trace validation", () => {
  const correlation: TraceCorrelation = {
    workflow_id: "workflow",
    conversation_id: "conversation",
    revision_id: "revision",
    run_id: "run",
    turn_id: "turn",
    operation_id: "operation",
    attempt_id: "attempt",
  };
  const quotedInput = (
    quoteRefs: Array<ReturnType<typeof messageLocator> & { author_public_id: string }>,
  ): TraceAppendInput => ({
    idempotency_key: "quoted-user-message",
    event: {
      type: "user_message",
      payload: {
        content: "Use the cited result",
        target_participants: "all",
        quote_refs: quoteRefs,
      },
    },
  });

  test("accepts one to eight exact public quote locators", () => {
    const quote = { ...messageLocator("trace-quote"), author_public_id: "human" };
    expect(validInput(correlation, quotedInput([quote]), null)).toBeTrue();
    expect(validInput(correlation, quotedInput([]), null)).toBeFalse();
    expect(validInput(correlation, quotedInput(Array.from({ length: 9 }, () => quote)), null)).toBe(
      false,
    );
  });
});

describe("post-freeze dry-run social publication", () => {
  test("returns an explicit diagnostic from both preview context variants", () => {
    const manifest = resolvedLineage().requested.source.manifest;
    const correlation = {
      workflow_id: manifest.workflow_id,
      conversation_id: manifest.conversation_id,
      revision_id: manifest.revision_id,
      run_id: manifest.run_id,
      turn_id: "preview-turn",
      operation_id: "preview-operation",
      attempt_id: "preview-attempt",
    };
    const request = {
      participant_id: "participant-1",
      response_event_id: "response-event",
      request: { present: true, quote_refs: [], reactions: [] },
    };

    expect(
      previewAgentPolicyContext(manifest, [], correlation).publishSocialIntent(request),
    ).toEqual({ accepted: false, diagnostic_code: "dry_run_context" });
    expect(previewPolicyContext(manifest, [], correlation).publishSocialIntent(request)).toEqual({
      accepted: false,
      diagnostic_code: "dry_run_context",
    });
  });
});

describe("post-freeze participant publication and attempt admission", () => {
  test("publishes a present participant social intent against the emitted response event", async () => {
    const response = { event_id: "response-event" } as StoredTraceEvent;
    let emitted: unknown;
    let published: unknown;
    const result = await publishDebateParticipantResponse(
      {
        publishSocialIntent: (input: unknown) => {
          published = input;
          return { accepted: true, diagnostic_code: null };
        },
      } as never,
      2,
      {
        participantId: "participant-1",
        attempt: {
          emit: async (input: unknown) => {
            emitted = input;
            return response;
          },
        } as never,
        content: "final response",
        claim: "claim",
        evidence: ["evidence"],
        socialIntent: { present: true, quote_refs: [], reactions: [] },
      },
    );

    expect(result).toBe(response);
    expect(emitted).toMatchObject({
      idempotency_key: "debate:round:2:participant:participant-1:response",
      event: { type: "agent_response_delta" },
    });
    expect(published).toEqual({
      participant_id: "participant-1",
      response_event_id: "response-event",
      request: { present: true, quote_refs: [], reactions: [] },
    });
  });

  test("marks the revision effect uncertain and terminates a started attempt rejected by admission", async () => {
    let uncertain = 0;
    let terminated = 0;
    const handle = {
      attemptId: "attempt-1",
      completion: Promise.resolve(undefined),
      terminate: async (reason?: string) => {
        expect(reason).toBe("attempt admission failed");
        terminated += 1;
      },
      readResumeBinding: () => undefined,
      readEvidenceBinding: () => undefined,
    };
    const lane = {} as never;
    expect(() =>
      startAndAdmitAttempt({
        adapter: { start: () => handle, startAuthority: undefined } as never,
        request: {} as never,
        operation: {
          addAttempt: () => {
            throw new Error("operation no longer accepts attempts");
          },
        } as never,
        revisionLane: lane,
        revisionLanes: {
          attach: () => undefined,
          effectUnknown: (observedLane: unknown, observedHandle: unknown) => {
            expect(observedLane).toBe(lane);
            expect(observedHandle).toBe(handle);
            uncertain += 1;
          },
        } as never,
      }),
    ).toThrow("operation no longer accepts attempts");
    await Promise.resolve();
    expect(uncertain).toBe(1);
    expect(terminated).toBe(1);
  });
});

describe("post-freeze assembled browser authorities", () => {
  test("hydrates timeline action watermarks and resolves roots from durable source authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-browser-authorities-postfreeze-"));
    try {
      const artifactRoot = join(root, "artifacts");
      const traceRoot = join(root, "traces");
      const registry = new DurableArtifactRegistry({ dir: join(root, "opaque") });
      const traceStore = new TraceStore({
        dir: traceRoot,
        artifactRegistry: registry,
        now: () => STAGED_AT,
      });
      const artifacts = new ConversationArtifactStore({ dir: artifactRoot });
      const home = new ConversationHomeAuthorities({ artifactRoot, now: () => STAGED_AT });
      const manifest = {
        ...resolvedLineage().requested.source.manifest,
        bindings: [
          {
            participant_id: "participant-1",
            input: { roleRef: "direct", engine: "codex" as const, sessionMode: "fresh" as const },
          },
        ],
      };
      artifacts.create(manifest, [
        {
          participant_id: "participant-1",
          engine: "codex",
          model: "gpt-5.4",
          session_mode: "fresh",
          role_source: "builtin",
          role_hash: "a".repeat(64),
          skill_hashes: [],
        },
      ]);
      await traceStore.append(
        {
          workflow_id: manifest.workflow_id,
          conversation_id: manifest.conversation_id,
          revision_id: manifest.revision_id,
          run_id: manifest.run_id,
          turn_id: "turn-configured",
          operation_id: "operation-configured",
          attempt_id: "attempt-configured",
        },
        {
          idempotency_key: "configured",
          event: {
            type: "conversation_configured",
            payload: {
              topic: manifest.topic,
              participants: [
                {
                  participant_id: "participant-1",
                  role_ref: "direct",
                  engine: "codex",
                  model: "gpt-5.4",
                },
              ],
              policy: manifest.policy,
              max_rounds: manifest.max_rounds,
            },
          },
        },
      );
      const browser = createConversationBrowserAuthorities({
        artifactRoot,
        traceRoot,
        traceStore,
        browserAuthorityKey: Buffer.alloc(32, 6),
        artifactRegistry: registry,
        artifactStore: artifacts,
        home,
        service: {} as never,
      });

      expect(browser.rootSessionId("conversation")).toBe("conversation");
      expect(browser.rootSessionId("missing")).toBeNull();
      const timeline = await browser.timeline.read("conversation");
      expect(timeline.items.map((item) => item.kind)).toEqual([
        "conversation-start",
        "conversation-event",
      ]);
      for (const item of timeline.items) {
        if (item.kind === "revision-boundary") continue;
        expect(item.action_operations).toMatchObject({
          schema_version: "1.0",
          items: [],
          next_cursor: null,
        });
        expect(item.action_operations.proposal_set_watermark).toMatch(/^sha256:[0-9a-f]{64}$/);
      }

      const rootCorrelation = {
        workflow_id: manifest.workflow_id,
        conversation_id: manifest.conversation_id,
        revision_id: manifest.revision_id,
        run_id: manifest.run_id,
        turn_id: "turn-user-message",
        operation_id: "operation-user-message",
        attempt_id: "attempt-user-message",
      };
      const quotedTarget = await traceStore.append(rootCorrelation, {
        idempotency_key: "user-message-target",
        event: {
          type: "user_message",
          payload: { content: "Original public decision", target_participants: "all" },
        },
      });
      const messages = new ConversationMessageAuthorityV1({
        artifactRoot,
        traceRoot,
        artifactRegistry: registry,
        home,
      });
      const target = messages
        .inventory("conversation")
        .messages.find((item) => item.locator.target_event_id === quotedTarget.event_id);
      if (!target) throw new Error("quoted target fixture is absent");
      const quoteReference = { ...target.locator, author_public_id: target.author_public_id };
      const quotingMessage = await traceStore.append(
        { ...rootCorrelation, turn_id: "turn-quoting-message" },
        {
          idempotency_key: "user-message-with-quote",
          event: {
            type: "user_message",
            payload: {
              content: "Follow the cited decision",
              target_participants: ["participant-1"],
              quote_refs: [quoteReference],
            },
          },
        },
      );
      const quotedInventory = messages.inventory("conversation");
      expect(
        quotedInventory.messages.find(
          (item) => item.locator.target_event_id === quotingMessage.event_id,
        )?.quote_refs,
      ).toEqual([quoteReference]);
      const actor = {
        kind: "human" as const,
        public_id: "human",
        participant_id: null,
        source_event_id: quotingMessage.event_id,
      };
      expect(messages.quote("conversation", quoteReference, actor)).toMatchObject({
        ...target.locator,
        author_public_id: "human",
        preview_text: "Original public decision",
      });
      expect(() =>
        messages.quote("conversation", { ...quoteReference, author_public_id: "other" }, actor),
      ).toThrow("public quote reference is unavailable");
      expect(() => messages.quote("conversation", null, actor)).toThrow(
        "public quote reference is unavailable",
      );

      const childManifest = {
        ...structuredClone(manifest),
        conversation_id: "conversation-child",
        revision_id: "revision-child",
        run_id: "run-child",
        parent_conversation_id: manifest.conversation_id,
        parent_revision_id: manifest.revision_id,
        topic: "Published child",
      };
      const bindingAuthorities = [
        {
          participant_id: "participant-1",
          engine: "codex" as const,
          model: "gpt-5.4",
          session_mode: "fresh" as const,
          role_source: "builtin" as const,
          role_hash: "a".repeat(64),
          skill_hashes: [],
        },
      ];
      artifacts.create(childManifest, bindingAuthorities);
      await traceStore.append(
        {
          workflow_id: childManifest.workflow_id,
          conversation_id: childManifest.conversation_id,
          revision_id: childManifest.revision_id,
          run_id: childManifest.run_id,
          turn_id: "turn-child-configured",
          operation_id: "operation-child-configured",
          attempt_id: "attempt-child-configured",
        },
        {
          idempotency_key: "child-configured",
          event: {
            type: "conversation_configured",
            payload: {
              topic: childManifest.topic,
              participants: [
                {
                  participant_id: "participant-1",
                  role_ref: "direct",
                  engine: "codex",
                  model: "gpt-5.4",
                },
              ],
              policy: childManifest.policy,
              max_rounds: childManifest.max_rounds,
            },
          },
        },
      );
      const initial = browser.lineage.resolve("conversation");
      const parent = initial.requested.node;
      const child = {
        conversation_id: childManifest.conversation_id,
        revision_id: childManifest.revision_id,
        revision_ordinal: 1,
      };
      const preparation = materializeRevisionPreparationPlan({
        root_session_id: "conversation",
        parent,
        expected_head_digest: initial.head.content_digest,
        expected_head_epoch: initial.head.head_epoch,
        expected_reservation_digest: null,
        expected_reservation_epoch: 0,
        expected_parent_last_seq: initial.requested.source.journal_head.last_seq,
        expected_parent_lock_digest: postfreezeDigest("browser-parent-lock"),
        permission_digest: EMPTY_PERMISSION_DIGEST,
        revision_claim_epoch: 1,
        binding_delta_digest: postfreezeDigest("browser-binding-delta"),
        resulting_binding_set_digest: postfreezeDigest("browser-binding-set"),
        handoff_selection_plan_digest: postfreezeDigest("browser-selection"),
        participant_starts: [],
        created_at: STAGED_AT,
        expires_at: "2026-08-25T01:00:00.000Z",
      });
      const browserPlanned = materializeContinueMessageProposal({
        root_session_id: "conversation",
        conversation_id: parent.conversation_id,
        revision_id: parent.revision_id,
        last_seq: initial.requested.source.journal_head.last_seq,
        conversation_lock_digest: postfreezeDigest("browser-parent-lock"),
        head: initial.head,
        request: { content: "Publish the child revision", target_participants: "all" },
        message_key: "browser-child-publication",
        authority: actionAuthority("conversation"),
        revision_plan: preparation,
        created_at: STAGED_AT,
      });
      const approval = materializeApproval(browserPlanned.proposal, {
        decision: "approved",
        decided_by: actionAuthority("conversation").actor,
        challenge_class: "normal-confirm",
        challenge_digest: null,
        decided_at: STAGED_AT,
        expires_at: "2026-08-25T00:30:00.000Z",
      });
      const preliminaryDispatch = materializeDispatchRecord(
        browserPlanned.proposal,
        approval,
        null,
      );
      const operation = materializeRevisionOperation({
        operation_id: preliminaryDispatch.operation_id,
        proposal_id: browserPlanned.proposal.proposal_id,
        proposal_digest: browserPlanned.proposal.proposal_digest,
        approval_id: approval.approval_id,
        approval_digest: approval.approval_digest,
        plan_digest: browserPlanned.proposal.plan_digest,
        authority_epoch: browserPlanned.proposal.base.authority_epoch,
        authority_head_digest: browserPlanned.proposal.base.authority_head_digest,
        root_session_id: "conversation",
        parent,
        child,
        expected_head_digest: initial.head.content_digest,
        expected_reservation_digest: null,
        expected_reservation_epoch: 0,
        revision_claim_epoch: 1,
        expected_parent_last_seq: initial.requested.source.journal_head.last_seq,
        expected_parent_lock_digest: postfreezeDigest("browser-parent-lock"),
        permission_digest: browserPlanned.proposal.permission_digest,
        binding_set_digest: preparation.resulting_binding_set_digest,
        handoff_digest: postfreezeDigest("browser-handoff"),
        handoff_selection_digest: preparation.handoff_selection_plan_digest,
        prompt_projection_digest: postfreezeDigest("browser-prompt"),
        created_at: preliminaryDispatch.created_at,
      });
      const dispatch = materializeDispatchRecord(
        browserPlanned.proposal,
        approval,
        operation.header_digest,
      );
      const publicationEvents: RevisionOperationEventV1[] = [];
      for (const [from, to] of [
        ["created", "preparing"],
        ["preparing", "prepared"],
      ] as const)
        appendRevisionEvent(operation, publicationEvents, {
          kind: "state-transition",
          from,
          to,
          authorized_by_action_operation_id: operation.operation_id,
          effect_action_operation_id: operation.operation_id,
          action_terminals: [],
          reason_code: null,
        });
      const committedHead = materializeRevisionHead(initial.head, operation);
      appendRevisionEvent(operation, publicationEvents, {
        kind: "head-commit",
        authorized_by_action_operation_id: operation.operation_id,
        effect_action_operation_id: operation.operation_id,
        prior_head_digest: initial.head.content_digest,
        prior_head_checkpoint_digest: initial.head.content_digest,
        committed_head_digest: committedHead.content_digest,
        directory_fsync_completed: true,
      });
      const reservation = materializeRevisionReservation(operation);
      const transition = {
        committed_head: committedHead,
        authority: {
          kind: "child-commit",
          prior_head: initial.head,
          reservation,
          revision_plan: preparation,
          operation,
          operation_events: publicationEvents,
          action_plan: browserPlanned.action_plan,
          proposal: browserPlanned.proposal,
          approval,
          dispatch,
        },
      };
      home.lineage.commitReservation(null, reservation);
      home.revisions.writePreparation(operation, preparation, transition);
      home.revisions.publish(operation.operation_id);
      const publishedInventory = readConversationSourceInventory({ artifactRoot, traceRoot });
      const publishedDerivation = deriveConversationLineages(publishedInventory, {
        publishedRevisionTransitions: home.publishedRevisionTransitions(),
      });
      expect(publishedDerivation.diagnostics).toEqual([]);
      const withChild = publishedDerivation.lineages[0];
      if (!withChild) throw new Error("published child lineage fixture is absent");
      home.lineage.commitHead(
        withChild,
        initial.head,
        committedHead,
        new Map([[committedHead.content_digest, transition.authority]]),
      );

      const childTimeline = await browser.timeline.read("conversation");
      expect(childTimeline.items.map((item) => item.kind)).toEqual([
        "conversation-start",
        "conversation-event",
        "conversation-event",
        "conversation-event",
        "revision-boundary",
        "conversation-start",
        "conversation-event",
      ]);
      expect(childTimeline.items.find((item) => item.kind === "revision-boundary")).toMatchObject({
        kind: "revision-boundary",
        from: parent,
        to: child,
        handoff_id: operation.handoff_id,
        prompt_projection_digest: operation.prompt_projection_digest,
      });

      const childTerminalCorrelation = {
        workflow_id: childManifest.workflow_id,
        conversation_id: childManifest.conversation_id,
        revision_id: childManifest.revision_id,
        run_id: childManifest.run_id,
        turn_id: "turn-child-terminal",
        operation_id: "operation-child-terminal",
        attempt_id: "attempt-child-terminal",
      };
      await traceStore.append(childTerminalCorrelation, {
        idempotency_key: "conversation:active",
        event: {
          type: "state_change",
          payload: { lifecycle: "ACTIVE", health: "healthy", terminal: false, reason: null },
        },
      });
      await traceStore.append(childTerminalCorrelation, {
        idempotency_key: "conversation:transition:COMPLETED",
        event: {
          type: "state_change",
          payload: { lifecycle: "COMPLETED", health: "healthy", terminal: true, reason: null },
        },
      });
      await traceStore.append(childTerminalCorrelation, {
        idempotency_key: "conversation:terminal",
        event: {
          type: "conversation_terminal",
          payload: { lifecycle: "COMPLETED", terminal: true, final_score: null },
        },
      });
      const terminalInventory = readConversationSourceInventory({ artifactRoot, traceRoot });
      expect(terminalInventory.diagnostics).toEqual([]);
      const terminalDerivation = deriveConversationLineages(terminalInventory, {
        publishedRevisionTransitions: home.publishedRevisionTransitions(),
      });
      expect(terminalDerivation.diagnostics).toEqual([]);
      const registeredResolvers: {
        root?: (conversationId: string) => { root_session_id: string };
        proposalBase?: (request: any) => any;
      } = {};
      registerCapabilityConversationProposalBase({
        actions: {
          registerCapabilityActionRootResolver: (
            resolver: NonNullable<typeof registeredResolvers.root>,
          ) => {
            registeredResolvers.root = resolver;
          },
          registerCapabilityProposalBaseResolver: (
            resolver: NonNullable<typeof registeredResolvers.proposalBase>,
          ) => {
            registeredResolvers.proposalBase = resolver;
          },
        } as unknown as ConversationActionService,
        artifactRoot,
        traceRoot,
        home,
      });
      const rootResolver = registeredResolvers.root;
      const proposalBaseResolver = registeredResolvers.proposalBase;
      if (!rootResolver || !proposalBaseResolver)
        throw new Error("capability proposal resolvers were not registered");
      expect(rootResolver(child.conversation_id)).toEqual({ root_session_id: "conversation" });
      const terminalLineage = browser.lineage.resolve(child.conversation_id);
      const capabilityRoot = terminalLineage.lineage.root_session_id;
      const expectedSource = {
        mode: "lineage-recovery" as const,
        root_session_id: capabilityRoot,
        conversation_id: terminalLineage.requested.node.conversation_id,
        revision_id: terminalLineage.requested.node.revision_id,
        last_seq: terminalLineage.requested.source.journal_head.last_seq,
        conversation_lock_digest: conversationLockDigest(
          capabilityRoot,
          terminalLineage.requested.source,
          terminalLineage.revision_claim_epoch,
        ),
        lineage_head_digest: terminalLineage.head.content_digest,
        lineage_head_epoch: terminalLineage.head.head_epoch,
      };
      expect(
        proposalBaseResolver({
          conversation_id: child.conversation_id,
          expected: expectedSource,
        }),
      ).toEqual({
        root_session_id: capabilityRoot,
        conversation_id: child.conversation_id,
        revision_id: child.revision_id,
        last_seq: expectedSource.last_seq,
        conversation_lock_digest: expectedSource.conversation_lock_digest,
        lineage_head_digest: terminalLineage.head.content_digest,
        lineage_head_epoch: terminalLineage.head.head_epoch,
        participant_binding_set_digest: digestV1(
          "VF-CONVERSATION-PARTICIPANT-BINDING-SET\0v1\0",
          terminalLineage.requested.source.manifest.bindings,
        ),
        participants: [{ participant_id: "participant-1", engine: "codex" }],
      });
      expect(() =>
        proposalBaseResolver?.({
          conversation_id: child.conversation_id,
          expected: { ...expectedSource, last_seq: expectedSource.last_seq - 1 },
        }),
      ).toThrow("capability proposal expected conversation source is stale");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
