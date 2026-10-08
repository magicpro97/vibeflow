// "bun:test" is imported dynamically (String(...)) so vue-tsc (src/ui build)
// never sees the module dependency — repo pattern, same as ui-agent-presence.test.ts.
const { describe, expect, test } = await import(String("bun:test"));
import type { RenderedHomeTimelineItem } from "../conversation-home-projection.js";
import { buildAgentActivity } from "../lib/agent-activity.js";
import { attributeItemsToParticipants } from "../lib/agent-presence.js";

const item = (partial: Partial<RenderedHomeTimelineItem>): RenderedHomeTimelineItem =>
  ({
    id: "i",
    kind: "user",
    title: "",
    body: "",
    at: null,
    anchorKey: null,
    sourceKey: null,
    sourceEventIds: [],
    conversationId: null,
    revisionId: null,
    publicSessionRef: null,
    publicAuthorId: null,
    messageRef: null,
    revisionOrdinal: 0,
    complete: true,
    evidence: [],
    quoteRefs: [],
    reactions: [],
    diagnosticCode: null,
    operations: [],
    ...partial,
  }) as RenderedHomeTimelineItem;

const assistant = (
  publicAuthorId: string,
  id: string,
  at: string | null = null,
  complete = false,
) =>
  item({
    id,
    kind: "assistant",
    publicAuthorId,
    at,
    complete,
    title: `${publicAuthorId} / engine`,
    body: `${publicAuthorId}…`,
  });

const tool = (id: string, at: string | null = null) =>
  item({
    id,
    kind: "tool",
    at,
    tool: { id, tool: "bun", action: "bun test", status: "completed", at },
  });

describe("agent activity", () => {
  test("assistant run owns its following tool items, original order", () => {
    const items = [assistant("builder", "a1"), tool("t1"), tool("t2")];
    expect(buildAgentActivity(items, "builder").map((entry) => entry.item.id)).toEqual([
      "a1",
      "t1",
      "t2",
    ]);
  });
  test("each participant owns only the tools after its own assistant row", () => {
    const items = [assistant("builder", "a1"), tool("t1"), assistant("reviewer", "a2"), tool("t2")];
    expect(buildAgentActivity(items, "builder").map((entry) => entry.item.id)).toEqual([
      "a1",
      "t1",
    ]);
    expect(buildAgentActivity(items, "reviewer").map((entry) => entry.item.id)).toEqual([
      "a2",
      "t2",
    ]);
  });
  test("empty items yield an empty feed", () => {
    expect(buildAgentActivity([], "builder")).toEqual([]);
  });
  test("other participants' items are excluded", () => {
    const items = [assistant("builder", "a1"), assistant("reviewer", "a2")];
    expect(buildAgentActivity(items, "builder").map((entry) => entry.item.id)).toEqual(["a1"]);
  });
  test("user rows are excluded even mid-run and never steal the cursor", () => {
    const items = [
      assistant("builder", "a1"),
      item({ id: "h1", kind: "user", publicAuthorId: "human" }),
      tool("t1"),
    ];
    expect(buildAgentActivity(items, "builder").map((entry) => entry.item.id)).toEqual([
      "a1",
      "t1",
    ]);
  });
  test("at mirrors the item's own at", () => {
    const items = [
      assistant("builder", "a1", "2026-10-08T00:00:05.000Z"),
      tool("t1", "2026-10-08T00:00:06.000Z"),
      item({ id: "a2", kind: "assistant", publicAuthorId: "builder", at: null }),
    ];
    expect(buildAgentActivity(items, "builder").map((entry) => entry.at)).toEqual([
      "2026-10-08T00:00:05.000Z",
      "2026-10-08T00:00:06.000Z",
      null,
    ]);
  });
  test("unknown participant yields an empty feed", () => {
    expect(buildAgentActivity([assistant("builder", "a1")], "nobody")).toEqual([]);
  });
  test("attributeItemsToParticipants maps interleaved runs to ascending indexes", () => {
    const items = [
      assistant("builder", "a1"),
      tool("t1"),
      assistant("reviewer", "a2"),
      tool("t2"),
      tool("t3"),
      item({ id: "h1", kind: "user", publicAuthorId: "human" }),
    ];
    const attribution = attributeItemsToParticipants(items);
    expect([...attribution.keys()]).toEqual(["builder", "reviewer"]);
    expect(attribution.get("builder")).toEqual([0, 1]);
    expect(attribution.get("reviewer")).toEqual([2, 3, 4]);
  });
});
