import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeProposal } from "../../src/actions/index.js";
import type { MaterializedAgentBinding } from "../../src/agents/binding.js";
import { conversationEnvPolicy } from "../../src/dispatch/env-filter.js";
import { createSpawnOptionsProjection } from "../../src/dispatch/session-types.js";
import { digestV1 } from "../../src/durability/index.js";
import {
  ConversationArtifactStore,
  conversationManifestPath,
} from "../../src/orchestrator/conversation/artifact-store.js";
import { CatalogCursorCodec } from "../../src/orchestrator/conversation/catalog-cursor.js";
import { conversationLockDigest } from "../../src/orchestrator/conversation/catalog-lock.js";
import { createCatalogRow } from "../../src/orchestrator/conversation/catalog-row.js";
import { TimelineCursorCodec } from "../../src/orchestrator/conversation/catalog-timeline-cursor.js";
import { compactionSourceAuthorityMatches } from "../../src/orchestrator/conversation/conversation-compaction-source-authority.js";
import {
  assertConversationControlEffectPlan,
  controlEffectId,
  materializeConversationControlEffectPlan,
} from "../../src/orchestrator/conversation/conversation-control-effect-types.js";
import { ConversationHomeAuthorities } from "../../src/orchestrator/conversation/conversation-home-authorities.js";
import { ConversationInteractionStore } from "../../src/orchestrator/conversation/conversation-interaction-store.js";
import type {
  ConversationInteractionProjectionV1,
  PublicMessageLocatorV1,
} from "../../src/orchestrator/conversation/conversation-interaction-types.js";
import { ConversationReceiptCandidateUnavailableError } from "../../src/orchestrator/conversation/conversation-receipt-action-authority.js";
import { conversationRevisionActionPlanDigest } from "../../src/orchestrator/conversation/conversation-revision-action-plan.js";
import { DirectConversationPolicy } from "../../src/orchestrator/conversation/direct-policy.js";
import { MAX_CANONICAL_HANDOFF_BYTES } from "../../src/orchestrator/conversation/handoff-limits.js";
import {
  buildContextHandoff,
  contextHandoffSharedPromptBytes,
} from "../../src/orchestrator/conversation/handoff-selection.js";
import { ContextHandoffStore } from "../../src/orchestrator/conversation/handoff-store.js";
import {
  assertLineageActionPlanBindingV1,
  sameCanonical,
} from "../../src/orchestrator/conversation/lineage-action-authority.js";
import type { PublishedRevisionTransitionInputV1 } from "../../src/orchestrator/conversation/lineage-published-transition.js";
import {
  type RevisionReservationRecordV1,
  deriveRevisionClaimEpoch,
  revisionReservationDigest,
} from "../../src/orchestrator/conversation/lineage-reservation.js";
import { ConversationLineageService } from "../../src/orchestrator/conversation/lineage-service.js";
import { LineageAuthorityStore } from "../../src/orchestrator/conversation/lineage-store.js";
import {
  type LineageHeadRecordV1,
  assertLineageHeadRecordV1,
  assertLineageNodeIdentityV1,
  createInitialLineageHead,
  lineageHeadDigest,
} from "../../src/orchestrator/conversation/lineage-types.js";
import { OperationRegistry } from "../../src/orchestrator/conversation/operation-registry.js";
import { ConversationPolicyRegistry } from "../../src/orchestrator/conversation/policy-registry.js";
import {
  settleConfiguredPrivateFileRange,
  settlePersistFailedPrivateFileRange,
} from "../../src/orchestrator/conversation/private-file-range-commit-authority.js";
import { createPrivateFileRangeHandoffId } from "../../src/orchestrator/conversation/private-file-range-staging-store.js";
import {
  inspectRevisionRecovery,
  revisionAbandonIsProved,
} from "../../src/orchestrator/conversation/revision-control-evidence.js";
import { prepareDeferredRevisionProposal } from "../../src/orchestrator/conversation/revision-deferred-proposal.js";
import { startInitialRevisionLaneBarrier } from "../../src/orchestrator/conversation/revision-initial-lane-runtime.js";
import { publishAcceptedRevisionLaneBarrier } from "../../src/orchestrator/conversation/revision-lane-barrier.js";
import { RevisionLaneEvidenceStore } from "../../src/orchestrator/conversation/revision-lane-evidence-store.js";
import { RevisionLaneRetryRuntime } from "../../src/orchestrator/conversation/revision-lane-retry-runtime.js";
import {
  materializeParticipantStartReceipt,
  participantStartAttemptKey,
} from "../../src/orchestrator/conversation/revision-participant-receipt.js";
import {
  materializeConsumedRevisionReservation,
  materializeRevisionEvent,
  materializeRevisionHead,
  materializeRevisionOperation,
  materializeRevisionPreparationPlan,
  materializeRevisionReservation,
} from "../../src/orchestrator/conversation/revision-planner.js";
import { DeferredRevisionProposalStore } from "../../src/orchestrator/conversation/revision-proposal-store.js";
import { reconcilePublishedRevisionReservation } from "../../src/orchestrator/conversation/revision-reservation-reconciliation.js";
import {
  buildRevisionHandoff,
  defaultConversationActionAuthority,
  resolveRevisionBase,
} from "../../src/orchestrator/conversation/revision-source.js";
import { ConversationRevisionStore } from "../../src/orchestrator/conversation/revision-store.js";
import { ConversationRuntime } from "../../src/orchestrator/conversation/runtime.js";
import { foldConversationJournal } from "../../src/orchestrator/conversation/source-inventory-fold.js";
import type { ValidatedConversationSourceV1 } from "../../src/orchestrator/conversation/source-inventory.js";
import {
  ConversationTimelineService,
  TimelineAuthorityCorruptError,
} from "../../src/orchestrator/conversation/timeline-service.js";
import { publicTurnMessages } from "../../src/orchestrator/conversation/turn-delivery-source.js";
import { prepareConversationTurn } from "../../src/orchestrator/conversation/turn-delivery.js";
import type { ConversationManifest } from "../../src/orchestrator/conversation/types.js";
import { DurableArtifactRegistry } from "../../src/orchestrator/trace/artifacts.js";
import { TraceStore } from "../../src/orchestrator/trace/store.js";
import { handleConversationActionRoute } from "../../src/server/conversation-action-route.js";
import { proposalDraft } from "../actions/fixtures.js";

const NOW = "2026-08-26T00:00:00.000Z";
const LATER = "2026-08-26T01:00:00.000Z";
const sha = (label: string): string =>
  digestV1("VF-CONVERSATION-POSTFREEZE-3-TEST\0v1\0", { label });

function revisionFixture(seed = 1) {
  const parent = {
    conversation_id: "conversation-root",
    revision_id: "revision-root",
    revision_ordinal: 0,
  };
  const child = {
    conversation_id: `conversation-child-${seed}`,
    revision_id: `revision-child-${seed}`,
    revision_ordinal: 1,
  };
  const priorHead = createInitialLineageHead("conversation-root", [
    {
      node: parent,
      manifest_digest: sha(`parent-manifest-${seed}`),
      ancestry_digest: sha(`parent-ancestry-${seed}`),
      updated_at: NOW,
    },
  ]);
  const plan = materializeRevisionPreparationPlan({
    root_session_id: "conversation-root",
    parent,
    expected_head_digest: priorHead.content_digest,
    expected_head_epoch: 0,
    expected_reservation_digest: null,
    expected_reservation_epoch: 0,
    expected_parent_last_seq: 3,
    expected_parent_lock_digest: sha("parent-lock"),
    permission_digest: sha("permission"),
    revision_claim_epoch: 1,
    binding_delta_digest: sha("binding-delta"),
    resulting_binding_set_digest: sha("binding-set"),
    handoff_selection_plan_digest: sha("handoff-selection"),
    participant_starts: [],
    created_at: NOW,
    expires_at: LATER,
  });
  const proposal = {
    proposal_id: `vf-proposal-${seed.toString(16).repeat(64)}`,
    proposal_digest: sha(`proposal-${seed}`),
  };
  const approval = {
    approval_id: `vf-approval-${(seed + 1).toString(16).repeat(64)}`,
    approval_digest: sha(`approval-${seed}`),
  };
  const operation = materializeRevisionOperation({
    operation_id: `vf-operation-${(seed + 2).toString(16).repeat(64)}`,
    proposal_id: proposal.proposal_id,
    proposal_digest: proposal.proposal_digest,
    approval_id: approval.approval_id,
    approval_digest: approval.approval_digest,
    plan_digest: conversationRevisionActionPlanDigest("conversation-root", plan),
    authority_epoch: 0,
    authority_head_digest: sha("authority-head"),
    root_session_id: "conversation-root",
    parent,
    child,
    expected_head_digest: priorHead.content_digest,
    expected_reservation_digest: null,
    expected_reservation_epoch: 0,
    revision_claim_epoch: 1,
    expected_parent_last_seq: 3,
    expected_parent_lock_digest: sha("parent-lock"),
    permission_digest: sha("permission"),
    binding_set_digest: sha("binding-set"),
    handoff_digest: sha("handoff"),
    handoff_selection_digest: sha("handoff-selection"),
    prompt_projection_digest: sha("prompt-projection"),
    created_at: NOW,
  });
  const reservation = materializeRevisionReservation(operation);
  const committedHead = materializeRevisionHead(priorHead, operation);
  const events: ReturnType<typeof materializeRevisionEvent>[] = [];
  for (const [from, to] of [
    ["created", "preparing"],
    ["preparing", "prepared"],
  ] as const)
    events.push(
      materializeRevisionEvent(operation, events, {
        kind: "state-transition",
        from,
        to,
        authorized_by_action_operation_id: operation.operation_id,
        effect_action_operation_id: operation.operation_id,
        action_terminals: [],
        reason_code: null,
      }),
    );
  events.push(
    materializeRevisionEvent(operation, events, {
      kind: "head-commit",
      authorized_by_action_operation_id: operation.operation_id,
      effect_action_operation_id: operation.operation_id,
      prior_head_digest: priorHead.content_digest,
      prior_head_checkpoint_digest: priorHead.content_digest,
      committed_head_digest: committedHead.content_digest,
      directory_fsync_completed: true,
    }),
  );
  const transition: PublishedRevisionTransitionInputV1 = {
    committed_head: committedHead,
    authority: {
      kind: "child-commit",
      prior_head: priorHead,
      reservation,
      revision_plan: plan,
      operation,
      operation_events: events,
      action_plan: { kind: "test-action-plan" },
      proposal,
      approval,
      dispatch: { operation_id: operation.operation_id },
    },
  } as PublishedRevisionTransitionInputV1;
  return {
    parent,
    child,
    priorHead,
    committedHead,
    plan,
    operation,
    reservation,
    events,
    transition,
  };
}

function manifest(conversationId: string, bindings: ConversationManifest["bindings"] = []) {
  return {
    version: "1.0",
    conversation_id: conversationId,
    workflow_id: "workflow",
    revision_id: `revision-${conversationId}`,
    run_id: `run-${conversationId}`,
    parent_conversation_id: null,
    parent_revision_id: null,
    topic: "Post-freeze integration",
    policy: "direct",
    max_rounds: 1,
    baseline_enabled: false,
    evaluator_auto_added: false,
    repo_root: "/repo",
    phase: 3,
    task_text: "close reachable coverage",
    bindings,
    created_at: NOW,
  } satisfies ConversationManifest;
}

function binding(participantId = "participant-1"): MaterializedAgentBinding {
  const roleHash = "a".repeat(64);
  const envPolicy = conversationEnvPolicy("codex");
  const provenance = { roleSource: "builtin" as const, roleHash, skillHashes: [] };
  const traceMetadata = { role_resolved_hash: roleHash, skill_resolved_hashes: [] };
  return {
    resolved: {
      role: {
        source: "builtin",
        resolved_hash: roleHash,
        metadata: {},
        spec: {
          name: participantId,
          description: "Direct",
          body: "Canonical role prompt",
          tools: ["read"],
          model: "gpt-5.4",
          sandbox: "read-only",
        },
      },
      skills: [],
      engine: "codex",
      model: "gpt-5.4",
      sessionMode: "fresh",
      tool_intents: ["read"],
      sandbox: "read-only",
      env_policy: envPolicy,
      isolation: null,
      provenance,
      trace_metadata: traceMetadata,
    },
    spawn: createSpawnOptionsProjection({
      engine: "codex",
      model: "gpt-5.4",
      sessionMode: "fresh",
      rendered_prompt: "Canonical role prompt\n",
      rendered_tools: ["read"],
      sandbox: "read-only",
      env_policy: envPolicy,
      isolation: null,
      provenance,
      trace_metadata: traceMetadata,
    }),
  };
}

function artifactAuthority(participantId: string) {
  return {
    participant_id: participantId,
    engine: "codex" as const,
    model: "gpt-5.4",
    session_mode: "fresh" as const,
    role_source: "builtin" as const,
    role_hash: "a".repeat(64),
    skill_hashes: [],
  };
}

function manifestBinding(participantId: string) {
  return {
    participant_id: participantId,
    input: { roleRef: "direct", engine: "codex" as const, sessionMode: "fresh" as const },
  };
}

const locator = (eventId: string): PublicMessageLocatorV1 => ({
  root_session_id: "root-session",
  conversation_id: "conversation",
  revision_id: "revision-conversation",
  target_event_id: eventId,
  target_kind: "user-message",
  content_digest: sha(`message-${eventId}`),
});

function source(
  id: string,
  options: { parentId?: string | null; parentRevision?: string | null; children?: string[] } = {},
): ValidatedConversationSourceV1 {
  const record = {
    manifest: {
      ...manifest(id),
      parent_conversation_id: options.parentId ?? null,
      parent_revision_id: options.parentRevision ?? null,
    },
    binding_authorities: [],
    resume_bindings: [],
    child_revisions: Object.fromEntries(
      (options.children ?? []).map((child, index) => [
        createHash("sha256").update(`${id}:${index}`).digest("hex"),
        child,
      ]),
    ),
    artifacts: [],
    artifact_reservations: {},
  };
  const digest = sha(`source-${id}`);
  return {
    manifest: record.manifest,
    manifest_record: record,
    manifest_digest: digest,
    journal_head: {
      schema_version: "1.0",
      record_id: id,
      record_digest: digest,
      last_seq: 0,
      updated_at: NOW,
      lifecycle: "INIT",
      health: "healthy",
      participants: [],
    },
    journal_records: [],
  } as ValidatedConversationSourceV1;
}

describe("post-freeze durable authority enumeration", () => {
  test("enumerates prepared transitions and retains unrelated resume bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-postfreeze-3-durable-"));
    try {
      const revisions = new ConversationRevisionStore({ artifactRoot: root });
      const first = revisionFixture(1);
      const second = revisionFixture(4);
      revisions.writePreparation(first.operation, first.plan, first.transition);
      revisions.writePreparation(second.operation, second.plan, second.transition);
      expect(
        revisions
          .preparedTransitions()
          .map(
            (row) =>
              (row.authority as { operation: { operation_id: string } }).operation.operation_id,
          ),
      ).toEqual([first.operation.operation_id, second.operation.operation_id].sort());

      const artifacts = new ConversationArtifactStore({ dir: root });
      artifacts.create(
        manifest("resume-child", [
          manifestBinding("participant-old"),
          manifestBinding("participant-new"),
        ]),
        [artifactAuthority("participant-old"), artifactAuthority("participant-new")],
      );
      artifacts.recordResumeBinding("resume-child", "participant-old", {
        attemptId: "attempt-old",
        engine: "codex",
        nativeSessionId: "00000000-0000-4000-8000-000000000001",
      });
      artifacts.recordResumeBindings("resume-child", [
        {
          participant_id: "participant-new",
          attemptId: "attempt-new",
          engine: "codex",
          nativeSessionId: "00000000-0000-4000-8000-000000000002",
        },
      ]);
      expect(artifacts.readRecord("resume-child")?.resume_bindings).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("post-freeze sorting and validation authorities", () => {
  test("sorts complete control plans and rejects duplicate cleanup authority", () => {
    const target = `vf-operation-${"a".repeat(64)}`;
    const effect = (participantId: string) => {
      const input = {
        target_operation_id: target,
        participant_id: participantId,
        adapter_fingerprint: `adapter-${participantId}`,
        effect_kind: "reconcile" as const,
        mode: "provider-idempotency" as const,
      };
      return {
        effect_id: controlEffectId(input),
        participant_id: participantId,
        adapter_fingerprint: input.adapter_fingerprint,
        effect_kind: input.effect_kind,
        mode: input.mode,
        native_reference_digest: sha(`native-${participantId}`),
        expected_control_postcondition_digest: sha(`postcondition-${participantId}`),
      };
    };
    const cleanup = [sha("cleanup-z"), sha("cleanup-a")];
    const plan = materializeConversationControlEffectPlan({
      target_operation_id: target,
      effects: [effect("zeta"), effect("alpha")],
      cleanup_artifact_digests: cleanup,
    });
    expect(plan.effects.map(({ effect_id }) => effect_id)).toEqual(
      plan.effects.map(({ effect_id }) => effect_id).sort(),
    );
    expect(plan.cleanup_artifact_digests).toEqual([...cleanup].sort());
    expect(() =>
      assertConversationControlEffectPlan({
        ...plan,
        cleanup_artifact_digests: [cleanup[0], cleanup[0]],
      }),
    ).toThrow("invalid conversation control cleanup artifacts");
  });

  test("executes canonical failure and target ordering validation", () => {
    expect(sameCanonical(1n, 1n)).toBeFalse();
    const proposal = materializeProposal(proposalDraft());
    const nativeDigest = sha("native-plan");
    const plan = {
      schema_version: "1.0" as const,
      domain: "conversation" as const,
      action_root_locator: proposal.action_root_locator,
      planning_options: proposal.planning_options,
      execution_object_closure_digest: null,
      permission_digest: proposal.permission_digest,
      steps: [
        {
          order: 0,
          step_id: "step-1",
          plan_kind: "lineage-association" as const,
          plan_digest: nativeDigest,
          target_ids: ["duplicate", "duplicate"],
          effect_classes: proposal.effect_classes,
          reversibility: proposal.reversibility,
        },
      ],
    };
    expect(() =>
      assertLineageActionPlanBindingV1(plan, nativeDigest, "lineage-association", proposal),
    ).toThrow("invalid lineage action plan");
  });

  test("rejects validly digested illegal reservation edges", () => {
    const first = revisionFixture().reservation;
    const activeBody = {
      schema_version: "1.0" as const,
      root_session_id: first.root_session_id,
      reservation_epoch: 2,
      previous_reservation_digest: first.content_digest,
      status: "active" as const,
      parent: first.parent,
      revision_claim_epoch: 2,
      operation_id: `vf-operation-${"b".repeat(64)}`,
      proposal_id: `vf-proposal-${"c".repeat(64)}`,
      plan_digest: sha("next-plan"),
      child: {
        conversation_id: "conversation-child-next",
        revision_id: "revision-child-next",
        revision_ordinal: 1,
      },
      created_at: NOW,
      updated_at: NOW,
    };
    const active = { ...activeBody, content_digest: revisionReservationDigest(activeBody) };
    expect(() =>
      deriveRevisionClaimEpoch(
        active,
        {} as never,
        {} as never,
        new Map([[first.content_digest, first]]),
      ),
    ).toThrow("invalid active revision reservation edge");

    const terminalBody = {
      ...activeBody,
      status: "released" as const,
      revision_claim_epoch: first.revision_claim_epoch,
      operation_id: `vf-operation-${"d".repeat(64)}`,
      proposal_id: first.proposal_id,
      plan_digest: first.plan_digest,
      child: first.child,
      created_at: first.created_at,
      updated_at: LATER,
    };
    const terminal = {
      ...terminalBody,
      content_digest: revisionReservationDigest(terminalBody),
    };
    expect(() =>
      deriveRevisionClaimEpoch(
        terminal,
        {} as never,
        {} as never,
        new Map([[first.content_digest, first]]),
      ),
    ).toThrow("invalid terminal revision reservation edge");
  });

  test("rejects invalid node, candidate order, and head state", () => {
    expect(() =>
      assertLineageNodeIdentityV1({
        conversation_id: "bad/id",
        revision_id: "revision",
        revision_ordinal: 0,
      }),
    ).toThrow("invalid lineage node identity");
    const a = { conversation_id: "a", revision_id: "revision-a", revision_ordinal: 0 };
    const b = { conversation_id: "b", revision_id: "revision-b", revision_ordinal: 0 };
    const unorderedBody = {
      schema_version: "1.0" as const,
      root_session_id: "root",
      head_status: "ambiguous" as const,
      active: null,
      candidate_heads: [b, a],
      head_epoch: 0,
      previous_head_digest: null,
      updated_by_operation_id: null,
      updated_at: NOW,
    };
    expect(() =>
      assertLineageHeadRecordV1({
        ...unorderedBody,
        content_digest: lineageHeadDigest(unorderedBody),
      }),
    ).toThrow("invalid lineage head candidate order");
    const invalidStateBody = {
      ...unorderedBody,
      head_status: "committed" as const,
      candidate_heads: [],
    };
    expect(() =>
      assertLineageHeadRecordV1({
        ...invalidStateBody,
        content_digest: lineageHeadDigest(invalidStateBody),
      }),
    ).toThrow("invalid lineage head state");
  });
});

describe("post-freeze lineage browsing authorities", () => {
  test("uses non-root cursor matching and sorts association identifiers", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-postfreeze-3-lineage-"));
    try {
      const inventory = {
        schema_version: "1.0" as const,
        state: "ready" as const,
        authoritative: true,
        sources: [
          source("root", { children: ["child"] }),
          source("child", {
            parentId: "root",
            parentRevision: "revision-root",
            children: ["grandchild"],
          }),
          source("grandchild", {
            parentId: "child",
            parentRevision: "revision-child",
          }),
        ],
        diagnostics: [],
        observed_source_digest: sha("inventory"),
      };
      const codec = new CatalogCursorCodec(Buffer.alloc(32, 7));
      const service = new ConversationLineageService({
        artifactRoot: root,
        traceRoot: join(root, "traces"),
        scopeId: "project:test",
        cursorCodec: codec,
        readInventory: () => inventory,
      });
      const first = service.read("root", { limit: 1 });
      const second = service.read("root", { limit: 1, cursor: first.next_cursor ?? undefined });
      const third = service.read("root", { limit: 1, cursor: second.next_cursor ?? undefined });
      expect(third.nodes.map(({ conversation_id }) => conversation_id)).toEqual(["grandchild"]);

      const resolved = service.resolve("root");
      const associations = [
        `vf-lineage-association-${"f".repeat(64)}`,
        `vf-lineage-association-${"1".repeat(64)}`,
      ];
      const row = createCatalogRow(
        resolved.lineage,
        resolved.head,
        "",
        codec,
        "project:test",
        new Map([["root", associations]]),
        resolved.revision_claim_epoch,
      );
      expect(row.association_ids).toEqual([...associations].sort());

      const ordinary = {
        artifact_id: "artifact-ordinary",
        artifact_type: "tests",
        ref: "artifact-ordinary-ref",
        content_hash: "a".repeat(64),
        previous_ref: null,
        idempotency_key: "ordinary-artifact",
      };
      const requested = structuredClone(resolved.requested);
      requested.source.manifest_record.artifacts = [ordinary];
      const record = requested.source.manifest_record;
      requested.source.manifest_digest = digestV1("VF-CONVERSATION-MANIFEST-RECORD\0v1\0", record);
      const withArtifact = { ...resolved, requested };
      const candidate = {
        schema_version: "1.0" as const,
        candidate_id: `vf-handoff-candidate-${"2".repeat(64)}`,
        source: {
          conversation_id: requested.node.conversation_id,
          revision_id: requested.node.revision_id,
          last_seq: requested.source.journal_head.last_seq,
          lock_digest: conversationLockDigest(
            resolved.lineage.root_session_id,
            requested.source,
            resolved.revision_claim_epoch,
          ),
        },
        source_public_head_digest: sha("public-head"),
        selection_plan_digest: sha("selection"),
        mandatory_projection_digest: sha("mandatory"),
        prompt_budget_bytes: 1024,
        encoded_candidate_bytes: 1025,
        overflow_bytes: 1,
        private_candidate_ref: "private-ref",
        created_at: NOW,
        expires_at: LATER,
        candidate_digest: sha("candidate"),
      };
      expect(
        compactionSourceAuthorityMatches({
          proposalId: `vf-proposal-${"3".repeat(64)}`,
          candidate,
          construction: {
            omitted: [],
            artifact_id: "planned-compaction",
            artifact_bytes: Buffer.from("compaction"),
          } as never,
          resolved: withArtifact,
        }),
      ).toBeTrue();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("post-freeze message and interaction projections", () => {
  test("replays a non-empty participant social intent exactly", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-postfreeze-3-interactions-"));
    try {
      const store = new ConversationInteractionStore(root);
      const input = {
        root_session_id: "root-session",
        actor_participant_id: "participant-1",
        response: { ...locator("response-1"), target_kind: "completed-agent-response" as const },
        quote_refs: [],
        reactions: [
          { operation: "add" as const, target: locator("target-1"), emoji: "👍" as const },
        ],
        diagnostic_code: null,
        created_at: NOW,
      };
      const first = store.commitParticipantIntent(input);
      expect(store.commitParticipantIntent(input)).toEqual(first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects invalid public targets and selects positive full-history reactions", () => {
    const invalidEvent = {
      event_id: "event-invalid-target",
      seq: 1,
      event: {
        type: "user_message",
        payload: { content: "hello", target_participants: "participant-1" },
      },
    };
    expect(() => publicTurnMessages([invalidEvent as never], "participant-1", 0)).toThrow(
      "public turn message targets are invalid",
    );
    const projection: ConversationInteractionProjectionV1 = {
      schema_version: "1.0",
      state: "ready",
      root_session_id: "root-session",
      interaction_head_digest: sha("interaction-head"),
      interaction_head_sequence: 1,
      interaction_head_digests_by_sequence: { "1": sha("interaction-head") },
      reaction_changes: [
        {
          target: locator("target-1"),
          emoji: "👍",
          count: 1,
          reacted_by_recipient: false,
          actor_public_ids: ["peer"],
          last_changed_interaction_sequence: 1,
        },
      ],
      message_locators_by_event_id: {},
      quote_projections_by_response_event_id: {},
      reaction_projections: [],
      diagnostics_by_response_event_id: {},
    };
    const turn = prepareConversationTurn({
      conversation_id: "conversation",
      revision_id: "revision-conversation",
      recipient_engine: "codex",
      request: {
        participant_id: "participant-1",
        instruction: { kind: "continue" },
      } as never,
      events: [],
      resume: undefined,
      prior_delivery: undefined,
      observed_after_public_seq: 0,
      shared_handoff: null,
      interaction_projection: projection,
    });
    expect(turn.envelope.peer_reactions).toHaveLength(1);
  });

  test("retains only compaction-selected artifacts in a real handoff", () => {
    const source = {
      conversation_id: "conversation",
      revision_id: "revision-conversation",
      last_seq: 1,
      lock_digest: sha("handoff-lock"),
    };
    const artifact = {
      artifact_id: "artifact-retained",
      artifact_kind: "conversation-artifact" as const,
      media_type: "text/plain",
      byte_length: 4,
      content_sha256: "a".repeat(64),
      resolver: "conversation-artifact-v1" as const,
    };
    const message = {
      event_id: "event-1",
      conversation_id: source.conversation_id,
      revision_id: source.revision_id,
      revision_ordinal: 0,
      public_seq: 1,
      author_public_id: "human",
      text: "hello",
      created_at: NOW,
      redaction_manifest_digest: sha("redaction"),
    };
    const compactionBody = {
      schema_version: "1.0" as const,
      profile: "vf-public-compaction/1" as const,
      source,
      source_public_head_digest: sha("compaction-public-head"),
      oversized_candidate_digest: sha("oversized"),
      selection_plan_digest: sha("compaction-selection"),
      previous_compaction_digest: null,
      compaction_input_digest: sha("compaction-input"),
      public_summary: "summary",
      retained_event_ids: [message.event_id],
      retained_artifact_ids: [artifact.artifact_id],
      omitted_public_ranges: [],
      created_at: NOW,
    };
    const result = buildContextHandoff({
      source,
      topic: "topic",
      policy_value: "direct",
      bindings: [],
      user_messages: [message],
      final_responses: [],
      artifacts: [artifact],
      consensus: { score: null, synthesis: null },
      prompt_budget_bytes: 32 * 1024,
      active_compaction: {
        ...compactionBody,
        content_digest: digestV1("VF-PUBLIC-COMPACTION-ARTIFACT\0v1\0", compactionBody),
      },
    });
    expect(result.handoff.artifacts).toEqual([artifact]);
  });
});

describe("post-freeze recovery evidence", () => {
  test("distinguishes unknown and incomplete child evidence and checks other publications", () => {
    const fixture = revisionFixture();
    const needsRecovery = [...fixture.events];
    needsRecovery.push(
      materializeRevisionEvent(fixture.operation, needsRecovery, {
        kind: "state-transition",
        from: "published",
        to: "needs_recovery",
        authorized_by_action_operation_id: fixture.operation.operation_id,
        effect_action_operation_id: fixture.operation.operation_id,
        action_terminals: [
          {
            action_operation_id: fixture.operation.operation_id,
            outcome: "needs_recovery",
            reason_code: "uncertain_start",
          },
        ],
        reason_code: "uncertain_start",
      }),
    );
    const other = revisionFixture(4);
    const unknown = inspectRevisionRecovery({
      home: {
        publishedRevisionTransitions: () => [],
        revisions: { readPlan: () => fixture.plan },
      } as never,
      lineages: { resolve: () => ({ head: other.committedHead }) } as never,
      operation: fixture.operation,
      events: needsRecovery,
      quiescent: false,
    });
    expect(unknown).toEqual({
      kind: "inconclusive",
      reason_code: "revision-head-is-not-proved",
    });
    const childHome = {
      publishedRevisionTransitions: () => [fixture.transition],
      revisions: { readPlan: () => fixture.plan },
    };
    expect(
      inspectRevisionRecovery({
        home: childHome as never,
        lineages: { resolve: () => ({ head: fixture.committedHead }) } as never,
        operation: fixture.operation,
        events: needsRecovery,
        quiescent: false,
      }),
    ).toEqual({ kind: "inconclusive", reason_code: "participant-evidence-is-incomplete" });

    const preparing = [fixture.events[0]].filter(Boolean) as typeof fixture.events;
    expect(
      revisionAbandonIsProved({
        home: {
          publishedRevisionTransitions: () => [other.transition],
          revisions: { readPlan: () => fixture.plan },
        } as never,
        lineages: { resolve: () => ({ head: fixture.priorHead }) } as never,
        operation: fixture.operation,
        events: preparing,
        quiescent: true,
      }),
    ).toBeTrue();
  });

  test("rethrows a lost reservation CAS when no exact consumed closure exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-postfreeze-3-reservation-race-"));
    try {
      const fixture = revisionFixture();
      const store = new LineageAuthorityStore({ artifactRoot: root });
      store.commitReservation(null, fixture.reservation);
      const raced = new Proxy(store, {
        get(target, property, receiver) {
          if (property !== "commitReservation") return Reflect.get(target, property, receiver);
          return (current: RevisionReservationRecordV1, _next: RevisionReservationRecordV1) => {
            const { content_digest: _digest, ...currentBody } = current;
            const releasedBody = {
              ...currentBody,
              reservation_epoch: current.reservation_epoch + 1,
              previous_reservation_digest: current.content_digest,
              status: "released" as const,
              updated_at: LATER,
            };
            const released = {
              ...releasedBody,
              content_digest: revisionReservationDigest(releasedBody),
            };
            target.commitReservation(current, released);
            throw new Error("lost reservation CAS");
          };
        },
      });
      expect(() =>
        reconcilePublishedRevisionReservation({
          lineage: raced,
          reservation: fixture.reservation,
          consumedAt: NOW,
        }),
      ).toThrow("lost reservation CAS");
      expect(store.readReservation("conversation-root")?.status).toBe("released");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("post-freeze private and HTTP authorities", () => {
  test("releases a proven-absent configured range and contains a corrupt manifest read", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-postfreeze-3-private-range-"));
    try {
      const artifactRoot = join(root, "artifacts");
      const home = new ConversationHomeAuthorities({ artifactRoot, now: () => NOW });
      const binding = home.privateFileRanges.stage({
        handoff_id: createPrivateFileRangeHandoffId(),
        repo_relative_path: "src/example.ts",
        start_line: 1,
        end_line: 1,
        content: "export {};",
        staged_at: NOW,
      });
      home.privateFileRanges.reserve(binding, "reservation-1", NOW);
      const registry = new DurableArtifactRegistry({ dir: join(root, "opaque") });
      const traceStore = new TraceStore({
        dir: join(root, "traces"),
        artifactRegistry: registry,
        now: () => NOW,
      });
      await settleConfiguredPrivateFileRange(
        traceStore,
        home,
        binding,
        "conversation-absent",
        "reservation-1",
        LATER,
      );
      expect(home.privateFileRanges.readFrames(binding.handoff_id).at(-1)?.state).toBe("available");

      const artifacts = new ConversationArtifactStore({ dir: artifactRoot });
      writeFileSync(conversationManifestPath(artifactRoot, "corrupt"), "not-json", { mode: 0o600 });
      expect(() =>
        settlePersistFailedPrivateFileRange(
          artifacts,
          home,
          binding,
          "corrupt",
          "reservation-1",
          LATER,
          manifest("corrupt"),
          [],
        ),
      ).not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("returns 202 for a genuinely non-terminal action commit", async () => {
    const proposalId = `vf-proposal-${"e".repeat(64)}`;
    const url = new URL(`http://local/action-proposals/${proposalId}/commit`);
    const response = await handleConversationActionRoute(
      {
        sessions: { authorize: () => true },
        csrf: () => true,
        rootSessionId: () => "root",
        principal: () => ({}) as never,
        actions: {
          commit: async () => ({
            schema_version: "1.0",
            operation: { operation_id: `vf-operation-${"f".repeat(64)}`, state: "committing" },
          }),
        } as never,
      },
      new Request(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schema_version: "1.0",
          proposal_digest: sha("route-proposal"),
          approval_id: `vf-approval-${"1".repeat(64)}`,
        }),
      }),
      url,
      "conversation",
      ["action-proposals", proposalId, "commit"],
    );
    expect(response?.status).toBe(202);
  });
});

describe("post-freeze timeline and journal projections", () => {
  test("routes corrupt anchored actions through the timeline authority callback", async () => {
    expect(new TimelineAuthorityCorruptError("corrupt").name).toBe("TimelineAuthorityCorruptError");
    const node = source("root");
    const identity = { conversation_id: "root", revision_id: "revision-root", revision_ordinal: 0 };
    const head = createInitialLineageHead("root", [
      {
        node: identity,
        manifest_digest: node.manifest_digest,
        ancestry_digest: sha("ancestry"),
        updated_at: NOW,
      },
    ]);
    const resolved = {
      inventory: {},
      derivation: {},
      lineage: { root_session_id: "root", nodes: [{ node: identity, source: node }] },
      requested: { node: identity, source: node },
      head,
      revision_claim_epoch: 0,
      selected_nodes: [{ node: identity, source: node }],
    };
    const service = new ConversationTimelineService({
      scopeId: "project:test",
      cursorCodec: new TimelineCursorCodec(Buffer.alloc(32, 9)),
      lineage: { resolve: () => resolved } as never,
      artifactRegistry: { register: () => "artifact", resolve: () => null } as never,
      actionOperations: () => ({}) as never,
    });
    await expect(service.read("root")).rejects.toThrow(TimelineAuthorityCorruptError);
  });

  test("projects capability-only journal tails before folding", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-postfreeze-3-fold-"));
    try {
      const registry = new DurableArtifactRegistry({ dir: join(root, "opaque") });
      const traces = new TraceStore({
        dir: join(root, "traces"),
        artifactRegistry: registry,
        now: () => NOW,
      });
      const correlation = {
        workflow_id: "workflow",
        conversation_id: "conversation",
        revision_id: "revision-conversation",
        run_id: "run-conversation",
        turn_id: "turn-1",
        operation_id: "operation-1",
        attempt_id: "attempt-1",
      };
      await traces.append(correlation, {
        idempotency_key: "configured",
        event: {
          type: "conversation_configured",
          payload: {
            topic: "topic",
            participants: [
              {
                participant_id: "participant-1",
                role_ref: "direct",
                engine: "codex",
                model: "gpt-5.4",
              },
            ],
            policy: "direct",
            max_rounds: 1,
          },
        },
      });
      await traces.append(correlation, {
        idempotency_key: "capability-projection",
        event: {
          type: "user_message",
          payload: { content: "projection placeholder", target_participants: "all" },
        },
      });
      const records = await traces.readConversation("conversation");
      const tail = records[1];
      if (!tail) throw new Error("projection fixture is absent");
      tail.stored_event.event = {
        type: "capability_action_projection",
        payload: { state: "queued" },
      } as never;
      expect(foldConversationJournal(records, "/absent", [])).toEqual({
        lifecycle: "INIT",
        health: "healthy",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("post-freeze lane resume projection", () => {
  test("accepts a process-lease lane without inventing a provider resume binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-postfreeze-3-lane-resume-"));
    try {
      const fixture = revisionFixture();
      const evidence = new RevisionLaneEvidenceStore(root);
      const participant = {
        participant_id: "participant-1",
        engine: "codex" as const,
        model: "gpt-5.4",
        adapter_fingerprint: "adapter-1",
        reconciliation_mode: "vf-process-lease" as const,
        cancellation_mode: "vf-process-lease" as const,
        wrapper_descriptor_digest: sha("wrapper"),
        max_shared_prompt_bytes: 1024,
      };
      const identity = {
        operation_id: fixture.operation.operation_id,
        participant_id: participant.participant_id,
        start_generation: 0,
      };
      const attemptKey = `vf-start-${digestV1("VF-PARTICIPANT-START-ATTEMPT\0v1\0", {
        schema_version: "1.0",
        ...identity,
      }).slice(7)}`;
      const stored = evidence.write({
        root_session_id: fixture.operation.root_session_id,
        operation_id: fixture.operation.operation_id,
        participant_id: participant.participant_id,
        start_generation: 0,
        attempt_key: attemptKey,
        native_session_id: null,
        adapter_evidence_ref: "process-lease-ref",
        reconciliation_mode: "vf-process-lease",
        adapter_reference_utf8: "process-lease-ref",
        absence_proved: false,
        recorded_at: NOW,
      });
      if (!stored.ref || !stored.digest) throw new Error("lane evidence fixture was not persisted");
      const receipt = {
        schema_version: "1.0" as const,
        ...identity,
        attempt_key: attemptKey,
        state: "accepted" as const,
        engine: participant.engine,
        model: participant.model,
        adapter_fingerprint: participant.adapter_fingerprint,
        reconciliation_mode: participant.reconciliation_mode,
        cancel_attempt_key: null,
        cancellation_mode: null,
        shared_prompt_digest: fixture.operation.prompt_projection_digest,
        wrapper_digest: participant.wrapper_descriptor_digest,
        private_native_session_ref: null,
        private_native_session_producer_receipt_digest: null,
        private_process_lease_ref: stored.ref,
        private_process_lease_producer_receipt_digest: stored.digest,
        prepared_at: NOW,
        observed_at: NOW,
        receipt_digest: sha("receipt-placeholder"),
      };
      const artifacts = new ConversationArtifactStore({ dir: root });
      artifacts.create(
        manifest(fixture.child.conversation_id, [manifestBinding(participant.participant_id)]),
        [artifactAuthority(participant.participant_id)],
      );
      const live = {
        resumeCounter: { value: 0 },
        resumeBindings: new Map(),
        resumeOrdinals: new Map(),
        turnDeliveries: new Map(),
        turnObservations: new Map(),
      };
      expect(
        publishAcceptedRevisionLaneBarrier({
          operation: fixture.operation,
          plan: { ...fixture.plan, participant_starts: [participant] },
          lanes: new Map([[participant.participant_id, receipt as never]]),
          evidence,
          artifacts,
          live: live as never,
        }),
      ).toBeTrue();
      expect(artifacts.readRecord(fixture.child.conversation_id)?.resume_bindings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("post-freeze public runtime surfaces", () => {
  test("persists a durable rejected candidate when a revision handoff is oversized", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-postfreeze-3-overflow-"));
    try {
      const artifactRoot = join(root, "artifacts");
      const traceRoot = join(root, "traces");
      const artifactRegistry = new DurableArtifactRegistry({ dir: join(root, "opaque") });
      const traceStore = new TraceStore({
        dir: traceRoot,
        artifactRegistry,
        now: () => NOW,
      });
      const artifactStore = new ConversationArtifactStore({ dir: artifactRoot });
      const home = new ConversationHomeAuthorities({ artifactRoot, now: () => NOW });
      const writeTerminal = async (conversationId: string, topic: string) => {
        const rootManifest = {
          ...manifest(conversationId, [manifestBinding("participant-1")]),
          topic,
        };
        artifactStore.create(rootManifest, [artifactAuthority("participant-1")]);
        const correlation = {
          workflow_id: rootManifest.workflow_id,
          conversation_id: conversationId,
          revision_id: rootManifest.revision_id,
          run_id: rootManifest.run_id,
          turn_id: "turn-overflow",
          operation_id: "operation-overflow",
          attempt_id: "attempt-overflow",
        };
        await traceStore.append(correlation, {
          idempotency_key: "configured",
          event: {
            type: "conversation_configured",
            payload: {
              topic,
              participants: [
                {
                  participant_id: "participant-1",
                  role_ref: "direct",
                  engine: "codex",
                  model: "gpt-5.4",
                },
              ],
              policy: "direct",
              max_rounds: 1,
            },
          },
        });
        await traceStore.append(correlation, {
          idempotency_key: "active",
          event: {
            type: "state_change",
            payload: { lifecycle: "ACTIVE", health: "healthy", terminal: false, reason: null },
          },
        });
        for (let index = 0; index < 17; index += 1) {
          await traceStore.append(correlation, {
            idempotency_key: `oversized-message-${index}`,
            event: {
              type: "user_message",
              payload: {
                content: `${index}:${"x".repeat(61_000)}`,
                target_participants: "all",
              },
            },
          });
        }
        await traceStore.append(correlation, {
          idempotency_key: "conversation:transition:COMPLETED",
          event: {
            type: "state_change",
            payload: { lifecycle: "COMPLETED", health: "healthy", terminal: true, reason: null },
          },
        });
        await traceStore.append(correlation, {
          idempotency_key: "conversation:terminal",
          event: {
            type: "conversation_terminal",
            payload: { lifecycle: "COMPLETED", terminal: true, final_score: null },
          },
        });
        return {
          rootManifest,
          base: resolveRevisionBase({ artifactRoot, traceRoot, conversationId, home }),
        };
      };
      const calibration = await writeTerminal("conversation-source-a", "");
      const calibrated = buildRevisionHandoff({
        base: calibration.base,
        bindings: [
          {
            participant_id: "participant-1",
            engine: "codex",
            model: "gpt-5.4",
            role_ref: "direct",
            continuity: "retained",
          },
        ],
        snapshot: { consensus_score: null } as never,
      });
      const calibratedBytes = contextHandoffSharedPromptBytes(
        calibrated.handoff.prompt_projection,
      ).byteLength;
      const topicPadding = MAX_CANONICAL_HANDOFF_BYTES - calibratedBytes + 1;
      expect(topicPadding).toBeGreaterThan(0);
      expect(topicPadding).toBeLessThan(65_536);
      const conversationId = "conversation-source-b";
      const { rootManifest, base } = await writeTerminal(conversationId, "t".repeat(topicPadding));
      const authority = defaultConversationActionAuthority(base.lineage.root_session_id);
      const request = {
        schema_version: "1.0" as const,
        idempotency_key: "oversized-deferred-revision",
        anchor_event_id: null,
        expected: {
          mode: "writable-revision" as const,
          conversation_id: conversationId,
          revision_id: rootManifest.revision_id,
          last_seq: base.parent.source.journal_head.last_seq,
          conversation_lock_digest: base.lock.lock_digest,
        },
        candidate: {
          type: "conversation.update_settings" as const,
          changes: { max_rounds: 2 },
        },
      };
      let thrown: unknown;
      try {
        await prepareDeferredRevisionProposal({
          options: {
            artifactRoot,
            traceRoot,
            artifactStore,
            home,
            runtime: { operationId: () => null },
            now: () => NOW,
            rehydrateBinding: async () => binding(),
          } as never,
          proposals: new DeferredRevisionProposalStore(artifactRoot),
          conversationId,
          snapshot: { consensus_score: null } as never,
          request,
          authority,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).name).toBe("ConversationHandoffTooLargeError");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("terminates a live peer when an initial revision lane rejects", async () => {
    const participantIds = ["participant-1", "participant-2"];
    const materialized = participantIds.map((participantId) => binding(participantId));
    const terminated: string[] = [];
    const unknown: string[] = [];
    let settleSecond!: (value: unknown) => void;
    const secondCompletion = new Promise((resolve) => {
      settleSecond = resolve;
    });
    const adapter = {
      start: ({ attemptId }: { attemptId: string }) => ({
        attemptId,
        completion:
          attemptId === "attempt-participant-1"
            ? Promise.reject(new Error("participant start rejected"))
            : secondCompletion,
        terminate: async () => {
          terminated.push(attemptId);
          if (attemptId === "attempt-participant-2")
            settleSecond({
              attemptId,
              engine: "codex",
              ok: false,
              state: "ambiguous",
              lifecycle: ["requested", "ambiguous"],
              output: "",
              evidenceStatus: "persisted",
              nativeSessionStatus: "unavailable",
            });
        },
        readResumeBinding: () => undefined,
        readEvidenceBinding: () => undefined,
      }),
      reconcileHistory: async () => ({ engine: "codex", status: "missing" }),
    };
    const authority = {
      prepare: ({ participant_id }: { participant_id: string }) => ({
        attempt_key: `attempt-${participant_id}`,
        participant_id,
      }),
      attach: () => undefined,
      observe: () => undefined,
      effectUnknown: (token: { participant_id: string }) => unknown.push(token.participant_id),
      allAccepted: () => false,
      isQuiescent: () => true,
    };
    const registry = new OperationRegistry();
    const operation = registry.create("conversation-initial-lanes", "operation-initial-lanes");
    const plan = {
      ...revisionFixture(8).plan,
      participant_starts: participantIds.map((participantId) => ({
        participant_id: participantId,
        engine: "codex" as const,
        model: "gpt-5.4",
        adapter_fingerprint: `adapter-${participantId}`,
        reconciliation_mode: "vf-process-lease" as const,
        cancellation_mode: "vf-process-lease" as const,
        wrapper_descriptor_digest: sha(`wrapper-${participantId}`),
        max_shared_prompt_bytes: 1024,
      })),
    };
    const artifactStore = new ConversationArtifactStore({ dir: "/tmp/unused-initial-lanes" });
    const accepted = await startInitialRevisionLaneBarrier({
      options: {
        sessionAdapter: adapter,
        artifactStore,
      } as never,
      authority: authority as never,
      live: {
        manifest: manifest(
          "conversation-initial-lanes",
          participantIds.map((participantId) => manifestBinding(participantId)),
        ),
        bindings: materialized,
        sharedHandoff: "shared revision handoff",
      } as never,
      operation,
      plan,
    });
    expect(accepted).toBeFalse();
    expect(unknown).toEqual(["participant-1"]);
    expect(terminated).toContain("attempt-participant-2");
  });

  test("terminates a live peer when a durable revision retry is uncertain", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-postfreeze-3-retry-"));
    try {
      const artifactRoot = join(root, "artifacts");
      const artifacts = new ConversationArtifactStore({ dir: artifactRoot });
      const handoffs = new ContextHandoffStore({ artifactRoot });
      const fixture = revisionFixture(9);
      const participantIds = ["participant-1", "participant-2"];
      const participants = participantIds.map((participantId) => ({
        participant_id: participantId,
        engine: "codex" as const,
        model: "gpt-5.4",
        adapter_fingerprint: `adapter-${participantId}`,
        reconciliation_mode: "vf-process-lease" as const,
        cancellation_mode: "vf-process-lease" as const,
        wrapper_descriptor_digest: sha(`retry-wrapper-${participantId}`),
        max_shared_prompt_bytes: MAX_CANONICAL_HANDOFF_BYTES,
      }));
      const built = buildContextHandoff({
        source: {
          conversation_id: fixture.parent.conversation_id,
          revision_id: fixture.parent.revision_id,
          last_seq: 3,
          lock_digest: sha("retry-parent-lock"),
        },
        topic: "retry barrier",
        policy_value: "direct",
        bindings: participants.map((participant) => ({
          participant_id: participant.participant_id,
          engine: participant.engine,
          model: participant.model,
          role_ref: "direct",
          continuity: "retained" as const,
        })),
        user_messages: [],
        final_responses: [],
        artifacts: [],
        consensus: { score: null, synthesis: null },
        prompt_budget_bytes: MAX_CANONICAL_HANDOFF_BYTES,
      });
      handoffs.write(built.handoff, built.selection_plan);
      const plan = materializeRevisionPreparationPlan({
        root_session_id: fixture.plan.root_session_id,
        parent: fixture.plan.parent,
        expected_head_digest: fixture.plan.expected_head_digest,
        expected_head_epoch: fixture.plan.expected_head_epoch,
        expected_reservation_digest: fixture.plan.expected_reservation_digest,
        expected_reservation_epoch: fixture.plan.expected_reservation_epoch,
        expected_parent_last_seq: fixture.plan.expected_parent_last_seq,
        expected_parent_lock_digest: fixture.plan.expected_parent_lock_digest,
        permission_digest: fixture.plan.permission_digest,
        revision_claim_epoch: fixture.plan.revision_claim_epoch,
        binding_delta_digest: fixture.plan.binding_delta_digest,
        resulting_binding_set_digest: fixture.plan.resulting_binding_set_digest,
        handoff_selection_plan_digest: built.selection_plan.selection_digest,
        participant_starts: participants,
        created_at: fixture.plan.created_at,
        expires_at: fixture.plan.expires_at,
      });
      const operation = materializeRevisionOperation({
        operation_id: fixture.operation.operation_id,
        proposal_id: fixture.operation.proposal_id,
        proposal_digest: fixture.operation.proposal_digest,
        approval_id: fixture.operation.approval_id,
        approval_digest: fixture.operation.approval_digest,
        plan_digest: plan.plan_digest,
        authority_epoch: fixture.operation.authority_epoch,
        authority_head_digest: fixture.operation.authority_head_digest,
        root_session_id: fixture.operation.root_session_id,
        parent: fixture.operation.parent,
        child: fixture.operation.child,
        expected_head_digest: fixture.operation.expected_head_digest,
        expected_reservation_digest: fixture.operation.expected_reservation_digest,
        expected_reservation_epoch: fixture.operation.expected_reservation_epoch,
        revision_claim_epoch: fixture.operation.revision_claim_epoch,
        expected_parent_last_seq: fixture.operation.expected_parent_last_seq,
        expected_parent_lock_digest: fixture.operation.expected_parent_lock_digest,
        permission_digest: fixture.operation.permission_digest,
        binding_set_digest: fixture.operation.binding_set_digest,
        handoff_digest: built.handoff.digest,
        handoff_selection_digest: built.selection_plan.selection_digest,
        prompt_projection_digest: built.handoff.prompt_projection_digest,
        created_at: fixture.operation.created_at,
      });
      artifacts.create(
        manifest(
          operation.child.conversation_id,
          participantIds.map((participantId) => manifestBinding(participantId)),
        ),
        participantIds.map((participantId) => artifactAuthority(participantId)),
      );
      const uncertainResult = (attemptId: string) => ({
        attemptId,
        engine: "codex" as const,
        ok: false,
        state: "ambiguous" as const,
        lifecycle: ["requested", "ambiguous"] as const,
        output: "",
        evidenceStatus: "persisted" as const,
        nativeSessionStatus: "unavailable" as const,
      });
      let settleSecond!: (value: ReturnType<typeof uncertainResult>) => void;
      const secondCompletion = new Promise<ReturnType<typeof uncertainResult>>((resolve) => {
        settleSecond = resolve;
      });
      const terminated: string[] = [];
      const adapter = {
        start: ({ attemptId }: { attemptId: string }) => ({
          attemptId,
          completion:
            attemptId ===
            participantStartAttemptKey({
              operation_id: operation.operation_id,
              participant_id: "participant-1",
              start_generation: 1,
            })
              ? Promise.resolve(uncertainResult(attemptId))
              : secondCompletion,
          terminate: async () => {
            terminated.push(attemptId);
            settleSecond(uncertainResult(attemptId));
          },
          readResumeBinding: () => undefined,
          readEvidenceBinding: () => undefined,
        }),
        reconcileHistory: async () => ({ engine: "codex", status: "missing" }),
      };
      const priorReceipts = new Map(
        participants.map((participant) => {
          const identity = {
            operation_id: operation.operation_id,
            participant_id: participant.participant_id,
            start_generation: 0,
          };
          return [
            participant.participant_id,
            [
              materializeParticipantStartReceipt({
                ...identity,
                attempt_key: participantStartAttemptKey(identity),
                state: "prepared",
                engine: participant.engine,
                model: participant.model,
                adapter_fingerprint: participant.adapter_fingerprint,
                reconciliation_mode: participant.reconciliation_mode,
                cancel_attempt_key: null,
                cancellation_mode: null,
                shared_prompt_digest: operation.prompt_projection_digest,
                wrapper_digest: participant.wrapper_descriptor_digest,
                private_native_session_ref: null,
                private_native_session_producer_receipt_digest: null,
                private_process_lease_ref: null,
                private_process_lease_producer_receipt_digest: null,
                prepared_at: NOW,
                observed_at: null,
              }),
            ],
          ] as const;
        }),
      );
      const generations = new Map(participantIds.map((participantId) => [participantId, 1]));
      const attemptKeys = new Map(
        participantIds.map((participantId) => [
          participantId,
          participantStartAttemptKey({
            operation_id: operation.operation_id,
            participant_id: participantId,
            start_generation: 1,
          }),
        ]),
      );
      const runtime = new RevisionLaneRetryRuntime(
        {
          artifactRoot,
          artifactStore: artifacts,
          sessionAdapter: adapter,
          rehydrateBinding: async (input: { participant_id: string }) =>
            binding(input.participant_id),
        } as never,
        handoffs,
      );
      const results = await runtime.retry({
        operation,
        plan,
        generations,
        attempt_keys: attemptKeys,
        prior_receipts: priorReceipts,
        now: () => NOW,
      });
      expect(results.map(({ outcome }) => outcome)).toEqual(["uncertain", "uncertain"]);
      const secondAttemptKey = attemptKeys.get("participant-2");
      if (!secondAttemptKey) throw new Error("second retry attempt key is absent");
      expect(terminated).toContain(secondAttemptKey);
      expect(runtime.isQuiescent(operation.operation_id)).toBeTrue();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("constructs the durable receipt candidate error with its action identity", () => {
    const error = new ConversationReceiptCandidateUnavailableError("context.compact");
    expect(error.action_type).toBe("context.compact");
    expect(error.message).toContain("context.compact");
  });

  test("delegates an absent conversation control-state read to restart authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-postfreeze-3-runtime-"));
    try {
      const artifactRegistry = new DurableArtifactRegistry({ dir: join(root, "opaque") });
      const traceStore = new TraceStore({
        dir: join(root, "traces"),
        artifactRegistry,
        now: () => NOW,
      });
      const artifactStore = new ConversationArtifactStore({ dir: join(root, "artifacts") });
      const runtime = new ConversationRuntime({
        traceStore,
        artifactRegistry,
        artifactStore,
        sessionAdapter: {
          start: () => {
            throw new Error("unused adapter start");
          },
          reconcileHistory: async () => ({
            engine: "codex",
            nativeSessionId: "unused",
            status: "missing",
          }),
        } as never,
        policies: new ConversationPolicyRegistry([new DirectConversationPolicy()]),
        rehydrateBinding: async () => binding(),
      });
      expect(await runtime.controlState("absent-conversation")).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
