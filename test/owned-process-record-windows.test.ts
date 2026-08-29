import { afterEach, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import {
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  WINDOWS_NATIVE_RECORD,
  type WindowsKernelLock,
  type WindowsKernelLockProvider,
  type WindowsRecordNativeBindings,
  assertWindowsLocalRecordPath,
  createWindowsKernelLockProvider,
  createWindowsWriteThroughRename,
  loadWindowsRecordNativeBindings,
  trustedWindowsSystemRoot,
} from "../src/dispatch/owned-process-record-windows-native.js";
import {
  createWindowsRecordRuntime,
  isWindowsDriveQualifiedPath,
  resolveWindowsRecordPath,
} from "../src/dispatch/owned-process-record-windows-storage.js";
import {
  WINDOWS_RECORD_STORAGE,
  WindowsOwnedProcessRecordBackend,
  type WindowsRecordRuntime,
} from "../src/dispatch/owned-process-record-windows.js";
import {
  WINDOWS_AUTHORITY_PATH_KIND,
  type WindowsPrivateAuthority,
} from "../src/dispatch/windows-private-authority.js";
import { canonicalJsonBytes } from "../src/durability/canonical.js";
import type { ProcessLockOwnerV1 } from "../src/durability/lock-owner.js";

const roots: string[] = [];
const ENTRY = `${"a".repeat(64)}.json`;
const OTHER_ENTRY = `${"b".repeat(64)}.json`;
const IDENTITY = "win32:638602314960000001";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "vf-win-record-")));
  roots.push(root);
  return root;
}

class SimulatedKernel implements WindowsKernelLockProvider {
  held = false;
  unavailable = 0;
  lost = false;
  acquisitions = 0;
  attempts = 0;
  releases = 0;

  tryAcquire(): WindowsKernelLock | null {
    this.attempts += 1;
    if (this.unavailable > 0) {
      this.unavailable -= 1;
      return null;
    }
    if (this.held) return null;
    this.held = true;
    this.acquisitions += 1;
    let released = false;
    return {
      assertHeld: () => {
        if (released || this.lost || !this.held) throw new Error("simulated kernel lock lost");
      },
      release: () => {
        if (released) throw new Error("simulated duplicate release");
        released = true;
        this.held = false;
        this.releases += 1;
      },
    };
  }

  crash(): void {
    this.held = false;
  }
}

interface Harness {
  backend: WindowsOwnedProcessRecordBackend;
  kernel: SimulatedKernel;
  renames: Array<{ source: string; target: string; replace: boolean; writeThrough: boolean }>;
  setAlive(value: boolean | null): void;
  recordsRoot: string;
}

function harness(
  options: {
    root?: string;
    maxBytes?: number;
    timeoutMs?: number;
    now?: () => number;
    wait?: (milliseconds: number) => void;
    runtime?: Partial<WindowsRecordRuntime>;
  } = {},
): Harness {
  const root = options.root ?? temporaryRoot();
  const kernel = new SimulatedKernel();
  const renames: Harness["renames"] = [];
  let nonce = 0;
  let alive: boolean | null = false;
  const rename = (
    source: string,
    target: string,
    flags: { replace: boolean; writeThrough: true },
  ) => {
    renames.push({ source, target, ...flags });
    if (!flags.replace && existsSync(target))
      throw Object.assign(new Error("target exists"), { code: "EEXIST" });
    renameSync(source, target);
  };
  const backend = new WindowsOwnedProcessRecordBackend(root, {
    maxBytes: options.maxBytes,
    timeoutMs: options.timeoutMs,
    runtime: {
      kernelLocks: kernel,
      rename,
      identity: () => IDENTITY,
      ownerAlive: () => alive,
      nonce: () => (++nonce).toString(16).padStart(64, "0"),
      host: "windows-test-host",
      now: options.now ?? Date.now,
      wait: options.wait ?? (() => {}),
      enforceLocalWindowsPath: false,
      ...options.runtime,
    },
  });
  return {
    backend,
    kernel,
    renames,
    setAlive: (value) => {
      alive = value;
    },
    recordsRoot: backend.recordsRoot,
  };
}

describe("Windows owned-process transactional backend", () => {
  test("creates, lists, reads, and replaces records under a kernel lock", () => {
    const { backend, kernel, renames } = harness();
    const first = Buffer.from("first");
    const second = Buffer.from("second");

    expect(backend.read(ENTRY)).toBeNull();
    backend.compareAndSwap(ENTRY, null, first, { operation: "create" });
    expect(backend.read(ENTRY)).toEqual(first);
    expect(backend.entries()).toEqual([ENTRY]);
    backend.compareAndSwap(ENTRY, first, second, { operation: "replace" });
    expect(backend.read(ENTRY)).toEqual(second);
    expect(kernel.acquisitions).toBe(2);
    expect(kernel.releases).toBe(2);
    expect(renames.every((entry) => entry.writeThrough)).toBe(true);
    expect(renames.some((entry) => entry.target.endsWith(ENTRY) && entry.replace)).toBe(true);
    expect(existsSync(`${backend.lockPath}${WINDOWS_RECORD_STORAGE.OWNER_SUFFIX}`)).toBe(false);
  });

  test("keeps backend path effects inside the verified records-directory lease", () => {
    const root = temporaryRoot();
    const observations: Array<{ action: string; depth: number; phase: string }> = [];
    let depth = 0;
    let phase = "setup";
    const observe = (action: string) => observations.push({ action, depth, phase });
    const files = {
      ...nodeFs,
      readdirSync(...args: unknown[]) {
        observe("readdirSync");
        return Reflect.apply(nodeFs.readdirSync, nodeFs, args);
      },
      unlinkSync(path: nodeFs.PathLike) {
        observe("unlinkSync");
        return nodeFs.unlinkSync(path);
      },
    } as unknown as WindowsRecordRuntime["files"];
    const kernel = new SimulatedKernel();
    const kernelLocks: WindowsKernelLockProvider = {
      tryAcquire() {
        observe("kernelLocks.tryAcquire");
        const acquired = kernel.tryAcquire();
        if (!acquired) return null;
        return {
          assertHeld() {
            observe("kernel.assertHeld");
            acquired.assertHeld();
          },
          release: () => acquired.release(),
        };
      },
    };
    const rename: WindowsRecordRuntime["rename"] = (source, target, flags) => {
      observe("rename");
      if (!flags.replace && existsSync(target))
        throw Object.assign(new Error("target exists"), { code: "EEXIST" });
      renameSync(source, target);
    };
    const base = createWindowsRecordRuntime({
      files,
      kernelLocks,
      rename,
      identity: () => IDENTITY,
      ownerAlive: () => false,
      nonce: (() => {
        let nonce = 0;
        return () => (++nonce).toString(16).padStart(64, "0");
      })(),
      enforceLocalWindowsPath: false,
    });
    const pathAuthority: WindowsRecordRuntime["pathAuthority"] = {
      ...base.pathAuthority,
      withVerifiedDirectory(path, expectedIdentity, operation) {
        return base.pathAuthority.withVerifiedDirectory(path, expectedIdentity, () => {
          depth += 1;
          try {
            return operation();
          } finally {
            depth -= 1;
          }
        });
      },
      readPrivateFile(path, maxBytes) {
        observe("readPrivateFile");
        return base.pathAuthority.readPrivateFile(path, maxBytes);
      },
      writePrivateFile(path, bytes, maxBytes) {
        observe("writePrivateFile");
        return base.pathAuthority.writePrivateFile(path, bytes, maxBytes);
      },
    };
    const backend = new WindowsOwnedProcessRecordBackend(root, {
      runtime: { ...base, pathAuthority },
    });
    const expectLeased = (expectedPhase: string, action: string) => {
      const matches = observations.filter(
        (entry) => entry.phase === expectedPhase && entry.action === action,
      );
      expect(matches.length).toBeGreaterThan(0);
      expect(matches.every((entry) => entry.depth > 0)).toBe(true);
    };

    phase = "entries";
    expect(backend.entries()).toEqual([]);

    const recoveredNonce = "c".repeat(64);
    const recoveredOwner: ProcessLockOwnerV1 = {
      schema_version: "1.0",
      pid: 42,
      process_start_identity: IDENTITY,
      host: "windows-test-host",
      operation: "recover-under-lease",
      nonce: recoveredNonce,
    };
    writeFileSync(
      `${backend.lockPath}${WINDOWS_RECORD_STORAGE.OWNER_SUFFIX}${WINDOWS_RECORD_STORAGE.RELEASE_MARKER}${recoveredNonce}`,
      canonicalJsonBytes(recoveredOwner),
    );
    phase = "acquire";
    const lock = backend.acquire("leased-acquire");

    phase = "assertHeld";
    lock.assertHeld();
    phase = "release";
    lock.release();

    const casStage = join(
      backend.recordsRoot,
      `${WINDOWS_RECORD_STORAGE.CAS_STAGE_PREFIX}${ENTRY}${WINDOWS_RECORD_STORAGE.CAS_STAGE_SUFFIX}`,
    );
    writeFileSync(casStage, "stale-stage");
    phase = "compareAndSwap";
    backend.compareAndSwap(ENTRY, null, Buffer.from("leased"), { operation: "leased-cas" });
    phase = "done";

    expectLeased("entries", "readdirSync");
    expectLeased("acquire", "kernelLocks.tryAcquire");
    expectLeased("acquire", "readdirSync");
    expectLeased("acquire", "unlinkSync");
    expectLeased("acquire", "rename");
    expectLeased("assertHeld", "kernel.assertHeld");
    expectLeased("assertHeld", "readPrivateFile");
    expectLeased("release", "kernel.assertHeld");
    expectLeased("release", "rename");
    expectLeased("release", "unlinkSync");
    expectLeased("compareAndSwap", "kernelLocks.tryAcquire");
    expectLeased("compareAndSwap", "readdirSync");
    expectLeased("compareAndSwap", "rename");
    expectLeased("compareAndSwap", "unlinkSync");
    expect(depth).toBe(0);
  });

  test("blocks the callback and filesystem effect when records identity mismatches", () => {
    const root = temporaryRoot();
    let callbacks = 0;
    let directoryIdentity = "initial-directory-identity";
    let readdirCalls = 0;
    const files = {
      ...nodeFs,
      readdirSync(...args: unknown[]) {
        readdirCalls += 1;
        return Reflect.apply(nodeFs.readdirSync, nodeFs, args);
      },
    } as unknown as WindowsRecordRuntime["files"];
    const base = createWindowsRecordRuntime({
      files,
      kernelLocks: new SimulatedKernel(),
      rename: () => {},
      identity: () => IDENTITY,
      ownerAlive: () => false,
      enforceLocalWindowsPath: false,
    });
    const pathAuthority: WindowsRecordRuntime["pathAuthority"] = {
      ...base.pathAuthority,
      directoryIdentity(path, verifyPrivate) {
        const identity = base.pathAuthority.directoryIdentity(path, verifyPrivate);
        return identity ? { ...identity, value: directoryIdentity } : null;
      },
      withVerifiedDirectory(_path, expectedIdentity, operation) {
        if (expectedIdentity !== directoryIdentity) throw new Error("storage directory changed");
        callbacks += 1;
        return operation();
      },
    };
    const backend = new WindowsOwnedProcessRecordBackend(root, {
      runtime: { ...base, pathAuthority },
    });

    directoryIdentity = "replacement-directory-identity";
    expect(() => backend.entries()).toThrow("storage directory changed");
    expect(callbacks).toBe(0);
    expect(readdirCalls).toBe(0);
  });

  test("releases a candidate kernel lock when lease completion fails", () => {
    const root = temporaryRoot();
    const kernel = new SimulatedKernel();
    const base = createWindowsRecordRuntime({
      kernelLocks: kernel,
      rename: () => {},
      identity: () => IDENTITY,
      ownerAlive: () => false,
      enforceLocalWindowsPath: false,
    });
    let failLeaseCompletion = false;
    const pathAuthority: WindowsRecordRuntime["pathAuthority"] = {
      ...base.pathAuthority,
      withVerifiedDirectory(path, expectedIdentity, operation) {
        const result = base.pathAuthority.withVerifiedDirectory(path, expectedIdentity, operation);
        if (failLeaseCompletion && kernel.acquisitions > 0)
          throw new Error("lease postcheck failed after kernel acquisition");
        return result;
      },
    };
    const backend = new WindowsOwnedProcessRecordBackend(root, {
      runtime: { ...base, pathAuthority },
    });

    failLeaseCompletion = true;
    expect(() => backend.acquire("lease-postcheck-failure")).toThrow(
      "lease postcheck failed after kernel acquisition",
    );
    expect(kernel.acquisitions).toBe(1);
    expect(kernel.releases).toBe(1);
    expect(kernel.held).toBe(false);
  });

  test("recovers a same-directory CAS stage deterministically after an injected crash", () => {
    const { backend, recordsRoot } = harness();
    const replacement = Buffer.from("durable");
    expect(() =>
      backend.compareAndSwap(ENTRY, null, replacement, {
        operation: "faulted",
        fault: (point) => {
          if (point === "after-stage-sync") throw new Error("crash after fsync");
        },
      }),
    ).toThrow("crash after fsync");
    const stage = join(
      recordsRoot,
      `${WINDOWS_RECORD_STORAGE.CAS_STAGE_PREFIX}${ENTRY}${WINDOWS_RECORD_STORAGE.CAS_STAGE_SUFFIX}`,
    );
    expect(readFileSync(stage)).toEqual(replacement);
    backend.compareAndSwap(ENTRY, null, replacement, { operation: "recover" });
    expect(backend.read(ENTRY)).toEqual(replacement);
    expect(existsSync(stage)).toBe(false);
  });

  test("replaces stale owner metadata only after exact owner death is proved", () => {
    const { backend, kernel, setAlive } = harness();
    const abandoned = backend.acquire("abandoned");
    const firstNonce = abandoned.owner.nonce;
    kernel.crash();

    setAlive(true);
    expect(() => backend.acquire("live-owner")).toThrow("live owner");
    setAlive(null);
    expect(() => backend.acquire("unknown-owner")).toThrow("death is unprovable");
    setAlive(false);
    const recovered = backend.acquire("recovered");
    expect(recovered.owner.nonce).not.toBe(firstNonce);
    expect(() => abandoned.assertHeld()).toThrow();
    recovered.release();
  });

  test("keeps directory identity lossless above Number.MAX_SAFE_INTEGER", () => {
    const root = temporaryRoot();
    const base = nodeFs.lstatSync(root, { bigint: true });
    let identity = 9_007_199_254_740_992n;
    const files = {
      ...nodeFs,
      lstatSync: (path: nodeFs.PathLike, options?: nodeFs.StatOptions) => {
        const stat = nodeFs.lstatSync(path, { bigint: true });
        return options && "bigint" in options && options.bigint
          ? Object.assign(stat, { ino: identity })
          : nodeFs.lstatSync(path);
      },
      statSync: (path: nodeFs.PathLike, options?: nodeFs.StatOptions) => {
        const stat = nodeFs.statSync(path, { bigint: true });
        return options && "bigint" in options && options.bigint
          ? Object.assign(stat, { ino: identity, dev: base.dev })
          : nodeFs.statSync(path);
      },
    } as unknown as WindowsRecordRuntime["files"];
    const { backend } = harness({ root, runtime: { files } });
    identity += 1n;
    expect(() => backend.entries()).toThrow("storage directory changed");
  });

  test("uses monotonic elapsed time and caps the final lock wait", () => {
    let now = 100;
    const waits: number[] = [];
    const { backend, kernel } = harness({
      timeoutMs: 5,
      now: () => now,
      wait: (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
    });
    kernel.unavailable = 99;
    expect(() => backend.acquire("bounded-wait")).toThrow("Windows process lock busy");
    expect(waits).toEqual([5]);
  });

  test("does not acquire when exclusion becomes available exactly at the deadline", () => {
    let now = 0;
    const { backend, kernel } = harness({
      timeoutMs: 5,
      now: () => now,
      wait: (milliseconds) => {
        now += milliseconds;
      },
    });
    kernel.unavailable = 1;
    expect(() => backend.acquire("deadline-exact")).toThrow("process lock busy");
    expect(kernel.attempts).toBe(1);
  });

  test("does not extend lock timeout when wall clock rolls backward", () => {
    const readings = [100, 90, 105];
    const waits: number[] = [];
    const { backend, kernel } = harness({
      timeoutMs: 5,
      now: () => readings.shift() ?? 105,
      wait: (milliseconds) => waits.push(milliseconds),
    });
    kernel.unavailable = 99;
    expect(() => backend.acquire("rollback")).toThrow("Windows process lock busy");
    expect(waits).toEqual([5]);
  });

  test("keeps opened record identity lossless across colliding number projections", () => {
    const { backend, recordsRoot } = harness();
    writeFileSync(join(recordsRoot, ENTRY), "value");
    const first = 9_007_199_254_740_992n;
    let opened = first;
    const files = {
      ...nodeFs,
      lstatSync: (path: nodeFs.PathLike, options?: nodeFs.StatOptions) => {
        const stat = nodeFs.lstatSync(path, { bigint: true });
        return options && "bigint" in options && options.bigint
          ? Object.assign(stat, { ino: path.toString().endsWith(ENTRY) ? first : stat.ino })
          : nodeFs.lstatSync(path);
      },
      fstatSync: (fd: number, options?: nodeFs.StatOptions) => {
        const stat = nodeFs.fstatSync(fd, { bigint: true });
        return options && "bigint" in options && options.bigint
          ? Object.assign(stat, { ino: opened })
          : nodeFs.fstatSync(fd);
      },
    } as unknown as WindowsRecordRuntime["files"];
    const swapped = harness({ root: backend.root, runtime: { files } }).backend;
    opened = first + 1n;
    expect(() => swapped.read(ENTRY)).toThrow("identity changed before read");
  });

  test("discards unpublished owner stages and recovers proved-dead release tombs", () => {
    const staged = harness();
    const abandoned = staged.backend.acquire("staged-owner");
    const ownerPath = `${staged.backend.lockPath}${WINDOWS_RECORD_STORAGE.OWNER_SUFFIX}`;
    const ownerStage = `${ownerPath}${WINDOWS_RECORD_STORAGE.CAS_STAGE_SUFFIX}`;
    writeFileSync(ownerStage, "partial-owner-stage");
    unlinkSync(ownerPath);
    staged.kernel.crash();
    staged.setAlive(true);
    const stageRecovered = staged.backend.acquire("partial-stage-retry");
    expect(() => abandoned.assertHeld()).toThrow();
    expect(existsSync(ownerStage)).toBe(false);
    stageRecovered.release();

    let failPublication = true;
    const retry = harness({
      runtime: {
        rename: (source, target, flags) => {
          if (failPublication && target.endsWith(WINDOWS_RECORD_STORAGE.OWNER_SUFFIX)) {
            failPublication = false;
            throw new Error("owner publication failed");
          }
          if (!flags.replace && existsSync(target))
            throw Object.assign(new Error("target exists"), { code: "EEXIST" });
          renameSync(source, target);
        },
      },
    });
    expect(() => retry.backend.acquire("failed-publication")).toThrow("owner publication failed");
    retry.setAlive(true);
    const sameProcessRetry = retry.backend.acquire("same-process-retry");
    sameProcessRetry.release();

    let failRelease = true;
    const tombed = harness({
      runtime: {
        rename: (source, target, flags) => {
          if (!flags.replace && existsSync(target))
            throw Object.assign(new Error("target exists"), { code: "EEXIST" });
          renameSync(source, target);
          if (failRelease && target.includes(WINDOWS_RECORD_STORAGE.RELEASE_MARKER)) {
            failRelease = false;
            throw new Error("release crash");
          }
        },
      },
    });
    const releasing = tombed.backend.acquire("release-tomb");
    expect(() => releasing.release()).toThrow("release crash");
    tombed.kernel.crash();
    tombed.setAlive(false);
    const tombRecovered = tombed.backend.acquire("recover-tomb");
    expect(
      nodeFs
        .readdirSync(tombed.recordsRoot)
        .some((entry) => entry.includes(WINDOWS_RECORD_STORAGE.RELEASE_MARKER)),
    ).toBe(false);
    tombRecovered.release();
  });

  test("polls kernel exclusion and fails closed at its bounded deadline", () => {
    let clock = 0;
    let waits = 0;
    const { backend, kernel } = harness({
      timeoutMs: 2,
      now: () => clock,
      wait: () => {
        waits += 1;
        clock += 1;
      },
    });
    kernel.held = true;
    expect(() => backend.acquire("busy")).toThrow("process lock busy");
    expect(waits).toBe(2);
    kernel.held = false;
    kernel.unavailable = 1;
    const acquired = backend.acquire("eventually-free");
    acquired.assertHeld();
    acquired.release();
    expect(waits).toBe(3);
  });

  test("enforces preimages, bounds, safe names, and exact no-op semantics", () => {
    const { backend, recordsRoot } = harness({ maxBytes: 8 });
    const value = Buffer.from("same");
    backend.compareAndSwap(ENTRY, null, value, { operation: "seed" });
    expect(() =>
      backend.compareAndSwap(ENTRY, Buffer.from("wrong"), value, { operation: "stale" }),
    ).toThrow("preimage mismatch");
    backend.compareAndSwap(ENTRY, value, value, { operation: "no-op" });
    expect(() =>
      backend.compareAndSwap(OTHER_ENTRY, null, Buffer.alloc(9), { operation: "large" }),
    ).toThrow("exceeds byte limit");
    expect(() => backend.read(ENTRY, 0)).toThrow("invalid read limit");
    expect(() => backend.read("CON.json")).toThrow("unsafe Windows storage name");
    expect(() => backend.read("stream:name.json")).toThrow("unsafe Windows storage name");
    expect(() => backend.read("trailing. ")).toThrow("unsafe Windows storage name");
    writeFileSync(join(recordsRoot, OTHER_ENTRY), Buffer.alloc(9));
    expect(() => backend.read(OTHER_ENTRY)).toThrow("oversized Windows record");
  });

  test("detects record links, directory aliases, and publication races", () => {
    const { backend, recordsRoot } = harness();
    const original = join(recordsRoot, ENTRY);
    const linked = join(recordsRoot, OTHER_ENTRY);
    writeFileSync(original, "linked");
    linkSync(original, linked);
    expect(() => backend.read(ENTRY)).toThrow("unsafe or oversized");
    unlinkSync(linked);
    unlinkSync(original);

    expect(() =>
      backend.compareAndSwap(ENTRY, null, Buffer.from("ours"), {
        operation: "raced",
        fault: (point) => {
          if (point === "before-publication") writeFileSync(original, "theirs");
        },
      }),
    ).toThrow("preimage raced");
    expect(readFileSync(original, "utf8")).toBe("theirs");

    const moved = `${recordsRoot}-moved`;
    renameSync(recordsRoot, moved);
    roots.push(moved);
    writeFileSync(recordsRoot, "replacement");
    expect(() => backend.entries()).toThrow("non-directory storage path");
  });

  test("rejects relative, network-like, escaped, symlinked, and unsafe entry paths", () => {
    const kernel = new SimulatedKernel();
    const seams = {
      kernelLocks: kernel,
      rename: (() => {}) as WindowsRecordRuntime["rename"],
      identity: () => IDENTITY,
      enforceLocalWindowsPath: false,
    };
    expect(() => new WindowsOwnedProcessRecordBackend("relative", { runtime: seams })).toThrow(
      "must be absolute",
    );
    const root = temporaryRoot();
    expect(
      () =>
        new WindowsOwnedProcessRecordBackend(root, {
          runtime: { ...seams, enforceLocalWindowsPath: true },
        }),
    ).toThrow("drive-qualified path");
    expect(
      () =>
        new WindowsOwnedProcessRecordBackend(root, {
          recordsRoot: temporaryRoot(),
          runtime: seams,
        }),
    ).toThrow("immediate root child");
    expect(
      () =>
        new WindowsOwnedProcessRecordBackend(root, {
          lockPath: join(dirname(root), "escaped.lock"),
          runtime: seams,
        }),
    ).toThrow("unsafe lock path");
    expect(
      () =>
        new WindowsOwnedProcessRecordBackend(root, {
          lockPath: "relative.lock",
          runtime: seams,
        }),
    ).toThrow("must be absolute");

    const target = temporaryRoot();
    const alias = `${target}-alias`;
    roots.push(alias);
    symlinkSync(target, alias, "dir");
    expect(() => new WindowsOwnedProcessRecordBackend(alias, { runtime: seams })).toThrow(
      "reparse or non-directory",
    );

    const validated: string[] = [];
    const simulated = createWindowsRecordRuntime({
      kernelLocks: kernel,
      rename: seams.rename,
      identity: () => IDENTITY,
      ownerAlive: () => false,
      enforceLocalWindowsPath: true,
      isAbsolutePath: (path) => isWindowsDriveQualifiedPath(path) || path.startsWith("\\"),
      resolvePath: (path) => path,
      validateLocalPath: (path) => validated.push(path),
    });
    expect(simulated.rename).toBe(seams.rename);
    expect(simulated.kernelLocks).toBe(kernel);
    expect(resolveWindowsRecordPath("C:\\state", simulated)).toBe("C:\\state");
    expect(validated).toEqual(["C:\\state"]);
    expect(isWindowsDriveQualifiedPath("\\state")).toBe(false);
    expect(isWindowsDriveQualifiedPath("C:relative")).toBe(false);
    expect(() => resolveWindowsRecordPath("\\state", simulated)).toThrow("drive-qualified path");
  });

  test("accepts a proved mkdir race and requires native seams off Windows", () => {
    const root = temporaryRoot();
    const raced = join(root, "raced");
    const kernel = new SimulatedKernel();
    const rename = (() => {}) as WindowsRecordRuntime["rename"];
    const files = {
      ...nodeFs,
      mkdirSync(
        path: nodeFs.PathLike,
        options?: nodeFs.MakeDirectoryOptions & { recursive?: false },
      ) {
        nodeFs.mkdirSync(path, options);
        throw Object.assign(new Error("mkdir raced"), { code: "EEXIST" });
      },
    } as unknown as WindowsRecordRuntime["files"];
    const backend = new WindowsOwnedProcessRecordBackend(raced, {
      timeoutMs: 1,
      runtime: {
        files,
        kernelLocks: kernel,
        rename,
        identity: () => IDENTITY,
        enforceLocalWindowsPath: false,
      },
    });
    expect(backend.root).toBe(raced);

    kernel.held = true;
    expect(() => backend.acquire("default-wait")).toThrow("process lock busy");
    if (process.platform !== "win32")
      expect(() => new WindowsOwnedProcessRecordBackend(temporaryRoot())).toThrow(
        "requires injected kernel seams",
      );
  });

  test("rejects symlink record entries during read and enumeration", () => {
    const { backend, recordsRoot } = harness();
    const outside = join(temporaryRoot(), "outside.json");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(recordsRoot, ENTRY));
    expect(() => backend.read(ENTRY)).toThrow("unsafe or oversized");
    expect(() => backend.entries()).toThrow("unsafe Windows record entry");
  });

  test("detects post-publication corruption and releases kernel exclusion", () => {
    const { backend, kernel, recordsRoot } = harness();
    expect(() =>
      backend.compareAndSwap(ENTRY, null, Buffer.from("expected"), {
        operation: "corrupt",
        fault: (point) => {
          if (point === "after-publication") writeFileSync(join(recordsRoot, ENTRY), "corrupt");
        },
      }),
    ).toThrow("postimage mismatch");
    expect(kernel.held).toBe(false);
  });

  test("preserves operation errors while still attempting failing lock cleanup", () => {
    const acquireRoot = temporaryRoot();
    let acquireReleases = 0;
    const failingKernel: WindowsKernelLockProvider = {
      tryAcquire: () => ({
        assertHeld: () => {},
        release: () => {
          acquireReleases += 1;
          throw new Error("acquire release secondary");
        },
      }),
    };
    const acquireBackend = new WindowsOwnedProcessRecordBackend(acquireRoot, {
      runtime: {
        kernelLocks: failingKernel,
        rename: () => {
          throw new Error("owner publication primary");
        },
        identity: () => IDENTITY,
        ownerAlive: () => false,
        enforceLocalWindowsPath: false,
      },
    });
    expect(() => acquireBackend.acquire("primary-acquire")).toThrow("owner publication primary");
    expect(acquireReleases).toBe(1);

    const casRoot = temporaryRoot();
    let casReleases = 0;
    const casBackend = new WindowsOwnedProcessRecordBackend(casRoot, {
      runtime: {
        kernelLocks: {
          tryAcquire: () => ({
            assertHeld: () => {},
            release: () => {
              casReleases += 1;
              throw new Error("kernel release secondary");
            },
          }),
        },
        rename: (source, target, flags) => {
          if (target.includes(WINDOWS_RECORD_STORAGE.RELEASE_MARKER))
            throw new Error("metadata release secondary");
          if (!flags.replace && existsSync(target))
            throw Object.assign(new Error("target exists"), { code: "EEXIST" });
          renameSync(source, target);
        },
        identity: () => IDENTITY,
        ownerAlive: () => false,
        enforceLocalWindowsPath: false,
      },
    });
    expect(() =>
      casBackend.compareAndSwap(ENTRY, null, Buffer.from("value"), {
        operation: "primary-cas",
        fault: (point) => {
          if (point === "after-stage-sync") throw new Error("CAS operation primary");
        },
      }),
    ).toThrow("CAS operation primary");
    expect(casReleases).toBe(1);
  });
});

interface NativeFixture {
  binding: WindowsRecordNativeBindings;
  calls: {
    create: unknown[][];
    lock: unknown[][];
    unlock: unknown[][];
    move: unknown[][];
    flush: number;
    close: number;
  };
  setError(code: number): void;
  setAttribute(value: number): void;
  setLinks(value: number): void;
  setDeletePending(value: boolean): void;
  setIdentity(value: number): void;
  setDriveType(value: number): void;
  setVolumeFlags(value: number): void;
  setVolumeResult(value: number): void;
  setWindowsDirectory(value: string | null): void;
  setResult(
    name: "create" | "lock" | "unlock" | "move" | "flush" | "close" | "info",
    value: number | bigint,
  ): void;
}

function nativeFixture(): NativeFixture {
  const calls: NativeFixture["calls"] = {
    create: [],
    lock: [],
    unlock: [],
    move: [],
    flush: 0,
    close: 0,
  };
  let error = 5;
  let attribute = 0;
  let links = 1;
  let deletePending = false;
  let identity = 1;
  let driveType: number = WINDOWS_NATIVE_RECORD.DRIVE_FIXED;
  let volumeFlags: number = WINDOWS_NATIVE_RECORD.FILE_PERSISTENT_ACLS;
  let volumeResult = 1;
  let windowsDirectory: string | null = "C:\\Windows";
  const results: Record<string, number | bigint> = {
    create: 41n,
    lock: 1,
    unlock: 1,
    move: 1,
    flush: 1,
    close: 1,
    info: 1,
  };
  const binding: WindowsRecordNativeBindings = {
    invalidHandle: -1n,
    createFile: (...args) => {
      calls.create.push(args);
      return results.create as bigint;
    },
    lockFile: (...args) => {
      calls.lock.push(args);
      return results.lock as number;
    },
    unlockFile: (...args) => {
      calls.unlock.push(args);
      return results.unlock as number;
    },
    moveFileEx: (...args) => {
      calls.move.push(args);
      return results.move as number;
    },
    flushFile: () => {
      calls.flush += 1;
      return results.flush as number;
    },
    closeHandle: () => {
      calls.close += 1;
      return results.close as number;
    },
    fileInfo: (_handle, informationClass, output) => {
      if (results.info === 0) return 0;
      if (informationClass === WINDOWS_NATIVE_RECORD.ATTRIBUTE_TAG_CLASS)
        output.writeUInt32LE(attribute, 0);
      if (informationClass === WINDOWS_NATIVE_RECORD.STANDARD_INFO_CLASS)
        output.writeUInt32LE(links, WINDOWS_NATIVE_RECORD.STANDARD_LINKS_OFFSET);
      if (informationClass === WINDOWS_NATIVE_RECORD.STANDARD_INFO_CLASS)
        output.writeUInt8(
          Number(deletePending),
          WINDOWS_NATIVE_RECORD.STANDARD_DELETE_PENDING_OFFSET,
        );
      if (informationClass === WINDOWS_NATIVE_RECORD.FILE_ID_INFO_CLASS)
        output.writeUInt32LE(identity, 8);
      return results.info as number;
    },
    driveType: () => driveType,
    volumeInformation: (_root, _volume, _volumeChars, _serial, _component, flags) => {
      flags[0] = volumeFlags;
      return volumeResult;
    },
    windowsDirectory: (output) => {
      if (windowsDirectory === null) return 0;
      output.write(windowsDirectory, "utf16le");
      return windowsDirectory.length;
    },
    lastError: () => error,
  };
  return {
    binding,
    calls,
    setError: (value) => {
      error = value;
    },
    setAttribute: (value) => {
      attribute = value;
    },
    setLinks: (value) => {
      links = value;
    },
    setDeletePending: (value) => {
      deletePending = value;
    },
    setIdentity: (value) => {
      identity = value;
    },
    setDriveType: (value) => {
      driveType = value;
    },
    setVolumeFlags: (value) => {
      volumeFlags = value;
    },
    setVolumeResult: (value) => {
      volumeResult = value;
    },
    setWindowsDirectory: (value) => {
      windowsDirectory = value;
    },
    setResult: (name, value) => {
      results[name] = value;
    },
  };
}

describe("native Windows record adapters", () => {
  test("uses write-through MoveFileExW with explicit replacement policy", () => {
    const fixture = nativeFixture();
    const rename = createWindowsWriteThroughRename(fixture.binding);
    rename("C:\\source", "C:\\target", { replace: false, writeThrough: true });
    rename("C:\\source", "C:\\target", { replace: true, writeThrough: true });
    expect(fixture.calls.move.map((call) => call[2])).toEqual([
      WINDOWS_NATIVE_RECORD.MOVE_WRITE_THROUGH,
      WINDOWS_NATIVE_RECORD.MOVE_WRITE_THROUGH | WINDOWS_NATIVE_RECORD.MOVE_REPLACE_EXISTING,
    ]);
    expect((fixture.calls.move[0]?.[0] as Buffer).toString("utf16le")).toContain(
      "\\\\?\\C:\\source",
    );
    expect(() => rename("a", "b", { replace: false, writeThrough: false } as never)).toThrow(
      "must be write-through",
    );
    fixture.setResult("move", 0);
    for (const [code, expected] of [
      [2, "ENOENT"],
      [80, "EEXIST"],
      [32, "EBUSY"],
      [5, "EACCES"],
    ] as const) {
      fixture.setError(code);
      try {
        rename("a", "b", { replace: false, writeThrough: true });
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe(expected);
      }
    }
  });

  test("accepts only a fixed local Windows drive", () => {
    const fixture = nativeFixture();
    expect(() => assertWindowsLocalRecordPath("C:\\state", fixture.binding)).not.toThrow();
    fixture.setDriveType(4);
    expect(() => assertWindowsLocalRecordPath("Z:\\state", fixture.binding)).toThrow(
      "fixed local drive",
    );
    expect(() => assertWindowsLocalRecordPath("\\\\server\\share", fixture.binding)).toThrow(
      "fixed local drive",
    );
    fixture.setDriveType(WINDOWS_NATIVE_RECORD.DRIVE_FIXED);
    fixture.setVolumeResult(0);
    expect(() => assertWindowsLocalRecordPath("C:\\state", fixture.binding)).toThrow(
      "GetVolumeInformationW failed with Windows error 5",
    );
    fixture.setVolumeResult(1);
    fixture.setVolumeFlags(0);
    expect(() => assertWindowsLocalRecordPath("C:\\state", fixture.binding)).toThrow(
      "lacks persistent ACLs",
    );
    fixture.setVolumeFlags(WINDOWS_NATIVE_RECORD.FILE_PERSISTENT_ACLS);
    expect(trustedWindowsSystemRoot(fixture.binding)).toBe("C:\\Windows");
    fixture.setWindowsDirectory(null);
    expect(() => trustedWindowsSystemRoot(fixture.binding)).toThrow(
      "system directory query failed",
    );
  });

  test("holds an exact deny-delete HANDLE lock and releases it", () => {
    const fixture = nativeFixture();
    const lock = createWindowsKernelLockProvider(fixture.binding).tryAcquire("C:\\writer.lock");
    expect(lock).not.toBeNull();
    lock?.assertHeld();
    lock?.release();
    expect(fixture.calls.create[0]?.[2]).toBe(
      WINDOWS_NATIVE_RECORD.FILE_SHARE_READ | WINDOWS_NATIVE_RECORD.FILE_SHARE_WRITE,
    );
    expect(fixture.calls.create[0]?.[1]).toBe(3_221_225_472);
    expect(fixture.calls.create[0]?.[5]).toBe(2_149_580_928);
    expect(fixture.calls.lock[0]?.slice(1, 5)).toEqual([
      WINDOWS_NATIVE_RECORD.LOCKFILE_EXCLUSIVE_LOCK |
        WINDOWS_NATIVE_RECORD.LOCKFILE_FAIL_IMMEDIATELY,
      0,
      WINDOWS_NATIVE_RECORD.LOCK_RANGE,
      WINDOWS_NATIVE_RECORD.LOCK_RANGE,
    ]);
    expect(fixture.calls.unlock).toHaveLength(1);
    expect(fixture.calls.flush).toBe(2);
    expect(fixture.calls.close).toBe(1);
    expect(() => lock?.assertHeld()).toThrow("ownership lost");
    expect(() => lock?.release()).toThrow("is released");
  });

  test("creates kernel metadata with token security and rejects a permissive existing handle", () => {
    const fixture = nativeFixture();
    const calls: unknown[] = [];
    const privacy: WindowsPrivateAuthority = {
      withCreationSecurity: (kind, create) => {
        expect(kind).toBe(WINDOWS_AUTHORITY_PATH_KIND.FILE);
        return create({ private: true });
      },
      verifyHandle: (handle, kind) => calls.push([handle, kind]),
    };
    const lock = createWindowsKernelLockProvider(fixture.binding, privacy).tryAcquire("C:\\lock");
    expect(fixture.calls.create[0]?.[3]).toEqual({ private: true });
    expect(calls).toEqual([[41n, WINDOWS_AUTHORITY_PATH_KIND.FILE]]);
    lock?.release();
    const permissive: WindowsPrivateAuthority = {
      ...privacy,
      verifyHandle: () => {
        throw new Error("permissive existing lock metadata");
      },
    };
    expect(() =>
      createWindowsKernelLockProvider(nativeFixture().binding, permissive).tryAcquire("C:\\lock"),
    ).toThrow("permissive existing lock metadata");
  });

  test("returns busy only for ERROR_LOCK_VIOLATION and closes the HANDLE", () => {
    const fixture = nativeFixture();
    fixture.setResult("lock", 0);
    fixture.setError(WINDOWS_NATIVE_RECORD.ERROR_LOCK_VIOLATION);
    expect(
      createWindowsKernelLockProvider(fixture.binding).tryAcquire("C:\\writer.lock"),
    ).toBeNull();
    expect(fixture.calls.close).toBe(1);
    fixture.setError(5);
    expect(() =>
      createWindowsKernelLockProvider(fixture.binding).tryAcquire("C:\\writer.lock"),
    ).toThrow("LockFileEx failed");
  });

  test("rejects invalid handles, reparse points, directories, links, and identity loss", () => {
    const fixture = nativeFixture();
    fixture.setResult("create", -1n);
    expect(() => createWindowsKernelLockProvider(fixture.binding).tryAcquire("C:\\x")).toThrow(
      "CreateFileW failed",
    );
    fixture.setResult("create", 41n);
    fixture.setAttribute(WINDOWS_NATIVE_RECORD.FILE_ATTRIBUTE_REPARSE_POINT);
    expect(() => createWindowsKernelLockProvider(fixture.binding).tryAcquire("C:\\x")).toThrow(
      "unsafe Windows kernel lock file",
    );
    fixture.setAttribute(WINDOWS_NATIVE_RECORD.FILE_ATTRIBUTE_DIRECTORY);
    expect(() => createWindowsKernelLockProvider(fixture.binding).tryAcquire("C:\\x")).toThrow(
      "unsafe Windows kernel lock file",
    );
    fixture.setAttribute(0);
    fixture.setLinks(2);
    expect(() => createWindowsKernelLockProvider(fixture.binding).tryAcquire("C:\\x")).toThrow(
      "multiply-linked",
    );
    fixture.setLinks(1);
    fixture.setDeletePending(true);
    expect(() => createWindowsKernelLockProvider(fixture.binding).tryAcquire("C:\\x")).toThrow(
      "delete-pending",
    );
    fixture.setDeletePending(false);
    fixture.setIdentity(0);
    expect(() => createWindowsKernelLockProvider(fixture.binding).tryAcquire("C:\\x")).toThrow(
      "identity is unavailable",
    );
    fixture.setIdentity(1);
    const lock = createWindowsKernelLockProvider(fixture.binding).tryAcquire("C:\\x");
    fixture.setIdentity(2);
    expect(() => lock?.assertHeld()).toThrow("ownership lost");
    lock?.release();
  });

  test("propagates native information, flush, unlock, and close failures", () => {
    for (const failing of ["info", "flush"] as const) {
      const fixture = nativeFixture();
      fixture.setResult(failing, 0);
      expect(() => createWindowsKernelLockProvider(fixture.binding).tryAcquire("C:\\x")).toThrow();
      expect(fixture.calls.close).toBe(1);
    }
    const unlock = nativeFixture();
    const unlockHandle = createWindowsKernelLockProvider(unlock.binding).tryAcquire("C:\\x");
    unlock.setResult("unlock", 0);
    expect(() => unlockHandle?.release()).toThrow("UnlockFileEx failed");
    expect(unlock.calls.close).toBe(1);
    const close = nativeFixture();
    const closeHandle = createWindowsKernelLockProvider(close.binding).tryAcquire("C:\\x");
    close.setResult("close", 0);
    expect(() => closeHandle?.release()).toThrow("CloseHandle failed");
    expect(close.calls.unlock).toHaveLength(1);
    const flush = nativeFixture();
    const flushHandle = createWindowsKernelLockProvider(flush.binding).tryAcquire("C:\\x");
    flush.setResult("flush", 0);
    flush.setResult("unlock", 0);
    flush.setResult("close", 0);
    expect(() => flushHandle?.release()).toThrow("FlushFileBuffers failed");
    expect(flush.calls.unlock).toHaveLength(1);
    expect(flush.calls.close).toBe(1);
  });

  test("constructs all stdcall bindings through an injectable Koffi loader", () => {
    const declarations: unknown[][] = [];
    const library = {
      func: (...args: unknown[]) => {
        declarations.push(args);
        return () => 1;
      },
    };
    const koffi = {
      load: (name: string) => {
        expect(name).toBe("Kernel32.dll");
        return library;
      },
      pointer: (value: unknown) => ({ pointer: value }),
      opaque: () => ({ opaque: true }),
      struct: (value: unknown) => ({ struct: value }),
      inout: (value: unknown) => ({ inout: value }),
      out: (value: unknown) => ({ out: value }),
      sizeof: () => 8,
    };
    const loaded = loadWindowsRecordNativeBindings({
      requireModule: () => koffi,
      isBun: false,
    });
    expect(loaded.invalidHandle).toBe(18_446_744_073_709_551_615n);
    expect(declarations).toHaveLength(11);
    expect(declarations.every((entry) => entry[0] === "__stdcall")).toBe(true);
  });

  test("locks and renames through the builtin Bun FFI adapter with encoded OVERLAPPED", () => {
    const calls: string[] = [];
    const dispatch: Record<string, (...args: any[]) => unknown> = {
      GetDriveTypeW: () => WINDOWS_NATIVE_RECORD.DRIVE_FIXED,
      GetVolumeInformationW: (
        _root: Buffer,
        _volume: Buffer,
        _chars: number,
        _serial: { [0]: number },
        _component: { [0]: number },
        flags: { [0]: number },
      ) => {
        flags[0] = WINDOWS_NATIVE_RECORD.FILE_PERSISTENT_ACLS;
        return 1;
      },
      GetWindowsDirectoryW: (output: Buffer) => {
        output.write("C:\\Windows", "utf16le");
        return 11;
      },
      GetLastError: () => 5,
      CreateFileW: () => 41n,
      GetFileInformationByHandleEx: (_handle: bigint, informationClass: number, output: Buffer) => {
        calls.push("info");
        if (informationClass === WINDOWS_NATIVE_RECORD.ATTRIBUTE_TAG_CLASS)
          output.writeUInt32LE(0, 0);
        if (informationClass === WINDOWS_NATIVE_RECORD.STANDARD_INFO_CLASS) {
          output.writeUInt32LE(1, WINDOWS_NATIVE_RECORD.STANDARD_LINKS_OFFSET);
          output.writeUInt8(0, WINDOWS_NATIVE_RECORD.STANDARD_DELETE_PENDING_OFFSET);
        }
        if (informationClass === WINDOWS_NATIVE_RECORD.FILE_ID_INFO_CLASS)
          output.writeUInt32LE(1, 8);
        return 1;
      },
      LockFileEx: (_handle: bigint, ...rest: unknown[]) => {
        calls.push("lock");
        const overlapped = rest[4] as Buffer;
        expect(overlapped.readBigUInt64LE(0)).toBe(0n);
        expect(overlapped.readBigUInt64LE(8)).toBe(0n);
        expect(overlapped.readUInt32LE(16)).toBe(0);
        expect(overlapped.readUInt32LE(20)).toBe(0);
        expect(overlapped.readBigUInt64LE(24)).toBe(0n);
        return 1;
      },
      UnlockFileEx: (_handle: bigint, ...rest: unknown[]) => {
        calls.push("unlock");
        expect(Buffer.isBuffer(rest[3])).toBe(true);
        return 1;
      },
      MoveFileExW: () => 1,
      FlushFileBuffers: () => 1,
      CloseHandle: () => 1,
    };
    const ffi = {
      FFIType: { ptr: 1, u32: 2, i32: 3 },
      dlopen: () => ({
        symbols: Object.fromEntries(
          Object.keys(dispatch).map((name) => [
            name,
            (...args: unknown[]) => dispatch[name]?.(...args) ?? 1,
          ]),
        ),
      }),
    };
    const binding = loadWindowsRecordNativeBindings({ isBun: true, requireModule: () => ffi });
    expect(binding.invalidHandle).toBe(18_446_744_073_709_551_615n);
    expect(() => assertWindowsLocalRecordPath("C:\\record", binding)).not.toThrow();
    const provider = createWindowsKernelLockProvider(binding);
    const lock = provider.tryAcquire("C:\\writer.lock");
    expect(lock).not.toBeNull();
    lock?.assertHeld();
    lock?.release();
    expect(calls).toContain("info");
    expect(calls).toContain("lock");
    expect(calls).toContain("unlock");
    const rename = createWindowsWriteThroughRename(binding);
    rename("C:\\source", "C:\\target", { replace: true, writeThrough: true });
  });
});
