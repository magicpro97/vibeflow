import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  materializeApproval,
  materializeDispatchRecord,
  materializeProposal,
} from "../../src/actions/index.js";
import type { MaterializedAgentBinding } from "../../src/agents/binding.js";
import { conversationEnvPolicy } from "../../src/dispatch/env-filter.js";
import { createSpawnOptionsProjection } from "../../src/dispatch/session-types.js";
import { digestV1 } from "../../src/durability/index.js";
import { ConversationArtifactStore } from "../../src/orchestrator/conversation/artifact-store.js";
import { createConversationBrowserAuthorities } from "../../src/orchestrator/conversation/conversation-browser-authorities.js";
import { ConversationHomeAuthorities } from "../../src/orchestrator/conversation/conversation-home-authorities.js";
import { conversationRevisionActionPlanDigest } from "../../src/orchestrator/conversation/conversation-revision-action-plan.js";
import {
  type LineageAssociationPlanV1,
  deriveLineageAssociations,
} from "../../src/orchestrator/conversation/lineage-association.js";
import { LineageAuthorityStore } from "../../src/orchestrator/conversation/lineage-store.js";
import {
  type LineageHeadRecordV1,
  createInitialLineageHead,
} from "../../src/orchestrator/conversation/lineage-types.js";
import { commitDeferredRevision } from "../../src/orchestrator/conversation/revision-deferred-commit.js";
import { prepareDeferredRevisionProposal } from "../../src/orchestrator/conversation/revision-deferred-proposal.js";
import {
  materializeRevisionEvent,
  materializeRevisionHead,
  materializeRevisionOperation,
  materializeRevisionPreparationPlan,
  materializeRevisionReservation,
} from "../../src/orchestrator/conversation/revision-planner.js";
import { DeferredRevisionProposalStore } from "../../src/orchestrator/conversation/revision-proposal-store.js";
import {
  defaultConversationActionAuthority,
  resolveRevisionBase,
  revisionManifestRecord,
} from "../../src/orchestrator/conversation/revision-source.js";
import { recoverInterruptedPublishedRevisionStart } from "../../src/orchestrator/conversation/revision-start-finalizer.js";
import type { ConversationManifest } from "../../src/orchestrator/conversation/types.js";
import { DurableArtifactRegistry } from "../../src/orchestrator/trace/artifacts.js";
import { TraceStore } from "../../src/orchestrator/trace/store.js";
import { human, proposalDraft } from "../actions/fixtures.js";

const NOW = "2026-08-25T00:00:00.000Z";
const LATER = "2026-08-25T01:00:00.000Z";
const digest = (label: string): string =>
  digestV1("VF-CONVERSATION-POSTFREEZE-2-TEST\0v1\0", { label });

function revisionClosure(seed = 1) {
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
      manifest_digest: digest(`parent-manifest-${seed}`),
      ancestry_digest: digest(`parent-ancestry-${seed}`),
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
    expected_parent_lock_digest: digest("parent-lock"),
    permission_digest: digest("permission"),
    revision_claim_epoch: 1,
    binding_delta_digest: digest("binding-delta"),
    resulting_binding_set_digest: digest("binding-set"),
    handoff_selection_plan_digest: digest("handoff-selection"),
    participant_starts: [],
    created_at: NOW,
    expires_at: LATER,
  });
  const proposal = {
    proposal_id: `vf-proposal-${seed.toString(16).repeat(64)}`,
    proposal_digest: digest(`proposal-${seed}`),
  };
  const approval = {
    approval_id: `vf-approval-${(seed + 1).toString(16).repeat(64)}`,
    approval_digest: digest(`approval-${seed}`),
  };
  const operation = materializeRevisionOperation({
    operation_id: `vf-operation-${(seed + 2).toString(16).repeat(64)}`,
    proposal_id: proposal.proposal_id,
    proposal_digest: proposal.proposal_digest,
    approval_id: approval.approval_id,
    approval_digest: approval.approval_digest,
    plan_digest: conversationRevisionActionPlanDigest(plan.root_session_id, plan),
    authority_epoch: 0,
    authority_head_digest: digest("authority-head"),
    root_session_id: plan.root_session_id,
    parent,
    child,
    expected_head_digest: plan.expected_head_digest,
    expected_reservation_digest: plan.expected_reservation_digest,
    expected_reservation_epoch: plan.expected_reservation_epoch,
    revision_claim_epoch: plan.revision_claim_epoch,
    expected_parent_last_seq: plan.expected_parent_last_seq,
    expected_parent_lock_digest: plan.expected_parent_lock_digest,
    permission_digest: plan.permission_digest,
    binding_set_digest: plan.resulting_binding_set_digest,
    handoff_digest: digest("handoff"),
    handoff_selection_digest: plan.handoff_selection_plan_digest,
    prompt_projection_digest: digest("prompt-projection"),
    created_at: NOW,
  });
  const reservation = materializeRevisionReservation(operation);
  const committedHead = materializeRevisionHead(priorHead, operation);
  const events = [] as ReturnType<typeof materializeRevisionEvent>[];
  events.push(
    materializeRevisionEvent(operation, events, {
      kind: "state-transition",
      from: "created",
      to: "preparing",
      authorized_by_action_operation_id: operation.operation_id,
      effect_action_operation_id: operation.operation_id,
      action_terminals: [],
      reason_code: null,
    }),
  );
  events.push(
    materializeRevisionEvent(operation, events, {
      kind: "state-transition",
      from: "preparing",
      to: "prepared",
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
  const transition = {
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
  };
  return {
    parent,
    child,
    priorHead,
    committedHead,
    plan,
    proposal,
    approval,
    operation,
    reservation,
    events,
    transition,
  };
}

function manifest(input: {
  conversationId: string;
  revisionId: string;
  parentConversationId?: string | null;
  parentRevisionId?: string | null;
  lifecyclePhase?: number;
}): ConversationManifest {
  return {
    version: "1.0",
    conversation_id: input.conversationId,
    workflow_id: "workflow",
    revision_id: input.revisionId,
    run_id: `run-${input.conversationId}`,
    parent_conversation_id: input.parentConversationId ?? null,
    parent_revision_id: input.parentRevisionId ?? null,
    topic: "Post-freeze recovery",
    policy: "direct",
    max_rounds: 1,
    baseline_enabled: false,
    evaluator_auto_added: false,
    repo_root: "/repo",
    phase: input.lifecyclePhase ?? 3,
    task_text: "exercise durable revision recovery",
    bindings: [],
    created_at: NOW,
  };
}

describe("post-freeze deferred commit recovery", () => {
  test("returns an exact already-committed publication only after checking the full closure", async () => {
    const fixture = revisionClosure();
    const childManifest = manifest({
      conversationId: fixture.child.conversation_id,
      revisionId: fixture.child.revision_id,
      parentConversationId: fixture.parent.conversation_id,
      parentRevisionId: fixture.parent.revision_id,
    });
    const manifestAuthority = revisionManifestRecord(childManifest, []);
    const record = manifestAuthority.record;
    const actionState = {
      proposal: fixture.proposal,
      approval: fixture.approval,
    };
    const result = await commitDeferredRevision({
      options: {
        home: {
          revisions: {
            readOperation: () => structuredClone(fixture.operation),
            readPlan: () => structuredClone(fixture.plan),
            readPreparedTransition: () => structuredClone(fixture.transition),
            readEvents: () => structuredClone(fixture.events),
          },
          lineage: {
            readHead: () => structuredClone(fixture.committedHead),
            readReservation: () => structuredClone(fixture.reservation),
          },
        },
        artifactStore: {
          revisionVisibility: () => ({
            operation_id: fixture.operation.operation_id,
            manifest_record_digest: manifestAuthority.digest,
          }),
          readPreparedRevision: () => structuredClone(record),
        },
      } as never,
      executor: {
        execute: async () => {
          throw new Error("exact replay must not execute");
        },
      } as never,
      proposals: {} as never,
      commit: {
        conversationId: fixture.parent.conversation_id,
        proposalId: fixture.proposal.proposal_id,
        proposalDigest: fixture.proposal.proposal_digest,
        approvalId: fixture.approval.approval_id,
        authority: {} as never,
      },
      validated: {
        actionState,
        deferred: {
          revision_plan: fixture.plan,
        },
        operationId: fixture.operation.operation_id,
        action: { type: "conversation.update_settings", changes: { max_rounds: 2 } },
      } as never,
    });

    expect(result).toEqual({
      childId: fixture.child.conversation_id,
      reconcilePublished: true,
    });
  });
});

function materializedBinding(): MaterializedAgentBinding {
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
          name: "direct",
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

async function terminalConversation(root: string) {
  const artifactRoot = join(root, "artifacts");
  const traceRoot = join(root, "traces");
  const registry = new DurableArtifactRegistry({ dir: join(root, "opaque") });
  const traceStore = new TraceStore({ dir: traceRoot, artifactRegistry: registry, now: () => NOW });
  const artifacts = new ConversationArtifactStore({ dir: artifactRoot });
  const home = new ConversationHomeAuthorities({ artifactRoot, now: () => NOW });
  const rootManifest = {
    ...manifest({ conversationId: "conversation", revisionId: "revision" }),
    bindings: [
      {
        participant_id: "participant-1",
        input: { roleRef: "direct", engine: "codex" as const, sessionMode: "fresh" as const },
      },
    ],
  };
  artifacts.create(rootManifest, [
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
  const correlation = {
    workflow_id: rootManifest.workflow_id,
    conversation_id: rootManifest.conversation_id,
    revision_id: rootManifest.revision_id,
    run_id: rootManifest.run_id,
    turn_id: "turn-terminal",
    operation_id: "operation-terminal",
    attempt_id: "attempt-terminal",
  };
  await traceStore.append(correlation, {
    idempotency_key: "configured",
    event: {
      type: "conversation_configured",
      payload: {
        topic: rootManifest.topic,
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
    idempotency_key: "conversation:active",
    event: {
      type: "state_change",
      payload: { lifecycle: "ACTIVE", health: "healthy", terminal: false, reason: null },
    },
  });
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
  return { artifactRoot, traceRoot, registry, traceStore, artifacts, home, rootManifest };
}

describe("post-freeze deferred commit rollback", () => {
  test("revision base preserves an unexpected interaction reader failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-revision-interaction-reader-postfreeze-"));
    try {
      const fixture = await terminalConversation(root);
      (
        fixture.home.interactions as unknown as {
          readFold(rootSessionId: string): never;
        }
      ).readFold = () => {
        throw new Error("injected interaction reader failure");
      };

      expect(() =>
        resolveRevisionBase({
          artifactRoot: fixture.artifactRoot,
          traceRoot: fixture.traceRoot,
          conversationId: "conversation",
          home: fixture.home,
        }),
      ).toThrow("injected interaction reader failure");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("abandons the exact preparation and releases its reservation before the head CAS", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-deferred-rollback-postfreeze-"));
    try {
      const fixture = await terminalConversation(root);
      const base = resolveRevisionBase({
        artifactRoot: fixture.artifactRoot,
        traceRoot: fixture.traceRoot,
        conversationId: "conversation",
        home: fixture.home,
      });
      const authority = defaultConversationActionAuthority(base.lineage.root_session_id);
      const proposals = new DeferredRevisionProposalStore(fixture.artifactRoot);
      let abandoned = 0;
      const settled: string[] = [];
      const options = {
        artifactRoot: fixture.artifactRoot,
        traceRoot: fixture.traceRoot,
        artifactStore: fixture.artifacts,
        home: fixture.home,
        runtime: { operationId: () => null },
        now: () => NOW,
        schedule: () => undefined,
        rehydrateBinding: async () => materializedBinding(),
        executeConfigured: async () => {
          throw new Error("not used");
        },
        revisionSettled: (conversationId: string) => {
          expect(abandoned).toBe(1);
          expect(fixture.home.lineage.readReservation(conversationId)).toMatchObject({
            status: "released",
          });
          settled.push(conversationId);
        },
      } as never;
      const request = {
        schema_version: "1.0" as const,
        idempotency_key: "rollback-before-head-cas",
        anchor_event_id: null,
        expected: {
          mode: "writable-revision" as const,
          conversation_id: "conversation",
          revision_id: "revision",
          last_seq: base.parent.source.journal_head.last_seq,
          conversation_lock_digest: base.lock.lock_digest,
        },
        candidate: { type: "conversation.update_settings" as const, changes: { max_rounds: 2 } },
      };
      const proposed = await prepareDeferredRevisionProposal({
        options,
        proposals,
        conversationId: "conversation",
        snapshot: { consensus_score: null } as never,
        request,
        authority,
      });
      const snapshot = fixture.home.actions.get(proposed.proposalId);
      if (!snapshot) throw new Error("deferred proposal fixture disappeared");
      const decided = fixture.home.actions.decide({
        proposal_id: proposed.proposalId,
        proposal_digest: snapshot.proposal.proposal_digest,
        authority,
        decision: "approved",
        challenge_id: null,
        challenge_response: null,
      });
      const approved = fixture.home.actions.get(proposed.proposalId);
      const deferred = proposals.read(proposed.proposalId);
      if (!approved?.approval || !deferred)
        throw new Error("approved deferred fixture disappeared");
      const executor = {
        execute: async () => {
          throw new Error("injected child preparation failure");
        },
        abandon: () => {
          abandoned += 1;
        },
      };
      await expect(
        commitDeferredRevision({
          options,
          executor: executor as never,
          proposals,
          commit: {
            conversationId: "conversation",
            proposalId: proposed.proposalId,
            proposalDigest: snapshot.proposal.proposal_digest,
            approvalId: decided.approval.approval_id,
            authority,
          },
          validated: {
            actionState: approved as never,
            deferred,
            operationId: `vf-operation-${"4".repeat(64)}`,
            action: request.candidate,
          },
        }),
      ).rejects.toThrow("injected child preparation failure");
      expect(abandoned).toBe(1);
      expect(settled).toEqual(["conversation"]);
      expect(fixture.home.lineage.readReservation("conversation")).toMatchObject({
        status: "released",
      });
      expect(fixture.home.lineage.readHead("conversation")?.content_digest).toBe(
        base.head.content_digest,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("post-freeze revision start recovery race", () => {
  test("mirrors a terminal concurrently published while the dead owner repairs visibility", async () => {
    const fixture = revisionClosure();
    const events = [...fixture.events];
    events.push(
      materializeRevisionEvent(fixture.operation, events, {
        kind: "state-transition",
        from: "published",
        to: "starting",
        authorized_by_action_operation_id: fixture.operation.operation_id,
        effect_action_operation_id: fixture.operation.operation_id,
        action_terminals: [],
        reason_code: null,
      }),
    );
    let publishedTerminal = false;
    let released = 0;
    const terminals: unknown[] = [];
    const recoveryOwner = {
      assertHeld: () => undefined,
      release: () => {
        released += 1;
      },
    };
    const home = {
      revisions: {
        readEvents: () => structuredClone(events),
        publish: () => undefined,
      },
      lineage: {
        readReservation: () => fixture.reservation,
        readReservationHistory: () => new Map(),
        commitReservation: () => undefined,
      },
      actions: {
        terminal: (_proposalId: string, _operationId: string, terminal: unknown) => {
          terminals.push(structuredClone(terminal));
        },
      },
    } as unknown as ConversationHomeAuthorities;
    const recovered = await recoverInterruptedPublishedRevisionStart({
      operation: fixture.operation,
      revisionPlan: fixture.plan,
      reservation: fixture.reservation,
      proposalId: fixture.proposal.proposal_id,
      runtime: { operationOwnerState: () => "absent" } as never,
      home,
      artifactStore: {
        publishRevision: () => {
          if (publishedTerminal) return;
          publishedTerminal = true;
          events.push(
            materializeRevisionEvent(fixture.operation, events, {
              kind: "state-transition",
              from: "starting",
              to: "started",
              authorized_by_action_operation_id: fixture.operation.operation_id,
              effect_action_operation_id: fixture.operation.operation_id,
              action_terminals: [
                {
                  action_operation_id: fixture.operation.operation_id,
                  outcome: "succeeded",
                  reason_code: null,
                },
              ],
              reason_code: null,
            }),
          );
        },
      } as never,
      startOwners: { claimDead: () => recoveryOwner } as never,
    });

    expect(recovered).toBeTrue();
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ outcome: "succeeded" });
    expect(released).toBe(1);
  });
});

function associationActionPlan(draft: ReturnType<typeof proposalDraft>, planDigest: string) {
  const binding = {
    schema_version: "1.0" as const,
    domain: "conversation" as const,
    action_root_locator: draft.action_root_locator,
    planning_options: draft.planning_options,
    execution_object_closure_digest: null,
    permission_digest: draft.permission_digest,
    steps: [
      {
        order: 0,
        step_id: "step-lineage-association",
        plan_kind: "lineage-association" as const,
        plan_digest: planDigest,
        target_ids: draft.target_set.map((target) => target.target_id),
        effect_classes: draft.effect_classes,
        reversibility: draft.reversibility,
      },
    ],
  };
  return { binding, digest: digestV1("VF-ACTION-PLAN\0v1\0", binding) };
}

function associationAuthority(suffix = "one") {
  const roots = [`association-a-${suffix}`, `association-b-${suffix}`];
  const rootBindings = roots.map((root, index) => ({
    root_session_id: root,
    expected_head_digest: `sha256:${String(index + 5).repeat(64)}`,
  }));
  const reason = `Keep the selected histories visibly related: ${suffix}.`;
  const reasonDigest = digestV1("VF-AUDIT-REASON\0v1\0", {
    schema_version: "1.0",
    reason,
  });
  const planPreimage = {
    schema_version: "1.0" as const,
    root_bindings: rootBindings.map((binding) => ({ ...binding, expected_head_epoch: 0 })),
    relation: "user-associated-unverified" as const,
    reason_digest: reasonDigest,
    created_at: NOW,
    expires_at: LATER,
  };
  const plan: LineageAssociationPlanV1 = {
    ...planPreimage,
    plan_digest: digestV1("VF-LINEAGE-ASSOCIATION-PLAN\0v1\0", planPreimage),
  };
  const base = proposalDraft();
  const draft = proposalDraft({
    action_root_locator: { kind: "conversation", root_session_id: roots[0] ?? "" },
    base: {
      ...base.base,
      root_session_id: roots[0] ?? "",
      conversation_id: roots[0] ?? "",
      revision_id: `revision-${roots[0]}`,
      last_seq: 0,
      lineage_head_digest: rootBindings[0]?.expected_head_digest ?? digest("head"),
      lineage_head_epoch: 0,
    },
    action: { type: "conversation.associate_lineages", root_session_ids: roots, reason },
    plan_digest: digest("association-placeholder"),
    preview: {
      ...base.preview,
      action_type: "conversation.associate_lineages",
      title: "Associate lineages",
      summary: "Keep selected histories related.",
    },
    created_at: NOW,
    expires_at: LATER,
  });
  const actionPlan = associationActionPlan(draft, plan.plan_digest);
  const proposal = materializeProposal({ ...draft, plan_digest: actionPlan.digest });
  const approval = materializeApproval(proposal, {
    decision: "approved",
    decided_by: human,
    challenge_class: "normal-confirm",
    challenge_digest: null,
    decided_at: NOW,
    expires_at: LATER,
  });
  const dispatch = materializeDispatchRecord(proposal, approval, null);
  const preimage = {
    schema_version: "1.0" as const,
    root_bindings: rootBindings,
    relation: "user-associated-unverified" as const,
    reason_digest: reasonDigest,
    proposal_id: proposal.proposal_id,
    approval_id: approval.approval_id,
    operation_id: dispatch.operation_id,
    created_by: human,
    created_at: approval.decided_at,
  };
  const contentDigest = digestV1("VF-LINEAGE-ASSOCIATION\0v1\0", preimage);
  const record = {
    ...preimage,
    association_id: `vf-lineage-association-${contentDigest.slice(7)}`,
    content_digest: contentDigest,
  };
  const heads = new Map(
    rootBindings.map((binding) => [
      binding.root_session_id,
      { content_digest: binding.expected_head_digest, head_epoch: 0 } as LineageHeadRecordV1,
    ]),
  );
  return {
    authority: { record, plan, action_plan: actionPlan.binding, proposal, approval, dispatch },
    record,
    heads,
  };
}

describe("post-freeze lineage association storage", () => {
  test("commits one validated association idempotently and sorts invalid affected roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-lineage-association-postfreeze-"));
    try {
      const fixture = associationAuthority();
      const second = associationAuthority("two");
      const store = new LineageAuthorityStore({ artifactRoot: root });
      expect(store.commitAssociation(fixture.authority, fixture.heads)).toEqual(fixture.record);
      expect(store.commitAssociation(fixture.authority, fixture.heads)).toEqual(fixture.record);
      expect(store.commitAssociation(second.authority, second.heads)).toEqual(second.record);
      expect(store.readAssociationRecords()).toEqual({
        records: [fixture.record, second.record].sort((left, right) =>
          Buffer.compare(Buffer.from(left.association_id), Buffer.from(right.association_id)),
        ),
        invalid_entries: 0,
      });

      const invalidA = {
        record: {
          association_id: `vf-lineage-association-${"f".repeat(64)}`,
          root_bindings: [{ root_session_id: "zeta" }, { root_session_id: "alpha" }],
        },
      };
      const invalidB = {
        plan: {
          root_bindings: [{ root_session_id: "bravo" }, { root_session_id: "alpha" }],
        },
      };
      expect(deriveLineageAssociations([invalidA, invalidB], new Map()).failures).toEqual([
        { record_id: null, root_session_ids: ["alpha", "bravo"] },
        {
          record_id: `vf-lineage-association-${"f".repeat(64)}`,
          root_session_ids: ["alpha", "zeta"],
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("post-freeze browser authority wiring", () => {
  test("exposes stored revision recovery authority and maps non-empty anchored actions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-browser-authority-wiring-postfreeze-"));
    try {
      const fixture = revisionClosure();
      const artifactRoot = join(root, "artifacts");
      const home = new ConversationHomeAuthorities({ artifactRoot, now: () => NOW });
      home.revisions.writeHeader(fixture.operation, fixture.plan);
      const anchoredRow = {
        proposal: {
          proposal_id: fixture.proposal.proposal_id,
          proposal_digest: fixture.proposal.proposal_digest,
        },
        operation: { operation_id: fixture.operation.operation_id, state: "pending_review" },
      };
      const additionalDomain = {
        domain: "capability" as const,
        supports: () => true,
        propose: async () => ({}),
        get: async () => null,
        pending: async () => [],
        anchored: async () => [anchoredRow],
        events: async () => null,
        challenge: async () => ({}),
        approve: async () => ({}),
        commit: async () => ({}),
        cancel: async () => ({}),
      };
      const browser = createConversationBrowserAuthorities({
        artifactRoot,
        traceRoot: join(root, "traces"),
        traceStore: {} as TraceStore,
        browserAuthorityKey: Buffer.alloc(32, 8),
        artifactRegistry: {} as DurableArtifactRegistry,
        artifactStore: new ConversationArtifactStore({ dir: artifactRoot }),
        home,
        service: {} as never,
        additionalActionDomains: [additionalDomain as never],
      });
      const recovery = (
        browser.lineage as unknown as {
          options: {
            revisionRecoveryAuthority(operationId: string): unknown;
          };
        }
      ).options.revisionRecoveryAuthority(fixture.operation.operation_id);
      expect(recovery).toEqual({ operation: fixture.operation, revision_plan: fixture.plan });
      const actionPage = await (
        browser.timeline as unknown as {
          options: {
            actionOperations(input: {
              conversation_id: string;
              revision_id: string;
              origin_event_id: string | null;
            }): Promise<unknown>;
          };
        }
      ).options.actionOperations({
        conversation_id: "conversation",
        revision_id: "revision",
        origin_event_id: null,
      });
      expect(actionPage).toMatchObject({
        items: [anchoredRow.operation],
        next_cursor: null,
        proposal_set_watermark: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });
      await browser.catalog.rebuild();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
