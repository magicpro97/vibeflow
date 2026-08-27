import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestV1 } from "../../src/durability/index.js";
import { ConversationArtifactStore } from "../../src/orchestrator/conversation/artifact-store.js";
import { publishAttemptResumeBinding } from "../../src/orchestrator/conversation/attempt-resume-publication.js";
import { CONVERSATION_PUBLIC_RESPONSE_TERMINAL_STATUS } from "../../src/orchestrator/conversation/conversation-public-wire-contract.js";
import {
  HANDOFF_PROMPT_PREFIX,
  MAX_CANONICAL_HANDOFF_BYTES,
} from "../../src/orchestrator/conversation/handoff-limits.js";
import { buildContextHandoff } from "../../src/orchestrator/conversation/handoff-selection.js";
import {
  CONVERSATION_TURN_HISTORY_SUMMARY_KIND,
  CONVERSATION_TURN_RECIPIENT_HISTORY_LIMIT,
} from "../../src/orchestrator/conversation/turn-delivery-contract.js";
import { ConversationTurnDeliveryStore } from "../../src/orchestrator/conversation/turn-delivery-store.js";
import {
  TURN_PROMPT_PREFIX,
  assertPreparedConversationTurn,
  bindFullHandoffToTurn,
  prepareConversationTurn,
} from "../../src/orchestrator/conversation/turn-delivery.js";
import { recipientTurnHistory } from "../../src/orchestrator/conversation/turn-recipient-history.js";
import { recipientSafeSharedHandoff } from "../../src/orchestrator/conversation/turn-shared-handoff.js";
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
const HANDOFF_SELF_MARKER = "claim p1";
const HANDOFF_PEER_MARKER = "canonical peer handoff marker";
const HANDOFF_USER_MARKER = "canonical user handoff marker";

function productionSharedHandoff(topic = "turn delivery recovery") {
  const source = {
    conversation_id: "parent-conversation",
    revision_id: "parent-revision",
    last_seq: 3,
    lock_digest: digestV1("FIXTURE-HANDOFF\0v1\0", { lock: true }),
  };
  return buildContextHandoff({
    source,
    topic,
    policy_value: "direct",
    bindings: [
      {
        participant_id: "p1",
        engine: "codex",
        model: null,
        role_ref: "builder",
        continuity: "retained",
      },
      {
        participant_id: "p2",
        engine: "claude",
        model: null,
        role_ref: "skeptic",
        continuity: "retained",
      },
    ],
    user_messages: [
      {
        event_id: "parent-user",
        conversation_id: source.conversation_id,
        revision_id: source.revision_id,
        revision_ordinal: 0,
        public_seq: 1,
        author_public_id: "human",
        text: HANDOFF_USER_MARKER,
        created_at: "2026-08-25T00:00:00.000Z",
        redaction_manifest_digest: digestV1("FIXTURE-HANDOFF\0v1\0", { event: "user" }),
      },
    ],
    final_responses: [
      {
        event_id: "parent-self",
        conversation_id: source.conversation_id,
        revision_id: source.revision_id,
        revision_ordinal: 0,
        public_seq: 2,
        participant_id: "p1",
        role_ref: "builder",
        text: HANDOFF_SELF_MARKER,
        terminal_status: CONVERSATION_PUBLIC_RESPONSE_TERMINAL_STATUS.COMPLETED,
        created_at: "2026-08-25T00:00:01.000Z",
        redaction_manifest_digest: digestV1("FIXTURE-HANDOFF\0v1\0", { event: "self" }),
      },
      {
        event_id: "parent-peer",
        conversation_id: source.conversation_id,
        revision_id: source.revision_id,
        revision_ordinal: 0,
        public_seq: 3,
        participant_id: "p2",
        role_ref: "skeptic",
        text: HANDOFF_PEER_MARKER,
        terminal_status: CONVERSATION_PUBLIC_RESPONSE_TERMINAL_STATUS.COMPLETED,
        created_at: "2026-08-25T00:00:02.000Z",
        redaction_manifest_digest: digestV1("FIXTURE-HANDOFF\0v1\0", { event: "peer" }),
      },
    ],
    artifacts: [],
    consensus: { score: null, synthesis: null },
    prompt_budget_bytes: MAX_CANONICAL_HANDOFF_BYTES,
  }).shared_prompt_bytes.toString("utf8");
}
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
      recipient_engine: "codex",
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
    expect(prepared.envelope.native_session_use).toBe("required-exact");
    expect(prepared.envelope.recipient_history).toEqual({
      source: "native-session",
      source_response_count: 1,
      replayed_response_count: 0,
      truncated_response_count: 0,
      entries: [],
    });
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
      recipient_engine: "codex",
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
    expect(prepared.envelope.native_session_use).toBe("required-exact");
    expect(prepared.envelope.recipient_history.source).toBe("native-session");
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

  test("projects a production handoff peer-only for exact recovery and replays fallback self once", () => {
    const sharedHandoff = productionSharedHandoff();
    const exactRecovery = prepareConversationTurn({
      conversation_id: "conversation",
      revision_id: "revision",
      recipient_engine: "codex",
      request: { participant_id: "p1", instruction: { kind: "direct", topic: "topic" } },
      events,
      resume: {
        participant_id: "p1",
        attemptId: "attempt-prior",
        engine: "codex",
        nativeSessionId: "00000000-0000-4000-8000-000000000001",
        delivery_public_seq: 3,
        delivery_digest: digestV1("FIXTURE\0v1\0", { unavailable_cursor: true }),
      },
      prior_delivery: undefined,
      observed_after_public_seq: 0,
      shared_handoff: sharedHandoff,
      interaction_projection: emptyInteractionProjection(),
    });
    const exactPrompt = bindFullHandoffToTurn(sharedHandoff, exactRecovery);
    expect(exactRecovery.envelope).toMatchObject({
      delivery_mode: "full-history",
      native_session_use: "required-exact",
      after_public_seq: 0,
      through_public_seq: 8,
      prior_delivery_digest: null,
      recipient_history: {
        source: "native-session",
        source_response_count: 1,
        replayed_response_count: 0,
        entries: [],
      },
    });
    expect(exactPrompt).not.toContain(HANDOFF_SELF_MARKER);
    expect(exactPrompt).toContain(HANDOFF_PEER_MARKER);
    expect(exactPrompt).toContain(HANDOFF_USER_MARKER);

    const fallback = prepareConversationTurn({
      conversation_id: "conversation",
      revision_id: "revision",
      recipient_engine: "antigravity",
      request: { participant_id: "p1", instruction: { kind: "direct", topic: "topic" } },
      events,
      resume: null,
      prior_delivery: undefined,
      observed_after_public_seq: 0,
      shared_handoff: sharedHandoff,
      interaction_projection: emptyInteractionProjection(),
    });
    const fallbackPrompt = bindFullHandoffToTurn(sharedHandoff, fallback);
    expect(fallback.envelope).toMatchObject({
      native_session_use: "not-used",
      recipient_engine: "antigravity",
      recipient_history: {
        source: "bounded-public-replay",
        source_response_count: 1,
        replayed_response_count: 1,
      },
    });
    expect(fallbackPrompt.split(HANDOFF_SELF_MARKER)).toHaveLength(2);
    expect(fallbackPrompt).toContain(HANDOFF_PEER_MARKER);
    expect(fallbackPrompt).toContain(HANDOFF_USER_MARKER);
  });

  test("invalidates an unproved exact binding so the next supported-engine turn replays self", () => {
    const requested = {
      attemptId: "attempt-prior",
      engine: "codex" as const,
      nativeSessionId: "00000000-0000-4000-8000-000000000001",
    };
    const resumeBindings = new Map([["p1", { participant_id: "p1", ...requested }]]);
    const resumeOrdinals = new Map<string, number>();
    const removed: unknown[] = [];
    publishAttemptResumeBinding({
      live: {
        manifest: { conversation_id: "conversation" },
        resumeBindings,
        resumeOrdinals,
      } as never,
      operation: { isLive: () => true } as never,
      store: {
        removeResumeBinding: (...args: unknown[]) => {
          removed.push(args);
          return true;
        },
      } as never,
      participantId: "p1",
      attemptId: "attempt-current",
      resumeOrdinal: 1,
      captured: undefined,
      requestedExactResume: requested,
      isolatedHistory: false,
      retained: true,
    });

    expect(resumeBindings.has("p1")).toBe(false);
    expect(resumeOrdinals.get("p1")).toBe(1);
    expect(removed).toHaveLength(1);
    const sharedHandoff = productionSharedHandoff();
    const fallback = prepareConversationTurn({
      conversation_id: "conversation",
      revision_id: "revision",
      recipient_engine: "codex",
      request: { participant_id: "p1", instruction: { kind: "direct", topic: "topic" } },
      events,
      resume: resumeBindings.get("p1"),
      prior_delivery: undefined,
      observed_after_public_seq: 0,
      shared_handoff: sharedHandoff,
      interaction_projection: emptyInteractionProjection(),
    });
    const prompt = bindFullHandoffToTurn(sharedHandoff, fallback);
    expect(fallback.envelope.native_session_use).toBe("not-used");
    expect(fallback.envelope.recipient_history.source).toBe("bounded-public-replay");
    expect(prompt.split(HANDOFF_SELF_MARKER)).toHaveLength(2);
    expect(prompt).toContain(HANDOFF_PEER_MARKER);
  });

  test("rejects unsupported and mismatched captured exact-resume authority", () => {
    const base = {
      live: {
        manifest: { conversation_id: "conversation" },
        resumeBindings: new Map(),
        resumeOrdinals: new Map(),
      } as never,
      operation: { isLive: () => true } as never,
      store: {} as never,
      participantId: "p1",
      attemptId: "attempt-current",
      resumeOrdinal: 1,
      isolatedHistory: false,
      retained: true,
    };
    expect(() =>
      publishAttemptResumeBinding({
        ...base,
        captured: {
          attemptId: "attempt-current",
          engine: "antigravity",
          nativeSessionId: "antigravity-session",
        },
      }),
    ).toThrow("captured native session cannot satisfy exact resume authority");
    expect(() =>
      publishAttemptResumeBinding({
        ...base,
        captured: {
          attemptId: "attempt-current",
          engine: "codex",
          nativeSessionId: "00000000-0000-4000-8000-000000000002",
        },
        requestedExactResume: {
          attemptId: "attempt-prior",
          engine: "codex",
          nativeSessionId: "00000000-0000-4000-8000-000000000001",
        },
      }),
    ).toThrow("captured native session does not match requested exact resume authority");
  });

  test("durable resume invalidation is compare-and-remove, never participant-only", () => {
    const expected = {
      participant_id: "p1",
      attemptId: "attempt-prior",
      engine: "codex" as const,
      nativeSessionId: "00000000-0000-4000-8000-000000000001",
    };
    const newer = {
      participant_id: "p2",
      attemptId: "attempt-newer",
      engine: "claude" as const,
      nativeSessionId: "00000000-0000-4000-8000-000000000002",
    };
    let record = { resume_bindings: [expected, newer] };
    const receiver = {
      updateRecord: (
        _conversationId: string,
        transform: (value: typeof record) => typeof record,
      ) => {
        record = transform(record);
        return record;
      },
    };
    const remove = ConversationArtifactStore.prototype.removeResumeBinding.bind(receiver as never);

    expect(
      remove("conversation", "p1", { ...expected, nativeSessionId: newer.nativeSessionId }),
    ).toBe(false);
    expect(record.resume_bindings).toEqual([expected, newer]);
    expect(remove("conversation", "p1", expected)).toBe(true);
    expect(record.resume_bindings).toEqual([newer]);
  });

  test("includes recipient history only when native resume proof is unavailable", () => {
    const prepared = prepareConversationTurn({
      conversation_id: "conversation",
      revision_id: "revision",
      recipient_engine: "copilot",
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
    ).toEqual(["p2"]);
    expect(prepared.envelope).toMatchObject({
      native_session_use: "not-used",
      recipient_history: {
        source: "bounded-public-replay",
        source_response_count: 1,
        replayed_response_count: 1,
        truncated_response_count: 0,
        entries: [
          {
            message_id: "event-5",
            role_ref: "builder",
            summary_kind: "claim",
            summary: "claim p1",
            summary_truncated: false,
          },
        ],
      },
    });
  });

  test.each([
    ["unsupported recipient", "copilot", "copilot", "copilot-cannot-resume-this-id"],
    ["cross-engine recipient", "claude", "codex", "00000000-0000-4000-8000-000000000001"],
  ] as const)(
    "rejects a false exact binding for %s and replays bounded self context",
    (_case, recipientEngine, bindingEngine, nativeSessionId) => {
      const prior = {
        participant_id: "p1",
        attempt_id: "attempt-prior",
        through_public_seq: 3,
        envelope_digest: digestV1("FIXTURE\0v1\0", { prior: "false-binding" }),
      };
      const prepared = prepareConversationTurn({
        conversation_id: "conversation",
        revision_id: "revision",
        recipient_engine: recipientEngine,
        request: { participant_id: "p1", instruction: { kind: "direct", topic: "topic" } },
        events,
        resume: {
          participant_id: "p1",
          attemptId: prior.attempt_id,
          engine: bindingEngine,
          nativeSessionId,
          delivery_public_seq: prior.through_public_seq,
          delivery_digest: prior.envelope_digest,
        },
        prior_delivery: prior,
        observed_after_public_seq: prior.through_public_seq,
        shared_handoff: null,
        interaction_projection: emptyInteractionProjection(),
      });

      expect(prepared.envelope).toMatchObject({
        delivery_mode: "full-history",
        native_session_use: "not-used",
        after_public_seq: 0,
        prior_delivery_digest: null,
        recipient_history: {
          source: "bounded-public-replay",
          source_response_count: 1,
          replayed_response_count: 1,
        },
      });
      expect(prepared.envelope.user_messages.map(({ content }) => content)).toEqual([
        "all",
        "only p1",
        "new for all",
      ]);
      expect(prepared.envelope.recipient_history.entries[0]?.summary).toBe("claim p1");
      expect(JSON.stringify(prepared.envelope)).toContain("claim p1");
    },
  );

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
      recipient_engine: "codex",
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
      recipient_engine: "codex",
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
      recipient_engine: "copilot",
      request: { participant_id: "p1", instruction: { kind: "direct", topic: "topic" } },
      events: [],
      resume: null,
      prior_delivery: undefined,
      observed_after_public_seq: 0,
      shared_handoff: null,
    });
    const emptyShared = productionSharedHandoff("");
    const emptyCombinedBytes = Buffer.byteLength(bindFullHandoffToTurn(emptyShared, base), "utf8");
    const topicBytes = MAX_CANONICAL_HANDOFF_BYTES - emptyCombinedBytes;
    const shared = productionSharedHandoff("x".repeat(topicBytes));
    const exact = prepareConversationTurn({
      conversation_id: "conversation",
      revision_id: "revision",
      recipient_engine: "copilot",
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
        recipient_engine: "copilot",
        request: { participant_id: "p1", instruction: { kind: "direct", topic: "topic" } },
        events: [],
        resume: null,
        prior_delivery: undefined,
        observed_after_public_seq: 0,
        shared_handoff: productionSharedHandoff("x".repeat(topicBytes + 1)),
      }),
    ).toThrow();
  });

  test("bounds and condenses fallback self history without splitting UTF-8", () => {
    const responses = Array.from({ length: 10 }, (_, index) => ({
      message_id: `self-${index}`,
      public_seq: index + 1,
      author_public_id: "p1",
      role_ref: "builder",
      round_id: `round-${index}`,
      answer: null,
      claim: `${"🧠".repeat(800)}-${index}`,
      evidence: [],
      artifact_refs: [],
      content_digest: digestV1("FIXTURE-SELF-HISTORY\0v1\0", { index }),
    }));
    const history = recipientTurnHistory(responses, false);

    expect(history.source_response_count).toBe(10);
    expect(history.replayed_response_count).toBe(
      CONVERSATION_TURN_RECIPIENT_HISTORY_LIMIT.MAX_ENTRIES,
    );
    expect(history.truncated_response_count).toBe(2);
    expect(history.entries[0]?.message_id).toBe("self-2");
    for (const entry of history.entries) {
      expect(entry.summary_truncated).toBe(true);
      expect(Buffer.byteLength(entry.summary ?? "", "utf8")).toBeLessThanOrEqual(
        CONVERSATION_TURN_RECIPIENT_HISTORY_LIMIT.MAX_SUMMARY_BYTES,
      );
      expect(entry.summary).toEndWith("…");
    }
  });

  test("labels answer-only fallback history without promoting it to a claim", () => {
    const history = recipientTurnHistory(
      [
        {
          message_id: "answer-only",
          public_seq: 1,
          author_public_id: "p1",
          role_ref: "builder",
          round_id: "round-1",
          answer: "bounded answer",
          claim: null,
          evidence: [],
          artifact_refs: [],
          content_digest: digestV1("FIXTURE-SELF-HISTORY\0v1\0", { kind: "answer" }),
        },
      ],
      false,
    );

    expect(history.entries[0]).toMatchObject({
      summary_kind: CONVERSATION_TURN_HISTORY_SUMMARY_KIND.ANSWER,
      summary: "bounded answer",
      summary_truncated: false,
    });
  });

  test("fails closed when a prefixed shared handoff is not canonical JSON", () => {
    expect(() => recipientSafeSharedHandoff(`${HANDOFF_PROMPT_PREFIX}{`, "p1")).toThrow(
      "shared handoff prompt authority is invalid",
    );
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
