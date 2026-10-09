// "bun:test" is imported dynamically (String(...)) so vue-tsc (src/ui build)
// never sees the module dependency — repo pattern, same as ui-turn-timing.test.ts.
const { describe, expect, test } = await import(String("bun:test"));
import type { RenderedHomeTimelineItem } from "../conversation-home-projection.js";
import { buildAgentPresence, liveElapsedMs } from "../lib/agent-presence.js";

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

describe("agent presence", () => {
  const participants = [
    {
      participant_id: "reviewer",
      role_ref: "review",
      engine: "claude" as const,
      model: "oc/reviewer",
    },
    { participant_id: "builder", role_ref: "build", engine: "codex" as const, model: null },
  ];
  test("elapsed seconds are derived from startedAt via turnElapsedMs", () => {
    const rows = buildAgentPresence(
      [
        item({ kind: "user", at: "2026-10-08T00:00:00.000Z" }),
        item({
          kind: "assistant",
          publicAuthorId: "builder",
          title: "Build / Codex",
          at: "2026-10-08T00:01:45.000Z",
          complete: true,
          body: "done",
        }),
      ],
      participants,
    );
    expect(rows.find((row) => row.participantId === "builder")).toMatchObject({
      status: "complete",
      elapsedMs: 105_000,
    });
  });
  test("liveElapsedMs ticks while working and freezes when complete", () => {
    const items = [
      item({ kind: "user", at: "2026-10-08T00:00:00.000Z" }),
      item({
        kind: "assistant",
        publicAuthorId: "builder",
        title: "Build / Codex",
        at: "2026-10-08T00:00:05.000Z",
        complete: false,
        body: "working…",
      }),
    ];
    const working = buildAgentPresence(items, participants).find(
      (row) => row.participantId === "builder",
    );
    if (!working) throw new Error("builder presence row expected while working");
    expect(liveElapsedMs(working, Date.parse("2026-10-08T00:01:01.000Z"))).toBe(61_000);
    const firstItem = items[0];
    if (!firstItem) throw new Error("timeline items[0] expected");
    const finished = buildAgentPresence(
      [
        firstItem,
        item({
          kind: "assistant",
          publicAuthorId: "builder",
          title: "Build / Codex",
          at: "2026-10-08T00:01:45.000Z",
          complete: true,
          body: "done",
        }),
      ],
      participants,
    ).find((row) => row.participantId === "builder");
    if (!finished) throw new Error("builder presence row expected when complete");
    expect(liveElapsedMs(finished, Date.parse("2026-10-08T09:00:00.000Z"))).toBe(105_000);
  });
  test("started tool action as the last attributed item reads as working", () => {
    const rows = buildAgentPresence(
      [
        item({ kind: "user", at: "2026-10-08T00:00:00.000Z" }),
        item({
          kind: "assistant",
          publicAuthorId: "builder",
          title: "Build / Codex",
          at: "2026-10-08T00:00:05.000Z",
          complete: true,
          body: "done",
        }),
        item({
          kind: "tool",
          tool: {
            id: "t1",
            tool: "bun",
            action: "bun test",
            status: "started",
            at: "2026-10-08T00:00:06.000Z",
          },
        }),
      ],
      participants,
    );
    expect(rows.find((row) => row.participantId === "builder")?.status).toBe("working");
  });
  test("tool-group with any started member reads as working; all completed reads complete", () => {
    const base = [
      item({ kind: "user", at: "2026-10-08T00:00:00.000Z" }),
      item({
        kind: "assistant",
        publicAuthorId: "builder",
        title: "Build / Codex",
        at: "2026-10-08T00:00:05.000Z",
        complete: false,
        body: "working…",
      }),
    ];
    const withStarted = buildAgentPresence(
      [
        ...base,
        item({
          kind: "tool-group",
          title: "2 tool actions",
          body: "bun, git",
          tools: [
            {
              id: "g1",
              tool: "bun",
              action: "bun test",
              status: "completed",
              at: "2026-10-08T00:00:06.000Z",
            },
            {
              id: "g2",
              tool: "git",
              action: "git status",
              status: "started",
              at: "2026-10-08T00:00:07.000Z",
            },
          ],
        }),
      ],
      participants,
    );
    expect(withStarted.find((row) => row.participantId === "builder")?.status).toBe("working");
    const allCompleted = buildAgentPresence(
      [
        ...base,
        item({
          kind: "tool-group",
          title: "2 tool actions",
          body: "bun, git",
          tools: [
            {
              id: "g1",
              tool: "bun",
              action: "bun test",
              status: "completed",
              at: "2026-10-08T00:00:06.000Z",
            },
            {
              id: "g2",
              tool: "git",
              action: "git status",
              status: "completed",
              at: "2026-10-08T00:00:07.000Z",
            },
          ],
        }),
      ],
      participants,
    );
    expect(allCompleted.find((row) => row.participantId === "builder")?.status).toBe("complete");
  });
  test("failed tool row freezes finishedAt at the failure time", () => {
    const items = [
      item({ kind: "user", at: "2026-10-08T00:00:00.000Z" }),
      item({
        kind: "assistant",
        publicAuthorId: "builder",
        title: "Build / Codex",
        at: "2026-10-08T00:00:05.000Z",
        complete: true,
        body: "done",
      }),
      item({
        kind: "tool",
        body: "bun test",
        at: "2026-10-08T00:00:06.000Z",
        tool: {
          id: "t1",
          tool: "bun",
          action: "bun test",
          status: "failed",
          at: "2026-10-08T00:00:06.000Z",
        },
      }),
    ];
    const row = buildAgentPresence(items, participants).find(
      (presence) => presence.participantId === "builder",
    );
    if (!row) throw new Error("builder presence row expected for the failed tool");
    expect(row.status).toBe("failed");
    expect(row.finishedAt).toBe("2026-10-08T00:00:06.000Z");
    expect(row.elapsedMs).toBe(6_000);
    expect(liveElapsedMs(row, Date.parse("2026-10-08T09:00:00.000Z"))).toBe(6_000);
  });
  test("failed tool-group freezes finishedAt at its failing last member", () => {
    const items = [
      item({ kind: "user", at: "2026-10-08T00:00:00.000Z" }),
      item({
        kind: "assistant",
        publicAuthorId: "builder",
        title: "Build / Codex",
        at: "2026-10-08T00:00:05.000Z",
        complete: true,
        body: "done",
      }),
      item({
        kind: "tool-group",
        title: "2 tool actions",
        body: "bun, git",
        at: "2026-10-08T00:00:06.000Z",
        tools: [
          {
            id: "g1",
            tool: "bun",
            action: "bun test",
            status: "completed",
            at: "2026-10-08T00:00:06.000Z",
          },
          {
            id: "g2",
            tool: "git",
            action: "git status",
            status: "failed",
            at: "2026-10-08T00:00:08.000Z",
          },
        ],
      }),
    ];
    const row = buildAgentPresence(items, participants).find(
      (presence) => presence.participantId === "builder",
    );
    if (!row) throw new Error("builder presence row expected for the failed tool-group");
    expect(row.status).toBe("failed");
    expect(row.finishedAt).toBe("2026-10-08T00:00:08.000Z");
    expect(row.elapsedMs).toBe(8_000);
  });
});
