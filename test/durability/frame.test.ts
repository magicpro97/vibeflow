import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vffrRuleFor } from "../../src/durability/frame-rules.js";
import {
  VffrError,
  acquireProcessLock,
  appendVffrFrame,
  canonicalJsonBytes,
  digestV1,
  encodeVffrFrame,
  ensurePrivateDirectory,
  readVffrBytes,
  readVffrFile,
} from "../../src/durability/index.js";
import type { VffrReadOptions } from "../../src/durability/index.js";
import { runAbruptNodeProcess } from "../helpers/abrupt-process.js";

const event = (sequence: number, previous: string | null) => {
  const body = {
    schema_version: "1.0",
    sequence,
    previous_event_digest: previous,
    recorded_at: `2026-08-25T00:00:0${sequence}.000Z`,
    value: `event-${sequence}`,
  };
  return {
    ...body,
    event_digest: digestV1("VF-TEST-EVENT\0v1\0", body),
  };
};

const options = {
  domain: "catalog-delta" as const,
  maxFrames: 8,
  maxPayloadBytes: 8_192,
  maxAggregateBytes: 64 * 1024,
  validatePayload(payload: Record<string, unknown>) {
    expect(payload.schema_version).toBe("1.0");
  },
  computePayloadDigest(payload: Record<string, unknown>) {
    const { event_digest: _observed, ...body } = payload;
    return digestV1("VF-TEST-EVENT\0v1\0", body);
  },
  validateJournalIdentity: () => true,
};

test("VFFR encoding has the normative byte-exact header and checksum golden vector", () => {
  const frame = encodeVffrFrame("catalog-delta", event(0, null), options);
  expect(frame.subarray(0, 20).toString("hex")).toBe("564646520100000d0000000000000000000000d6");
  expect(frame.toString("hex")).toBe(
    "564646520100000d0000000000000000000000d6636174616c6f672d64656c74617b226576656e745f646967657374223a227368613235363a38366664306230623437653935623433313562313738663230623734616433353066356233323665643238616531366561336635313263386235653065383237222c2270726576696f75735f6576656e745f646967657374223a6e756c6c2c227265636f726465645f6174223a22323032362d30382d32355430303a30303a30302e3030305a222c22736368656d615f76657273696f6e223a22312e30222c2273657175656e6365223a302c2276616c7565223a226576656e742d30227d268a0422d3236533f07f23f5e13b32e0cd2d87f0ae50f51615fecbe57d37de38",
  );
});

test("VFFR reader accepts a dense verified chain and rejects sequence or digest-chain tampering", () => {
  const first = event(0, null);
  const second = event(1, first.event_digest);
  const bytes = Buffer.concat([
    encodeVffrFrame("catalog-delta", first, options),
    encodeVffrFrame("catalog-delta", second, {
      ...options,
      sequenceStart: 1,
      initialPreviousDigest: first.event_digest,
    }),
  ]);
  expect(readVffrBytes(bytes, options).map((item) => item.payload)).toEqual([first, second]);

  const gap = Buffer.concat([
    encodeVffrFrame("catalog-delta", first, options),
    encodeVffrFrame("catalog-delta", event(2, first.event_digest), {
      ...options,
      sequenceStart: 2,
      initialPreviousDigest: first.event_digest,
    }),
  ]);
  expectVffr(gap, "corrupt", "sequence");

  const wrongPrevious = Buffer.concat([
    encodeVffrFrame("catalog-delta", first, options),
    encodeVffrFrame("catalog-delta", event(1, null), {
      ...options,
      sequenceStart: 1,
      initialPreviousDigest: null,
    }),
  ]);
  expectVffr(wrongPrevious, "corrupt", "chain");

  expect(() =>
    encodeVffrFrame(
      "catalog-delta",
      { ...first, event_digest: `sha256:${"0".repeat(64)}` },
      options,
    ),
  ).toThrow(/self digest/);
  expect(() => readVffrBytes(bytes, { ...options, validateJournalIdentity: () => false })).toThrow(
    /journal identity/,
  );
});

test("VFFR reader classifies truncation, checksum corruption, versions, domains, and bounds", () => {
  const encoded = encodeVffrFrame("catalog-delta", event(0, null), options);
  expectVffr(encoded.subarray(0, encoded.length - 1), "corrupt", "frame");
  expectVffr(Buffer.concat([encoded, Buffer.from([0])]), "corrupt", "header");

  const badChecksum = Buffer.from(encoded);
  badChecksum[badChecksum.length - 1] = (badChecksum[badChecksum.length - 1] as number) ^ 1;
  expectVffr(badChecksum, "corrupt", "checksum");

  const badReserved = Buffer.from(encoded);
  badReserved[5] = 1;
  expectVffr(badReserved, "corrupt", "reserved");

  const future = Buffer.from(encoded);
  future[4] = 2;
  expectVffr(future, "corrupt", "major");

  expect(() => readVffrBytes(encoded, { ...options, domain: "grant-authority" })).toThrow(/domain/);
  expect(() => readVffrBytes(encoded, { ...options, maxPayloadBytes: 16 })).toThrow(/payload/);
  expect(() => readVffrBytes(encoded, { ...options, maxAggregateBytes: 16 })).toThrow(/aggregate/);
  expect(() =>
    readVffrBytes(Buffer.concat([encoded, encoded]), { ...options, maxFrames: 1 }),
  ).toThrow(/frame count/);
  expect(() => encodeVffrFrame("not-a-domain" as "catalog-delta", event(0, null), options)).toThrow(
    /domain/,
  );
});

test("public VFFR encoding enforces its starting sequence and aggregate byte cap", () => {
  const first = event(0, null);
  const encoded = encodeVffrFrame("catalog-delta", first, options);
  expect(() => encodeVffrFrame("catalog-delta", event(1, first.event_digest), options)).toThrow(
    /starting sequence|sequence start/i,
  );
  expect(() =>
    encodeVffrFrame("catalog-delta", first, {
      ...options,
      initialPreviousDigest: `sha256:${"0".repeat(64)}`,
    }),
  ).toThrow(/initial previous digest/i);
  expect(() =>
    encodeVffrFrame("catalog-delta", first, {
      ...options,
      maxAggregateBytes: encoded.length - 1,
    }),
  ).toThrow(/aggregate/i);
});

test("VFFR validation callbacks cannot mutate the payload returned for canonical payload bytes", () => {
  const first = event(0, null);
  const encoded = encodeVffrFrame("catalog-delta", first, options);
  const [decoded] = readVffrBytes(encoded, {
    ...options,
    validatePayload(payload) {
      payload.value = "callback-mutation";
    },
  });
  expect(decoded?.payload).toEqual(first);
  expect(JSON.parse(decoded?.payloadBytes.toString("utf8") ?? "null")).toEqual(first);
});

test("VFFR snapshots bytes, selectors, caps, and callback references before validation", async () => {
  const first = event(0, null);
  const encoded = encodeVffrFrame("catalog-delta", first, options);

  const mutableBytes = Buffer.from(encoded);
  const mutableReadOptions: VffrReadOptions = { ...options };
  mutableReadOptions.computePayloadDigest = (payload) => {
    mutableReadOptions.validateJournalIdentity = () => false;
    mutableReadOptions.validatePayload = () => {
      throw new Error("replacement callback must not run");
    };
    const { event_digest: _observed, ...body } = payload;
    return digestV1("VF-TEST-EVENT\0v1\0", body);
  };
  const originalValidate = options.validatePayload;
  mutableReadOptions.validatePayload = (payload) => {
    originalValidate(payload);
    mutableBytes.fill(0);
    mutableReadOptions.domain = "grant-authority";
    mutableReadOptions.maxFrames = 0;
    mutableReadOptions.maxPayloadBytes = 1;
    mutableReadOptions.maxAggregateBytes = 1;
  };
  const [decoded] = readVffrBytes(mutableBytes, mutableReadOptions);
  expect(decoded?.domain).toBe("catalog-delta");
  expect(decoded?.payload).toEqual(first);
  expect(decoded?.payloadBytes).toEqual(canonicalJsonBytes(first));

  const mutableEncodeOptions: VffrReadOptions = { ...options };
  mutableEncodeOptions.validatePayload = (payload) => {
    originalValidate(payload);
    mutableEncodeOptions.domain = "grant-authority";
    mutableEncodeOptions.maxAggregateBytes = 1;
    mutableEncodeOptions.computePayloadDigest = () => `sha256:${"0".repeat(64)}`;
    mutableEncodeOptions.validateJournalIdentity = () => false;
  };
  expect(encodeVffrFrame("catalog-delta", first, mutableEncodeOptions)).toEqual(encoded);

  const publicApi = (await import("../../src/durability/index.js")) as Record<string, unknown>;
  expect(publicApi.VFFR_DOMAIN_RULES).toBeUndefined();
  expect(Object.isFrozen(publicApi.VFFR_DOMAINS)).toBeTrue();
  const rule = vffrRuleFor("catalog-delta");
  expect(Object.isFrozen(rule)).toBeTrue();
  expect(Object.isFrozen(rule.timestamp)).toBeTrue();
});

test("VFFR append fsyncs dense frames and never silently repairs a truncated file", () => {
  const root = mkdtempSync(join(tmpdir(), "vf-vffr-"));
  const path = join(root, "events.frames");
  const lock = acquireProcessLock(join(root, "writer.lock"), { operation: "frame-test" });
  try {
    const first = event(0, null);
    const second = event(1, first.event_digest);
    appendVffrFrame(path, "catalog-delta", first, { ...options, lock });
    appendVffrFrame(path, "catalog-delta", second, { ...options, lock });
    expect(readVffrFile(path, options).map((item) => item.payload)).toEqual([first, second]);

    truncateSync(path, readFileSync(path).length - 3);
    expect(() =>
      appendVffrFrame(path, "catalog-delta", event(2, second.event_digest), {
        ...options,
        lock,
      }),
    ).toThrow(/truncated/);
    expect(() => readVffrFile(path, options)).toThrow(VffrError);
  } finally {
    lock.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("VFFR validates a first append before creation and never treats an existing empty file as a journal", () => {
  const root = mkdtempSync(join(tmpdir(), "vf-vffr-first-"));
  const path = join(root, "events.frames");
  const lock = acquireProcessLock(join(root, "writer.lock"), { operation: "frame-first-test" });
  try {
    expect(() =>
      appendVffrFrame(path, "catalog-delta", event(1, null), { ...options, lock }),
    ).toThrow(/sequence/i);
    expect(existsSync(path)).toBeFalse();

    writeFileSync(path, Buffer.alloc(0), { mode: 0o600 });
    expect(() => readVffrFile(path, options)).toThrow(/empty|truncated/i);
    expect(() =>
      appendVffrFrame(path, "catalog-delta", event(0, null), { ...options, lock }),
    ).toThrow(/empty|truncated/i);
    expect(statSync(path).size).toBe(0);
  } finally {
    lock.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("VFFR first-frame publication exposes either absence or one complete frame at every fault boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "vf-vffr-publish-"));
  const path = join(root, "events.frames");
  const lock = acquireProcessLock(join(root, "writer.lock"), { operation: "frame-publish-test" });
  try {
    expect(() =>
      appendVffrFrame(path, "catalog-delta", event(0, null), {
        ...options,
        lock,
        fault(point) {
          if (point === "after-first-frame-link") throw new Error("injected-first-frame-crash");
        },
      }),
    ).toThrow("injected-first-frame-crash");
    expect(readVffrFile(path, options).map((frame) => frame.payload)).toEqual([event(0, null)]);
    expect(statSync(path).size).toBeGreaterThan(0);
  } finally {
    lock.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("VFFR restart recovers the exact deterministic first-frame publication after process exit", () => {
  const root = mkdtempSync(join(tmpdir(), "vf-vffr-process-crash-"));
  const path = join(root, "events.frames");
  const lockPath = join(root, "writer.lock");
  const modulePath = join(process.cwd(), "src", "durability", "index.ts");
  ensurePrivateDirectory(root);
  const source = `import { acquireProcessLock, appendVffrFrame, digestV1 } from ${JSON.stringify(modulePath)};
const body = { schema_version: "1.0", sequence: 0, previous_event_digest: null, recorded_at: "2026-08-25T00:00:00.000Z", value: "event-0" };
const payload = { ...body, event_digest: digestV1("VF-TEST-EVENT\\0v1\\0", body) };
const lock = acquireProcessLock(process.argv[2], { operation: "first-frame-crash" });
appendVffrFrame(process.argv[1], "catalog-delta", payload, {
  domain: "catalog-delta", maxFrames: 8, maxPayloadBytes: 8192, maxAggregateBytes: 65536,
  validatePayload() {},
  computePayloadDigest(value) { const { event_digest: _observed, ...digestBody } = value; return digestV1("VF-TEST-EVENT\\0v1\\0", digestBody); },
  validateJournalIdentity() { return true; }, lock,
  fault(point) { if (point === "after-first-frame-link") process.exit(86); },
});`;
  try {
    const child = runAbruptNodeProcess({
      source,
      args: [path, lockPath],
      expectedStatus: 86,
    });
    expect(child.status).toBe(86);
    expect(statSync(path).nlink).toBe(2);
    expect(readVffrFile(path, options).map((frame) => frame.payload)).toEqual([event(0, null)]);

    const lock = acquireProcessLock(lockPath, { operation: "recover-first-frame", timeoutMs: 500 });
    try {
      const first = event(0, null);
      appendVffrFrame(path, "catalog-delta", event(1, first.event_digest), {
        ...options,
        lock,
      });
    } finally {
      lock.release();
    }
    expect(readVffrFile(path, options).map((frame) => frame.payload)).toEqual([
      event(0, null),
      event(1, event(0, null).event_digest),
    ]);
    expect(statSync(path).nlink).toBe(1);
    expect(readdirSync(root).some((name) => name.includes("vffr-first"))).toBeFalse();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("VFFR existing append rejects visible-entry replacement before write and after fsync", () => {
  const root = mkdtempSync(join(tmpdir(), "vf-vffr-entry-swap-"));
  ensurePrivateDirectory(root);
  try {
    for (const [point, displacedFrames] of [
      ["before-existing-frame-write", 1],
      ["after-existing-frame-fsync", 2],
    ] as const) {
      const path = join(root, `${point}.frames`);
      const displaced = `${path}.displaced`;
      const lock = acquireProcessLock(join(root, `${point}.lock`), { operation: point });
      try {
        const first = event(0, null);
        appendVffrFrame(path, "catalog-delta", first, { ...options, lock });
        const original = readFileSync(path);
        expect(() =>
          appendVffrFrame(path, "catalog-delta", event(1, first.event_digest), {
            ...options,
            lock,
            fault(observed) {
              if (observed !== point) return;
              renameSync(path, displaced);
              writeFileSync(path, original, { mode: 0o600 });
            },
          }),
        ).toThrow(/identity|replaced|changed/i);
        expect(readVffrFile(path, options)).toHaveLength(1);
        expect(readVffrFile(displaced, options)).toHaveLength(displacedFrames);
        appendVffrFrame(path, "catalog-delta", event(1, first.event_digest), {
          ...options,
          lock,
        });
        expect(readVffrFile(path, options)).toHaveLength(2);
      } finally {
        lock.release();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("VFFR rejects non-positive, non-finite, fractional caps and missing codecs", () => {
  const encoded = encodeVffrFrame("catalog-delta", event(0, null), options);
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
    for (const field of ["maxFrames", "maxPayloadBytes", "maxAggregateBytes"] as const) {
      expect(() => readVffrBytes(encoded, { ...options, [field]: invalid })).toThrow(
        /bound|limit/i,
      );
    }
  }
  for (const callback of [
    "validatePayload",
    "computePayloadDigest",
    "validateJournalIdentity",
  ] as const) {
    expect(() => readVffrBytes(encoded, { ...options, [callback]: undefined as never })).toThrow(
      /codec|callback/i,
    );
  }
});

function expectVffr(bytes: Buffer, kind: VffrError["kind"], message: string): void {
  try {
    readVffrBytes(bytes, options);
    throw new Error("expected VFFR failure");
  } catch (error) {
    expect(error).toBeInstanceOf(VffrError);
    expect((error as VffrError).kind).toBe(kind);
    expect((error as VffrError).fencedAs).toBe(kind === "bounds" ? "bounds" : "corrupt");
    expect((error as Error).message).toContain(message);
  }
}
