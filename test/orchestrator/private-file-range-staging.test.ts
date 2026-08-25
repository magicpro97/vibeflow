import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PrivateFileRangeStagingStoreV1,
  createPrivateFileRangeHandoffId,
} from "../../src/orchestrator/conversation/private-file-range-staging-store.js";

test("private file range staging preserves exact text and supports retry before consume", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-private-range-stage-"));
  try {
    const store = new PrivateFileRangeStagingStoreV1(root);
    const binding = store.stage({
      handoff_id: createPrivateFileRangeHandoffId(),
      repo_relative_path: "src/example.ts",
      start_line: 1,
      end_line: 2,
      content: "one\r\ntwo\n",
      staged_at: "2026-08-25T00:00:00.000Z",
    });

    store.reserve(binding, "message-key", "2026-08-25T00:00:01.000Z");
    store.release(binding, "message-key", "2026-08-25T00:00:02.000Z");
    store.reserve(binding, "message-key", "2026-08-25T00:00:03.000Z");
    store.consume(binding, "message-key", "conversation:create", "2026-08-25T00:00:04.000Z");

    expect(store.content(binding)).toEqual({
      repo_relative_path: "src/example.ts",
      start_line: 1,
      end_line: 2,
      line_count: 2,
      content: "one\r\ntwo\n",
    });
    expect(store.readFrames(binding.handoff_id).map((frame) => frame.state)).toEqual([
      "available",
      "reserved",
      "available",
      "reserved",
      "consumed",
    ]);

    const restarted = new PrivateFileRangeStagingStoreV1(root);
    expect(restarted.content(binding).content).toBe("one\r\ntwo\n");
    restarted.consume(binding, "message-key", "conversation:create", "2026-08-25T00:00:04.000Z");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private file range staging rejects tamper and replay conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-private-range-stage-"));
  try {
    const store = new PrivateFileRangeStagingStoreV1(root);
    const binding = store.stage({
      handoff_id: createPrivateFileRangeHandoffId(),
      repo_relative_path: "src/example.ts",
      start_line: 4,
      end_line: 6,
      content: "four\nfive\nsix",
      staged_at: "2026-08-25T00:00:00.000Z",
    });

    expect(() => store.content({ ...binding, end_line: 7, line_count: 4 })).toThrow("binding");

    const recordPath = join(
      root,
      "actions",
      "v1",
      "private-file-range-records",
      `${binding.handoff_id}.json`,
    );
    writeFileSync(recordPath, JSON.stringify({ corrupted: true }), { mode: 0o600 });
    expect(() => store.content(binding)).toThrow("corrupt");

    const cleanRoot = await mkdtemp(join(tmpdir(), "vf-private-range-stage-"));
    try {
      const clean = new PrivateFileRangeStagingStoreV1(cleanRoot);
      const replay = clean.stage({
        handoff_id: createPrivateFileRangeHandoffId(),
        repo_relative_path: "src/replay.ts",
        start_line: 1,
        end_line: 1,
        content: "replay",
        staged_at: "2026-08-25T00:00:00.000Z",
      });
      clean.reserve(replay, "message-a", "2026-08-25T00:00:01.000Z");
      clean.consume(replay, "message-a", "conversation:message", "2026-08-25T00:00:02.000Z");
      expect(() => clean.reserve(replay, "message-b", "2026-08-25T00:00:03.000Z")).toThrow(
        "available",
      );
    } finally {
      await rm(cleanRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
