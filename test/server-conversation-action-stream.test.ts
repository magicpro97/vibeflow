import { describe, expect, test } from "bun:test";
import type { ActionOperationEventV1, ActionProposalResponseV1 } from "../src/actions/index.js";
import { digestV1 } from "../src/durability/index.js";
import { ConversationActionCursorCodec } from "../src/orchestrator/conversation/conversation-action-cursor.js";
import type { ConversationActionDomainRegistryV1 } from "../src/orchestrator/conversation/conversation-action-registry.js";
import { operationActionEvents } from "../src/server/conversation-action-events-route.js";
import { handleConversationActionRoute } from "../src/server/conversation-action-route.js";

const proposalId = (digit: string) => `vf-proposal-${digit.repeat(64)}`;
const operationId = `vf-operation-${"a".repeat(64)}`;

function proposal(index: number): ActionProposalResponseV1 {
  return {
    schema_version: "1.0",
    proposal: {
      proposal_id: proposalId(String(index)),
      proposal_digest: digestV1("VF-ACTION-STREAM-TEST\0v1\0", { index }),
      created_at: `2026-08-25T00:00:0${index}.000Z`,
    },
    operation: { operation_id: `${operationId.slice(0, -1)}${index}` },
  } as ActionProposalResponseV1;
}

function listAuthority(actions: unknown) {
  return {
    sessions: { authorize: () => true },
    actions: actions as ConversationActionDomainRegistryV1,
    actionCursors: new ConversationActionCursorCodec(Buffer.alloc(32, 9)),
    rootSessionId: () => "root-1",
  };
}

async function routeGet(actions: unknown, target: string, path: string[]) {
  const url = new URL(target);
  return handleConversationActionRoute(
    listAuthority(actions),
    new Request(url.toString()),
    url,
    "conversation-1",
    path,
  );
}

describe("conversation action cursor routes", () => {
  test("pages pending and anchored projections with signed query-bound cursors", async () => {
    let rows = [proposal(3), proposal(2), proposal(1)];
    const actions = {
      pending: async () => rows,
      anchored: async () => rows,
    };
    const first = await routeGet(actions, "http://local/action-proposals?state=pending&limit=1", [
      "action-proposals",
    ]);
    expect(first?.status).toBe(200);
    const firstBody = (await first?.json()) as {
      items: ActionProposalResponseV1[];
      next_cursor: string;
    };
    expect(firstBody.items[0]?.proposal.proposal_id).toBe(proposalId("3"));
    const second = await routeGet(
      actions,
      `http://local/action-proposals?state=pending&limit=1&cursor=${encodeURIComponent(firstBody.next_cursor)}`,
      ["action-proposals"],
    );
    const secondBody = (await second?.json()) as { items: ActionProposalResponseV1[] };
    expect(secondBody.items[0]?.proposal.proposal_id).toBe(proposalId("2"));

    const anchored = await routeGet(
      actions,
      "http://local/action-operations?anchor_kind=event&anchor_event_id=event-1&revision_id=revision-1&limit=1",
      ["action-operations"],
    );
    const anchoredBody = (await anchored?.json()) as { items: unknown[]; next_cursor: string };
    expect(anchoredBody.items).toHaveLength(1);
    expect(anchoredBody.next_cursor.length).toBeGreaterThan(40);

    rows = [proposal(4), ...rows];
    const stale = await routeGet(
      actions,
      `http://local/action-proposals?state=pending&limit=1&cursor=${encodeURIComponent(firstBody.next_cursor)}`,
      ["action-proposals"],
    );
    expect(stale?.status).toBe(409);
    const staleBody = (await stale?.json()) as { error: { code: string; details: unknown } };
    expect(staleBody.error.code).toBe("stale_pending_proposal_cursor");
    expect(staleBody.error.details).toMatchObject({ authority_watermark: expect.any(String) });
  });

  test("rejects a chunked body above one MiB and cancels before consuming the tail", async () => {
    let pulls = 0;
    let canceled = false;
    let proposed = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 40) return controller.close();
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        canceled = true;
      },
    });
    const url = new URL("http://local/action-proposals");
    const response = await handleConversationActionRoute(
      listAuthority({
        propose: async () => {
          proposed += 1;
          throw new Error("must not dispatch");
        },
      }),
      new Request(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      url,
      "conversation-1",
      ["action-proposals"],
    );
    expect(response?.status).toBe(400);
    expect(proposed).toBe(0);
    expect(canceled).toBe(true);
    expect(pulls).toBeLessThan(40);
  });
});

function operationEvent(sequence: number): ActionOperationEventV1 {
  return {
    schema_version: "1.0",
    operation_id: operationId,
    phase_sequence: sequence,
    state: sequence === 0 ? "committing" : "succeeded",
    progress: {
      sequence,
      phase: sequence === 0 ? "dispatch" : "conversation-receipt:succeeded",
      status: sequence === 0 ? "running" : "succeeded",
      message_code:
        sequence === 0 ? "operation.dispatch" : "operation.conversation-receipt:succeeded",
      at: `2026-08-25T00:00:0${sequence}.000Z`,
    },
    target: null,
    error: null,
    occurred_at: `2026-08-25T00:00:0${sequence}.000Z`,
    event_cursor: `vf-operation-event-${String(sequence).repeat(64)}`,
  };
}

describe("conversation action operation SSE", () => {
  test("replays once, streams an append after open, heartbeats exactly, and cleans up", async () => {
    const events = [operationEvent(0)];
    let notify: () => void = () => undefined;
    let unsubscribed = 0;
    const actions = {
      events: async () => [...events],
      subscribe: async (_conversation: string, _proposal: string, listener: () => void) => {
        notify = listener;
        return () => {
          unsubscribed += 1;
        };
      },
    } as unknown as ConversationActionDomainRegistryV1;
    const url = new URL("http://local/events");
    const response = await operationActionEvents(
      { actions, actionHeartbeatMs: 1 },
      new Request(url.toString(), { headers: { accept: "text/event-stream" } }),
      url,
      "conversation-1",
      proposalId("1"),
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing event stream");
    const first = await reader.read();
    const firstText = new TextDecoder().decode(first.value);
    expect(firstText).toContain(`id: ${events[0]?.event_cursor}\nevent: operation\ndata: {`);
    events.push(operationEvent(1));
    notify();
    let output = "";
    for (
      let attempt = 0;
      attempt < 5 && !output.includes(events[1]?.event_cursor ?? "");
      attempt += 1
    ) {
      const part = await reader.read();
      output += new TextDecoder().decode(part.value);
    }
    expect(output.match(new RegExp(`id: ${events[1]?.event_cursor ?? ""}`, "g"))).toHaveLength(1);
    for (let attempt = 0; attempt < 5 && !output.includes("event: heartbeat"); attempt += 1) {
      const part = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("heartbeat did not arrive")), 100),
        ),
      ]);
      output += new TextDecoder().decode(part.value);
    }
    expect(`${firstText}${output}`).toContain("event: heartbeat\ndata: \n\n");
    await reader.cancel();
    expect(unsubscribed).toBe(1);
  });

  test("rejects stale replay cursors before opening a stream", async () => {
    let subscribed = 0;
    const actions = {
      events: async () => [operationEvent(0)],
      subscribe: async () => {
        subscribed += 1;
        return () => undefined;
      },
    } as unknown as ConversationActionDomainRegistryV1;
    const url = new URL(`http://local/events?after=vf-operation-event-${"f".repeat(64)}`);
    const response = await operationActionEvents(
      { actions },
      new Request(url.toString(), { headers: { accept: "text/event-stream" } }),
      url,
      "conversation-1",
      proposalId("1"),
    );
    expect(response.status).toBe(409);
    expect((await response.json()) as object).toMatchObject({
      error: { code: "stale_operation_cursor" },
    });
    expect(subscribed).toBe(0);
  });

  test("a valid Last-Event-ID supersedes the original reconnect query boundary", async () => {
    const events = [operationEvent(0), operationEvent(1), operationEvent(2)];
    const actions = {
      events: async () => events,
      subscribe: async () => () => undefined,
    } as unknown as ConversationActionDomainRegistryV1;
    const url = new URL(`http://local/events?after=${events[0]?.event_cursor}`);
    const response = await operationActionEvents(
      { actions },
      new Request(url.toString(), {
        headers: { "last-event-id": events[1]?.event_cursor ?? "" },
      }),
      url,
      "conversation-1",
      proposalId("1"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: ActionOperationEventV1[] };
    expect(body.items.map((event) => event.phase_sequence)).toEqual([2]);
  });

  test("rejects malformed cursors and does not negotiate parameterized SSE", async () => {
    const actions = {
      events: async () => [operationEvent(0)],
      subscribe: async () => () => undefined,
    } as unknown as ConversationActionDomainRegistryV1;
    const malformed = new URL(`http://local/events?after=${"x".repeat(20_000)}`);
    const malformedResponse = await handleConversationActionRoute(
      listAuthority(actions),
      new Request(malformed.toString(), { headers: { accept: "text/event-stream" } }),
      malformed,
      "conversation-1",
      ["action-proposals", proposalId("1"), "events"],
    );
    expect(malformedResponse?.status).toBe(400);
    const validCursor = operationEvent(0).event_cursor;
    const malformedQueryWithHeader = await handleConversationActionRoute(
      listAuthority(actions),
      new Request(malformed.toString(), { headers: { "last-event-id": validCursor } }),
      malformed,
      "conversation-1",
      ["action-proposals", proposalId("1"), "events"],
    );
    expect(malformedQueryWithHeader?.status).toBe(400);
    const validQuery = new URL(`http://local/events?after=${validCursor}`);
    const malformedHeader = await handleConversationActionRoute(
      listAuthority(actions),
      new Request(validQuery.toString(), { headers: { "last-event-id": "bad-cursor" } }),
      validQuery,
      "conversation-1",
      ["action-proposals", proposalId("1"), "events"],
    );
    expect(malformedHeader?.status).toBe(400);
    const parameterized = new URL("http://local/events");
    const json = await operationActionEvents(
      { actions },
      new Request(parameterized.toString(), {
        headers: { accept: "text/event-stream; charset=utf-8" },
      }),
      parameterized,
      "conversation-1",
      proposalId("1"),
    );
    expect(json.headers.get("content-type")).toContain("application/json");
  });

  test("releases a subscription acquired after request abort", async () => {
    const abort = new AbortController();
    let release = 0;
    let finish!: (value: (() => void) | null) => void;
    const acquired = new Promise<(() => void) | null>((resolve) => {
      finish = resolve;
    });
    const actions = {
      events: async () => [operationEvent(0)],
      subscribe: async () => acquired,
    } as unknown as ConversationActionDomainRegistryV1;
    const url = new URL("http://local/events");
    const response = await operationActionEvents(
      { actions },
      new Request(url.toString(), {
        headers: { accept: "text/event-stream" },
        signal: abort.signal,
      }),
      url,
      "conversation-1",
      proposalId("1"),
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing event stream");
    abort.abort();
    finish(() => {
      release += 1;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect((await reader.read()).done).toBe(true);
    expect(release).toBe(1);
  });
});
