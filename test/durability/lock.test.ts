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
import {
  type ProcessLockOwnerRuntime,
  type ProcessLockOwnerV1,
  processLockOwnerIsAlive,
  processStartIdentity,
} from "../../src/durability/lock-owner.js";
import { publishStableLockRecord, readStableLockRecord } from "../../src/durability/lock-record.js";
import { formatPlatformProcessStartIdentity } from "../../src/durability/process-identity-contract.js";

const DEAD_PROCESS_IDENTITY = formatPlatformProcessStartIdentity("freebsd", "dead-lock-owner");
const STALE_PROCESS_IDENTITY = formatPlatformProcessStartIdentity("freebsd", "stale-lock-owner");

function exactOwner(
  platform: "darwin" | "win32",
  processStartIdentity: string,
): ProcessLockOwnerV1 {
  return {
    schema_version: "1.0",
    pid: 41,
    process_start_identity: processStartIdentity,
    host: hostname(),
    operation: `${platform}-owner`,
    nonce: "a".repeat(64),
  };
}

test("Windows lock identity uses an absolute native query and never POSIX ps", () => {
  const identities = new Map<number, string | Error>([[41, "638918820000000000"]]);
  const commands: string[] = [];
  const runtime: Partial<ProcessLockOwnerRuntime> = {
    platform: "win32",
    host: hostname(),
    windowsSystemRoot: "D:\\Windows",
    kill: (() => true) as typeof process.kill,
    execFileSync: ((command: string, args: string[]) => {
      commands.push(command);
      const pid = Number((args[2] ?? "").match(/ProcessId = (\d+)/)?.[1]);
      const result = identities.get(pid);
      if (result instanceof Error) throw result;
      if (!result) throw Object.assign(new Error("absent"), { status: 3 });
      return result;
    }) as typeof execFileSync,
  };
  const identity = "win32:638918820000000000";
  const owner = exactOwner("win32", identity);

  expect(processStartIdentity(owner.pid, runtime)).toBe(identity);
  expect(processLockOwnerIsAlive(owner, runtime)).toBeTrue();
  expect(commands).toEqual([
    "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  ]);
  expect(commands).not.toContain("/bin/ps");

  identities.set(owner.pid, "638918820000000001");
  expect(processLockOwnerIsAlive(owner, runtime)).toBeFalse();
  identities.set(owner.pid, Object.assign(new Error("query denied"), { status: 1 }));
  expect(processLockOwnerIsAlive(owner, runtime)).toBeNull();

  const beforeAbsentProbe = commands.length;
  expect(
    processLockOwnerIsAlive(owner, {
      ...runtime,
      kill: (() => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }) as typeof process.kill,
    }),
  ).toBeFalse();
  expect(commands).toHaveLength(beforeAbsentProbe);
  expect(processStartIdentity(owner.pid, { ...runtime, windowsSystemRoot: "relative" })).toBeNull();
});

test("Darwin external owners use exact start identity for live, reused, and unknown proofs", () => {
  const identity = "darwin:1700000000:123456";
  const owner = exactOwner("darwin", identity);
  let observed: string | null = identity;
  const runtime: Partial<ProcessLockOwnerRuntime> = {
    platform: "darwin",
    host: hostname(),
    kill: (() => true) as typeof process.kill,
    observeStartIdentity: () => observed,
  };

  expect(processLockOwnerIsAlive(owner, runtime)).toBeTrue();
  observed = "darwin:1700000001:654321";
  expect(processLockOwnerIsAlive(owner, runtime)).toBeFalse();
  observed = null;
  expect(processLockOwnerIsAlive(owner, runtime)).toBeNull();
  expect(processLockOwnerIsAlive({ ...owner, host: "remote.example" }, runtime)).toBeNull();
  expect(
    processLockOwnerIsAlive(owner, {
      ...runtime,
      kill: (() => {
        throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      }) as typeof process.kill,
    }),
  ).toBeNull();
  expect(
    processLockOwnerIsAlive(owner, {
      ...runtime,
      kill: (() => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }) as typeof process.kill,
    }),
  ).toBeFalse();
});

test("same-host lock takeover requires a proved identity mismatch on Windows and Darwin", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "vf-lock-cross-platform-owner-"));
  const root = join(sandbox, "private");
  ensurePrivateDirectory(root);
  try {
    for (const [platform, staleIdentity, reusedIdentity, currentIdentity] of [
      ["win32", "win32:638918820000000000", "win32:638918820000000001", "win32:638918830000000000"],
      [
        "darwin",
        "darwin:1700000000:123456",
        "darwin:1700000001:654321",
        "darwin:1700000002:111111",
      ],
    ] as const) {
      const path = join(root, `${platform}.lock`);
      const stale = {
        ...exactOwner(platform, staleIdentity),
        nonce: (platform === "win32" ? "b" : "c").repeat(64),
      };
      seedOwner(path, stale);
      let observed: string | null = staleIdentity;
      const processRuntime: Partial<ProcessLockOwnerRuntime> = {
        platform,
        host: hostname(),
        kill: (() => true) as typeof process.kill,
        observeStartIdentity: (pid) => (pid === process.pid ? currentIdentity : observed),
      };

      expect(() =>
        acquireProcessLock(path, { operation: "must-not-steal-live", processRuntime }),
      ).toThrow(/live owner/);
      observed = null;
      expect(() =>
        acquireProcessLock(path, { operation: "must-not-steal-unknown", processRuntime }),
      ).toThrow(/death is unprovable/);
      observed = reusedIdentity;
      const recovered = acquireProcessLock(path, {
        operation: "proved-dead-takeover",
        processRuntime,
      });
      expect(recovered.owner.process_start_identity).toBe(currentIdentity);
      expect(recovered.owner.nonce).not.toBe(stale.nonce);
      recovered.release();
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

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
      process_start_identity: DEAD_PROCESS_IDENTITY,
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
      process_start_identity: DEAD_PROCESS_IDENTITY,
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
        process_start_identity: STALE_PROCESS_IDENTITY,
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
  const sources = [
    `import { mock } from "bun:test";
const os = await import("node:os");
mock.module("node:os", () => ({
  ...os,
  hostname: () => "bad" + String.fromCharCode(10) + "host",
}));
const { acquireProcessLock } = await import(${JSON.stringify(modulePath)});
try {
  acquireProcessLock(process.argv[1], { operation: "generated-owner-test" });
  console.log(JSON.stringify({ ok: true }));
} catch (error) {
  console.log(JSON.stringify({ code: error?.code, message: error?.message }));
}`,
    `import { spyOn } from "bun:test";
import * as fs from "node:fs";
const durability = await import(${JSON.stringify(modulePath)});
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const realReadFile = fs.readFileSync;
const readSpy = spyOn(fs, "readFileSync").mockImplementation((path, ...args) => {
  if (String(path) === "/proc/" + process.pid + "/stat") {
    return process.pid + " (bun) R " + Array(18).fill("1").join(" ") + " " + "9".repeat(600);
  }
  if (String(path) === "/proc/sys/kernel/random/boot_id") {
    return "12345678-1234-1234-1234-123456789abc";
  }
  return realReadFile(path, ...args);
});
Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
try {
  durability.acquireProcessLock(process.argv[1], { operation: "generated-owner-test" });
  console.log(JSON.stringify({ ok: true }));
} catch (error) {
  console.log(JSON.stringify({ code: error?.code, message: error?.message }));
} finally {
  readSpy.mockRestore();
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
}`,
  ];
  try {
    for (const [index, source] of sources.entries()) {
      const path = join(root, `invalid-${index}.lock`);
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
