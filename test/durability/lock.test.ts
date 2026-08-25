import { expect, spyOn, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DurabilityError,
  acquireProcessLock,
  canonicalJsonBytes,
  ensurePrivateDirectory,
  inspectProcessLock,
  inspectProcessLockStatus,
} from "../../src/durability/index.js";
import { publishStableLockRecord, readStableLockRecord } from "../../src/durability/lock-record.js";

test("process lock stores private owner identity and fences a live owner within a bound", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "vf-lock-"));
  const root = join(sandbox, "private");
  ensurePrivateDirectory(root);
  const path = join(root, "writer.lock");
  try {
    const first = acquireProcessLock(path, { operation: "test-operation", timeoutMs: 50 });
    const owner = inspectProcessLock(path);
    expect(owner).toEqual(first.owner);
    expect(owner?.pid).toBe(process.pid);
    expect(owner?.host).toBe(hostname());
    expect(owner?.operation).toBe("test-operation");
    expect(owner?.nonce).toMatch(/^[a-f0-9]{64}$/);
    expect(owner?.process_start_identity.length).toBeGreaterThan(0);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);

    const began = Date.now();
    expect(() => acquireProcessLock(path, { operation: "contender", timeoutMs: 30 })).toThrow(
      /lock busy/,
    );
    expect(Date.now() - began).toBeLessThan(500);

    first.release();
    expect(inspectProcessLock(path)).toBeNull();
    expect(lstatSync(path).size).toBe(8_192);
    const second = acquireProcessLock(path, { operation: "second", timeoutMs: 50 });
    expect(second.owner.nonce).not.toBe(owner?.nonce);
    second.release();
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("lock acquisition closes its opened file after validation or root fsync failure", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "vf-lock-open-failure-"));
  const root = join(sandbox, "private");
  ensurePrivateDirectory(root);
  const descriptorDirectory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
  const before = fs.readdirSync(descriptorDirectory).length;
  const realFstat = fs.fstatSync;
  const realFsync = fs.fsyncSync;
  let rejectFileValidation = false;
  const fstatSpy = spyOn(fs, "fstatSync").mockImplementation(((fd: number) => {
    const observed = realFstat(fd);
    if (!rejectFileValidation || !observed.isFile()) return observed;
    return new Proxy(observed, {
      get(target, property, receiver) {
        if (property === "mode") return (target.mode & ~0o7777) | 0o644;
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof fs.fstatSync);
  try {
    for (let index = 0; index < 32; index++) {
      rejectFileValidation = true;
      try {
        acquireProcessLock(join(root, `invalid-${index}.lock`), { operation: "validation-fail" });
        throw new Error("expected validation failure");
      } catch (error) {
        expect(error).toBeInstanceOf(DurabilityError);
        expect((error as DurabilityError).code).toBe("unsafe_path");
      } finally {
        rejectFileValidation = false;
      }
    }
  } finally {
    fstatSpy.mockRestore();
  }

  const primary = new DurabilityError("corrupt", "injected root fsync failure");
  let rejectRootFsync = false;
  const fsyncSpy = spyOn(fs, "fsyncSync").mockImplementation(((fd: number) => {
    if (rejectRootFsync && realFstat(fd).isDirectory()) throw primary;
    return realFsync(fd);
  }) as typeof fs.fsyncSync);
  try {
    for (let index = 0; index < 32; index++) {
      rejectRootFsync = true;
      try {
        acquireProcessLock(join(root, `fsync-${index}.lock`), { operation: "fsync-fail" });
        throw new Error("expected root fsync failure");
      } catch (error) {
        expect(error).toBe(primary);
      } finally {
        rejectRootFsync = false;
      }
    }
  } finally {
    fsyncSpy.mockRestore();
  }
  expect(fs.readdirSync(descriptorDirectory).length).toBeLessThanOrEqual(before + 1);
  rmSync(sandbox, { recursive: true, force: true });
});

test("process lock atomically replaces exact proved-dead owner metadata under the OS lock", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "vf-lock-stale-"));
  const root = join(sandbox, "private");
  ensurePrivateDirectory(root);
  const path = join(root, "writer.lock");
  const ready = join(sandbox, "stale-owner.json");
  const modulePath = join(process.cwd(), "src", "durability", "index.ts");
  const source = `import { writeFileSync } from "node:fs";
import { acquireProcessLock } from ${JSON.stringify(modulePath)};
const lock = acquireProcessLock(process.argv[1], { operation: "crashed-operation" });
writeFileSync(process.argv[2], JSON.stringify(lock.owner));`;
  try {
    const child = spawn(process.execPath, ["-e", source, path, ready], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const stale = JSON.parse(readFileSync(ready, "utf8"));
    expect(inspectProcessLockStatus(path)).toEqual({ status: "dead", owner: stale });
    const recovered = acquireProcessLock(path, { operation: "recover", timeoutMs: 500 });
    expect(recovered.owner.nonce).not.toBe(stale.nonce);
    expect(inspectProcessLock(path)).toEqual(recovered.owner);
    recovered.release();
    expect(lstatSync(path).size).toBe(8_192);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("unknown owner fields, remote owners, symlinks, and release tampering fail closed", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "vf-lock-fence-"));
  const root = join(sandbox, "private");
  ensurePrivateDirectory(root);
  const path = join(root, "writer.lock");
  try {
    seedOwner(path, {
      schema_version: "1.0" as const,
      pid: 2_147_483_647,
      process_start_identity: "dead",
      host: hostname(),
      operation: "old",
      nonce: "b".repeat(64),
      surprise: true,
    });
    expect(() => acquireProcessLock(path, { operation: "recover", timeoutMs: 20 })).toThrow(
      /owner metadata/,
    );

    rmSync(path);
    seedOwner(path, {
      schema_version: "1.0" as const,
      pid: 2_147_483_647,
      process_start_identity: "dead",
      host: "different-host.example",
      operation: "old",
      nonce: "c".repeat(64),
    });
    expect(() => acquireProcessLock(path, { operation: "recover", timeoutMs: 20 })).toThrow(
      /remote owner/,
    );

    rmSync(path);
    const target = join(root, "target");
    writeFileSync(target, "{}", { mode: 0o600 });
    symlinkSync(target, path);
    expect(() => acquireProcessLock(path, { operation: "recover", timeoutMs: 20 })).toThrow(
      /openat file/,
    );

    rmSync(path);
    const tamperSource = `import { writeFileSync } from "node:fs";
import { acquireProcessLock } from ${JSON.stringify(join(process.cwd(), "src", "durability", "index.ts"))};
const lock = acquireProcessLock(process.argv[1], { operation: "mine" });
writeFileSync(process.argv[1], "{}", { mode: 0o600 });
try { lock.release(); console.log("unexpected"); } catch (error) { console.log(error?.code); }`;
    expect(
      execFileSync(process.execPath, ["-e", tamperSource, path], { encoding: "utf8" }).trim(),
    ).toBe("corrupt");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

function seedOwner(path: string, owner: Record<string, unknown>): void {
  const initial = acquireProcessLock(path, { operation: "seed" });
  initial.release();
  const fd = openSync(path, "r+");
  try {
    const prior = readStableLockRecord(fd, path);
    publishStableLockRecord(fd, path, prior, canonicalJsonBytes(owner));
  } finally {
    closeSync(fd);
  }
}

test("a killed holder auto-releases the kernel lock and the next process takes over", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "vf-lock-race-"));
  const root = join(sandbox, "private");
  ensurePrivateDirectory(root);
  const path = join(root, "writer.lock");
  const ready = join(sandbox, "ready");
  const modulePath = join(process.cwd(), "src", "durability", "index.ts");
  const source = `import { writeFileSync } from "node:fs";
import { acquireProcessLock } from ${JSON.stringify(modulePath)};
const lock = acquireProcessLock(process.argv[1], { operation: "crash-holder", timeoutMs: 2000 });
writeFileSync(process.argv[2], lock.owner.nonce);
setInterval(() => lock.assertHeld(), 50);`;
  try {
    const child = spawn(process.execPath, ["-e", source, path, ready], { stdio: "ignore" });
    await waitFor(() => existsSync(ready), 3_000);
    const crashedNonce = readFileSync(ready, "utf8");
    expect(() => acquireProcessLock(path, { operation: "live-contender", timeoutMs: 30 })).toThrow(
      /lock busy/,
    );
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(inspectProcessLockStatus(path).status).toBe("dead");

    const recovered = acquireProcessLock(path, { operation: "after-crash", timeoutMs: 2_000 });
    expect(recovered.owner.nonce).not.toBe(crashedNonce);
    expect(inspectProcessLock(path)).toEqual(recovered.owner);
    recovered.release();
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("dual owner slots recover each acquire crash point as the exact old or new record", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "vf-lock-slot-crash-"));
  const root = join(sandbox, "private");
  ensurePrivateDirectory(root);
  const modulePath = join(process.cwd(), "src", "durability", "index.ts");
  try {
    for (const point of [
      "acquire-owner-slot-mid-write",
      "acquire-owner-slot-written",
      "acquire-owner-slot-fsynced",
    ] as const) {
      const path = join(root, `${point}.lock`);
      const stale = {
        schema_version: "1.0" as const,
        pid: 2_147_483_647,
        process_start_identity: "dead-process-start",
        host: hostname(),
        operation: "prior-owner",
        nonce: "e".repeat(64),
      };
      seedOwner(path, stale);
      const source = `import { acquireProcessLock } from ${JSON.stringify(modulePath)};
acquireProcessLock(process.argv[1], { operation: process.argv[2], fault(point) { if (point === process.argv[3]) process.exit(86); } });`;
      const child = spawn(process.execPath, ["-e", source, path, `crash-${point}`, point], {
        stdio: "ignore",
      });
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      const observed = inspectProcessLock(path);
      if (point === "acquire-owner-slot-mid-write") expect(observed).toEqual(stale);
      else {
        expect(observed?.operation).toBe(`crash-${point}`);
        expect(observed?.pid).toBe(child.pid);
      }
      const recovered = acquireProcessLock(path, { operation: "recover-slot", timeoutMs: 500 });
      recovered.release();
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("release publication faults retain flock until an exact absent slot is durable and retryable", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "vf-lock-release-slot-"));
  const root = join(sandbox, "private");
  ensurePrivateDirectory(root);
  try {
    for (const point of [
      "release-owner-slot-mid-write",
      "release-owner-slot-written",
      "release-owner-slot-fsynced",
    ] as const) {
      const path = join(root, `${point}.lock`);
      let inject = true;
      const lock = acquireProcessLock(path, {
        operation: "release-fault",
        fault(observed) {
          if (inject && observed === point) throw new Error(point);
        },
      });
      expect(() => lock.release()).toThrow(point);
      expect(() =>
        acquireProcessLock(path, { operation: "must-stay-busy", timeoutMs: 10 }),
      ).toThrow(/lock busy/);
      if (point === "release-owner-slot-mid-write")
        expect(inspectProcessLock(path)).toEqual(lock.owner);
      else expect(inspectProcessLock(path)).toBeNull();
      inject = false;
      expect(() => lock.release()).not.toThrow();
      expect(inspectProcessLock(path)).toBeNull();
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("slot generation overflow fences without changing committed bytes", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "vf-lock-generation-"));
  const root = join(sandbox, "private");
  ensurePrivateDirectory(root);
  const path = join(root, "writer.lock");
  const lock = acquireProcessLock(path, { operation: "generation-test" });
  lock.release();
  const before = readFileSync(path);
  const fd = openSync(path, "r+");
  try {
    const prior = readStableLockRecord(fd, path);
    expect(() =>
      publishStableLockRecord(
        fd,
        path,
        { ...prior, generation: Number.MAX_SAFE_INTEGER },
        canonicalJsonBytes({ ok: true }),
      ),
    ).toThrow(/generation.*exhausted/i);
  } finally {
    closeSync(fd);
  }
  expect(readFileSync(path)).toEqual(before);
  rmSync(sandbox, { recursive: true, force: true });
});

const LOCK_SLOT_BYTES = 4_096;
const LOCK_SLOT_BODY_BYTES = LOCK_SLOT_BYTES - 32;

function rewriteSlotGeneration(bytes: Buffer, slot: 0 | 1, generation: number): void {
  const base = slot * LOCK_SLOT_BYTES;
  bytes.writeBigUInt64BE(BigInt(generation), base + 8);
  const body = bytes.subarray(base, base + LOCK_SLOT_BODY_BYTES);
  createHash("sha256")
    .update(Buffer.from("VF-LOCK-OWNER-SLOT\0v1\0", "utf8"))
    .update(body)
    .digest()
    .copy(bytes, base + LOCK_SLOT_BODY_BYTES);
}

test("dual owner slots reject impossible generation parity and non-adjacent topology", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "vf-lock-topology-"));
  const root = join(sandbox, "private");
  ensurePrivateDirectory(root);
  try {
    for (const [name, mutate] of [
      [
        "parity",
        (bytes: Buffer) => {
          bytes.fill(0, LOCK_SLOT_BYTES);
          rewriteSlotGeneration(bytes, 0, 3);
        },
      ],
      ["gap", (bytes: Buffer) => rewriteSlotGeneration(bytes, 0, 4)],
    ] as const) {
      const path = join(root, `${name}.lock`);
      const lock = acquireProcessLock(path, { operation: `seed-${name}` });
      lock.release();
      const bytes = readFileSync(path);
      mutate(bytes);
      writeFileSync(path, bytes, { mode: 0o600 });
      const fd = openSync(path, "r");
      try {
        expect(() => readStableLockRecord(fd, path)).toThrow(/topology|parity/i);
      } finally {
        closeSync(fd);
      }
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("generated owner identity is validated before a lock file can be published", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "vf-lock-generated-owner-"));
  const root = join(sandbox, "private");
  ensurePrivateDirectory(root);
  const modulePath = join(process.cwd(), "src", "durability", "index.ts");
  const cases = [
    `const os = await import("node:os"); mock.module("node:os", () => ({ ...os, hostname: () => "bad" + String.fromCharCode(10) + "host" }));`,
    `if (process.platform === "linux") {
       const fs = await import("node:fs");
       mock.module("node:fs", () => ({ ...fs, readFileSync(path, ...args) {
         if (String(path) === "/proc/" + process.pid + "/stat") return process.pid + " (bun) R " + Array(19).fill("1").join(" ") + " " + "9".repeat(600);
         if (String(path) === "/proc/sys/kernel/random/boot_id") return "12345678-1234-1234-1234-123456789abc";
         return fs.readFileSync(path, ...args);
       }}));
     } else {
       const childProcess = await import("node:child_process");
       mock.module("node:child_process", () => ({ ...childProcess, execFileSync: () => "x".repeat(600) }));
     }`,
  ];
  try {
    for (const [index, setup] of cases.entries()) {
      const path = join(root, `invalid-${index}.lock`);
      const source = `import { mock } from "bun:test";
${setup}
const { acquireProcessLock } = await import(${JSON.stringify(modulePath)});
try { acquireProcessLock(process.argv[1], { operation: "generated-owner-test" }); console.log(JSON.stringify({ ok: true })); }
catch (error) { console.log(JSON.stringify({ code: error?.code, message: error?.message })); }`;
      const observed = JSON.parse(
        execFileSync(process.execPath, ["-e", source, path], { encoding: "utf8" }),
      );
      expect(observed.code).toMatch(/invalid_value|unsupported/);
      expect(existsSync(path)).toBeFalse();
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for child process");
    await Bun.sleep(10);
  }
}
