import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestV1 } from "../../src/durability/index.js";
import { MAX_CANONICAL_HANDOFF_BYTES } from "../../src/orchestrator/conversation/handoff-limits.js";
import { ConversationTurnDeliveryStore } from "../../src/orchestrator/conversation/turn-delivery-store.js";
import {
  TURN_PROMPT_PREFIX,
  assertPreparedConversationTurn,
  bindFullHandoffToTurn,
  prepareConversationTurn,
} from "../../src/orchestrator/conversation/turn-delivery.js";
import type { PublicStoredTraceEvent } from "../../src/orchestrator/trace/types.js";

function event(
  seq: number,
  value: unknown,
  patch: Record<string, unknown> = {},
): PublicStoredTraceEvent {
  return {
    workflow_id: "workflow",
    conversation_id: "conversation",
    revision_id: "revision",
    run_id: "run",
    turn_id: `turn-${seq}`,
    operation_id: "operation",
    attempt_id: `attempt-${seq}`,
    event_id: `event-${seq}`,
    seq,
    ts: "2026-08-25T00:00:00.000Z",
    public_session_ref: null,
    event: value,
    ...patch,
  } as unknown as PublicStoredTraceEvent;
}

const events = [
  event(1, { type: "user_message", payload: { content: "all", target_participants: "all" } }),
  event(2, {
    type: "user_message",
    payload: { content: "only p1", target_participants: ["p1"] },
  }),
  event(3, {
    type: "user_message",
    payload: { content: "only p2", target_participants: ["p2"] },
  }),
  event(4, {
    type: "precommit",
    payload: { round_id: "round-1", participant_id: "p1", answer: "answer p1", evidence: [] },
  }),
  event(
    5,
    {
      type: "agent_response_delta",
      payload: {
        round_id: "round-1",
        participant_id: "p1",
        content_delta: "private-provider-history-is-not-used",
        final_claim: "claim p1",
        final_evidence: ["evidence p1"],
        completes_response: true,
      },
    },
    { participant_id: "p1", role_ref: "builder" },
  ),
  event(6, {
    type: "precommit",
    payload: { round_id: "round-1", participant_id: "p2", answer: "answer p2", evidence: [] },
  }),
  event(
    7,
    {
      type: "agent_response_delta",
      payload: {
        round_id: "round-1",
        participant_id: "p2",
        content_delta: "not-forwarded-analysis",
        final_claim: "claim p2",
        final_evidence: ["evidence p2"],
        completes_response: true,
      },
    },
    { participant_id: "p2", role_ref: "skeptic", evidence_refs: ["artifact-public"] },
  ),
  event(8, {
    type: "user_message",
    payload: { content: "new for all", target_participants: "all" },
  }),
];

const interactionDigest = (sequence: number) =>
  digestV1("FIXTURE-INTERACTION-HEAD\0v1\0", { sequence });
const messageLocator = (eventId: string) => ({
  root_session_id: "conversation",
  conversation_id: "conversation",
  revision_id: "revision",
  target_event_id: eventId,
  target_kind: "user-message" as const,
  content_digest: digestV1("FIXTURE-MESSAGE-LOCATOR\0v1\0", { event_id: eventId }),
});
const emptyInteractionProjection = () => ({
  schema_version: "1.0" as const,
  state: "ready" as const,
  root_session_id: "conversation",
  interaction_head_digest: interactionDigest(0),
  interaction_head_sequence: 0,
  interaction_head_digests_by_sequence: { "0": interactionDigest(0) },
  reaction_changes: [],
  message_locators_by_event_id: {},
  quote_projections_by_response_event_id: {},
  reaction_projections: [],
  diagnostics_by_response_event_id: {},
});

describe("canonical conversation turn delivery", () => {
  test("uses a receipt-bound exact delta and excludes self and untargeted content", () => {
    const prior = {
      participant_id: "p1",
      attempt_id: "attempt-prior",
      through_public_seq: 3,
      envelope_digest: digestV1("FIXTURE\0v1\0", { prior: true }),
      interaction_sequence: 0,
      interaction_head_digest: interactionDigest(0),
    };
    const prepared = prepareConversationTurn({
      conversation_id: "conversation",
      revision_id: "revision",
      request: {
        participant_id: "p1",
        instruction: { kind: "debate-participant", topic: "topic", round: 2 },
      },
      events,
      resume: {
        participant_id: "p1",
        attemptId: prior.attempt_id,
        engine: "codex",
        nativeSessionId: "00000000-0000-4000-8000-000000000001",
        delivery_public_seq: prior.through_public_seq,
        delivery_digest: prior.envelope_digest,
        delivery_interaction_sequence: 0,
        delivery_interaction_digest: interactionDigest(0),
      },
      prior_delivery: prior,
      observed_after_public_seq: prior.through_public_seq,
      shared_handoff: null,
      interaction_projection: emptyInteractionProjection(),
    });
    expect(prepared.envelope.delivery_mode).toBe("exact-delta");
    expect(prepared.envelope.user_messages.map(({ content }) => content)).toEqual(["new for all"]);
    expect(
      prepared.envelope.public_responses.map(({ author_public_id }) => author_public_id),
    ).toEqual(["p2"]);
    expect(prepared.envelope.public_responses[0]).toMatchObject({
      answer: "answer p2",
      claim: "claim p2",
      evidence: ["evidence p2"],
      artifact_refs: ["artifact-public"],
    });
    expect(prepared.prompt_input).not.toContain("not-forwarded-analysis");
    expect(prepared.prompt_input).not.toContain("private-provider-history-is-not-used");
    expect(prepared.prompt_input).not.toContain("only p2");
    assertPreparedConversationTurn(prepared, "p1", prepared.prompt_input);
    expect(() =>
      assertPreparedConversationTurn(structuredClone(prepared), "p1", prepared.prompt_input),
    ).toThrow("turn delivery authority");

    const response = prepared.envelope.public_responses[0];
    if (!response) throw new Error("expected public response");
    const { content_digest: _digest, ...preimage } = response;
    expect(response.content_digest).toBe(digestV1("VF-PUBLIC-TURN-RESPONSE\0v1\0", preimage));
    expect(response.content_digest).not.toBe(
      digestV1("VF-PUBLIC-TURN-RESPONSE\0v1\0", { ...preimage, answer: "tampered" }),
    );
  });

  test("keeps fallback context peer-only when the native resume remains trusted", () => {
    const quote = {
      ...messageLocator("event-1"),
      author_public_id: "human",
      preview_text: "all",
      created_at: "2026-08-25T00:00:00.000Z",
    };
    const prepared = prepareConversationTurn({
      conversation_id: "conversation",
      revision_id: "revision",
      request: { participant_id: "p1", instruction: { kind: "direct", topic: "topic" } },
      events,
      resume: {
        participant_id: "p1",
        attemptId: "attempt-prior",
        engine: "codex",
        nativeSessionId: "00000000-0000-4000-8000-000000000001",
        delivery_public_seq: 3,
        delivery_digest: digestV1("FIXTURE\0v1\0", { forged: true }),
      },
      prior_delivery: undefined,
      observed_after_public_seq: 0,
      shared_handoff: null,
      interaction_projection: {
        ...emptyInteractionProjection(),
        quote_projections_by_response_event_id: { "event-8": [quote] },
      },
    });
    expect(prepared.envelope.delivery_mode).toBe("full-history");
    expect(prepared.envelope.user_messages.map(({ content }) => content)).toEqual([
      "all",
      "only p1",
      "new for all",
    ]);
    expect(
      prepared.envelope.public_responses.map(({ author_public_id }) => author_public_id),
    ).toEqual(["p2"]);
    expect(JSON.stringify(prepared.envelope)).not.toContain("answer p1");
    const { preview_text: _preview, created_at: _createdAt, ...reference } = quote;
    expect(prepared.envelope.quoted_messages).toEqual([
      { quoting_message_id: "event-8", quote_order: 1, target: reference },
    ]);
  });

  test("includes recipient history only when native resume proof is unavailable", () => {
    const prepared = prepareConversationTurn({
      conversation_id: "conversation",
      revision_id: "revision",
      request: { participant_id: "p1", instruction: { kind: "direct", topic: "topic" } },
      events,
      resume: null,
      prior_delivery: undefined,
      observed_after_public_seq: 0,
      shared_handoff: null,
      interaction_projection: emptyInteractionProjection(),
    });

    expect(prepared.envelope.delivery_mode).toBe("full-history");
    expect(
      prepared.envelope.public_responses.map(({ author_public_id }) => author_public_id),
    ).toEqual(["p1", "p2"]);
  });

  test("degraded interaction authority cannot claim an exact native delivery delta", () => {
    const prior = {
      participant_id: "p1",
      attempt_id: "attempt-prior",
      through_public_seq: 7,
      envelope_digest: digestV1("FIXTURE\0v1\0", { prior: "degraded" }),
    };
    const prepared = prepareConversationTurn({
      conversation_id: "conversation",
      revision_id: "revision",
      request: { participant_id: "p1", instruction: { kind: "direct", topic: null } },
      events,
      resume: {
        participant_id: "p1",
        attemptId: prior.attempt_id,
        engine: "codex",
        nativeSessionId: "00000000-0000-4000-8000-000000000001",
        delivery_public_seq: prior.through_public_seq,
        delivery_digest: prior.envelope_digest,
      },
      prior_delivery: prior,
      observed_after_public_seq: 7,
      shared_handoff: null,
    });
    expect(prepared.envelope).toMatchObject({
      delivery_mode: "full-history",
      interaction_state: "degraded",
      after_interaction_sequence: 0,
      through_interaction_sequence: 0,
      prior_interaction_head_digest: null,
      interaction_head_digest: null,
      prior_delivery_digest: null,
    });
  });

  test("binds quote occurrences and independently advances peer interaction deltas", () => {
    const prior = {
      participant_id: "p1",
      attempt_id: "attempt-prior",
      through_public_seq: 7,
      envelope_digest: digestV1("FIXTURE\0v1\0", { prior: "turn" }),
      interaction_sequence: 1,
      interaction_head_digest: interactionDigest(1),
    };
    const quote = {
      ...messageLocator("event-1"),
      author_public_id: "human",
      preview_text: "all",
      created_at: "2026-08-25T00:00:00.000Z",
    };
    const prepared = prepareConversationTurn({
      conversation_id: "conversation",
      revision_id: "revision",
      request: { participant_id: "p1", instruction: { kind: "direct", topic: null } },
      events,
      resume: {
        participant_id: "p1",
        attemptId: prior.attempt_id,
        engine: "codex",
        nativeSessionId: "00000000-0000-4000-8000-000000000001",
        delivery_public_seq: prior.through_public_seq,
        delivery_digest: prior.envelope_digest,
        delivery_interaction_sequence: 1,
        delivery_interaction_digest: interactionDigest(1),
      },
      prior_delivery: prior,
      observed_after_public_seq: 7,
      shared_handoff: null,
      interaction_projection: {
        schema_version: "1.0",
        state: "ready",
        root_session_id: "conversation",
        interaction_head_digest: interactionDigest(2),
        interaction_head_sequence: 2,
        interaction_head_digests_by_sequence: {
          "0": interactionDigest(0),
          "1": interactionDigest(1),
          "2": interactionDigest(2),
        },
        reaction_changes: [
          {
            target: messageLocator("event-1"),
            emoji: "👍",
            count: 2,
            reacted_by_recipient: true,
            actor_public_ids: ["p1", "p2"],
            last_changed_interaction_sequence: 2,
          },
        ],
        message_locators_by_event_id: {},
        quote_projections_by_response_event_id: { "event-8": [quote] },
        reaction_projections: [],
        diagnostics_by_response_event_id: {},
      },
    });
    expect(prepared.envelope.delivery_mode).toBe("exact-delta");
    expect(prepared.envelope.quoted_messages).toEqual([
      { quoting_message_id: "event-8", quote_order: 1, target: quote },
    ]);
    expect(prepared.envelope.peer_reactions).toEqual([
      {
        target: messageLocator("event-1"),
        emoji: "👍",
        count: 1,
        reacted_by_recipient: false,
        actor_public_ids: ["p2"],
      },
    ]);
    expect(prepared.receipt).toMatchObject({
      after_interaction_sequence: 1,
      through_interaction_sequence: 2,
      prior_interaction_head_digest: interactionDigest(1),
      interaction_head_digest: interactionDigest(2),
    });
  });

  test("binds shared handoff and turn bytes to one exact one MiB admission", () => {
    const base = prepareConversationTurn({
      conversation_id: "conversation",
      revision_id: "revision",
      request: { participant_id: "p1", instruction: { kind: "direct", topic: "topic" } },
      events: [],
      resume: null,
      prior_delivery: undefined,
      observed_after_public_seq: 0,
      shared_handoff: null,
    });
    const separatorBytes = Buffer.byteLength("\n\n", "utf8");
    const prefix = "VF-HANDOFF/1\n";
    const sharedLength =
      MAX_CANONICAL_HANDOFF_BYTES - separatorBytes - Buffer.byteLength(base.prompt_input, "utf8");
    const shared = `${prefix}${"x".repeat(sharedLength - Buffer.byteLength(prefix, "utf8"))}`;
    const exact = prepareConversationTurn({
      conversation_id: "conversation",
      revision_id: "revision",
      request: { participant_id: "p1", instruction: { kind: "direct", topic: "topic" } },
      events: [],
      resume: null,
      prior_delivery: undefined,
      observed_after_public_seq: 0,
      shared_handoff: shared,
    });
    expect(Buffer.byteLength(bindFullHandoffToTurn(shared, exact), "utf8")).toBe(
      MAX_CANONICAL_HANDOFF_BYTES,
    );
    expect(() =>
      prepareConversationTurn({
        conversation_id: "conversation",
        revision_id: "revision",
        request: { participant_id: "p1", instruction: { kind: "direct", topic: "topic" } },
        events: [],
        resume: null,
        prior_delivery: undefined,
        observed_after_public_seq: 0,
        shared_handoff: `${shared}x`,
      }),
    ).toThrow();
  });

  test("persists the exact delivery cursor and digest across restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-turn-delivery-"));
    try {
      const row = {
        participant_id: "p1",
        attempt_id: "attempt-1",
        through_public_seq: 8,
        envelope_digest: digestV1("FIXTURE\0v1\0", { envelope: true }),
      };
      new ConversationTurnDeliveryStore(root).write("conversation", [row]);
      expect(new ConversationTurnDeliveryStore(root).read("conversation")).toEqual([row]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
