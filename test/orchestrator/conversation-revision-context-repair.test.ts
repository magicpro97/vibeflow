import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { digestV1 } from "../../src/durability/index.js";
import type { ConversationArtifactStore } from "../../src/orchestrator/conversation/artifact-store.js";
import type {
  ConversationInteractionFoldV1,
  PublicQuoteReferenceV1,
} from "../../src/orchestrator/conversation/conversation-interaction-types.js";
import { conversationRevisionActionPlanDigest } from "../../src/orchestrator/conversation/conversation-revision-action-plan.js";
import { buildContextHandoff } from "../../src/orchestrator/conversation/handoff-selection.js";
import type { ContextHandoffStore } from "../../src/orchestrator/conversation/handoff-store.js";
import type {
  PublicCompactionArtifactV1,
  PublicHandoffMessageV1,
  PublicHandoffResponseV1,
} from "../../src/orchestrator/conversation/handoff-types.js";
import type {
  RevisionOperationV1,
  RevisionPreparationPlanV1,
} from "../../src/orchestrator/conversation/lineage-revision-operation.js";
import { executeRevisionRetry } from "../../src/orchestrator/conversation/revision-control-retry.js";
import { foldRevisionOperation } from "../../src/orchestrator/conversation/revision-fold.js";
import { revisionHandoffInteractionCursor } from "../../src/orchestrator/conversation/revision-handoff-cursor.js";
import {
  publishAcceptedRevisionLaneBarrier,
  publishRevisionLaneResume,
} from "../../src/orchestrator/conversation/revision-lane-barrier.js";
import type { RevisionLaneEvidenceStore } from "../../src/orchestrator/conversation/revision-lane-evidence-store.js";
import {
  type ParticipantStartReceiptV1,
  materializeParticipantStartReceipt,
  participantStartAttemptKey,
} from "../../src/orchestrator/conversation/revision-participant-receipt.js";
import {
  type RevisionOperationEventV1,
  materializeRevisionEvent,
  materializeRevisionOperation,
  materializeRevisionPreparationPlan,
} from "../../src/orchestrator/conversation/revision-planner.js";
import {
  type RevisionPublicTranscriptV1,
  buildRevisionHandoff,
  buildRevisionQuoteGraphArtifact,
  revisionPublicTranscript,
} from "../../src/orchestrator/conversation/revision-source.js";
import {
  bindFullHandoffToTurn,
  prepareConversationTurn,
} from "../../src/orchestrator/conversation/turn-delivery.js";
import type { PublicStoredTraceEvent } from "../../src/orchestrator/trace/types.js";

const NOW = "2026-08-26T00:00:00.000Z";
const ROOT_ID = "conversation-root";
const CHILD_ID = "conversation-child";
const PARTICIPANT_ID = "participant-1";
const PEER_ID = "participant-2";
const sha = (label: string): string => digestV1("VF-REVISION-CONTEXT-REPAIR-TEST\0v1\0", { label });

function message(
  eventId: string,
  conversationId: string,
  revisionId: string,
  revisionOrdinal: number,
  publicSeq: number,
  text: string,
): PublicHandoffMessageV1 {
  return {
    event_id: eventId,
    conversation_id: conversationId,
    revision_id: revisionId,
    revision_ordinal: revisionOrdinal,
    public_seq: publicSeq,
    author_public_id: "human",
    text,
    created_at: NOW,
    redaction_manifest_digest: sha(`redaction:${eventId}`),
  };
}

function response(
  eventId: string,
  conversationId: string,
  revisionId: string,
  revisionOrdinal: number,
  publicSeq: number,
  participantId: string,
  text: string,
): PublicHandoffResponseV1 {
  return {
    event_id: eventId,
    conversation_id: conversationId,
    revision_id: revisionId,
    revision_ordinal: revisionOrdinal,
    public_seq: publicSeq,
    participant_id: participantId,
    role_ref: participantId === PARTICIPANT_ID ? "builder" : "skeptic",
    text,
    terminal_status: "completed",
    created_at: NOW,
    redaction_manifest_digest: sha(`redaction:${eventId}`),
  };
}

function quote(target: PublicHandoffMessageV1 | PublicHandoffResponseV1): PublicQuoteReferenceV1 {
  const user = "author_public_id" in target;
  return {
    root_session_id: ROOT_ID,
    conversation_id: target.conversation_id,
    revision_id: target.revision_id,
    target_event_id: target.event_id,
    target_kind: user ? "user-message" : "completed-agent-response",
    content_digest: sha(`locator:${target.event_id}`),
    author_public_id: user ? target.author_public_id : target.participant_id,
  };
}

function reaction(
  target: PublicHandoffMessageV1 | PublicHandoffResponseV1,
  actorPublicId = PEER_ID,
) {
  const { author_public_id: _authorPublicId, ...locator } = quote(target);
  return {
    schema_version: "1.0" as const,
    operation_id: `vf-reaction-${"a".repeat(64)}`,
    root_session_id: ROOT_ID,
    actor_public_id: actorPublicId,
    actor_kind: "participant" as const,
    operation: "add" as const,
    target: locator,
    emoji: "👀" as const,
    prior_interaction_head_digest: sha("reaction-prior-head"),
    created_at: NOW,
    operation_digest: sha("reaction-operation"),
  };
}

function traceEvent(
  seq: number,
  event: unknown,
  patch: Record<string, unknown> = {},
): PublicStoredTraceEvent {
  return {
    workflow_id: "workflow",
    conversation_id: CHILD_ID,
    revision_id: "revision-child",
    run_id: "run-child",
    turn_id: `turn-${seq}`,
    operation_id: "operation-child",
    attempt_id: `attempt-${seq}`,
    event_id: `child-event-${seq}`,
    seq,
    ts: NOW,
    public_session_ref: null,
    event,
    ...patch,
  } as unknown as PublicStoredTraceEvent;
}

interface PublishedBarrierCapture {
  resume: Record<string, unknown>;
  delivery: Record<string, unknown>;
  interaction: { interaction_sequence: number; interaction_head_digest: string };
}

function revisionPublicationFixture(
  includeQuote = true,
  interaction = {
    interaction_sequence: 3,
    interaction_head_digest: sha("parent-interaction-head"),
  },
  includeReaction = includeQuote,
): {
  operation: RevisionOperationV1;
  plan: RevisionPreparationPlanV1;
  receipt: ParticipantStartReceiptV1;
  evidence: RevisionLaneEvidenceStore;
  handoffs: Pick<ContextHandoffStore, "read">;
  interaction: { interaction_sequence: number; interaction_head_digest: string };
  shared_handoff: string;
} {
  const handoffTarget = message("handoff-target", ROOT_ID, "revision-root", 0, 1, "Parent context");
  const handoffQuoting = message(
    "handoff-quoting",
    ROOT_ID,
    "revision-root",
    0,
    2,
    "Parent follow-up",
  );
  const graph = buildRevisionQuoteGraphArtifact({
    root_session_id: ROOT_ID,
    transcript: {
      selected_ancestry: [
        { conversation_id: ROOT_ID, revision_id: "revision-root", revision_ordinal: 0 },
      ],
      messages: [handoffTarget, handoffQuoting],
      responses: [],
      quote_sources: includeQuote
        ? [
            {
              quoting_message_id: handoffQuoting.event_id,
              revision_ordinal: handoffQuoting.revision_ordinal,
              public_seq: handoffQuoting.public_seq,
              quote_refs: [quote(handoffTarget)],
            },
          ]
        : [],
    },
    interaction_fold: {
      schema_version: "1.0",
      root_session_id: ROOT_ID,
      head_digest: interaction.interaction_head_digest,
      head_sequence: interaction.interaction_sequence,
      head_digests_by_sequence: {
        [String(interaction.interaction_sequence)]: interaction.interaction_head_digest,
      },
      reaction_sequences_by_operation_id: includeReaction
        ? { [reaction(handoffTarget).operation_id]: interaction.interaction_sequence }
        : {},
      reactions: includeReaction ? [reaction(handoffTarget)] : [],
      participant_intents: [],
    },
  });
  if (!graph) throw new Error("handoff cursor graph was not materialized");
  const built = buildContextHandoff({
    source: {
      conversation_id: ROOT_ID,
      revision_id: "revision-root",
      last_seq: 2,
      lock_digest: sha("publication-lock"),
    },
    topic: "Topic",
    policy_value: "direct",
    bindings: [
      {
        participant_id: PARTICIPANT_ID,
        engine: "codex",
        model: "gpt-5.4",
        role_ref: "builder",
        continuity: "retained",
      },
    ],
    user_messages: [handoffTarget, handoffQuoting],
    final_responses: [],
    artifacts: [],
    mandatory_artifacts: [graph],
    consensus: { score: null, synthesis: null },
    prompt_budget_bytes: 1024 * 1024,
  });
  const plan = materializeRevisionPreparationPlan({
    root_session_id: ROOT_ID,
    parent: { conversation_id: ROOT_ID, revision_id: "revision-root", revision_ordinal: 0 },
    expected_head_digest: sha("publication-head"),
    expected_head_epoch: 0,
    expected_reservation_digest: null,
    expected_reservation_epoch: 0,
    expected_parent_last_seq: 2,
    expected_parent_lock_digest: sha("publication-lock"),
    permission_digest: sha("publication-permission"),
    revision_claim_epoch: 1,
    binding_delta_digest: sha("publication-binding-delta"),
    resulting_binding_set_digest: sha("publication-bindings"),
    handoff_selection_plan_digest: built.selection_plan.selection_digest,
    participant_starts: [
      {
        participant_id: PARTICIPANT_ID,
        engine: "codex",
        model: "gpt-5.4",
        adapter_fingerprint: "adapter-1",
        reconciliation_mode: "provider-idempotency",
        cancellation_mode: "idempotent-cancel",
        wrapper_descriptor_digest: sha("publication-wrapper"),
        max_shared_prompt_bytes: 1024 * 1024,
      },
    ],
    created_at: NOW,
    expires_at: "2026-08-26T01:00:00.000Z",
  });
  const operation = materializeRevisionOperation({
    operation_id: `vf-operation-${"a".repeat(64)}`,
    proposal_id: `vf-proposal-${"c".repeat(64)}`,
    proposal_digest: sha("publication-proposal"),
    approval_id: `vf-approval-${"d".repeat(64)}`,
    approval_digest: sha("publication-approval"),
    plan_digest: conversationRevisionActionPlanDigest(ROOT_ID, plan),
    authority_epoch: 0,
    authority_head_digest: sha("publication-action-head"),
    root_session_id: ROOT_ID,
    parent: structuredClone(plan.parent),
    child: { conversation_id: CHILD_ID, revision_id: "revision-child", revision_ordinal: 1 },
    expected_head_digest: plan.expected_head_digest,
    expected_reservation_digest: null,
    expected_reservation_epoch: 0,
    revision_claim_epoch: 1,
    expected_parent_last_seq: plan.expected_parent_last_seq,
    expected_parent_lock_digest: plan.expected_parent_lock_digest,
    permission_digest: plan.permission_digest,
    binding_set_digest: plan.resulting_binding_set_digest,
    handoff_digest: built.handoff.digest,
    handoff_selection_digest: built.selection_plan.selection_digest,
    prompt_projection_digest: built.handoff.prompt_projection_digest,
    created_at: NOW,
  });
  const receiptIdentity = {
    operation_id: operation.operation_id,
    participant_id: PARTICIPANT_ID,
    start_generation: 0,
  };
  const receipt = materializeParticipantStartReceipt({
    ...receiptIdentity,
    attempt_key: participantStartAttemptKey(receiptIdentity),
    engine: "codex",
    model: "gpt-5.4",
    adapter_fingerprint: "adapter-1",
    reconciliation_mode: "provider-idempotency",
    state: "accepted",
    cancel_attempt_key: null,
    cancellation_mode: null,
    shared_prompt_digest: operation.prompt_projection_digest,
    wrapper_digest: sha("publication-wrapper"),
    private_native_session_ref: sha("lane-ref"),
    private_native_session_producer_receipt_digest: sha("lane-evidence"),
    private_process_lease_ref: null,
    private_process_lease_producer_receipt_digest: null,
    prepared_at: NOW,
    observed_at: NOW,
  });
  const evidence = {
    read: () => ({
      operation_id: operation.operation_id,
      participant_id: PARTICIPANT_ID,
      start_generation: 0,
      attempt_key: receipt.attempt_key,
      native_session_id: "00000000-0000-4000-8000-000000000001",
    }),
  } as unknown as RevisionLaneEvidenceStore;
  const handoffs = {
    read: (digest: string) =>
      digest === built.handoff.digest ? structuredClone(built.handoff) : null,
  } satisfies Pick<ContextHandoffStore, "read">;
  return {
    operation,
    plan,
    receipt,
    evidence,
    handoffs,
    interaction,
    shared_handoff: built.shared_prompt_bytes.toString("utf8"),
  };
}

function captureAcceptedBarrier(
  fixture = revisionPublicationFixture(),
  handoffs: Pick<ContextHandoffStore, "read"> = fixture.handoffs,
): PublishedBarrierCapture {
  let resume: Record<string, unknown> | undefined;
  let delivery: Record<string, unknown> | undefined;
  const artifacts = {
    recordResumeBindings: (_conversationId: string, bindings: Record<string, unknown>[]) => {
      resume = structuredClone(bindings[0]);
    },
    recordTurnDeliveries: (_conversationId: string, deliveries: Record<string, unknown>[]) => {
      delivery = structuredClone(deliveries[0]);
    },
  } as unknown as ConversationArtifactStore;
  const live = {
    resumeCounter: { value: 7 },
    resumeBindings: new Map(),
    resumeOrdinals: new Map(),
    turnDeliveries: new Map(),
    turnObservations: new Map(),
  };
  expect(
    publishAcceptedRevisionLaneBarrier({
      ...fixture,
      handoffs,
      lanes: new Map([[PARTICIPANT_ID, fixture.receipt]]),
      artifacts,
      live: live as never,
    }),
  ).toBeTrue();
  expect(live.resumeBindings.get(PARTICIPANT_ID)).toEqual(resume);
  expect(live.turnDeliveries.get(PARTICIPANT_ID)).toEqual(delivery);
  if (!resume || !delivery) throw new Error("accepted barrier was not published");
  return { resume, delivery, interaction: fixture.interaction };
}

describe("revision context continuity repairs", () => {
  test("reused completed coordination rounds remain independent in child handoff history", () => {
    const parent = {
      node: { conversation_id: ROOT_ID, revision_id: "revision-root", revision_ordinal: 0 },
      parent: null,
      source: {
        journal_records: [
          {
            stored_event: {
              event_id: "event-delegate",
              seq: 1,
              ts: NOW,
              event: {
                type: "agent_response_delta",
                payload: {
                  round_id: "coordination:task-1",
                  participant_id: PARTICIPANT_ID,
                  content_delta: "delegate",
                  completes_response: true,
                },
              },
            },
          },
          {
            stored_event: {
              event_id: "event-resolve",
              seq: 3,
              ts: NOW,
              event: {
                type: "agent_response_delta",
                payload: {
                  round_id: "coordination:task-1",
                  participant_id: PARTICIPANT_ID,
                  content_delta: "resolve",
                  completes_response: true,
                },
              },
            },
          },
        ],
        journal_head: { last_seq: 3, lifecycle: "COMPLETED" },
        manifest: {
          bindings: [{ participant_id: PARTICIPANT_ID, input: { roleRef: "builder" } }],
        },
      },
    };

    expect(
      revisionPublicTranscript(
        { root_session_id: ROOT_ID, nodes: [parent] } as never,
        parent as never,
      ).responses.map(({ event_id: eventId, text }) => ({ eventId, text })),
    ).toEqual([
      { eventId: "event-delegate", text: "delegate" },
      { eventId: "event-resolve", text: "resolve" },
    ]);
  });

  test("canonical quote graph remains inline, ordered, and mandatory across compaction", () => {
    const rootUser = message("root-user", ROOT_ID, "revision-root", 0, 1, "Root question");
    const rootPeer = response("root-peer", ROOT_ID, "revision-root", 0, 2, PEER_ID, "Peer answer");
    const childUser = message("child-user", CHILD_ID, "revision-child", 1, 1, "Follow up");
    const childResponse = response(
      "child-response",
      CHILD_ID,
      "revision-child",
      1,
      2,
      PARTICIPANT_ID,
      "Builder answer",
    );
    const siblingTarget = message(
      "sibling-target",
      "conversation-sibling",
      "revision-sibling",
      1,
      1,
      "Sibling-only context",
    );
    const transcript: RevisionPublicTranscriptV1 = {
      selected_ancestry: [
        { conversation_id: ROOT_ID, revision_id: "revision-root", revision_ordinal: 0 },
        { conversation_id: CHILD_ID, revision_id: "revision-child", revision_ordinal: 1 },
      ],
      messages: [rootUser, childUser],
      responses: [rootPeer, childResponse],
      quote_sources: [
        {
          quoting_message_id: childUser.event_id,
          revision_ordinal: childUser.revision_ordinal,
          public_seq: childUser.public_seq,
          quote_refs: [quote(rootPeer), quote(rootUser)],
        },
      ],
    };
    const interactionFold = {
      schema_version: "1.0",
      root_session_id: ROOT_ID,
      head_digest: sha("interaction-head"),
      head_sequence: 3,
      head_digests_by_sequence: { "3": sha("interaction-head") },
      reaction_sequences_by_operation_id: { [reaction(siblingTarget).operation_id]: 3 },
      reactions: [reaction(siblingTarget)],
      participant_intents: [
        {
          actor_participant_id: PARTICIPANT_ID,
          response: {
            root_session_id: ROOT_ID,
            conversation_id: CHILD_ID,
            revision_id: "revision-child",
            target_event_id: childResponse.event_id,
            target_kind: "completed-agent-response",
            content_digest: sha("locator:child-response"),
          },
          quote_refs: [quote(rootUser), quote(rootPeer)],
          diagnostic_code: null,
        },
        {
          actor_participant_id: PEER_ID,
          response: {
            root_session_id: ROOT_ID,
            conversation_id: "conversation-sibling",
            revision_id: "revision-sibling",
            target_event_id: "sibling-response",
            target_kind: "completed-agent-response",
            content_digest: sha("locator:sibling-response"),
          },
          quote_refs: [quote(rootUser)],
          diagnostic_code: null,
        },
      ],
    } as unknown as ConversationInteractionFoldV1;
    const graphSelection = buildRevisionQuoteGraphArtifact({
      root_session_id: ROOT_ID,
      transcript,
      interaction_fold: interactionFold,
    });
    if (!graphSelection || graphSelection.delivery !== "inline-public-text")
      throw new Error("quote graph artifact was not materialized inline");
    expect(graphSelection.artifact.byte_length).toBe(
      Buffer.byteLength(graphSelection.public_text, "utf8"),
    );
    expect(graphSelection.artifact.content_sha256).toBe(
      createHash("sha256").update(graphSelection.public_text, "utf8").digest("hex"),
    );
    const graph = JSON.parse(graphSelection.public_text) as {
      interaction_head_sequence: number;
      reaction_projections: unknown[];
      occurrences: Array<{
        quoting_message_id: string;
        quote_order: number;
        target: { target_event_id: string; author_public_id: string };
      }>;
    };
    expect(graph.interaction_head_sequence).toBe(3);
    expect(graph.reaction_projections).toEqual([]);
    expect(
      graph.occurrences.map(({ quoting_message_id, quote_order, target }) => ({
        quoting_message_id,
        quote_order,
        target_event_id: target.target_event_id,
        author_public_id: target.author_public_id,
      })),
    ).toEqual([
      {
        quoting_message_id: "child-user",
        quote_order: 1,
        target_event_id: "root-peer",
        author_public_id: PEER_ID,
      },
      {
        quoting_message_id: "child-user",
        quote_order: 2,
        target_event_id: "root-user",
        author_public_id: "human",
      },
      {
        quoting_message_id: "child-response",
        quote_order: 1,
        target_event_id: "root-user",
        author_public_id: "human",
      },
      {
        quoting_message_id: "child-response",
        quote_order: 2,
        target_event_id: "root-peer",
        author_public_id: PEER_ID,
      },
    ]);
    expect(graphSelection.public_text).not.toContain("preview_text");
    expect(graphSelection.public_text).not.toContain("created_at");
    expect(graphSelection.public_text).not.toContain(rootUser.text);
    expect(graphSelection.public_text).not.toContain(rootPeer.text);
    expect(graphSelection.public_text).not.toContain("sibling-response");
    expect(graphSelection.public_text).not.toContain("sibling-target");

    const selectedReactionMismatch = structuredClone(interactionFold);
    const siblingReaction = selectedReactionMismatch.reactions[0];
    if (!siblingReaction) throw new Error("sibling reaction fixture is absent");
    siblingReaction.target.conversation_id = CHILD_ID;
    siblingReaction.target.revision_id = "revision-child";
    expect(() =>
      buildRevisionQuoteGraphArtifact({
        root_session_id: ROOT_ID,
        transcript,
        interaction_fold: selectedReactionMismatch,
      }),
    ).toThrow("reaction projection target changed");

    const selectedMissing = structuredClone(interactionFold);
    const siblingIntent = selectedMissing.participant_intents[1];
    if (!siblingIntent) throw new Error("sibling intent fixture is absent");
    siblingIntent.response.conversation_id = CHILD_ID;
    siblingIntent.response.revision_id = "revision-child";
    expect(() =>
      buildRevisionQuoteGraphArtifact({
        root_session_id: ROOT_ID,
        transcript,
        interaction_fold: selectedMissing,
      }),
    ).toThrow("quote occurrence source changed");

    const actorMismatch = structuredClone(interactionFold);
    const selectedIntent = actorMismatch.participant_intents[0];
    if (!selectedIntent) throw new Error("selected intent fixture is absent");
    selectedIntent.actor_participant_id = PEER_ID;
    expect(() =>
      buildRevisionQuoteGraphArtifact({
        root_session_id: ROOT_ID,
        transcript,
        interaction_fold: actorMismatch,
      }),
    ).toThrow("quote occurrence source changed");

    const compactionPreimage: Omit<PublicCompactionArtifactV1, "content_digest"> = {
      schema_version: "1.0",
      profile: "vf-public-compaction/1",
      source: {
        conversation_id: ROOT_ID,
        revision_id: "revision-root",
        last_seq: 2,
        lock_digest: sha("root-lock"),
      },
      source_public_head_digest: sha("root-public-head"),
      oversized_candidate_digest: sha("oversized"),
      selection_plan_digest: sha("compaction-selection"),
      previous_compaction_digest: null,
      compaction_input_digest: sha("compaction-input"),
      public_summary: "Reviewed root summary",
      retained_event_ids: [],
      retained_artifact_ids: [],
      omitted_public_ranges: [],
      created_at: NOW,
    };
    const compaction: PublicCompactionArtifactV1 = {
      ...compactionPreimage,
      content_digest: digestV1("VF-PUBLIC-COMPACTION-ARTIFACT\0v1\0", compactionPreimage),
    };
    const built = buildContextHandoff({
      source: {
        conversation_id: CHILD_ID,
        revision_id: "revision-child",
        last_seq: 2,
        lock_digest: sha("child-lock"),
      },
      topic: "Topic",
      policy_value: "direct",
      bindings: [
        {
          participant_id: PARTICIPANT_ID,
          engine: "codex",
          model: "gpt-5.4",
          role_ref: "builder",
          continuity: "retained",
        },
      ],
      user_messages: transcript.messages,
      final_responses: transcript.responses,
      artifacts: [],
      mandatory_artifacts: [graphSelection],
      consensus: { score: null, synthesis: null },
      prompt_budget_bytes: 1024 * 1024,
      active_compaction: compaction,
    });
    expect(built.selection_plan.mandatory_artifact_ids).toContain(
      graphSelection.artifact.artifact_id,
    );
    expect(
      built.handoff.prompt_projection.artifacts.find(
        ({ artifact }) => artifact.artifact_id === graphSelection.artifact.artifact_id,
      ),
    ).toEqual(graphSelection);
    expect(built.shared_prompt_bytes.toString("utf8")).toContain(
      "application/vnd.vibeflow.public-quote-graph+json",
    );

    const malformedGraphText = "{";
    const malformedGraphSha = createHash("sha256").update(malformedGraphText).digest("hex");
    const malformedGraphSelection = {
      artifact: {
        artifact_id: `vf-public-quote-graph-${malformedGraphSha}`,
        artifact_kind: "conversation-artifact" as const,
        media_type: graphSelection.artifact.media_type,
        byte_length: Buffer.byteLength(malformedGraphText, "utf8"),
        content_sha256: malformedGraphSha,
        resolver: "conversation-artifact-v1" as const,
      },
      delivery: "inline-public-text" as const,
      public_text: malformedGraphText,
    };
    const malformedBuilt = buildContextHandoff({
      source: {
        conversation_id: CHILD_ID,
        revision_id: "revision-child",
        last_seq: 2,
        lock_digest: sha("child-lock"),
      },
      topic: "Topic",
      policy_value: "direct",
      bindings: [
        {
          participant_id: PARTICIPANT_ID,
          engine: "codex",
          model: "gpt-5.4",
          role_ref: "builder",
          continuity: "retained",
        },
      ],
      user_messages: transcript.messages,
      final_responses: transcript.responses,
      artifacts: [],
      mandatory_artifacts: [malformedGraphSelection],
      consensus: { score: null, synthesis: null },
      prompt_budget_bytes: 1024 * 1024,
      active_compaction: compaction,
    });
    expect(() =>
      revisionHandoffInteractionCursor({
        handoff: malformedBuilt.handoff,
        root_session_id: ROOT_ID,
        prompt_projection_digest: malformedBuilt.handoff.prompt_projection_digest,
      }),
    ).toThrow("revision quote graph is not JSON");

    const rootRevision = {
      node: { conversation_id: ROOT_ID, revision_id: "revision-root", revision_ordinal: 0 },
      parent: null,
      source: {
        journal_records: [
          {
            stored_event: {
              event_id: rootUser.event_id,
              seq: rootUser.public_seq,
              ts: NOW,
              event: {
                type: "user_message",
                payload: { content: rootUser.text, target_participants: "all" },
              },
            },
          },
          {
            stored_event: {
              event_id: rootPeer.event_id,
              seq: rootPeer.public_seq,
              ts: NOW,
              event: {
                type: "agent_response_delta",
                payload: {
                  round_id: "round-root",
                  participant_id: PEER_ID,
                  content_delta: rootPeer.text,
                  completes_response: true,
                },
              },
            },
          },
        ],
        journal_head: { last_seq: 2, lifecycle: "COMPLETED" },
        manifest: {
          topic: "Topic",
          policy: "direct",
          bindings: [{ participant_id: PEER_ID, input: { roleRef: "skeptic" } }],
        },
      },
    };
    const childRevision = {
      node: { conversation_id: CHILD_ID, revision_id: "revision-child", revision_ordinal: 1 },
      parent: rootRevision.node,
      source: {
        journal_records: [
          {
            stored_event: {
              event_id: childUser.event_id,
              seq: childUser.public_seq,
              ts: NOW,
              event: {
                type: "user_message",
                payload: {
                  content: childUser.text,
                  target_participants: "all",
                  quote_refs: [quote(rootPeer), quote(rootUser)],
                },
              },
            },
          },
          {
            stored_event: {
              event_id: childResponse.event_id,
              seq: childResponse.public_seq,
              ts: NOW,
              event: {
                type: "agent_response_delta",
                payload: {
                  round_id: "round-child",
                  participant_id: PARTICIPANT_ID,
                  content_delta: childResponse.text,
                  completes_response: true,
                },
              },
            },
          },
        ],
        journal_head: { last_seq: 2, lifecycle: "COMPLETED" },
        manifest: {
          topic: "Topic",
          policy: "direct",
          bindings: [{ participant_id: PARTICIPANT_ID, input: { roleRef: "builder" } }],
        },
      },
    };
    const revisionHandoff = buildRevisionHandoff({
      base: {
        lineage: { root_session_id: ROOT_ID, nodes: [rootRevision, childRevision] },
        parent: childRevision,
        lock: { lock_digest: sha("child-lock") },
        active_compaction: compaction,
        interaction_fold: interactionFold,
      } as never,
      bindings: [
        {
          participant_id: PARTICIPANT_ID,
          engine: "codex",
          model: "gpt-5.4",
          role_ref: "builder",
          continuity: "retained",
        },
      ],
      snapshot: { consensus_score: null } as never,
    });
    const wiredGraph = revisionHandoff.handoff.prompt_projection.artifacts.find(
      ({ artifact }) => artifact.media_type === "application/vnd.vibeflow.public-quote-graph+json",
    );
    expect(wiredGraph?.delivery).toBe("inline-public-text");
    expect(
      wiredGraph?.delivery === "inline-public-text"
        ? (JSON.parse(wiredGraph.public_text) as { occurrences: unknown[] }).occurrences
        : [],
    ).toHaveLength(4);
  });

  test("both publication paths seed only the handoff-bound interaction cursor", () => {
    const fixture = revisionPublicationFixture(false);
    let resume: Record<string, unknown> | undefined;
    let delivery: Record<string, unknown> | undefined;
    const artifacts = {
      recordResumeBinding: (
        _conversationId: string,
        _participantId: string,
        binding: Record<string, unknown>,
      ) => {
        resume = structuredClone(binding);
      },
      recordTurnDeliveries: (_conversationId: string, rows: Record<string, unknown>[]) => {
        delivery = structuredClone(rows[0]);
      },
    } as unknown as ConversationArtifactStore;
    publishRevisionLaneResume({
      operation: fixture.operation,
      receipt: fixture.receipt,
      evidence: fixture.evidence,
      artifacts,
      handoffs: fixture.handoffs,
    });
    const expected = fixture.interaction;
    expect(resume).toMatchObject({
      delivery_interaction_sequence: expected.interaction_sequence,
      delivery_interaction_digest: expected.interaction_head_digest,
    });
    expect(delivery).toMatchObject({
      interaction_sequence: expected.interaction_sequence,
      interaction_head_digest: expected.interaction_head_digest,
    });
    const barrier = captureAcceptedBarrier(fixture);
    expect(barrier.resume).toMatchObject({
      delivery_interaction_sequence: expected.interaction_sequence,
      delivery_interaction_digest: expected.interaction_head_digest,
    });
    expect(barrier.delivery).toMatchObject({
      interaction_sequence: expected.interaction_sequence,
      interaction_head_digest: expected.interaction_head_digest,
    });
    expect(expected.interaction_sequence).toBeGreaterThan(0);
    expect(fixture.shared_handoff).toContain("text/vnd.vf.ic1");
    expect(fixture.shared_handoff).not.toContain("vf-public-quote-graph/1");

    const tamperedHandoff = fixture.handoffs.read(fixture.operation.handoff_digest);
    if (!tamperedHandoff) throw new Error("publication handoff fixture is absent");
    const cursor = tamperedHandoff.prompt_projection.artifacts.find(
      ({ artifact }) => artifact.media_type === "text/vnd.vf.ic1",
    );
    if (!cursor || cursor.delivery !== "inline-public-text")
      throw new Error("publication cursor fixture is absent");
    cursor.public_text = `${cursor.public_text}0`;
    const tampered = captureAcceptedBarrier(fixture, {
      read: () => structuredClone(tamperedHandoff),
    });
    expect(Object.hasOwn(tampered.resume, "delivery_interaction_sequence")).toBeFalse();
    expect(Object.hasOwn(tampered.resume, "delivery_interaction_digest")).toBeFalse();
    expect(Object.hasOwn(tampered.delivery, "interaction_sequence")).toBeFalse();
    expect(Object.hasOwn(tampered.delivery, "interaction_head_digest")).toBeFalse();
  });

  test("a nonzero handoff cursor carries the current folded reactions even without quotes", () => {
    const fixture = revisionPublicationFixture(false, undefined, true);
    const handoff = fixture.handoffs.read(fixture.operation.handoff_digest);
    const selection = handoff?.prompt_projection.artifacts.find(
      ({ artifact }) => artifact.media_type === "application/vnd.vibeflow.public-quote-graph+json",
    );
    if (!selection || selection.delivery !== "inline-public-text")
      throw new Error("reaction handoff projection is absent");
    const graph = JSON.parse(selection.public_text) as {
      interaction_head_sequence: number;
      interaction_head_digest: string;
      occurrences: unknown[];
      reaction_projections: Array<{
        target: { target_event_id: string };
        emoji: string;
        count: number;
        reacted_by_recipient: boolean;
        actor_public_ids: string[];
      }>;
    };
    expect(graph).toMatchObject({
      interaction_head_sequence: fixture.interaction.interaction_sequence,
      interaction_head_digest: fixture.interaction.interaction_head_digest,
      occurrences: [],
    });
    expect(graph.reaction_projections).toEqual([
      {
        target: expect.objectContaining({ target_event_id: "handoff-target" }),
        emoji: "👀",
        count: 1,
        reacted_by_recipient: false,
        actor_public_ids: [PEER_ID],
      },
    ]);
    const published = captureAcceptedBarrier(fixture);
    expect(published.resume).toMatchObject({
      delivery_interaction_sequence: fixture.interaction.interaction_sequence,
      delivery_interaction_digest: fixture.interaction.interaction_head_digest,
    });
  });

  test("an accepted retry publishes its handoff cursor before the started terminal", async () => {
    const fixture = revisionPublicationFixture();
    const retryOperationId = `vf-operation-${"e".repeat(64)}`;
    const participant = fixture.plan.participant_starts[0];
    if (!participant) throw new Error("retry participant fixture is absent");
    const failedIdentity = {
      operation_id: fixture.operation.operation_id,
      participant_id: participant.participant_id,
      start_generation: 0,
    };
    const failedReceipt = (state: "prepared" | "effect_in_progress" | "failed") =>
      materializeParticipantStartReceipt({
        ...failedIdentity,
        attempt_key: participantStartAttemptKey(failedIdentity),
        state,
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
        private_process_lease_ref: null,
        private_process_lease_producer_receipt_digest: null,
        prepared_at: NOW,
        observed_at: null,
      });
    const events: RevisionOperationEventV1[] = [];
    const append = (payload: RevisionOperationEventV1["payload"]) =>
      events.push(materializeRevisionEvent(fixture.operation, events, payload, NOW));
    for (const [from, to] of [
      ["created", "preparing"],
      ["preparing", "prepared"],
    ] as const)
      append({
        kind: "state-transition",
        from,
        to,
        authorized_by_action_operation_id: fixture.operation.operation_id,
        effect_action_operation_id: fixture.operation.operation_id,
        action_terminals: [],
        reason_code: null,
      });
    append({
      kind: "head-commit",
      authorized_by_action_operation_id: fixture.operation.operation_id,
      effect_action_operation_id: fixture.operation.operation_id,
      prior_head_digest: fixture.operation.expected_head_digest,
      prior_head_checkpoint_digest: fixture.operation.expected_head_digest,
      committed_head_digest: sha("retry-child-head"),
      directory_fsync_completed: true,
    });
    append({
      kind: "state-transition",
      from: "published",
      to: "starting",
      authorized_by_action_operation_id: fixture.operation.operation_id,
      effect_action_operation_id: fixture.operation.operation_id,
      action_terminals: [],
      reason_code: null,
    });
    for (const state of ["prepared", "effect_in_progress", "failed"] as const)
      append({
        kind: "participant-start",
        authorized_by_action_operation_id: fixture.operation.operation_id,
        effect_action_operation_id: fixture.operation.operation_id,
        receipt: failedReceipt(state),
      });
    append({
      kind: "state-transition",
      from: "starting",
      to: "start_failed",
      authorized_by_action_operation_id: fixture.operation.operation_id,
      effect_action_operation_id: fixture.operation.operation_id,
      action_terminals: [
        {
          action_operation_id: fixture.operation.operation_id,
          outcome: "failed",
          reason_code: "child_start_failed",
        },
      ],
      reason_code: "child_start_failed",
    });
    append({
      kind: "state-transition",
      from: "start_failed",
      to: "starting",
      authorized_by_action_operation_id: retryOperationId,
      effect_action_operation_id: retryOperationId,
      action_terminals: [],
      reason_code: null,
    });
    const appended: RevisionOperationEventV1[] = [];
    const resumes: Record<string, unknown>[] = [];
    const deliveries: Record<string, unknown>[] = [];
    const artifacts = {
      rootPath: () => "/unused",
      recordResumeBinding: (
        _conversationId: string,
        participantId: string,
        binding: Record<string, unknown>,
      ) => resumes.push({ participant_id: participantId, ...structuredClone(binding) }),
      recordTurnDeliveries: (_conversationId: string, rows: Record<string, unknown>[]) =>
        deliveries.push(...structuredClone(rows)),
    } as unknown as ConversationArtifactStore;
    const retryEvents = await executeRevisionRetry({
      home: {
        revisions: {
          appendEvent: (_operation: RevisionOperationV1, event: RevisionOperationEventV1) =>
            appended.push(event),
        },
      } as never,
      operation: fixture.operation,
      plan: fixture.plan,
      events,
      actionOperationId: retryOperationId,
      now: () => NOW,
      retry: async ({ attempt_keys }) => [
        {
          participant_id: PARTICIPANT_ID,
          start_generation: 1,
          attempt_key: attempt_keys.get(PARTICIPANT_ID) ?? "",
          outcome: "accepted",
          private_evidence_ref: sha("retry-lane-ref"),
          private_evidence_digest: sha("retry-lane-evidence"),
          observed_at: NOW,
        },
      ],
      publishAccepted: ({ lanes }) => {
        const accepted = lanes.get(PARTICIPANT_ID);
        if (!accepted) return false;
        publishRevisionLaneResume({
          operation: fixture.operation,
          receipt: accepted,
          evidence: {
            read: () => ({
              operation_id: fixture.operation.operation_id,
              participant_id: PARTICIPANT_ID,
              start_generation: 1,
              attempt_key: accepted.attempt_key,
              native_session_id: "00000000-0000-4000-8000-000000000002",
            }),
          } as unknown as RevisionLaneEvidenceStore,
          artifacts,
          handoffs: fixture.handoffs,
        });
        return resumes.length === 1 && deliveries.length === 1;
      },
    });
    expect(appended).toEqual(retryEvents.slice(events.length));
    expect(
      foldRevisionOperation(fixture.operation, retryEvents, {
        preparationPlan: fixture.plan,
      }).state,
    ).toBe("started");
    expect(resumes[0]).toMatchObject({
      delivery_interaction_sequence: fixture.interaction.interaction_sequence,
      delivery_interaction_digest: fixture.interaction.interaction_head_digest,
    });
    expect(deliveries[0]).toMatchObject({
      interaction_sequence: fixture.interaction.interaction_sequence,
      interaction_head_digest: fixture.interaction.interaction_head_digest,
    });
    expect(retryEvents.at(-2)?.payload).toMatchObject({
      kind: "participant-start",
      receipt: { state: "accepted", start_generation: 1 },
    });
    expect(retryEvents.at(-1)?.payload).toMatchObject({
      kind: "state-transition",
      from: "starting",
      to: "started",
    });
    const resume = resumes[0];
    const delivery = deliveries[0];
    if (!resume || !delivery) throw new Error("retry publication cursor is absent");
    const firstTurn = prepareConversationTurn({
      conversation_id: CHILD_ID,
      revision_id: "revision-child",
      recipient_engine: "codex",
      request: { participant_id: PARTICIPANT_ID, instruction: { kind: "direct", topic: null } },
      events: [
        traceEvent(1, {
          type: "user_message",
          payload: { content: "First child request after retry", target_participants: "all" },
        }),
      ],
      resume,
      prior_delivery: delivery as never,
      observed_after_public_seq: 0,
      shared_handoff: fixture.shared_handoff,
      interaction_projection: {
        schema_version: "1.0",
        state: "ready",
        root_session_id: ROOT_ID,
        interaction_head_digest: fixture.interaction.interaction_head_digest,
        interaction_head_sequence: fixture.interaction.interaction_sequence,
        interaction_head_digests_by_sequence: {
          [String(fixture.interaction.interaction_sequence)]:
            fixture.interaction.interaction_head_digest,
        },
        reaction_changes: [],
        message_locators_by_event_id: {},
        quote_projections_by_response_event_id: {},
        reaction_projections: [],
        diagnostics_by_response_event_id: {},
      },
    });
    expect(firstTurn.envelope.delivery_mode).toBe("exact-delta");
    expect(bindFullHandoffToTurn(fixture.shared_handoff, firstTurn)).toBe(firstTurn.prompt_input);
    expect(firstTurn.prompt_input.match(/VF-HANDOFF\/1/g) ?? []).toHaveLength(0);
  });

  test("the first child policy turn is exact, peer-only, and fails closed on cursor mismatch", () => {
    const fixture = revisionPublicationFixture();
    const published = captureAcceptedBarrier(fixture);
    const events = [
      traceEvent(1, {
        type: "user_message",
        payload: { content: "New child request", target_participants: "all" },
      }),
      traceEvent(2, {
        type: "precommit",
        payload: { round_id: "round-1", participant_id: PEER_ID, answer: "Peer delta" },
      }),
      traceEvent(
        3,
        {
          type: "agent_response_delta",
          payload: {
            round_id: "round-1",
            participant_id: PEER_ID,
            content_delta: "private peer stream",
            final_claim: "Peer claim",
            final_evidence: ["Peer evidence"],
            completes_response: true,
          },
        },
        { participant_id: PEER_ID, role_ref: "skeptic" },
      ),
      traceEvent(4, {
        type: "precommit",
        payload: { round_id: "round-1", participant_id: PARTICIPANT_ID, answer: "Own prior" },
      }),
      traceEvent(
        5,
        {
          type: "agent_response_delta",
          payload: {
            round_id: "round-1",
            participant_id: PARTICIPANT_ID,
            content_delta: "own private stream",
            final_claim: "Own claim",
            final_evidence: [],
            completes_response: true,
          },
        },
        { participant_id: PARTICIPANT_ID, role_ref: "builder" },
      ),
    ];
    const currentInteractionSequence = published.interaction.interaction_sequence + 1;
    const currentInteractionDigest = sha("current-interaction-head");
    const interactionProjection = {
      schema_version: "1.0" as const,
      state: "ready" as const,
      root_session_id: ROOT_ID,
      interaction_head_digest: currentInteractionDigest,
      interaction_head_sequence: currentInteractionSequence,
      interaction_head_digests_by_sequence: {
        [String(published.interaction.interaction_sequence)]:
          published.interaction.interaction_head_digest,
        [String(currentInteractionSequence)]: currentInteractionDigest,
      },
      reaction_changes: [
        {
          target: {
            root_session_id: ROOT_ID,
            conversation_id: ROOT_ID,
            revision_id: "revision-root",
            target_event_id: "handoff-target",
            target_kind: "user-message" as const,
            content_digest: sha("locator:handoff-target"),
          },
          emoji: "👀" as const,
          count: 1,
          reacted_by_recipient: false,
          actor_public_ids: [PEER_ID],
          last_changed_interaction_sequence: published.interaction.interaction_sequence,
        },
        {
          target: {
            root_session_id: ROOT_ID,
            conversation_id: CHILD_ID,
            revision_id: "revision-child",
            target_event_id: "child-event-1",
            target_kind: "user-message" as const,
            content_digest: sha("locator:child-event-1"),
          },
          emoji: "✅" as const,
          count: 1,
          reacted_by_recipient: false,
          actor_public_ids: [PEER_ID],
          last_changed_interaction_sequence: currentInteractionSequence,
        },
      ],
      message_locators_by_event_id: {},
      quote_projections_by_response_event_id: {},
      reaction_projections: [],
      diagnostics_by_response_event_id: {},
    };
    const sharedHandoff = fixture.shared_handoff;
    expect(sharedHandoff).toContain("vf-public-quote-graph/1");
    const deliveredHandoff = fixture.handoffs.read(fixture.operation.handoff_digest);
    const deliveredGraph = deliveredHandoff?.prompt_projection.artifacts.find(
      ({ artifact }) => artifact.media_type === "application/vnd.vibeflow.public-quote-graph+json",
    );
    if (!deliveredGraph || deliveredGraph.delivery !== "inline-public-text")
      throw new Error("delivered interaction graph is absent");
    expect(
      (
        JSON.parse(deliveredGraph.public_text) as {
          reaction_projections: Array<{ target: { target_event_id: string } }>;
        }
      ).reaction_projections,
    ).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({ target_event_id: "handoff-target" }),
      }),
    ]);
    const exact = prepareConversationTurn({
      conversation_id: CHILD_ID,
      revision_id: "revision-child",
      recipient_engine: "codex",
      request: { participant_id: PARTICIPANT_ID, instruction: { kind: "direct", topic: null } },
      events,
      resume: published.resume,
      prior_delivery: published.delivery as never,
      observed_after_public_seq: 0,
      shared_handoff: sharedHandoff,
      interaction_projection: interactionProjection,
    });
    expect(exact.envelope.delivery_mode).toBe("exact-delta");
    expect(exact.envelope).toMatchObject({
      after_interaction_sequence: published.interaction.interaction_sequence,
      through_interaction_sequence: currentInteractionSequence,
      prior_interaction_head_digest: published.interaction.interaction_head_digest,
      interaction_head_digest: currentInteractionDigest,
    });
    expect(exact.envelope.public_responses).toEqual([
      expect.objectContaining({
        author_public_id: PEER_ID,
        role_ref: "skeptic",
        answer: "Peer delta",
        claim: "Peer claim",
        evidence: ["Peer evidence"],
      }),
    ]);
    expect(JSON.stringify(exact.envelope)).not.toContain("Own prior");
    expect(JSON.stringify(exact.envelope)).not.toContain("own private stream");
    expect(exact.envelope.peer_reactions).toEqual([
      expect.objectContaining({
        emoji: "✅",
        actor_public_ids: [PEER_ID],
        target: expect.objectContaining({ target_event_id: "child-event-1" }),
      }),
    ]);
    expect(JSON.stringify(exact.envelope.peer_reactions)).not.toContain("handoff-target");
    const exactPrompt = bindFullHandoffToTurn(sharedHandoff, exact);
    expect(exactPrompt).toBe(exact.prompt_input);
    expect(exactPrompt.match(/VF-HANDOFF\/1/g) ?? []).toHaveLength(0);

    const forgedInteractionDigest = sha("wrong-interaction-head");
    const mismatched = prepareConversationTurn({
      conversation_id: CHILD_ID,
      revision_id: "revision-child",
      recipient_engine: "codex",
      request: { participant_id: PARTICIPANT_ID, instruction: { kind: "direct", topic: null } },
      events,
      resume: {
        ...published.resume,
        delivery_interaction_digest: forgedInteractionDigest,
      },
      prior_delivery: {
        ...published.delivery,
        interaction_head_digest: forgedInteractionDigest,
      } as never,
      observed_after_public_seq: 0,
      shared_handoff: sharedHandoff,
      interaction_projection: interactionProjection,
    });
    expect(mismatched.envelope).toMatchObject({
      delivery_mode: "full-history",
      prior_delivery_digest: null,
      prior_interaction_head_digest: null,
      after_interaction_sequence: 0,
    });
    expect(
      mismatched.envelope.public_responses.map(({ author_public_id }) => author_public_id),
    ).toEqual([PEER_ID]);
    expect(JSON.stringify(mismatched.envelope)).not.toContain("Own prior");
    expect(
      bindFullHandoffToTurn(sharedHandoff, mismatched).match(/VF-HANDOFF\/1/g) ?? [],
    ).toHaveLength(1);
  });
});
