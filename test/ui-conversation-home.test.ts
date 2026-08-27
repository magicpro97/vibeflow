import { describe, expect, test } from "bun:test";
import { computed, effectScope, ref, shallowRef } from "vue";
import { AGENT_ENGINE, ENGINES } from "../src/core/agent-contract.js";
import { conversationHomeApi } from "../src/ui/src/conversation-home-api.js";
import {
  HOME_QUOTE_LIMIT,
  moveHomeQuoteReference,
  resolveHomeQuoteStatus,
  toHomeCanonicalQuoteReference,
  toggleHomeQuoteReference,
} from "../src/ui/src/conversation-home-authoring.js";
import { createHomeCommandRuntime } from "../src/ui/src/conversation-home-command-runtime.js";
import { homeParticipantDisplayLabel } from "../src/ui/src/conversation-home-participant-label.js";
import { projectHomeTimeline } from "../src/ui/src/conversation-home-projection.js";
import { projectHomeTrace } from "../src/ui/src/conversation-home-projection.js";
import { createHomeQueryRuntime } from "../src/ui/src/conversation-home-query-runtime.js";
import {
  captureHomeCommandToken,
  matchesHomeCommandToken,
  retainSelectedHomeSession,
} from "../src/ui/src/conversation-home-runtime.js";
import {
  ActivationEpoch,
  ActivationResourceRegistry,
  parseComposerIntent,
} from "../src/ui/src/conversation-home-state.js";
import {
  applyHomeReactionFold,
  degradedHomeTimelineInteraction,
  watchHomeConversationStream,
} from "../src/ui/src/conversation-home-stream.js";
import type {
  HomeAuthoritativeHeadResponse,
  HomeCanonicalMessageReference,
  HomeCapabilityItem,
  HomeQuoteReference,
  HomeReactionSummary,
  HomeSessionSummary,
  HomeTimelineItem,
  HomeTimelineResponse,
} from "../src/ui/src/conversation-home-types.js";
import { matchHomeComposerSuggestions } from "../src/ui/src/home-composer-suggestions.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const readyLocator = (
  overrides: Partial<HomeCanonicalMessageReference> = {},
): HomeCanonicalMessageReference => ({
  root_session_id: "root-a",
  conversation_id: "conversation-a",
  revision_id: "revision-a",
  target_event_id: "event-final",
  target_kind: "completed-agent-response",
  content_digest: "sha256:timeline",
  ...overrides,
});

const emptyQueueHooks = () => ({
  adoptMessageQueueSnapshot: () => {},
  clearMessageQueueProjection: () => {},
  messageQueueHasLiveItems: () => false,
});

describe("AI-first conversation Home", () => {
  test("switching sessions invalidates stale callbacks and resources", () => {
    const activation = new ActivationEpoch();
    const cleaned: string[] = [];
    const first = activation.begin("root-a");
    first.addCleanup(() => cleaned.push("a-stream"));
    const second = activation.begin("root-b");

    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(second.signal.aborted).toBe(false);
    expect(second.isCurrent()).toBe(true);
    expect(cleaned).toEqual(["a-stream"]);
    activation.close();
    expect(second.signal.aborted).toBe(true);
  });

  test("read-resource refreshes do not invalidate command authority", () => {
    const commandAuthority = new ActivationEpoch();
    const readEpoch = new ActivationEpoch();
    commandAuthority.begin("root-a");
    readEpoch.begin("root-a");
    const command = captureHomeCommandToken(commandAuthority, "root-a", "conversation-a");

    readEpoch.begin("root-a");
    expect(
      matchesHomeCommandToken(commandAuthority, command, "root-a", "conversation-a"),
    ).toBeTrue();
    commandAuthority.begin("root-b");
    expect(
      matchesHomeCommandToken(commandAuthority, command, "root-a", "conversation-a"),
    ).toBeFalse();
  });

  test("one activation owns at most one live resource per durable action", () => {
    const closed: string[] = [];
    const resources = new ActivationResourceRegistry<{ close(): void }>();
    const first = resources.getOrCreate("proposal-a", () => ({
      close: () => closed.push("first"),
    }));
    const duplicate = resources.getOrCreate("proposal-a", () => ({
      close: () => closed.push("duplicate"),
    }));

    expect(duplicate).toBe(first);
    expect(resources.size).toBe(1);
    resources.release("proposal-a", first);
    expect(closed).toEqual(["first"]);
    expect(resources.size).toBe(0);

    resources.getOrCreate("proposal-b", () => ({ close: () => closed.push("second") }));
    resources.getOrCreate("proposal-c", () => ({ close: () => closed.push("third") }));
    resources.retain(new Set(["proposal-c"]));
    expect(closed).toEqual(["first", "second"]);
    expect(resources.size).toBe(1);
    resources.close();
    expect(closed).toEqual(["first", "second", "third"]);
  });

  test("searching the rail does not discard the conversation being read", () => {
    const retained = { root_session_id: "root-active", topic: "Active" };
    expect(
      retainSelectedHomeSession(
        [{ root_session_id: "root-match", topic: "Search match" }],
        "root-active",
        retained,
      ),
    ).toBe(retained);
    expect(
      retainSelectedHomeSession(
        [{ root_session_id: "root-active", topic: "Refreshed" }],
        "root-active",
        retained,
      ),
    ).toEqual({ root_session_id: "root-active", topic: "Refreshed" });
  });

  test("friendly composer syntax maps only explicit commands to typed intents", () => {
    expect(parseComposerIntent("Help me tighten the release checks")).toEqual({
      kind: "message",
      content: "Help me tighten the release checks",
      targets: "all",
    });
    expect(parseComposerIntent("+reviewer@codex")).toEqual({
      kind: "add-participant",
      roleRef: "reviewer",
      engine: "codex",
      model: null,
    });
    expect(parseComposerIntent("-@agent-review")).toEqual({
      kind: "remove-participant",
      participantId: "agent-review",
    });
    expect(parseComposerIntent("-@bad participant")).toEqual({
      kind: "invalid",
      message: "That command is incomplete. Choose a suggestion below.",
    });
    expect(parseComposerIntent("@agent-review Please check the permission diff")).toEqual({
      kind: "message",
      content: "Please check the permission diff",
      targets: ["agent-review"],
    });
    expect(parseComposerIntent("/install magicpro97/release-auditor --user")).toEqual({
      kind: "install-capability",
      packageId: "magicpro97/release-auditor",
      scope: "user",
    });
    expect(parseComposerIntent("   ")).toEqual({ kind: "empty" });
    expect(parseComposerIntent("+reviewer@unknown")).toEqual({
      kind: "invalid",
      message: `Choose one of: ${ENGINES.join(", ")}.`,
    });
    expect(
      matchHomeComposerSuggestions("-@", [
        { participant_id: "agent-review", role_ref: "reviewer", engine: "codex", model: null },
      ]),
    ).toEqual([
      {
        glyph: "−",
        label: "Remove reviewer",
        description: "codex",
        value: "-@agent-review",
      },
    ]);
  });

  test("streamed participant deltas form one readable message", () => {
    const base = {
      workflow_id: "workflow",
      conversation_id: "conversation",
      revision_id: "revision",
      run_id: "run",
      turn_id: "turn",
      operation_id: "operation",
      attempt_id: "attempt",
      event_id: "event-a",
      seq: 1,
      ts: "2026-08-25T00:00:00.000Z",
      public_session_ref: null,
    };
    const timeline = [
      {
        kind: "conversation-event",
        revision_ordinal: 0,
        action_operations: { items: [] },
        event: {
          ...base,
          participant_id: "reviewer",
          event: {
            type: "agent_response_delta",
            payload: {
              round_id: "round-1",
              participant_id: "reviewer",
              content_delta: "Ship ",
              final_claim: null,
              final_evidence: [],
              completes_response: false,
            },
          },
        },
        interaction: degradedHomeTimelineInteraction(),
      },
      {
        kind: "conversation-event",
        revision_ordinal: 0,
        action_operations: { items: [] },
        event: {
          ...base,
          event_id: "event-b",
          seq: 2,
          participant_id: "reviewer",
          event: {
            type: "agent_response_delta",
            payload: {
              round_id: "round-1",
              participant_id: "reviewer",
              content_delta: "it.",
              final_claim: "Ship it.",
              final_evidence: ["tests"],
              completes_response: true,
            },
          },
        },
        interaction: {
          state: "ready",
          message_locator: readyLocator(),
          quote_refs: [],
          reactions: [],
          diagnostic_code: null,
        },
      },
    ] as HomeTimelineItem[];
    const items = projectHomeTimeline(timeline, [
      {
        participant_id: "reviewer",
        role_ref: "direct",
        engine: AGENT_ENGINE.CLAUDE,
        model: null,
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "assistant",
      title: "Direct / Claude",
      body: "Ship it.",
      complete: true,
      evidence: ["tests"],
      publicAuthorId: "reviewer",
    });
  });

  test("participant labels prefer configured role and engine without exposing raw ids", () => {
    expect(
      homeParticipantDisplayLabel({
        participantId: "participant-1",
        roleRef: "brainstorm_participant",
        engine: AGENT_ENGINE.OPENCODE,
      }),
    ).toBe("Brainstorm Participant / OpenCode");
    expect(
      homeParticipantDisplayLabel({
        participantId: "participant-1",
        roleRef: "participant-1",
        engine: AGENT_ENGINE.CLAUDE,
      }),
    ).toBe("Claude");
    expect(
      homeParticipantDisplayLabel({
        participantId: "participant-1",
        roleRef: null,
        engine: "toString",
      }),
    ).toBe("AI participant");
  });

  test("trace projection exposes only public correlation and evidence references", () => {
    const timeline = [
      {
        kind: "conversation-event",
        revision_ordinal: 2,
        action_operations: { items: [] },
        event: {
          workflow_id: "workflow",
          conversation_id: "conversation",
          revision_id: "revision",
          run_id: "run",
          turn_id: "turn",
          operation_id: "operation",
          attempt_id: "attempt",
          event_id: "event-a",
          seq: 7,
          ts: "2026-08-25T00:00:00.000Z",
          public_session_ref: "session_public",
          evidence_refs: ["artifact_top"],
          event: {
            type: "agent_response_delta",
            payload: {
              round_id: "round-1",
              participant_id: "reviewer",
              content_delta: "Done",
              final_claim: "Done",
              final_evidence: ["artifact_final", "artifact_top"],
              completes_response: true,
            },
          },
        },
        interaction: degradedHomeTimelineInteraction(),
      },
    ] as HomeTimelineItem[];

    expect(projectHomeTrace(timeline)).toEqual([
      {
        id: "event-a",
        type: "agent response delta",
        seq: 7,
        at: "2026-08-25T00:00:00.000Z",
        revisionOrdinal: 2,
        publicSessionRef: "session_public",
        correlation: {
          workflowId: "workflow",
          runId: "run",
          turnId: "turn",
          operationId: "operation",
          attemptId: "attempt",
        },
        evidence: ["artifact_final", "artifact_top"],
        operations: [],
      },
    ]);
  });

  test("quote selection caps at eight visible messages and can be reordered", () => {
    const quote = (index: number): HomeQuoteReference => ({
      root_session_id: "root-a",
      source_key: `source-${index}`,
      conversation_id: "conversation-a",
      revision_id: "revision-a",
      revision_ordinal: 0,
      source_event_ids: [`event-${index}`],
      target_event_id: `target-${index}`,
      target_kind: "completed-agent-response",
      content_digest: `digest-${index}`,
      author_public_id: "reviewer",
      author: "reviewer",
      excerpt: `quote ${index}`,
      at: null,
    });
    let selected: HomeQuoteReference[] = [];
    for (let index = 0; index < HOME_QUOTE_LIMIT; index += 1)
      selected = toggleHomeQuoteReference(selected, quote(index)).next;

    const overflow = toggleHomeQuoteReference(selected, quote(HOME_QUOTE_LIMIT));
    expect(overflow.next).toHaveLength(HOME_QUOTE_LIMIT);
    expect(overflow.error).toContain("up to 8 visible messages");

    const moved = moveHomeQuoteReference(selected, 2, -1);
    expect(moved[1]?.source_key).toBe("source-2");
  });

  test("quote previews surface foreign, missing, stale, and canonical-authority states", () => {
    const reference: HomeQuoteReference = {
      root_session_id: "root-a",
      source_key: "source-1",
      conversation_id: "conversation-a",
      revision_id: "revision-a",
      revision_ordinal: 0,
      source_event_ids: ["event-1"],
      target_event_id: null,
      target_kind: "completed-agent-response",
      content_digest: null,
      author_public_id: "reviewer",
      author: "reviewer",
      excerpt: "Ship it.",
      at: null,
    };

    expect(resolveHomeQuoteStatus(reference, "root-b", null)).toMatchObject({ status: "foreign" });
    expect(resolveHomeQuoteStatus(reference, "root-a", null)).toMatchObject({ status: "missing" });
    expect(
      resolveHomeQuoteStatus(reference, "root-a", {
        source_key: "source-1",
        root_session_id: "root-a",
        author: "reviewer",
        excerpt: "Changed",
        target_event_id: null,
        content_digest: null,
      }),
    ).toMatchObject({ status: "stale" });
    expect(
      resolveHomeQuoteStatus(reference, "root-a", {
        source_key: "source-1",
        root_session_id: "root-a",
        author: "reviewer",
        excerpt: "Ship it.",
        target_event_id: null,
        content_digest: null,
      }),
    ).toMatchObject({ status: "missing" });
    expect(
      resolveHomeQuoteStatus(
        { ...reference, target_event_id: "target-1", content_digest: "digest-1" },
        "root-a",
        {
          source_key: "source-1",
          root_session_id: "root-a",
          author: "reviewer",
          excerpt: "Ship it.",
          target_event_id: "target-1",
          content_digest: "digest-1",
        },
      ),
    ).toMatchObject({ status: "ready" });
  });

  test("canonical quote refs drop UI-only fields before send", () => {
    const canonical = toHomeCanonicalQuoteReference({
      root_session_id: "root-a",
      conversation_id: "conversation-a",
      revision_id: "revision-a",
      target_event_id: "event-1",
      target_kind: "completed-agent-response",
      content_digest: "sha256:1",
      author_public_id: "reviewer",
    });

    expect(canonical).toEqual({
      root_session_id: "root-a",
      conversation_id: "conversation-a",
      revision_id: "revision-a",
      target_event_id: "event-1",
      target_kind: "completed-agent-response",
      content_digest: "sha256:1",
      author_public_id: "reviewer",
    });
    expect(Object.keys(canonical ?? {})).toEqual([
      "root_session_id",
      "conversation_id",
      "revision_id",
      "target_event_id",
      "target_kind",
      "content_digest",
      "author_public_id",
    ]);
  });

  test("authoritative reaction folds replace only the matching timeline interaction", () => {
    const summary = (count: number, reactedByRecipient: boolean): HomeReactionSummary[] => [
      {
        emoji: "👍",
        label: "Approve",
        count,
        reacted_by_recipient: reactedByRecipient,
        actor_public_ids: reactedByRecipient ? ["human", "reviewer"] : ["reviewer"],
      },
    ];
    const timeline: HomeTimelineResponse = {
      schema_version: "1.0",
      root_session_id: "root-a",
      head: { conversation_id: "conversation-a", revision_id: "revision-a", revision_ordinal: 0 },
      head_epoch: 1,
      head_digest: "head",
      next_cursor: null,
      items: [
        {
          kind: "conversation-event",
          revision_ordinal: 0,
          action_operations: { items: [] },
          event: {
            workflow_id: "workflow",
            conversation_id: "conversation-a",
            revision_id: "revision-a",
            run_id: "run",
            turn_id: "turn",
            operation_id: "operation",
            attempt_id: "attempt",
            event_id: "event-final",
            seq: 4,
            ts: "2026-08-25T00:00:00.000Z",
            public_session_ref: null,
            event: {
              type: "user_message",
              payload: { content: "hello", target_participants: "all" },
            },
          },
          interaction: {
            state: "ready",
            message_locator: readyLocator({
              target_kind: "user-message",
              target_event_id: "event-final",
            }),
            quote_refs: [],
            reactions: summary(1, false),
            diagnostic_code: null,
          },
        },
      ],
    };

    const updated = applyHomeReactionFold(
      timeline,
      readyLocator({ target_kind: "user-message", target_event_id: "event-final" }),
      summary(2, true),
    );

    expect(updated?.items[0]).toMatchObject({
      interaction: {
        reactions: [{ count: 2, reacted_by_recipient: true }],
      },
    });
    expect(
      (timeline.items[0] as Extract<HomeTimelineItem, { kind: "conversation-event" }>).interaction
        .reactions[0]?.count,
    ).toBe(1);
  });

  test("stream watcher ignores stale token renewals after a session switch and clears timers on close", async () => {
    type Listener = (event: Event) => void;
    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      readonly url: string;
      closed = false;
      onerror: (() => Promise<void>) | null = null;
      private readonly listeners = new Map<string, Listener[]>();

      constructor(url: string | URL) {
        this.url = String(url);
        FakeEventSource.instances.push(this);
      }

      addEventListener(type: string, listener: Listener) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }

      close() {
        this.closed = true;
      }
    }

    const originalEventSource = globalThis.EventSource;
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers = new Map<number, { delay: number; callback: () => void | Promise<void> }>();
    let timerId = 0;
    let resolveFirstRenew: ((value: Response) => void) | null = null;
    let fetchCount = 0;
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      if (fetchCount === 1)
        return await new Promise<Response>((resolve) => {
          resolveFirstRenew = resolve;
        });
      return new Response(
        JSON.stringify({
          stream_token: "token-b",
          stream_token_expires_at: new Date(Date.now() + 61_000).toISOString(),
        }),
      );
    }) as unknown as typeof fetch;
    globalThis.setTimeout = ((
      handler: Parameters<typeof setTimeout>[0],
      delay = 0,
      ...args: unknown[]
    ) => {
      timerId += 1;
      timers.set(timerId, {
        delay,
        callback: () =>
          typeof handler === "function"
            ? (handler as (...values: unknown[]) => void)(...args)
            : undefined,
      });
      return timerId;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id?: number) => {
      timers.delete(id ?? -1);
    }) as typeof clearTimeout;

    try {
      const flush = async (turns = 6) => {
        for (let index = 0; index < turns; index += 1) await Promise.resolve();
      };
      const controllerA = new AbortController();
      const controllerB = new AbortController();
      const streamA = watchHomeConversationStream({
        conversationId: "conversation-a",
        cursor: () => 0,
        signal: controllerA.signal,
        isCurrent: () => true,
        setStatus() {},
        onSnapshot() {},
        onTrace() {},
        onRefreshNeeded() {},
      });
      streamA.close();
      const streamB = watchHomeConversationStream({
        conversationId: "conversation-b",
        cursor: () => 7,
        signal: controllerB.signal,
        isCurrent: () => true,
        setStatus() {},
        onSnapshot() {},
        onTrace() {},
        onRefreshNeeded() {},
      });
      await flush();
      const firstRenew: (value: Response) => void =
        resolveFirstRenew ??
        (() => {
          throw new Error("first renewal was not captured");
        });
      firstRenew(
        new Response(
          JSON.stringify({
            stream_token: "token-a",
            stream_token_expires_at: new Date(Date.now() + 61_000).toISOString(),
          }),
        ),
      );
      await flush();

      expect(FakeEventSource.instances).toHaveLength(1);
      expect(FakeEventSource.instances[0]?.url).toContain("conversation-b/events");
      expect(FakeEventSource.instances[0]?.url).toContain("stream_token=token-b");
      expect(FakeEventSource.instances[0]?.url).toContain("since=7");
      expect(timers.size).toBeGreaterThan(0);

      streamB.close();
      expect(timers.size).toBe(0);
    } finally {
      globalThis.EventSource = originalEventSource;
      globalThis.fetch = originalFetch;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test("pagination loads stay bound to the active session during a rapid A-to-B switch", async () => {
    const headDigest = (rootSessionId: string) =>
      `sha256:${(rootSessionId === "root-a" ? "a" : "b").repeat(64)}`;
    const session = (rootSessionId: string, topic: string): HomeSessionSummary => ({
      schema_version: "1.0",
      root_session_id: rootSessionId,
      head_status: "committed",
      root: {
        schema_version: "1.0",
        conversation_id: `${rootSessionId}-conversation`,
        revision_id: `${rootSessionId}-revision`,
        revision_ordinal: 0,
        parent_conversation_id: null,
        parent_revision_id: null,
        lineage_status: "verified",
        topic,
        policy: "direct",
        lifecycle: "COMPLETED",
        health: "healthy",
        participants: [{ participant_id: "p1", role_ref: "direct", engine: "codex", model: null }],
        created_at: "2026-08-25T00:00:00.000Z",
        updated_at: "2026-08-25T00:00:00.000Z",
        last_seq: 1,
        lock_digest: headDigest(rootSessionId),
      },
      active_conversation_id: `${rootSessionId}-conversation`,
      active_revision_id: `${rootSessionId}-revision`,
      active_revision_ordinal: 0,
      revision_count: 1,
      active: {
        schema_version: "1.0",
        conversation_id: `${rootSessionId}-conversation`,
        revision_id: `${rootSessionId}-revision`,
        revision_ordinal: 0,
        parent_conversation_id: null,
        parent_revision_id: null,
        lineage_status: "verified",
        topic,
        policy: "direct",
        lifecycle: "COMPLETED",
        health: "healthy",
        participants: [{ participant_id: "p1", role_ref: "direct", engine: "codex", model: null }],
        created_at: "2026-08-25T00:00:00.000Z",
        updated_at: "2026-08-25T00:00:00.000Z",
        last_seq: 1,
        lock_digest: headDigest(rootSessionId),
      },
      matched_revision: null,
      association_ids: [],
      sort_updated_at: "2026-08-25T00:00:00.000Z",
      lineage_cursor: `cursor-${rootSessionId}`,
    });
    const timelineResponse = (rootSessionId: string, body: string, nextCursor: string | null) => ({
      schema_version: "1.0" as const,
      root_session_id: rootSessionId,
      head: {
        conversation_id: `${rootSessionId}-conversation`,
        revision_id: `${rootSessionId}-revision`,
        revision_ordinal: 0,
      },
      head_epoch: 1,
      head_digest: headDigest(rootSessionId),
      next_cursor: nextCursor,
      items: [
        {
          kind: "conversation-event" as const,
          revision_ordinal: 0,
          action_operations: { items: [] },
          event: {
            workflow_id: "workflow",
            conversation_id: `${rootSessionId}-conversation`,
            revision_id: `${rootSessionId}-revision`,
            run_id: "run",
            turn_id: "turn",
            operation_id: "operation",
            attempt_id: "attempt",
            event_id: `${rootSessionId}-${body}`,
            seq: 1,
            ts: "2026-08-25T00:00:00.000Z",
            public_session_ref: null,
            event: {
              type: "user_message" as const,
              payload: { content: body, target_participants: "all" as const },
            },
          },
          interaction: degradedHomeTimelineInteraction(),
        },
      ],
    });
    const pendingResponse = (proposalId: string, nextCursor: string | null) => ({
      schema_version: "1.0" as const,
      items: [
        {
          schema_version: "1.0" as const,
          proposal: {
            schema_version: "1.0" as const,
            proposal_id: proposalId,
            proposal_digest: `digest-${proposalId}`,
            origin_event_id: null,
            action_type: "conversation.update_settings" as const,
            domain: "conversation" as const,
            scope: "conversation" as const,
            risk: "low" as const,
            effect_classes: [],
            targets: [],
            package_pins: [],
            reversibility: "reversible" as const,
            preview: {
              title: proposalId,
              summary: proposalId,
              permission_delta: [],
              target_dispositions: [],
              recovery_actions: [],
            },
            created_at: "2026-08-25T00:00:00.000Z",
            expires_at: "2026-08-25T01:00:00.000Z",
          },
          approval: null,
          operation: {
            schema_version: "1.0" as const,
            operation_id: null,
            proposal_id: proposalId,
            proposal_digest: `digest-${proposalId}`,
            approval_id: null,
            approval_digest: null,
            correlation_id: `correlation-${proposalId}`,
            domain: "conversation" as const,
            state: "pending_review" as const,
            phase_sequence: null,
            latest_event_cursor: null,
            progress: [],
            targets: [],
            delivery: "not-applicable" as const,
            result_ref: null,
            error: null,
            recovery_actions: [],
            created_at: "2026-08-25T00:00:00.000Z",
            updated_at: "2026-08-25T00:00:00.000Z",
          },
        },
      ],
      next_cursor: nextCursor,
      authority_watermark: `watermark-${proposalId}`,
    });
    const originalHead = conversationHomeApi.head;
    const originalTimeline = conversationHomeApi.timeline;
    const originalPending = conversationHomeApi.pending;
    const originalMessageQueue = conversationHomeApi.messageQueue;
    const timelineCalls: Array<{
      input: Parameters<typeof conversationHomeApi.timeline>[0];
      signal?: AbortSignal;
      deferred: ReturnType<typeof deferred<HomeTimelineResponse>>;
    }> = [];
    const pendingCalls: Array<{
      conversationId: string;
      input: { cursor?: string; limit?: number } | undefined;
      signal?: AbortSignal;
      deferred: ReturnType<typeof deferred<ReturnType<typeof pendingResponse>>>;
    }> = [];
    conversationHomeApi.head = (async (rootSessionId) => {
      const row = session(rootSessionId, `Session ${rootSessionId}`);
      if (!row.active) throw new Error("test session lacks an active head");
      return {
        schema_version: "1.0",
        root_session_id: rootSessionId,
        head_status: "committed",
        head_epoch: 1,
        head_digest: headDigest(rootSessionId),
        active: row.active,
      };
    }) as typeof conversationHomeApi.head;
    conversationHomeApi.timeline = ((input, signal) => {
      const row = { input, signal, deferred: deferred<HomeTimelineResponse>() };
      timelineCalls.push(row);
      return row.deferred.promise;
    }) as typeof conversationHomeApi.timeline;
    conversationHomeApi.pending = ((conversationId, input, signal) => {
      const row = {
        conversationId,
        input,
        signal,
        deferred: deferred<ReturnType<typeof pendingResponse>>(),
      };
      pendingCalls.push(row);
      return row.deferred.promise;
    }) as typeof conversationHomeApi.pending;
    conversationHomeApi.messageQueue = (async (rootSessionId) => ({
      schema_version: "1.0",
      root_session_id: rootSessionId,
      current_authority_digest: headDigest(rootSessionId),
      max_nonterminal_items: 32,
      items: [],
    })) as typeof conversationHomeApi.messageQueue;

    try {
      const sessions = ref([session("root-a", "Session A"), session("root-b", "Session B")]);
      const sessionQuery = ref("");
      const catalogHealth = ref<"ready" | "rebuilding" | "degraded">("ready");
      const catalogLoading = ref(false);
      const catalogError = ref("");
      const activeRootId = ref<string | null>(null);
      const selectedSession = shallowRef<HomeSessionSummary | null>(null);
      const authoritativeHead = shallowRef<HomeAuthoritativeHeadResponse | null>(null);
      const timeline = shallowRef<HomeTimelineResponse | null>(null);
      const pendingActions = ref<ReturnType<typeof pendingResponse>["items"]>([]);
      const activationLoading = ref(false);
      const activationError = ref("");
      const online = ref(true);
      const streamStatus = ref<"idle" | "connecting" | "live" | "reconnecting" | "error">("idle");
      const streamError = ref("");
      const capabilities = ref<HomeCapabilityItem[]>([]);
      const capabilityQuery = ref("");
      const capabilityScope = ref<"project" | "user">("project");
      const capabilityLoading = ref(false);
      const capabilityError = ref("");
      const paging = {
        catalog: { nextCursor: null as string | null, loadingMore: false },
        timeline: { nextCursor: null as string | null, loadingMore: false },
        pending: { nextCursor: null as string | null, loadingMore: false },
        capability: { nextCursor: null as string | null, loadingMore: false },
      };
      const activation = new ActivationEpoch();
      const commandAuthority = new ActivationEpoch();
      const activeRevision = computed(() => authoritativeHead.value?.active ?? null);
      const selectedConversationId = computed(() => activeRevision.value?.conversation_id ?? null);
      const runtime = createHomeQueryRuntime({
        sessions,
        sessionQuery,
        catalogHealth,
        catalogLoading,
        catalogError,
        activeRootId,
        selectedSession,
        authoritativeHead,
        timeline,
        pendingActions,
        ...emptyQueueHooks(),
        activationLoading,
        activationError,
        online,
        streamStatus,
        streamError,
        capabilities,
        capabilityQuery,
        capabilityScope,
        capabilityLoading,
        capabilityError,
        paging,
        activeRevision,
        selectedConversationId,
        readEpoch: activation,
        commandAuthority,
      });

      const selectingA = runtime.selectSession("root-a");
      await Promise.resolve();
      timelineCalls[0]?.deferred.resolve(timelineResponse("root-a", "A initial", "timeline-a"));
      pendingCalls[0]?.deferred.resolve(pendingResponse("proposal-a", "pending-a"));
      await selectingA;

      const loadingTimelineA = runtime.loadMoreTimeline();
      const loadingPendingA = runtime.loadMorePendingActions();
      expect(timelineCalls[1]?.input).toMatchObject({
        rootSessionId: "root-a",
        cursor: "timeline-a",
      });
      expect(pendingCalls[1]?.input).toMatchObject({ cursor: "pending-a" });

      const selectingB = runtime.selectSession("root-b");
      await Promise.resolve();
      timelineCalls[2]?.deferred.resolve(timelineResponse("root-b", "B initial", "timeline-b"));
      pendingCalls[2]?.deferred.resolve(pendingResponse("proposal-b", "pending-b"));
      await selectingB;

      expect(timelineCalls[1]?.signal?.aborted).toBe(true);
      expect(pendingCalls[1]?.signal?.aborted).toBe(true);
      timelineCalls[1]?.deferred.resolve(timelineResponse("root-a", "A stale page", null));
      pendingCalls[1]?.deferred.resolve(pendingResponse("proposal-a-stale", null));
      await Promise.all([loadingTimelineA, loadingPendingA]);

      expect(timeline.value?.root_session_id).toBe("root-b");
      expect(JSON.stringify(timeline.value)).not.toContain("A stale page");
      expect(pendingActions.value.map((item) => item.proposal.proposal_id)).toEqual(["proposal-b"]);

      const loadingTimelineB = runtime.loadMoreTimeline();
      const loadingPendingB = runtime.loadMorePendingActions();
      const refreshingB = runtime.refreshActiveSelection();
      await Promise.resolve();
      expect(timelineCalls[3]?.signal?.aborted).toBe(true);
      expect(pendingCalls[3]?.signal?.aborted).toBe(true);
      timelineCalls[4]?.deferred.resolve(timelineResponse("root-b", "B refreshed", null));
      pendingCalls[4]?.deferred.resolve(pendingResponse("proposal-b-fresh", null));
      await refreshingB;
      timelineCalls[3]?.deferred.resolve(timelineResponse("root-b", "B stale page", null));
      pendingCalls[3]?.deferred.resolve(pendingResponse("proposal-b-stale", null));
      await Promise.all([loadingTimelineB, loadingPendingB]);
      expect(JSON.stringify(timeline.value)).toContain("B refreshed");
      expect(JSON.stringify(timeline.value)).not.toContain("B stale page");
      expect(pendingActions.value.map((item) => item.proposal.proposal_id)).toEqual([
        "proposal-b-fresh",
      ]);

      const firstCoalescedRefresh = runtime.refreshActiveSelection();
      await Promise.resolve();
      const trailingCoalescedRefresh = runtime.refreshActiveSelection();
      expect(timelineCalls).toHaveLength(6);
      expect(pendingCalls).toHaveLength(6);
      timelineCalls[5]?.deferred.resolve(timelineResponse("root-b", "B coalesced first", null));
      pendingCalls[5]?.deferred.resolve(pendingResponse("proposal-b-coalesced-first", null));
      for (let turn = 0; turn < 8 && timelineCalls.length < 7; turn += 1) await Promise.resolve();
      expect(timelineCalls).toHaveLength(7);
      expect(pendingCalls).toHaveLength(7);
      timelineCalls[6]?.deferred.resolve(timelineResponse("root-b", "B trailing", null));
      pendingCalls[6]?.deferred.resolve(pendingResponse("proposal-b-trailing", null));
      await Promise.all([firstCoalescedRefresh, trailingCoalescedRefresh]);
      expect(JSON.stringify(timeline.value)).toContain("B trailing");
      expect(JSON.stringify(timeline.value)).not.toContain("B coalesced first");
      expect(pendingActions.value.map((item) => item.proposal.proposal_id)).toEqual([
        "proposal-b-trailing",
      ]);

      const command = captureHomeCommandToken(commandAuthority, "root-b", "root-b-conversation");
      const timelineCallCount = timelineCalls.length;
      const pendingCallCount = pendingCalls.length;
      let mismatch: unknown;
      try {
        await runtime.adoptAuthoritativeActiveHead("unexpected-child");
      } catch (error) {
        mismatch = error;
      }
      expect(mismatch).toBeInstanceOf(Error);
      expect(timelineCalls).toHaveLength(timelineCallCount);
      expect(pendingCalls).toHaveLength(pendingCallCount);
      expect(authoritativeHead.value?.active?.conversation_id).toBe("root-b-conversation");
      expect(
        matchesHomeCommandToken(commandAuthority, command, "root-b", "root-b-conversation"),
      ).toBeTrue();
    } finally {
      conversationHomeApi.head = originalHead;
      conversationHomeApi.timeline = originalTimeline;
      conversationHomeApi.pending = originalPending;
      conversationHomeApi.messageQueue = originalMessageQueue;
    }
  });

  test("catalog load-more aborts stale pages after the rail search changes", async () => {
    const session = (rootSessionId: string, topic: string): HomeSessionSummary => ({
      schema_version: "1.0",
      root_session_id: rootSessionId,
      head_status: "committed",
      root: {
        schema_version: "1.0",
        conversation_id: `${rootSessionId}-conversation`,
        revision_id: `${rootSessionId}-revision`,
        revision_ordinal: 0,
        parent_conversation_id: null,
        parent_revision_id: null,
        lineage_status: "verified",
        topic,
        policy: "direct",
        lifecycle: "COMPLETED",
        health: "healthy",
        participants: [],
        created_at: "2026-08-25T00:00:00.000Z",
        updated_at: "2026-08-25T00:00:00.000Z",
        last_seq: 1,
        lock_digest: `lock-${rootSessionId}`,
      },
      active_conversation_id: `${rootSessionId}-conversation`,
      active_revision_id: `${rootSessionId}-revision`,
      active_revision_ordinal: 0,
      revision_count: 1,
      active: null,
      matched_revision: null,
      association_ids: [],
      sort_updated_at: "2026-08-25T00:00:00.000Z",
      lineage_cursor: `cursor-${rootSessionId}`,
    });
    const originalSessions = conversationHomeApi.sessions;
    const calls: Array<{
      input: Parameters<typeof conversationHomeApi.sessions>[0];
      signal?: AbortSignal;
      deferred: ReturnType<
        typeof deferred<import("../src/ui/src/conversation-home-types.js").HomeCatalogResponse>
      >;
    }> = [];
    conversationHomeApi.sessions = ((input, signal) => {
      const row = {
        input,
        signal,
        deferred:
          deferred<import("../src/ui/src/conversation-home-types.js").HomeCatalogResponse>(),
      };
      calls.push(row);
      return row.deferred.promise;
    }) as typeof conversationHomeApi.sessions;

    try {
      const sessions = ref<HomeSessionSummary[]>([]);
      const sessionQuery = ref("alpha");
      const catalogHealth = ref<"ready" | "rebuilding" | "degraded">("ready");
      const catalogLoading = ref(false);
      const catalogError = ref("");
      const activeRootId = ref<string | null>(null);
      const selectedSession = shallowRef<HomeSessionSummary | null>(null);
      const authoritativeHead = shallowRef<HomeAuthoritativeHeadResponse | null>(null);
      const timeline = shallowRef<HomeTimelineResponse | null>(null);
      const pendingActions = ref([]);
      const activationLoading = ref(false);
      const activationError = ref("");
      const online = ref(true);
      const streamStatus = ref<"idle" | "connecting" | "live" | "reconnecting" | "error">("idle");
      const streamError = ref("");
      const capabilities = ref<HomeCapabilityItem[]>([]);
      const capabilityQuery = ref("");
      const capabilityScope = ref<"project" | "user">("project");
      const capabilityLoading = ref(false);
      const capabilityError = ref("");
      const paging = {
        catalog: { nextCursor: null as string | null, loadingMore: false },
        timeline: { nextCursor: null as string | null, loadingMore: false },
        pending: { nextCursor: null as string | null, loadingMore: false },
        capability: { nextCursor: null as string | null, loadingMore: false },
      };
      const activation = new ActivationEpoch();
      const activeRevision = computed(() => null);
      const selectedConversationId = computed(() => null);
      const runtime = createHomeQueryRuntime({
        sessions,
        sessionQuery,
        catalogHealth,
        catalogLoading,
        catalogError,
        activeRootId,
        selectedSession,
        authoritativeHead,
        timeline,
        pendingActions,
        ...emptyQueueHooks(),
        activationLoading,
        activationError,
        online,
        streamStatus,
        streamError,
        capabilities,
        capabilityQuery,
        capabilityScope,
        capabilityLoading,
        capabilityError,
        paging,
        activeRevision,
        selectedConversationId,
        readEpoch: activation,
        commandAuthority: new ActivationEpoch(),
      });

      const refreshAlpha = runtime.refreshSessions();
      calls[0]?.deferred.resolve({
        schema_version: "1.0",
        items: [session("root-a", "Alpha")],
        next_cursor: "alpha-cursor",
        catalog_generation: "gen-alpha",
        source_watermark: "watermark-alpha",
        catalog_health: "ready",
      });
      await refreshAlpha;

      const loadMoreAlpha = runtime.loadMoreSessions();
      expect(calls[1]?.input).toMatchObject({ query: "alpha", cursor: "alpha-cursor" });

      sessionQuery.value = "beta";
      const refreshBeta = runtime.refreshSessions();
      expect(calls[1]?.signal?.aborted).toBe(true);
      expect(paging.catalog.nextCursor).toBeNull();
      calls[2]?.deferred.resolve({
        schema_version: "1.0",
        items: [session("root-b", "Beta")],
        next_cursor: null,
        catalog_generation: "gen-beta",
        source_watermark: "watermark-beta",
        catalog_health: "ready",
      });
      await refreshBeta;
      calls[1]?.deferred.resolve({
        schema_version: "1.0",
        items: [session("root-stale", "Alpha stale")],
        next_cursor: null,
        catalog_generation: "gen-alpha-stale",
        source_watermark: "watermark-alpha-stale",
        catalog_health: "ready",
      });
      await loadMoreAlpha;

      expect(sessions.value.map((item) => item.root_session_id)).toEqual(["root-b"]);
      expect(JSON.stringify(sessions.value)).not.toContain("Alpha stale");
    } finally {
      conversationHomeApi.sessions = originalSessions;
    }
  });

  test("capability refresh coalesces to one latest request and stale failures cannot write", async () => {
    const originalCapabilities = conversationHomeApi.capabilities;
    const calls: Array<{
      input: Parameters<typeof conversationHomeApi.capabilities>[0];
      signal?: AbortSignal;
      deferred: ReturnType<
        typeof deferred<import("../src/ui/src/conversation-home-types.js").HomeCapabilityResponse>
      >;
    }> = [];
    conversationHomeApi.capabilities = ((input, signal) => {
      const row = {
        input,
        signal,
        deferred:
          deferred<import("../src/ui/src/conversation-home-types.js").HomeCapabilityResponse>(),
      };
      calls.push(row);
      return row.deferred.promise;
    }) as typeof conversationHomeApi.capabilities;

    try {
      const sessions = ref<HomeSessionSummary[]>([]);
      const sessionQuery = ref("");
      const catalogHealth = ref<"ready" | "rebuilding" | "degraded">("ready");
      const catalogLoading = ref(false);
      const catalogError = ref("");
      const activeRootId = ref<string | null>(null);
      const selectedSession = shallowRef<HomeSessionSummary | null>(null);
      const authoritativeHead = shallowRef<HomeAuthoritativeHeadResponse | null>(null);
      const timeline = shallowRef<HomeTimelineResponse | null>(null);
      const pendingActions = ref([]);
      const activationLoading = ref(false);
      const activationError = ref("");
      const online = ref(true);
      const streamStatus = ref<"idle" | "connecting" | "live" | "reconnecting" | "error">("idle");
      const streamError = ref("");
      const capabilities = ref<HomeCapabilityItem[]>([]);
      const capabilityQuery = ref("alpha");
      const capabilityScope = ref<"project" | "user">("project");
      const capabilityLoading = ref(false);
      const capabilityError = ref("");
      const paging = {
        catalog: { nextCursor: null as string | null, loadingMore: false },
        timeline: { nextCursor: null as string | null, loadingMore: false },
        pending: { nextCursor: null as string | null, loadingMore: false },
        capability: { nextCursor: null as string | null, loadingMore: false },
      };
      const activation = new ActivationEpoch();
      const activeRevision = computed(() => null);
      const selectedConversationId = computed(() => null);
      const runtime = createHomeQueryRuntime({
        sessions,
        sessionQuery,
        catalogHealth,
        catalogLoading,
        catalogError,
        activeRootId,
        selectedSession,
        authoritativeHead,
        timeline,
        pendingActions,
        ...emptyQueueHooks(),
        activationLoading,
        activationError,
        online,
        streamStatus,
        streamError,
        capabilities,
        capabilityQuery,
        capabilityScope,
        capabilityLoading,
        capabilityError,
        paging,
        activeRevision,
        selectedConversationId,
        readEpoch: activation,
        commandAuthority: new ActivationEpoch(),
      });

      paging.capability.nextCursor = "stale-page";
      const searchAlpha = runtime.searchCapabilities();
      expect(paging.capability.nextCursor).toBeNull();
      capabilityQuery.value = "beta";
      const searchBeta = runtime.searchCapabilities();
      capabilityQuery.value = "gamma";
      const searchGamma = runtime.searchCapabilities();
      expect(calls[0]?.signal?.aborted).toBe(true);
      calls[0]?.deferred.reject(new Error("stale alpha failure"));
      for (let turn = 0; turn < 4 && calls.length < 2; turn += 1) await Promise.resolve();
      expect(calls).toHaveLength(2);
      expect(calls[1]?.input).toMatchObject({ query: "gamma", scope: "project" });
      calls[1]?.deferred.resolve({
        schema_version: "1.0",
        items: [
          {
            package_id: "gamma/pkg",
            display_name: "Gamma",
            summary: "Gamma",
            version: "1.0.0",
            package_pin_digest: null,
            scope: "project",
            status: "ready",
            source_trust: "trusted",
            scan_status: "ready",
            cache_status: "warm",
            targets: [],
            recovery_actions: [],
          },
        ],
        next_cursor: null,
        source_watermark: "gamma",
      });
      await Promise.all([searchAlpha, searchBeta, searchGamma]);

      expect(capabilities.value.map((item) => item.package_id)).toEqual(["gamma/pkg"]);
      expect(capabilityError.value).toBe("");
    } finally {
      conversationHomeApi.capabilities = originalCapabilities;
    }
  });

  test("private range staging ignores stale results after the session context changes", async () => {
    const browserGlobal = globalThis as typeof globalThis & {
      document?: { querySelector(selector: string): null };
    };
    const originalDocument = browserGlobal.document;
    browserGlobal.document = { querySelector: () => null };
    const { useHomePrivateRangeComposer } = await import(
      "../src/ui/src/composables/useHomePrivateRangeComposer.js"
    );
    const staged = deferred<boolean>();
    const stageRequests: unknown[] = [];

    try {
      const activeRootId = ref<string | null>("root-a");
      const composerEpoch = ref(0);
      const scope = effectScope();
      const composer =
        scope.run(() =>
          useHomePrivateRangeComposer({
            activeRootId,
            composerEpoch,
            async stagePrivateContext(request) {
              stageRequests.push(structuredClone(request));
              return staged.promise;
            },
          }),
        ) ?? null;
      if (!composer) throw new Error("private range composer did not start");

      composer.privateRangeDraft.path = "src/private.ts";
      composer.privateRangeDraft.startLine = "10";
      composer.privateRangeDraft.endLine = "12";
      const staging = composer.stagePrivateRange();

      activeRootId.value = "root-b";
      composerEpoch.value += 1;
      staged.resolve(true);
      await staging;

      expect(stageRequests).toEqual([
        { repo_relative_path: "src/private.ts", start_line: 10, end_line: 12 },
      ]);
      expect(composer.privateRangeOpen.value).toBeFalse();
      expect(composer.privateRangeBusy.value).toBeFalse();
      scope.stop();
    } finally {
      browserGlobal.document = originalDocument;
    }
  });

  test("private range staging aborts on scope dispose before late results can mutate state", async () => {
    const browserGlobal = globalThis as typeof globalThis & {
      document?: { querySelector(selector: string): null };
    };
    const originalDocument = browserGlobal.document;
    browserGlobal.document = { querySelector: () => null };
    const { useHomePrivateRangeComposer } = await import(
      "../src/ui/src/composables/useHomePrivateRangeComposer.js"
    );
    const staged = deferred<boolean>();
    let stageSignal: AbortSignal | undefined;

    try {
      const activeRootId = ref<string | null>("root-a");
      const composerEpoch = ref(0);
      const scope = effectScope();
      const composer =
        scope.run(() =>
          useHomePrivateRangeComposer({
            activeRootId,
            composerEpoch,
            async stagePrivateContext(_request, signal) {
              stageSignal = signal;
              signal?.addEventListener(
                "abort",
                () => staged.reject(new DOMException("The operation was aborted.", "AbortError")),
                { once: true },
              );
              return staged.promise;
            },
          }),
        ) ?? null;
      if (!composer) throw new Error("private range composer did not start");

      composer.privateRangeDraft.path = "src/private.ts";
      composer.privateRangeDraft.startLine = "10";
      composer.privateRangeDraft.endLine = "12";
      const staging = composer.stagePrivateRange();

      expect(stageSignal?.aborted).toBeFalse();
      scope.stop();
      expect(stageSignal?.aborted).toBeTrue();

      await staging;

      expect(composer.privateRangeBusy.value).toBeFalse();
    } finally {
      browserGlobal.document = originalDocument;
    }
  });

  test("queue admissions snapshot only private presence and clear context after success", async () => {
    const requests: Array<{
      idempotency_key?: string;
      content: string;
      private_context_present: boolean;
    }> = [];
    const privateKey = "private-message-key";
    let privateContextPresent = true;
    const capturePrivateContext = () =>
      privateContextPresent
        ? {
            idempotency_key: privateKey,
            private_context_present: true as const,
            clearIfCurrent() {
              privateContextPresent = false;
            },
            restoreIfVacant() {
              if (privateContextPresent) return false;
              privateContextPresent = true;
              return true;
            },
          }
        : null;
    let attempt = 0;
    const activeRevision = computed(
      () =>
        ({
          conversation_id: "conversation-a",
          revision_id: "revision-a",
        }) as unknown as import("../src/ui/src/conversation-home-types.js").HomeRevisionSummary,
    );
    const activeRootId = ref<string | null>("root-a");
    const draft = ref("Use the selected file range.");
    const online = ref(true);
    const submitting = ref(false);
    const submittingToken = ref<string | null>(null);
    const composerError = ref("");
    const activationError = ref("");
    const quoteRefs = ref<HomeQuoteReference[]>([]);
    const reactionBusyTokens = ref<Record<string, string>>({});
    const reactionBusy = ref<Record<string, boolean>>({});
    const pendingActions = ref([]);
    const timeline = ref<HomeTimelineResponse | null>(null);
    const sessions = ref([
      { root_session_id: "root-a", root: { conversation_id: "conversation-a" } },
    ]);
    const sessionQuery = ref("");
    const activation = new ActivationEpoch();
    activation.begin("root-a");
    const selectedConversationId = computed(() => activeRevision.value?.conversation_id ?? null);
    const runtime = createHomeCommandRuntime({
      activation,
      activeRevision,
      activeRootId,
      selectedConversationId,
      draft,
      online,
      submitting,
      submittingToken,
      privateContext: {
        present: () => privateContextPresent,
        captureForMessage: capturePrivateContext,
        captureForCreate: capturePrivateContext,
      },
      composerError,
      activationError,
      quoteRefs,
      reactionBusy,
      reactionBusyTokens,
      pendingActions,
      timeline,
      refreshSessions: async () => undefined,
      refreshActiveSelection: async () => true,
      refreshAuthoritativeActiveHead: async () => true,
      selectSession: async () => undefined,
      sessions,
      sessionQuery,
      messageQueue: {
        enqueue: async (admission) => {
          requests.push({
            idempotency_key: admission.idempotency_key,
            content: admission.content,
            private_context_present: admission.private_context_present,
          });
          attempt += 1;
          if (attempt === 1) throw new Error("send failed");
          admission.clearIfCurrent();
          return true;
        },
        currentEdit: () => null,
        saveEdit: async () => false,
      },
    });

    await runtime.submitDraft();
    expect(composerError.value).toContain("send failed");
    expect(privateContextPresent).toBeTrue();
    expect(requests[0]).toEqual({
      idempotency_key: privateKey,
      content: "Use the selected file range.",
      private_context_present: true,
    });

    await runtime.submitDraft();
    expect(privateContextPresent).toBeFalse();
    expect(draft.value).toBe("");
    expect(requests[1]).toEqual(requests[0]);
  });
});
