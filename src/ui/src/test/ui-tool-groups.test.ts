// Pure-function tests for tool-call grouping (no Vue mount infra).
// "bun:test" is imported dynamically (String(...)) so vue-tsc (src/ui build)
// never sees the module dependency — repo pattern, same as ui-use-home-engines.test.ts.
const { describe, expect, test } = await import(String("bun:test"));
import { projectHomeTimeline } from "../conversation-home-projection.js";
import type { RenderedHomeTimelineItem } from "../conversation-home-projection.js";
import { degradedHomeTimelineInteraction } from "../conversation-home-stream.js";
import type { HomeTimelineItem } from "../conversation-home-types.js";
import {
  groupToolItems,
  toolActionItem,
  toolActionStatus,
  toolGroupDetail,
  toolGroupSummary,
} from "../lib/tool-groups.js";

const entry = (id: string, tool: string, status: "started" | "completed" | "failed") => ({
  id,
  tool,
  action: `${tool} call`,
  status,
  at: "2026-10-08T00:00:00.000Z",
});

describe("tool groups", () => {
  test("narrows unknown statuses to started", () => {
    expect(toolActionStatus("completed")).toBe("completed");
    expect(toolActionStatus("failed")).toBe("failed");
    expect(toolActionStatus("nonsense")).toBe("started");
    expect(toolActionStatus(undefined)).toBe("started");
  });

  test("merges consecutive tool items into one group, keeping other items as fences", () => {
    const a = toolActionItem("e1", entry("e1", "claude", "completed"), 1);
    const b = toolActionItem("e2", entry("e2", "git", "failed"), 1);
    const c = toolActionItem("e3", entry("e3", "claude", "started"), 1);
    const fence = {
      ...a,
      id: "u1",
      kind: "user" as const,
      tool: undefined,
      title: "You",
      body: "hi",
    };
    const out = groupToolItems([a, b, fence, c]);
    expect(out.map((item) => item.kind)).toEqual(["tool-group", "user", "tool"]);
    expect(out[0]?.id).toBe("tool-group:e1");
    expect(out[0]?.tools?.map((t) => t.id)).toEqual(["e1", "e2"]);
    expect(out[2]?.tool?.tool).toBe("claude");
  });

  test("a group accumulates operations from every member, not just the first", () => {
    const op = (id: string) =>
      ({ operation_id: id }) as unknown as RenderedHomeTimelineItem["operations"][number];
    const a = toolActionItem("e1", entry("e1", "claude", "completed"), 1, [op("op-1")]);
    const b = toolActionItem("e2", entry("e2", "git", "completed"), 1, [op("op-2"), op("op-3")]);
    const out = groupToolItems([a, b]);
    expect(out[0]?.operations.map((operation) => operation.operation_id)).toEqual([
      "op-1",
      "op-2",
      "op-3",
    ]);
    // A lone tool item keeps its own operations untouched.
    const single = groupToolItems([a]);
    expect(single[0]?.operations.map((operation) => operation.operation_id)).toEqual(["op-1"]);
  });

  test("a lone tool item stays a plain tool item", () => {
    const single = toolActionItem("e9", entry("e9", "codex", "completed"), 1);
    const out = groupToolItems([single]);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("tool");
  });

  test("grouping resets at ANY non-tool item, including round boundaries", () => {
    const a = toolActionItem("e1", entry("e1", "claude", "completed"), 1);
    const b = toolActionItem("e2", entry("e2", "git", "completed"), 1);
    const boundary = {
      ...a,
      id: "b1",
      kind: "boundary" as const,
      tool: undefined,
      title: "New round",
      body: "",
    };
    const out = groupToolItems([a, boundary, b]);
    expect(out.map((item) => item.kind)).toEqual(["tool", "boundary", "tool"]);
  });

  test("summarizes failure, running, and completed-only groups", () => {
    expect(toolGroupSummary([entry("1", "a", "completed"), entry("2", "b", "completed")])).toBe(
      "2 tool actions · 2 completed",
    );
    expect(toolGroupSummary([entry("1", "a", "failed"), entry("2", "b", "started")])).toBe(
      "2 tool actions · 1 failed · 1 running",
    );
    expect(toolGroupDetail([entry("1", "a", "completed"), entry("2", "a", "completed")])).toBe("a");
  });

  test("projection integration: consecutive tool_action records render as one group", () => {
    const eventBase = {
      workflow_id: "workflow",
      conversation_id: "conversation-a",
      revision_id: "revision-a",
      run_id: "run",
      turn_id: "turn",
      operation_id: "operation",
      attempt_id: "attempt",
      public_session_ref: null,
    };
    const item = (eventId: string, seq: number, ts: string, event: unknown): HomeTimelineItem =>
      ({
        kind: "conversation-event",
        revision_ordinal: 0,
        action_operations: { items: [] },
        event: { ...eventBase, event_id: eventId, seq, ts, event },
        interaction: degradedHomeTimelineInteraction(),
      }) as unknown as HomeTimelineItem; // deliberate double-cast: repo tests build these literals this way
    const timeline = [
      item("event-user", 1, "2026-10-08T00:00:00.000Z", {
        type: "user_message",
        payload: { content: "run the tests", target_participants: "all" },
      }),
      item("event-tool-1", 2, "2026-10-08T00:00:01.000Z", {
        type: "tool_action",
        payload: {
          tool: "claude",
          action: "ran tests",
          status: "completed",
          input_ref: null,
          output_ref: null,
        },
      }),
      item("event-tool-2", 3, "2026-10-08T00:00:02.000Z", {
        type: "tool_action",
        payload: {
          tool: "git",
          action: "status",
          status: "completed",
          input_ref: null,
          output_ref: null,
        },
      }),
    ];
    const out = projectHomeTimeline(timeline);
    const groups = out.filter((entry) => entry.kind === "tool-group");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.title).toBe("2 tool actions · 2 completed");
    expect(groups[0]?.tools?.map((tool) => tool.tool)).toEqual(["claude", "git"]);
  });
});
