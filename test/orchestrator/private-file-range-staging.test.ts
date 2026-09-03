import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestV1, encodeVffrFrame } from "../../src/durability/index.js";
import type { JsonValue } from "../../src/durability/index.js";
import {
  type PRIVATE_FILE_RANGE_HANDOFF_BINDING_FIELDS,
  PRIVATE_FILE_RANGE_HANDOFF_BINDING_FIELD_CONTRACT_EXACT,
  PRIVATE_FILE_RANGE_STAGING_DIGEST_DOMAIN,
  type PRIVATE_FILE_RANGE_STAGING_FRAME_FIELDS,
  PRIVATE_FILE_RANGE_STAGING_LIMIT,
  type PRIVATE_FILE_RANGE_STAGING_RECORD_FIELDS,
  PRIVATE_FILE_RANGE_STAGING_SCHEMA_VERSION,
  PRIVATE_FILE_RANGE_STAGING_STATE,
  PRIVATE_FILE_RANGE_STAGING_STORAGE,
  type PrivateFileRangeHandoffBindingV1,
  type PrivateFileRangeStagingFrameV1,
  type PrivateFileRangeStagingRecordV1,
  assertPrivateFileRangeHandoffBindingV1,
  assertPrivateFileRangeStagingFrameChain,
  assertPrivateFileRangeStagingFrameV1,
} from "../../src/orchestrator/conversation/private-file-range-staging-contract.js";
import {
  PrivateFileRangeStagingStoreV1,
  createPrivateFileRangeHandoffId,
} from "../../src/orchestrator/conversation/private-file-range-staging-store.js";

type SameKeys<RecordType, Fields extends readonly PropertyKey[]> = Exclude<
  keyof RecordType,
  Fields[number]
> extends never
  ? Exclude<Fields[number], keyof RecordType> extends never
    ? true
    : false
  : false;

const stagingFrameFieldParity = true satisfies SameKeys<
  PrivateFileRangeStagingFrameV1,
  typeof PRIVATE_FILE_RANGE_STAGING_FRAME_FIELDS
>;
const stagingRecordFieldParity = true satisfies SameKeys<
  PrivateFileRangeStagingRecordV1,
  typeof PRIVATE_FILE_RANGE_STAGING_RECORD_FIELDS
>;
const handoffBindingFieldParity = true satisfies SameKeys<
  PrivateFileRangeHandoffBindingV1,
  typeof PRIVATE_FILE_RANGE_HANDOFF_BINDING_FIELDS
>;

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
    const frames = store.readFrames(binding.handoff_id);
    expect(frames.map((frame) => frame.state)).toEqual([
      PRIVATE_FILE_RANGE_STAGING_STATE.AVAILABLE,
      PRIVATE_FILE_RANGE_STAGING_STATE.RESERVED,
      PRIVATE_FILE_RANGE_STAGING_STATE.AVAILABLE,
      PRIVATE_FILE_RANGE_STAGING_STATE.RESERVED,
      PRIVATE_FILE_RANGE_STAGING_STATE.CONSUMED,
    ]);
    expect(() => assertPrivateFileRangeStagingFrameChain(frames)).not.toThrow();
    const authorityDrift = structuredClone(frames);
    const reserved = authorityDrift[1] as PrivateFileRangeStagingFrameV1;
    reserved.handoff_record_digest = `sha256:${"f".repeat(64)}`;
    expect(() => assertPrivateFileRangeStagingFrameChain(authorityDrift)).toThrow(
      "frame authority changed",
    );
    const linkDrift = structuredClone(frames);
    const linked = linkDrift[1] as PrivateFileRangeStagingFrameV1;
    linked.previous_frame_digest = `sha256:${"e".repeat(64)}`;
    expect(() => assertPrivateFileRangeStagingFrameChain(linkDrift)).toThrow("frame link changed");

    const restarted = new PrivateFileRangeStagingStoreV1(root);
    expect(restarted.content(binding).content).toBe("one\r\ntwo\n");
    restarted.consume(binding, "message-key", "conversation:create", "2026-08-25T00:00:04.000Z");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private file range staging rejects re-digested unknown and extended frame protocols", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-private-range-stage-contract-"));
  try {
    expect(stagingFrameFieldParity).toBe(true);
    expect(stagingRecordFieldParity).toBe(true);
    expect(handoffBindingFieldParity).toBe(true);
    expect(PRIVATE_FILE_RANGE_HANDOFF_BINDING_FIELD_CONTRACT_EXACT).toBe(true);
    const store = new PrivateFileRangeStagingStoreV1(root);
    const binding = store.stage({
      handoff_id: createPrivateFileRangeHandoffId(),
      repo_relative_path: "src/protocol.ts",
      start_line: 1,
      end_line: 1,
      content: "protocol",
      staged_at: "2026-08-25T00:00:00.000Z",
    });
    expect(() => assertPrivateFileRangeHandoffBindingV1(binding)).not.toThrow();
    expect(() =>
      assertPrivateFileRangeHandoffBindingV1({ ...binding, extension: "re-digested" }),
    ).toThrow("invalid private file range handoff binding");
    const inheritedBinding = Object.assign(Object.create({ inherited: true }), binding);
    expect(() => assertPrivateFileRangeHandoffBindingV1(inheritedBinding)).toThrow(
      "invalid private file range handoff binding",
    );
    const preimage = {
      schema_version: PRIVATE_FILE_RANGE_STAGING_SCHEMA_VERSION,
      handoff_id: binding.handoff_id,
      sequence: 0,
      previous_frame_digest: null,
      handoff_record_digest: binding.handoff_record_digest,
      state: "invented",
      reservation_key: null,
      consumed_by: null,
      recorded_at: "2026-08-25T00:00:00.000Z",
      extension: true,
    } as const;
    const malformed = {
      ...preimage,
      frame_digest: digestV1(PRIVATE_FILE_RANGE_STAGING_DIGEST_DOMAIN.FRAME, preimage),
    };
    expect(() => assertPrivateFileRangeStagingFrameV1(malformed)).toThrow(
      "invalid private file range staging frame",
    );

    const permissiveCodec = {
      domain: PRIVATE_FILE_RANGE_STAGING_STORAGE.DOMAIN,
      maxFrames: PRIVATE_FILE_RANGE_STAGING_LIMIT.MAX_FRAMES,
      maxPayloadBytes: PRIVATE_FILE_RANGE_STAGING_LIMIT.MAX_RECORD_BYTES,
      maxAggregateBytes:
        PRIVATE_FILE_RANGE_STAGING_LIMIT.MAX_RECORD_BYTES *
        PRIVATE_FILE_RANGE_STAGING_LIMIT.MAX_FRAMES,
      validatePayload: () => undefined,
      computePayloadDigest: (payload: Record<string, unknown>) => String(payload.frame_digest),
      validateJournalIdentity: () => true,
    };
    const encoded = encodeVffrFrame(
      PRIVATE_FILE_RANGE_STAGING_STORAGE.DOMAIN,
      malformed as unknown as JsonValue,
      permissiveCodec,
    );
    writeFileSync(
      join(
        root,
        "actions",
        "v1",
        PRIVATE_FILE_RANGE_STAGING_STORAGE.FRAMES_DIRECTORY,
        `${binding.handoff_id}.frames`,
      ),
      encoded,
      { mode: 0o600 },
    );
    expect(() => store.readFrames(binding.handoff_id)).toThrow();

    const forgedPreimage = {
      schema_version: PRIVATE_FILE_RANGE_STAGING_SCHEMA_VERSION,
      handoff_id: binding.handoff_id,
      sequence: 0,
      previous_frame_digest: null,
      handoff_record_digest: `sha256:${"f".repeat(64)}`,
      state: PRIVATE_FILE_RANGE_STAGING_STATE.AVAILABLE,
      reservation_key: null,
      consumed_by: null,
      recorded_at: "2026-08-25T00:00:00.000Z",
    } as const;
    const forged = {
      ...forgedPreimage,
      frame_digest: digestV1(PRIVATE_FILE_RANGE_STAGING_DIGEST_DOMAIN.FRAME, forgedPreimage),
    };
    const forgedBytes = encodeVffrFrame(
      PRIVATE_FILE_RANGE_STAGING_STORAGE.DOMAIN,
      forged,
      permissiveCodec,
    );
    const framePath = join(
      root,
      "actions",
      "v1",
      PRIVATE_FILE_RANGE_STAGING_STORAGE.FRAMES_DIRECTORY,
      `${binding.handoff_id}.frames`,
    );
    writeFileSync(framePath, forgedBytes, { mode: 0o600 });
    expect(() => store.readFrames(binding.handoff_id)).toThrow("frame authority changed");
    const beforeReserve = readFileSync(framePath);
    expect(() => store.reserve(binding, "forged-reservation", "2026-08-25T00:00:01.000Z")).toThrow(
      "frame authority changed",
    );
    expect(readFileSync(framePath)).toEqual(beforeReserve);
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

test("private file range staging rejects invalid preimages before writes and preserves valid chains", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-private-range-prewrite-"));
  try {
    const store = new PrivateFileRangeStagingStoreV1(root);
    const recordPath = (id: string) =>
      join(
        root,
        "actions",
        "v1",
        PRIVATE_FILE_RANGE_STAGING_STORAGE.RECORDS_DIRECTORY,
        `${id}.json`,
      );
    const framePath = (id: string) =>
      join(
        root,
        "actions",
        "v1",
        PRIVATE_FILE_RANGE_STAGING_STORAGE.FRAMES_DIRECTORY,
        `${id}.frames`,
      );
    const invalid = [
      { staged_at: "2026-08-25T00:00:00Z" },
      { staged_at: "2026-08-25T00:00:00.000Z", ttl_ms: 0 },
      { staged_at: "2026-08-25T00:00:00.000Z", ttl_ms: 1.5 },
      { staged_at: "2026-08-25T00:00:00.000Z", ttl_ms: Number.MAX_SAFE_INTEGER },
    ];
    for (const fields of invalid) {
      const handoffId = createPrivateFileRangeHandoffId();
      expect(() =>
        store.stage({
          handoff_id: handoffId,
          repo_relative_path: "src/prewrite.ts",
          start_line: 1,
          end_line: 1,
          content: "prewrite",
          ...fields,
        }),
      ).toThrow();
      expect(existsSync(recordPath(handoffId))).toBeFalse();
      expect(existsSync(framePath(handoffId))).toBeFalse();
    }

    const binding = store.stage({
      handoff_id: createPrivateFileRangeHandoffId(),
      repo_relative_path: "src/monotonic.ts",
      start_line: 1,
      end_line: 1,
      content: "monotonic",
      staged_at: "2026-08-25T00:00:10.000Z",
    });
    const before = readFileSync(framePath(binding.handoff_id));
    expect(() => store.reserve(binding, "reservation", "2026-08-25T00:00:09.000Z")).toThrow(
      "timestamp regressed",
    );
    expect(readFileSync(framePath(binding.handoff_id))).toEqual(before);

    const other = store.stage({
      handoff_id: createPrivateFileRangeHandoffId(),
      repo_relative_path: "src/other.ts",
      start_line: 1,
      end_line: 1,
      content: "other",
      staged_at: "2026-08-25T00:00:10.000Z",
    });
    writeFileSync(recordPath(other.handoff_id), readFileSync(recordPath(binding.handoff_id)));
    expect(() => store.readRecord(other.handoff_id)).toThrow("corrupt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
