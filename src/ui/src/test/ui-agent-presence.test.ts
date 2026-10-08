// "bun:test" is imported dynamically (String(...)) so vue-tsc (src/ui build)
// never sees the module dependency — repo pattern, same as ui-turn-timing.test.ts.
const { describe, expect, test } = await import(String("bun:test"));
import { homeParticipantDisplayLabel } from "../conversation-home-participant-label.js";
import type { RenderedHomeTimelineItem } from "../conversation-home-projection.js";
import { buildAgentPresence, liveElapsedMs } from "../lib/agent-presence.js";

const item = (partial: Partial<RenderedHomeTimelineItem>): RenderedHomeTimelineItem =>
  ({ id: "i", kind: "user", title: "", body: "", at: null, anchorKey: null, sourceKey: null,
     sourceEventIds: [], conversationId: null, revisionId: null, publicSessionRef: null,
     publicAuthorId: null, messageRef: null, revisionOrdinal: 0, complete: true, evidence: [],
     quoteRefs: [], reactions: [], diagnosticCode: null, operations: [], ...partial } as RenderedHomeTimelineItem);

describe("agent presence", () => {
  const participants = [
    { participant_id: "reviewer", role_ref: "review", engine: "claude" as const, model: "oc/reviewer" },
    { participant_id: "builder", role_ref: "build", engine: "codex" as const, model: null },
  ];
  test("working agent pins first with its latest action and elapsed start", () => {
    const rows = buildAgentPresence(
      [
        item({ kind: "user", at: "2026-10-08T00:00:00.000Z" }),
        item({ kind: "assistant", publicAuthorId: "builder", title: "Build / Codex", at: "2026-10-08T00:00:05.000Z", complete: false, body: "working…" }),
      ],
      participants,
    );
    expect(rows.map((row) => row.participantId)).toEqual(["builder", "reviewer"]);
    expect(rows[0]).toMatchObject({ status: "working", engine: "codex", startedAt: "2026-10-08T00:00:00.000Z", latestAction: "working…" });
    expect(rows[1]).toMatchObject({ status: "idle" });
  });
  test("failed tool pins as failed; later completion restores complete", () => {
    const failed = [
      item({ kind: "user", at: "2026-10-08T00:00:00.000Z" }),
      item({ kind: "assistant", publicAuthorId: "builder", title: "Build / Codex", at: "2026-10-08T00:00:05.000Z", complete: false, body: "working…" }),
      item({ kind: "tool", body: "bun test", tool: { id: "t1", tool: "bun", action: "bun test", status: "failed", at: "2026-10-08T00:00:06.000Z" } }),
    ];
    expect(buildAgentPresence(failed, participants).find((row) => row.participantId === "builder")?.status).toBe("failed");
    const recovered = buildAgentPresence(
      [...failed, item({ kind: "assistant", publicAuthorId: "builder", title: "Build / Codex", at: "2026-10-08T00:01:00.000Z", complete: true, body: "done" })],
      participants,
    );
    expect(recovered.find((row) => row.participantId === "builder")?.status).toBe("complete");
  });
  test("elapsed seconds are derived from startedAt via turnElapsedMs", () => {
    const rows = buildAgentPresence([item({ kind: "user", at: "2026-10-08T00:00:00.000Z" }), item({ kind: "assistant", publicAuthorId: "builder", title: "Build / Codex", at: "2026-10-08T00:01:45.000Z", complete: true, body: "done" })], participants);
    expect(rows.find((row) => row.participantId === "builder")).toMatchObject({ status: "complete", elapsedMs: 105_000 });
  });
  test("liveElapsedMs ticks while working and freezes when complete", () => {
    const items = [item({ kind: "user", at: "2026-10-08T00:00:00.000Z" }), item({ kind: "assistant", publicAuthorId: "builder", title: "Build / Codex", at: "2026-10-08T00:00:05.000Z", complete: false, body: "working…" })];
    const working = buildAgentPresence(items, participants).find((row) => row.participantId === "builder")!;
    expect(liveElapsedMs(working, Date.parse("2026-10-08T00:01:01.000Z"))).toBe(61_000);
    const finished = buildAgentPresence([items[0]!, item({ kind: "assistant", publicAuthorId: "builder", title: "Build / Codex", at: "2026-10-08T00:01:45.000Z", complete: true, body: "done" })], participants).find((row) => row.participantId === "builder")!;
    expect(liveElapsedMs(finished, Date.parse("2026-10-08T09:00:00.000Z"))).toBe(105_000);
  });
  test("failed tool as the last attributed item reads as failed", () => {
    const rows = buildAgentPresence(
      [
        item({ kind: "user", at: "2026-10-08T00:00:00.000Z" }),
        item({ kind: "assistant", publicAuthorId: "builder", title: "Build / Codex", at: "2026-10-08T00:00:05.000Z", complete: true, body: "done" }),
        item({ kind: "tool", tool: { id: "t1", tool: "bun", action: "bun test", status: "failed", at: "2026-10-08T00:00:06.000Z" } }),
      ],
      participants,
    );
    expect(rows.find((row) => row.participantId === "builder")?.status).toBe("failed");
  });
  test("tool-group takes its status from the last group entry", () => {
    const rows = buildAgentPresence(
      [
        item({ kind: "user", at: "2026-10-08T00:00:00.000Z" }),
        item({ kind: "assistant", publicAuthorId: "builder", title: "Build / Codex", at: "2026-10-08T00:00:05.000Z", complete: false, body: "working…" }),
        item({ kind: "tool-group", title: "2 tool actions", body: "bun, git", tools: [
          { id: "g1", tool: "bun", action: "bun test", status: "completed", at: "2026-10-08T00:00:06.000Z" },
          { id: "g2", tool: "git", action: "git status", status: "failed", at: "2026-10-08T00:00:07.000Z" },
        ] }),
      ],
      participants,
    );
    expect(rows.find((row) => row.participantId === "builder")?.status).toBe("failed");
  });
  test("tool-group recovers when its last entry completed after a failure", () => {
    const rows = buildAgentPresence(
      [
        item({ kind: "user", at: "2026-10-08T00:00:00.000Z" }),
        item({ kind: "assistant", publicAuthorId: "builder", title: "Build / Codex", at: "2026-10-08T00:00:05.000Z", complete: false, body: "working…" }),
        item({ kind: "tool-group", title: "2 tool actions", body: "bun, git", tools: [
          { id: "g1", tool: "bun", action: "bun test", status: "failed", at: "2026-10-08T00:00:06.000Z" },
          { id: "g2", tool: "git", action: "git status", status: "completed", at: "2026-10-08T00:00:07.000Z" },
        ] }),
      ],
      participants,
    );
    expect(rows.find((row) => row.participantId === "builder")?.status).toBe("complete");
  });
  test("latest action truncates to 140 characters", () => {
    const rows = buildAgentPresence(
      [
        item({ kind: "user", at: "2026-10-08T00:00:00.000Z" }),
        item({ kind: "assistant", publicAuthorId: "builder", title: "Build / Codex", at: "2026-10-08T00:00:05.000Z", complete: false, body: "x".repeat(200) }),
      ],
      participants,
    );
    expect(rows.find((row) => row.participantId === "builder")?.latestAction?.length).toBe(140);
  });
  test("complete agents sort by label ascending", () => {
    const rows = buildAgentPresence(
      [
        item({ kind: "user", at: "2026-10-08T00:00:00.000Z" }),
        item({ kind: "assistant", publicAuthorId: "reviewer", title: "Review / Claude", at: "2026-10-08T00:00:06.000Z", complete: true, body: "reviewed" }),
        item({ kind: "assistant", publicAuthorId: "builder", title: "Build / Codex", at: "2026-10-08T00:00:07.000Z", complete: true, body: "done" }),
      ],
      participants,
    );
    expect(rows.map((row) => row.participantId)).toEqual(["builder", "reviewer"]);
  });
  test("label matches homeParticipantDisplayLabel", () => {
    const rows = buildAgentPresence([item({ kind: "user", at: "2026-10-08T00:00:00.000Z" })], participants);
    expect(rows.find((row) => row.participantId === "reviewer")?.label).toBe(
      homeParticipantDisplayLabel({ participantId: "reviewer", roleRef: "review", engine: "claude" }),
    );
  });
});
