import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS } from "../src/orchestrator/conversation/conversation-private-context-broker-contract.js";
import {
  PRIVATE_FILE_RANGES_STAGING_STORAGE,
  PrivateFileRangesStagingStoreV1,
  createPrivateFileRangesHandoffId,
} from "../src/orchestrator/conversation/private-file-ranges-staging-store.js";

const stamp = "2026-09-14T00:00:00.000Z";

function recordDirectory(root: string): string {
  return join(root, "actions", "v1", PRIVATE_FILE_RANGES_STAGING_STORAGE.RECORDS_DIRECTORY);
}

async function fixture(): Promise<{ root: string; artifactRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "vf-private-ranges-stage-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/a.ts"), "a-one\na-two\na-three\n", { mode: 0o600 });
  writeFileSync(join(root, "src/b.ts"), "b-one\nb-two\nb-three\n", { mode: 0o600 });
  return { root, artifactRoot: join(root, "state") };
}

test("stages normalized ranges from multiple files with deterministic aggregate content", async () => {
  const value = await fixture();
  try {
    const store = new PrivateFileRangesStagingStoreV1(value.artifactRoot, value.root);
    const binding = store.stage({
      handoff_id: createPrivateFileRangesHandoffId(),
      ranges: [
        { repo_relative_path: "src/b.ts", start_line: 2, end_line: 3 },
        { repo_relative_path: "src/a.ts", start_line: 1, end_line: 1 },
        { repo_relative_path: "src/a.ts", start_line: 2, end_line: 2 },
      ],
      staged_at: stamp,
    });

    expect(binding).toMatchObject({
      file_count: 2,
      range_count: 2,
      total_line_count: 4,
      staged_at: stamp,
    });
    expect(store.content(binding)).toMatchObject({
      file_count: 2,
      range_count: 2,
      total_line_count: 4,
      ranges: [
        {
          repo_relative_path: "src/a.ts",
          start_line: 1,
          end_line: 2,
          line_count: 2,
          content: "a-one\na-two\n",
        },
        {
          repo_relative_path: "src/b.ts",
          start_line: 2,
          end_line: 3,
          line_count: 2,
          content: "b-two\nb-three\n",
        },
      ],
    });
    expect(store.readFrames(binding.handoff_id)).toHaveLength(1);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("rejects any invalid member before committing an aggregate record", async () => {
  const value = await fixture();
  try {
    writeFileSync(join(value.root, "invalid.bin"), Buffer.from([0xc3, 0x28]), { mode: 0o600 });
    writeFileSync(join(value.root, "binary.bin"), Buffer.from([0x61, 0x00]), { mode: 0o600 });
    writeFileSync(join(value.root, "oversized.bin"), Buffer.alloc(1_024 * 1_024 + 1, 0x61), {
      mode: 0o600,
    });
    symlinkSync(join(value.root, "src/a.ts"), join(value.root, "link.ts"));
    const store = new PrivateFileRangesStagingStoreV1(value.artifactRoot, value.root);
    for (const repo_relative_path of [
      "missing.ts",
      "link.ts",
      "invalid.bin",
      "binary.bin",
      "oversized.bin",
    ]) {
      const handoffId = createPrivateFileRangesHandoffId();
      expect(() =>
        store.stage({
          handoff_id: handoffId,
          ranges: [{ repo_relative_path, start_line: 1, end_line: 1 }],
          staged_at: stamp,
        }),
      ).toThrow();
      expect(
        existsSync(join(recordDirectory(value.artifactRoot), `${handoffId}.json`)),
      ).toBeFalse();
    }
    expect(readdirSync(recordDirectory(value.artifactRoot))).toEqual([]);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("rejects aggregate range, file, and line limits before reading files", async () => {
  const value = await fixture();
  try {
    const store = new PrivateFileRangesStagingStoreV1(value.artifactRoot, value.root);
    const tooManyRanges = Array.from(
      { length: CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxRanges + 1 },
      (_, index) => ({ repo_relative_path: `src/${index}.ts`, start_line: 1, end_line: 1 }),
    );
    const tooManyFiles = Array.from(
      { length: CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxFiles + 1 },
      (_, index) => ({ repo_relative_path: `src/file-${index}.ts`, start_line: 1, end_line: 1 }),
    );
    const tooManyLines = Array.from({ length: 6 }, (_, index) => ({
      repo_relative_path: `src/${String.fromCharCode(99 + index)}.ts`,
      start_line: 1,
      end_line: 200,
    }));
    for (const ranges of [tooManyRanges, tooManyFiles, tooManyLines]) {
      expect(() =>
        store.stage({
          handoff_id: createPrivateFileRangesHandoffId(),
          ranges,
          staged_at: stamp,
        }),
      ).toThrow();
    }
    expect(readdirSync(recordDirectory(value.artifactRoot))).toEqual([]);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("replays identical aggregate requests and conflicts on changed ranges", async () => {
  const value = await fixture();
  try {
    const store = new PrivateFileRangesStagingStoreV1(value.artifactRoot, value.root);
    const handoffId = createPrivateFileRangesHandoffId();
    const request = {
      handoff_id: handoffId,
      ranges: [{ repo_relative_path: "src/a.ts", start_line: 1, end_line: 2 }],
      staged_at: stamp,
    } as const;
    const first = store.stage(request);
    const recordPath = join(recordDirectory(value.artifactRoot), `${handoffId}.json`);
    const before = Bun.file(recordPath).size;
    expect(store.stage(request)).toEqual(first);
    expect(Bun.file(recordPath).size).toBe(before);
    expect(() =>
      store.stage({
        ...request,
        ranges: [{ repo_relative_path: "src/a.ts", start_line: 2, end_line: 3 }],
      }),
    ).toThrow("request changed");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("aggregate digest changes when member source content changes", async () => {
  const value = await fixture();
  try {
    const request = {
      ranges: [{ repo_relative_path: "src/a.ts", start_line: 1, end_line: 1 }],
      staged_at: stamp,
    } as const;
    const first = new PrivateFileRangesStagingStoreV1(value.artifactRoot, value.root).stage({
      ...request,
      handoff_id: createPrivateFileRangesHandoffId(),
    });
    writeFileSync(join(value.root, "src/a.ts"), "changed\na-two\na-three\n", { mode: 0o600 });
    const second = new PrivateFileRangesStagingStoreV1(value.artifactRoot, value.root).stage({
      ...request,
      handoff_id: createPrivateFileRangesHandoffId(),
    });

    expect(first.aggregate_digest).not.toBe(second.aggregate_digest);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("rejects merged ranges above per-range limit before reading members", async () => {
  const value = await fixture();
  try {
    const handoffId = createPrivateFileRangesHandoffId();
    writeFileSync(
      join(value.root, "src/merged.ts"),
      `${Array.from({ length: 400 }, (_, index) => `line-${index + 1}`).join("\\n")}\\n`,
      { mode: 0o600 },
    );
    const store = new PrivateFileRangesStagingStoreV1(value.artifactRoot, value.root);
    expect(() =>
      store.stage({
        handoff_id: handoffId,
        ranges: [
          { repo_relative_path: "src/merged.ts", start_line: 1, end_line: 200 },
          { repo_relative_path: "src/merged.ts", start_line: 201, end_line: 400 },
        ],
        staged_at: stamp,
      }),
    ).toThrow("invalid private file ranges aggregate");
    expect(existsSync(join(recordDirectory(value.artifactRoot), `${handoffId}.json`))).toBeFalse();
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
