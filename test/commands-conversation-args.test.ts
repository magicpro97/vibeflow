import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONVERSATION_EXIT,
  classifyConversationResult,
  executeConversationMessage,
  productionLibraries,
} from "../src/commands/conversation-args.js";
import { buildConversationHttpAuthority } from "../src/commands/conversation-http.js";
import type { EngineProcessSpawner } from "../src/dispatch/session-types.js";
import type { PublicStoredTraceEvent } from "../src/orchestrator/trace/types.js";
import { startServer } from "../src/server.js";
import { type PolicyVerifyReport, VERIFY_GATE_ORDER, gateResult } from "../src/verify/core.js";

function streamText(text = ""): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function completedEngineProcess(stdout = "") {
  return {
    stdin: { write: () => {}, end: () => {} },
    stdout: streamText(stdout),
    stderr: streamText(),
    exited: Promise.resolve(0),
    kill: () => {},
  };
}

function queueSpawner(outputs: string[]): EngineProcessSpawner {
  return () => completedEngineProcess(outputs.shift() ?? "");
}

const event = (
  seq: number,
  conversationId: string,
  type: string,
  payload: unknown,
): PublicStoredTraceEvent =>
  ({
    workflow_id: "workflow-1",
    conversation_id: conversationId,
    revision_id: `revision-${conversationId}`,
    run_id: "run-1",
    turn_id: `turn-${seq}`,
    operation_id: "operation-1",
    attempt_id: "attempt-1",
    event_id: `event-${seq}`,
    seq,
    ts: "2026-08-22T00:00:00.000Z",
    public_session_ref: null,
    event: { type, payload },
  }) as unknown as PublicStoredTraceEvent;

const fullVerifyManifest = (): PolicyVerifyReport =>
  Object.fromEntries(
    VERIFY_GATE_ORDER.map((name) => [name, gateResult("pass", `${name} ok`)]),
  ) as PolicyVerifyReport;

describe("conversation command helpers", () => {
  test("stopped is a distinct success exit", () => {
    expect(classifyConversationResult("stopped", [])).toBe(CONVERSATION_EXIT.ok);
  });

  test("awaiting approval is an accepted nonterminal success exit", () => {
    expect(classifyConversationResult("awaiting_approval", [])).toBe(CONVERSATION_EXIT.ok);
  });

  test("buildConversationHttpAuthority caches one process-local authority per repo/host mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-conversation-http-"));
    try {
      const loopback = buildConversationHttpAuthority({}, undefined, dir);
      const secondLoopback = buildConversationHttpAuthority({}, "127.0.0.1", dir);
      const lan = buildConversationHttpAuthority({}, "0.0.0.0", dir);
      const ipv6Loopback = buildConversationHttpAuthority({}, "::1", dir);
      expect(loopback).toBe(secondLoopback);
      expect(ipv6Loopback).toBe(loopback);
      expect(loopback.sessions.loopback).toBe(true);
      expect(loopback.sessions.issueCookie()).not.toBeNull();
      expect(lan.sessions.loopback).toBe(false);
      expect(lan.sessions.issueCookie()).toBeNull();
      const running = await startServer(0, { host: "::1", conversation: ipv6Loopback });
      try {
        expect(running.url).toMatch(/^http:\/\/\[::1\]:\d+$/);
      } finally {
        running.server.stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("plan updates persist the authoritative sidecar and review stays deterministic human-only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-plan-sidecar-"));
    try {
      const libraries = productionLibraries(dir);
      const context = {
        topic: "Draft a rollout",
        participantIds: ["participant-1"],
        correlation: { revision_id: "revision-1" },
        launchAttempt: ({ purpose }: { purpose: "plan" | "review" }) => ({
          completion: Promise.resolve({
            ok: true,
            output: purpose === "plan" ? "# Initial plan\n" : '```json\n{"verdict":"approve"}\n```',
          }),
        }),
      };
      const created = await libraries.plan.create({ context: context as never });
      expect(readFileSync(join(dir, ".vibeflow", "plans", "revision-1.md"), "utf8")).toContain(
        "# Initial plan",
      );
      await libraries.plan.update?.({
        context: context as never,
        revision: {
          revision_id: "revision-2",
          content: "Revise the rollout section",
          reason: "conversation revision",
        },
        previous: { artifact_id: "artifact-1", revision_id: "revision-1", ref: "vf-artifact-1" },
      });
      const review = await libraries.review.review({
        context: context as never,
        artifact: { artifact_id: "artifact-2", revision_id: "revision-2", ref: "vf-artifact-2" },
        mode: "human-only",
        head_sha: "a".repeat(40),
      });
      expect(readFileSync(join(dir, ".vibeflow", "plans", "revision-2.md"), "utf8")).toContain(
        "Revise the rollout section",
      );
      expect(review).toEqual({
        reviewed_head: "a".repeat(40),
        reviewer: "human-only",
        outcome: "changes_requested",
        evidence_refs: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("executeConversationMessage replays an immediately completed child revision", async () => {
    const childId = "conversation-child";
    const childEvents = [
      event(1, childId, "agent_response_delta", {
        round_id: "direct:operation-1",
        participant_id: "participant-1",
        content_delta: "child answer",
        final_claim: "child answer",
        final_evidence: [],
        completes_response: true,
      }),
      event(2, childId, "conversation_terminal", {
        lifecycle: "COMPLETED",
        terminal: true,
        final_score: null,
      }),
    ];
    const service = {
      message: async () => ({
        message_id: "message-1",
        accepted: true as const,
        child_conversation_id: childId,
      }),
      snapshot: async (id: string) =>
        id === childId
          ? ({ lifecycle: "COMPLETED", last_seq: 2 } as never)
          : ({ lifecycle: "COMPLETED", last_seq: 5 } as never),
      events: async (_id: string, afterSeq: number) =>
        childEvents.filter((record) => record.seq > afterSeq),
      subscribe: (id: string, listener: (record: any) => void, afterSeq = 0) =>
        Object.assign(() => undefined, {
          replayReady: (async () => {
            for (const record of await service.events(id, afterSeq)) listener(record);
          })(),
        }),
    };

    const result = await executeConversationMessage(service as never, "conversation-parent", "go");

    expect(result).toMatchObject({
      conversationId: childId,
      childConversationId: childId,
      status: "completed",
      output: "child answer",
    });
    expect(result.events.map((record) => record.seq)).toEqual([1, 2]);
  });

  test("executeConversationMessage waits on an active target and never returns accepted blank output", async () => {
    const targetId = "conversation-1";
    const targetEvents = [
      event(2, targetId, "agent_response_delta", {
        round_id: "direct:operation-1",
        participant_id: "participant-1",
        content_delta: "updated answer",
        final_claim: "updated answer",
        final_evidence: [],
        completes_response: true,
      }),
      event(3, targetId, "conversation_terminal", {
        lifecycle: "COMPLETED",
        terminal: true,
        final_score: null,
      }),
    ];
    const snapshots = [
      { lifecycle: "ACTIVE", last_seq: 1 },
      { lifecycle: "ACTIVE", last_seq: 1 },
      { lifecycle: "COMPLETED", last_seq: 3 },
    ];
    let snapshotIndex = 0;
    const chunks: string[] = [];
    const service = {
      message: async () => ({ message_id: "message-1", accepted: true as const }),
      snapshot: async () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)] as never,
      events: async (_id: string, afterSeq: number) =>
        targetEvents.filter((record) => record.seq > afterSeq),
      subscribe: (id: string, listener: (record: any) => void, afterSeq = 0) =>
        Object.assign(() => undefined, {
          replayReady: (async () => {
            for (const record of await service.events(id, afterSeq)) {
              listener(record);
            }
          })(),
        }),
    };

    const result = await executeConversationMessage(
      service as never,
      targetId,
      "continue",
      (chunk) => chunks.push(chunk),
    );

    expect(result.status).toBe("completed");
    expect(result.output).toBe("updated answer");
    expect(result.childConversationId).toBeUndefined();
    expect(result.events.map((record) => record.seq)).toEqual([2, 3]);
    expect(chunks).toEqual(["updated answer"]);
  });

  test("production verify library returns the exact authoritative gate manifest from one async collector run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-verify-library-"));
    try {
      let calls = 0;
      const manifest = fullVerifyManifest();
      manifest.waiver = gateResult("fail", "waiver policy failed");
      const libraries = productionLibraries(dir, {
        collectVerify: async () => {
          calls += 1;
          return {
            ok: false,
            confidence: 0,
            gates: manifest,
            toolchain: [],
            policy: { ok: false, failures: ["waiver"], warnings: [], passed: [] },
          };
        },
      });

      expect(
        await libraries.verify.run({
          context: {} as never,
          artifact: { artifact_id: "artifact-1", revision_id: "revision-1", ref: "vf-artifact-1" },
        }),
      ).toEqual(manifest);
      expect(calls).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
