import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withCleanup } from "../../src/durability/cleanup.js";
import {
  DurabilityError,
  acquireProcessLock,
  appendVffrFrame,
  assertNoSymlinkComponents,
  atomicCompareAndSwap,
  createCanonicalObject,
  createOrVerifyPrivateFile,
  createRawObject,
  digestV1,
  ensurePrivateDirectory,
  inspectProcessLock,
  privateFileBytes,
  readVffrFile,
  syncPrivateDirectory,
} from "../../src/durability/index.js";

const vffrOptions = {
  domain: "catalog-delta" as const,
  maxFrames: 4,
  maxPayloadBytes: 4_096,
  maxAggregateBytes: 16_384,
  validatePayload: () => {},
  computePayloadDigest(payload: Record<string, unknown>) {
    const { event_digest: _digest, ...body } = payload;
    return digestV1("VF-HARDENING-EVENT\0v1\0", body);
  },
  validateJournalIdentity: () => true,
};

function event() {
  const body = {
    schema_version: "1.0",
    sequence: 0,
    previous_event_digest: null,
    recorded_at: "2026-08-25T00:00:00.000Z",
  };
  return { ...body, event_digest: digestV1("VF-HARDENING-EVENT\0v1\0", body) };
}

function expectUnsafe(operation: () => unknown): void {
  try {
    operation();
    throw new Error("expected unsafe path rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(DurabilityError);
    expect((error as DurabilityError).code).toBe("unsafe_path");
  }
}

test("cleanup failures never replace a primary typed durability error and run exactly once", () => {
  const primary = new DurabilityError("corrupt", "primary read failure");
  let cleanupAttempts = 0;
  try {
    withCleanup(() => {
      throw primary;
    }, [
      () => {
        cleanupAttempts++;
        throw new Error("injected close failure");
      },
    ]);
    throw new Error("expected primary failure");
  } catch (error) {
    expect(error).toBe(primary);
    expect((error as DurabilityError).code).toBe("corrupt");
    expect((error as Error).message).toBe("primary read failure");
  }
  expect(cleanupAttempts).toBe(1);
});

test("every public durability path rejects NUL before creating its truncated prefix", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "vf-durability-nul-"));
  const root = join(sandbox, "private");
  ensurePrivateDirectory(root);
  const lock = acquireProcessLock(join(root, "writer.lock"), { operation: "nul-test" });
  try {
    const cases: Array<[string, () => unknown]> = [
      [join(sandbox, "ensure"), () => ensurePrivateDirectory(`${join(sandbox, "ensure")}\0tail`)],
      [join(sandbox, "sync"), () => syncPrivateDirectory(`${join(sandbox, "sync")}\0tail`)],
      [join(sandbox, "walk"), () => assertNoSymlinkComponents(`${join(sandbox, "walk")}\0tail`)],
      [join(root, "read"), () => privateFileBytes(`${join(root, "read")}\0tail`, 64)],
      [join(root, "inspect"), () => inspectProcessLock(`${join(root, "inspect")}\0tail`)],
      [
        join(root, "acquire"),
        () => acquireProcessLock(`${join(root, "acquire")}\0tail`, { operation: "bad" }),
      ],
      [
        join(root, "object"),
        () =>
          createOrVerifyPrivateFile(`${join(root, "object")}\0tail`, Buffer.from("x"), { lock }),
      ],
      [
        join(root, "cas"),
        () => atomicCompareAndSwap(`${join(root, "cas")}\0tail`, null, Buffer.from("x"), { lock }),
      ],
      [
        join(root, "journal"),
        () =>
          appendVffrFrame(`${join(root, "journal")}\0tail`, "catalog-delta", event(), {
            ...vffrOptions,
            lock,
          }),
      ],
      [
        join(root, "journal-read"),
        () => readVffrFile(`${join(root, "journal-read")}\0tail`, vffrOptions),
      ],
      [
        join(root, "canonical-root"),
        () =>
          createCanonicalObject(
            `${join(root, "canonical-root")}\0tail`,
            "VF-OBJECT\0v1\0",
            { ok: true },
            { lock },
          ),
      ],
      [
        join(root, "raw-root"),
        () => createRawObject(`${join(root, "raw-root")}\0tail`, Buffer.from("x"), { lock }),
      ],
    ];
    for (const [prefix, operation] of cases) {
      expectUnsafe(operation);
      expect(existsSync(prefix)).toBeFalse();
    }
  } finally {
    lock.release();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("private directory and file modes reject every special permission bit", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "vf-durability-mode-"));
  const root = join(sandbox, "private");
  ensurePrivateDirectory(root);
  const broadDirectory = join(root, "setgid-directory");
  mkdirSync(broadDirectory, { mode: 0o700 });
  execFileSync("/bin/chmod", ["1700", broadDirectory]);
  expect(() => ensurePrivateDirectory(broadDirectory)).toThrow(/unsafe pinned directory/);

  const lock = acquireProcessLock(join(root, "writer.lock"), { operation: "mode-test" });
  const path = join(root, "object");
  try {
    createOrVerifyPrivateFile(path, Buffer.from("x"), { lock });
    execFileSync("/bin/chmod", ["1600", path]);
    expect(() => createOrVerifyPrivateFile(path, Buffer.from("x"), { lock })).toThrow(/mode/);
  } finally {
    lock.release();
  }
  execFileSync("/bin/chmod", ["1600", join(root, "writer.lock")]);
  expect(() => acquireProcessLock(join(root, "writer.lock"), { operation: "bad-mode" })).toThrow(
    /mode/,
  );
  rmSync(sandbox, { recursive: true, force: true });
});

test("failing pinned descendant validation preserves primary errors and does not leak descriptors", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "vf-durability-fd-"));
  const root = join(sandbox, "private");
  ensurePrivateDirectory(root);
  const bad = join(root, "broad");
  mkdirSync(bad, { mode: 0o755 });
  chmodSync(bad, 0o755);
  const lock = acquireProcessLock(join(root, "writer.lock"), { operation: "fd-test" });
  const descriptorDirectory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
  const before = readdirSync(descriptorDirectory).length;
  try {
    for (let index = 0; index < 64; index++) {
      expectUnsafe(() =>
        atomicCompareAndSwap(join(bad, `head-${index}`), null, Buffer.from("x"), { lock }),
      );
      expectUnsafe(() => ensurePrivateDirectory(bad));
    }
    const after = readdirSync(descriptorDirectory).length;
    expect(after).toBeLessThanOrEqual(before + 1);
  } finally {
    lock.release();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("all public byte caps reject unsafe numbers without writes", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "vf-durability-cap-"));
  const root = join(sandbox, "private");
  ensurePrivateDirectory(root);
  const lock = acquireProcessLock(join(root, "writer.lock"), { operation: "cap-test" });
  try {
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
      expect(() => privateFileBytes(join(root, "missing"), invalid)).toThrow(/limit/i);
      expect(() =>
        createOrVerifyPrivateFile(join(root, "object"), Buffer.from("x"), {
          lock,
          maxBytes: invalid,
        }),
      ).toThrow(/limit/i);
      expect(() =>
        atomicCompareAndSwap(join(root, "cas"), null, Buffer.from("x"), {
          lock,
          maxBytes: invalid,
        }),
      ).toThrow(/limit/i);
      expect(() => createRawObject(root, Buffer.from("x"), { lock, maxBytes: invalid })).toThrow(
        /limit/i,
      );
      expect(() =>
        createCanonicalObject(root, "VF-OBJECT\0v1\0", { ok: true }, { lock, maxBytes: invalid }),
      ).toThrow(/limit/i);
    }
    expect(existsSync(join(root, "object"))).toBeFalse();
    expect(existsSync(join(root, "cas"))).toBeFalse();
  } finally {
    lock.release();
    rmSync(sandbox, { recursive: true, force: true });
  }
});
