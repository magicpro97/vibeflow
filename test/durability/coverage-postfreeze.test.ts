import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { createServer } from "node:net";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runCleanups, withFailureCleanup } from "../../src/durability/cleanup.js";
import { openVffrFileForAppendAt, vffrFileBytes } from "../../src/durability/frame-file.js";
import {
  DurabilityError,
  acquireProcessLock,
  atomicCompareAndSwap,
  canonicalJson,
  createOrVerifyPrivateFile,
  digestV1,
  encodeVffrFrame,
  ensurePrivateDirectory,
  inspectProcessLock,
  readVffrBytes,
} from "../../src/durability/index.js";
import {
  parseProcessLockOwner,
  processLockOwnerIsAlive,
  processStartIdentity,
} from "../../src/durability/lock-owner.js";
import {
  STABLE_LOCK_FILE_BYTES,
  ensureStableLockInitialized,
  readStableLockRecord,
} from "../../src/durability/lock-record.js";
import * as nativeRuntime from "../../src/durability/native-runtime.js";
import {
  closePinnedDirectory,
  createAt,
  linkAt,
  openAt,
  openPinnedDescendant,
  openPrivateDirectory,
  pinnedDirectoryPath,
  pinnedDirectoryPathForRuntime,
  tryLinkAt,
  unlinkAt,
} from "../../src/durability/native.js";
import {
  assertNoSymlinkComponents,
  createPrivateFileAt,
  openOrCreatePrivateFileAt,
  writePrivateTemporaryAt,
} from "../../src/durability/path.js";

const { native } = nativeRuntime;

const vffrOptions = {
  domain: "catalog-delta" as const,
  maxFrames: 8,
  maxPayloadBytes: 8_192,
  maxAggregateBytes: 64 * 1_024,
  validatePayload: () => {},
  computePayloadDigest(payload: Record<string, unknown>) {
    const { event_digest: _digest, ...body } = payload;
    return digestV1("VF-DURABILITY-COVERAGE\0v1\0", body);
  },
  validateJournalIdentity: () => true,
};

function event() {
  const body = {
    schema_version: "1.0",
    sequence: 0,
    previous_event_digest: null,
    recorded_at: "2026-08-26T00:00:00.000Z",
  };
  return { ...body, event_digest: digestV1("VF-DURABILITY-COVERAGE\0v1\0", body) };
}

function sandbox(prefix: string): string {
  return fs.mkdtempSync(join(tmpdir(), prefix));
}

function closeQuietly(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    fs.closeSync(fd);
  } catch {
    // A test may already have closed the injected descriptor.
  }
}

function descriptorFor(path: string, exclude: ReadonlySet<number> = new Set()): number {
  const expected = fs.statSync(path);
  const descriptorRoot = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
  for (const name of fs.readdirSync(descriptorRoot)) {
    const fd = Number(name);
    if (!Number.isSafeInteger(fd) || exclude.has(fd)) continue;
    try {
      const observed = fs.fstatSync(fd);
      if (observed.dev === expected.dev && observed.ino === expected.ino) return fd;
    } catch {
      // Descriptor directory enumeration can race harmlessly with runtime handles.
    }
  }
  throw new Error(`no live descriptor for ${path}`);
}

function descriptorMatches(fd: number, path: string): boolean {
  try {
    const expected = fs.statSync(path);
    const observed = fs.fstatSync(fd);
    return observed.dev === expected.dev && observed.ino === expected.ino;
  } catch {
    return false;
  }
}

test("cleanup helpers retain the first cleanup failure and failure-only cleanup preserves primary", () => {
  const first = new Error("first-cleanup");
  let ranSecond = false;
  expect(() =>
    runCleanups([
      () => {
        throw first;
      },
      () => {
        ranSecond = true;
        throw new Error("second-cleanup");
      },
    ]),
  ).toThrow(first);
  expect(ranSecond).toBeTrue();

  const primary = new Error("primary-operation");
  expect(() =>
    withFailureCleanup(() => {
      throw primary;
    }, [() => {}]),
  ).toThrow(primary);
});

test("canonical JSON rejects an unpaired low surrogate", () => {
  expect(() => canonicalJson("\udc00")).toThrow(/low surrogate/);
});

test("compatibility path walking distinguishes a missing suffix from a non-directory failure", () => {
  const root = sandbox("vf-path-walk-");
  try {
    expect(assertNoSymlinkComponents(join(root, "missing", "suffix"))).toBe(
      join(fs.realpathSync(root), "missing", "suffix"),
    );
    fs.writeFileSync(join(root, "file"), "x");
    expect(() => assertNoSymlinkComponents(join(root, "file", "child"))).toThrow(
      /not a directory/i,
    );

    if (process.platform === "darwin") {
      const realLstat = fs.lstatSync;
      let tmpCalls = 0;
      const lstat = spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike) => {
        if (String(path) === "/tmp" && ++tmpCalls === 2) throw new Error("alias inspection failed");
        return realLstat(path);
      }) as typeof fs.lstatSync);
      try {
        expect(() => assertNoSymlinkComponents("/tmp/vf-path-alias-probe")).toThrow(
          /symlink path component rejected/,
        );
      } finally {
        lstat.mockRestore();
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stable lock records recover only an exact interrupted initial prefix", () => {
  const root = sandbox("vf-lock-prefix-");
  const path = join(root, "writer.lock");
  const fd = fs.openSync(path, "w+", 0o600);
  try {
    const initialized = ensureStableLockInitialized(fd, path);
    expect(initialized).toEqual({ generation: 0, payload: null, slot: 0 });
    const initial = fs.readFileSync(path);

    for (const prefix of [0, 1, 97, 4_095]) {
      const partial = Buffer.alloc(STABLE_LOCK_FILE_BYTES);
      initial.copy(partial, 0, 0, prefix);
      fs.writeFileSync(path, partial, { mode: 0o600 });
      expect(readStableLockRecord(fd, path)).toEqual({
        generation: 0,
        payload: null,
        slot: null,
      });
    }

    const corrupt = Buffer.alloc(STABLE_LOCK_FILE_BYTES);
    corrupt[100] = 0xff;
    fs.writeFileSync(path, corrupt, { mode: 0o600 });
    expect(() => readStableLockRecord(fd, path)).toThrow(/no valid owner slot/);
  } finally {
    fs.closeSync(fd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Linux process identities parse procfs defensively and bind liveness to start identity", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const realReadFile = fs.readFileSync;
  let scenario: "success" | "long" | "missing-paren" | "bad-ticks" | "bad-boot" | "throw" =
    "success";
  const read = spyOn(fs, "readFileSync").mockImplementation(((
    path: fs.PathLike,
    ...args: unknown[]
  ) => {
    const observed = String(path);
    if (observed.startsWith("/proc/") && observed.endsWith("/stat")) {
      if (scenario === "throw")
        throw Object.assign(new Error("missing procfs"), { code: "ENOENT" });
      if (scenario === "long") return "x".repeat(16 * 1_024 + 1);
      if (scenario === "missing-paren") return "malformed-stat";
      const ticks = scenario === "bad-ticks" ? "not-a-number" : "424242";
      return `${process.pid} (bun worker) R ${Array(18).fill("1").join(" ")} ${ticks}`;
    }
    if (observed === "/proc/sys/kernel/random/boot_id") {
      return scenario === "bad-boot" ? "bad" : "12345678-1234-1234-1234-123456789ABC";
    }
    return (realReadFile as (...values: unknown[]) => unknown)(path, ...args);
  }) as typeof fs.readFileSync);
  try {
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    expect(processStartIdentity()).toBe("linux:12345678-1234-1234-1234-123456789abc:424242");
    const identity = processStartIdentity() as string;
    expect(
      processLockOwnerIsAlive({
        schema_version: "1.0",
        pid: process.pid,
        process_start_identity: identity,
        host: hostname(),
        operation: "coverage",
        nonce: "a".repeat(64),
      }),
    ).toBeTrue();

    for (const rejected of ["long", "missing-paren", "bad-ticks", "bad-boot", "throw"] as const) {
      scenario = rejected;
      expect(processStartIdentity()).toBeNull();
    }
  } finally {
    read.mockRestore();
    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
  }

  expect(() => parseProcessLockOwner(Buffer.from([0xff]))).toThrow(/owner metadata/);
  if (process.platform !== "linux") expect(processStartIdentity(2_147_483_647)).toBeNull();
});

test("lock inspection treats a missing parent as an absent lock", () => {
  const root = sandbox("vf-lock-inspect-absent-");
  try {
    expect(inspectProcessLock(join(root, "missing", "writer.lock"))).toBeNull();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VFFR callback failures and canonical-frame failures retain their typed classification", () => {
  expect(() =>
    encodeVffrFrame("catalog-delta", event(), {
      ...vffrOptions,
      validatePayload() {
        throw new Error("schema rejected");
      },
    }),
  ).toThrow(/codec callback rejected/);

  const domain = Buffer.from("catalog-delta", "ascii");
  const payload = Buffer.from(`${JSON.stringify(event(), null, 1)}\n`, "utf8");
  const header = Buffer.alloc(20);
  Buffer.from("VFFR", "ascii").copy(header);
  header[4] = 1;
  header.writeUInt16BE(domain.length, 6);
  header.writeBigUInt64BE(0n, 8);
  header.writeUInt32BE(payload.length, 16);
  const checksum = createHash("sha256")
    .update(Buffer.from("VF-FRAME-CHECKSUM\0v1\0", "utf8"))
    .update(header)
    .update(domain)
    .update(payload)
    .digest();
  expect(() =>
    readVffrBytes(Buffer.concat([header, domain, payload, checksum]), vffrOptions),
  ).toThrow(/not canonical JSON/);
});

test("VFFR file recovery removes an abandoned stage and rejects an unrecognized hard link", () => {
  const root = sandbox("vf-vffr-file-");
  ensurePrivateDirectory(root);
  const directory = openPrivateDirectory(root, false);
  const name = "events.frames";
  const stageIdentity = createHash("sha256")
    .update("VF-VFFR-FIRST-STAGE\0v1\0")
    .update(name)
    .digest("hex");
  const stagedName = `.vffr-first-${stageIdentity}.stage`;
  try {
    fs.writeFileSync(join(root, stagedName), "abandoned", { mode: 0o600 });
    expect(openVffrFileForAppendAt(directory, name)).toBeNull();
    expect(fs.existsSync(join(root, stagedName))).toBeFalse();

    fs.writeFileSync(join(root, name), "journal", { mode: 0o600 });
    fs.linkSync(join(root, name), join(root, "unrecognized-link"));
    expect(() => openVffrFileForAppendAt(directory, name)).toThrow(/unrecognized hard link/);
  } finally {
    closePinnedDirectory(directory);
    fs.rmSync(root, { recursive: true, force: true });
  }

  const missingParent = join(root, "missing", "events.frames");
  expect(vffrFileBytes(missingParent, 1_024)).toBeNull();
});

test("native relative file operations expose exact create, link, and missing semantics", () => {
  const root = sandbox("vf-native-files-");
  ensurePrivateDirectory(root);
  const directory = openPrivateDirectory(root, false);
  let sourceFd: number | undefined;
  let openedFd: number | undefined;
  try {
    sourceFd = createAt(directory, "source", fs.constants.O_RDWR) ?? undefined;
    expect(sourceFd).toBeNumber();
    fs.writeSync(sourceFd as number, Buffer.from("value"));
    openedFd = openAt(directory, "source", fs.constants.O_RDONLY);
    expect(fs.readFileSync(openedFd, "utf8")).toBe("value");
    expect(createAt(directory, "source", fs.constants.O_RDWR)).toBeNull();

    linkAt(directory, "source", "linked");
    expect(tryLinkAt(directory, "source", "linked")).toBeFalse();
    unlinkAt(directory, "already-missing", true);
  } finally {
    closeQuietly(openedFd);
    closeQuietly(sourceFd);
    closePinnedDirectory(directory);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("private path helpers sanitize temporary names and fence repeated allocation collisions", () => {
  const root = sandbox("vf-private-temp-");
  ensurePrivateDirectory(root);
  const directory = openPrivateDirectory(root, false);
  try {
    const temporary = writePrivateTemporaryAt(directory, "../../unsafe name", Buffer.from("ok"));
    expect(basename(temporary)).toBe(temporary);
    expect(fs.readFileSync(join(root, temporary), "utf8")).toBe("ok");

    const random = spyOn(crypto, "randomBytes");
    random.mockImplementation((() => Buffer.alloc(16)) as never);
    try {
      const collision = ".___-00000000000000000000000000000000.tmp";
      fs.writeFileSync(join(root, collision), "occupied", { mode: 0o600 });
      expect(() => writePrivateTemporaryAt(directory, "!!!", Buffer.from("new"))).toThrow(
        /unique private temporary/,
      );
    } finally {
      random.mockRestore();
    }
  } finally {
    closePinnedDirectory(directory);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CAS replaces a stale deterministic stage before committing", () => {
  const root = sandbox("vf-cas-stale-stage-");
  ensurePrivateDirectory(root);
  const target = join(root, "head");
  const stage = join(
    root,
    `.cas-stage-${createHash("sha256").update("head", "utf8").digest("hex")}`,
  );
  fs.writeFileSync(stage, "stale", { mode: 0o600 });
  const lock = acquireProcessLock(join(root, "writer.lock"), { operation: "stale-cas-stage" });
  try {
    atomicCompareAndSwap(target, null, Buffer.from("replacement"), { lock });
    expect(fs.readFileSync(target, "utf8")).toBe("replacement");
    expect(fs.existsSync(stage)).toBeFalse();
  } finally {
    lock.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("create-or-verify accepts exact staging and publication races and rejects a differing race", () => {
  const root = sandbox("vf-object-races-");
  ensurePrivateDirectory(root);
  const lock = acquireProcessLock(join(root, "writer.lock"), { operation: "object-races" });
  const api = native();
  const realOpenat = api.openat;
  const realLinkat = api.linkat;
  try {
    for (const [name, racedBytes, expected] of [
      ["exact", Buffer.from("exact"), "created"],
      ["different", Buffer.from("wrong"), "conflict"],
    ] as const) {
      const target = join(root, name);
      const staged = join(root, `.${name}.create-object`);
      let injected = false;
      api.openat = (directoryFd, entry, flags, modeType, mode) => {
        if (
          !injected &&
          entry === `.${name}.create-object` &&
          (flags & fs.constants.O_CREAT) !== 0
        ) {
          injected = true;
          fs.writeFileSync(staged, racedBytes, { mode: 0o600 });
        }
        return realOpenat(directoryFd, entry, flags, modeType, mode);
      };
      if (expected === "created") {
        expect(createOrVerifyPrivateFile(target, Buffer.from("exact"), { lock })).toBe("created");
      } else {
        expect(() => createOrVerifyPrivateFile(target, Buffer.from("exact"), { lock })).toThrow(
          /staging conflict/,
        );
      }
      api.openat = realOpenat;
    }

    const target = join(root, "publication");
    let linked = false;
    api.linkat = (fromFd, from, toFd, to, flags) => {
      if (!linked && from === ".publication.create-object" && to === "publication") {
        linked = true;
        fs.linkSync(join(root, from), join(root, to));
      }
      return realLinkat(fromFd, from, toFd, to, flags);
    };
    expect(createOrVerifyPrivateFile(target, Buffer.from("published"), { lock })).toBe("verified");
    expect(fs.readFileSync(target, "utf8")).toBe("published");
  } finally {
    api.openat = realOpenat;
    api.linkat = realLinkat;
    lock.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("publication recovery closes or rejects entries that disappear after exact reads", () => {
  for (const replacement of ["missing-final", "invalid-stage"] as const) {
    const root = sandbox(`vf-object-publication-${replacement}-`);
    ensurePrivateDirectory(root);
    const target = join(root, "object");
    const staged = join(root, ".object.create-object");
    const lock = acquireProcessLock(join(root, "writer.lock"), { operation: replacement });
    try {
      expect(() =>
        createOrVerifyPrivateFile(target, Buffer.from("bytes"), {
          lock,
          fault(point) {
            if (point === "after-link") throw new Error("leave-publication-pair");
          },
        }),
      ).toThrow("leave-publication-pair");
      const inode = fs.statSync(target).ino;
      const realClose = fs.closeSync;
      let matchingCloses = 0;
      const close = spyOn(fs, "closeSync").mockImplementation((fd) => {
        let matches = false;
        try {
          matches = fs.fstatSync(fd).ino === inode;
        } catch {}
        const result = realClose(fd);
        if (matches && ++matchingCloses === 2) {
          if (replacement === "missing-final") fs.unlinkSync(target);
          else {
            fs.unlinkSync(staged);
            fs.mkdirSync(staged, { mode: 0o700 });
          }
        }
        return result;
      });
      try {
        expect(() => createOrVerifyPrivateFile(target, Buffer.from("bytes"), { lock })).toThrow(
          replacement === "missing-final" ? /entries disappeared/ : /private file mode/,
        );
      } finally {
        close.mockRestore();
      }
    } finally {
      try {
        lock.release();
      } catch {}
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a failed private-file creation preserves its primary error across both cleanup failures", () => {
  const root = sandbox("vf-private-create-cleanup-");
  ensurePrivateDirectory(root);
  const directory = openPrivateDirectory(root, false);
  const api = native();
  const realUnlinkat = api.unlinkat;
  const realClose = fs.closeSync;
  const primary = new Error("injected-fchmod");
  let leaked: number | undefined;
  const chmod = spyOn(fs, "fchmodSync").mockImplementation((fd) => {
    leaked = fd;
    throw primary;
  });
  const close = spyOn(fs, "closeSync").mockImplementation((fd) => {
    if (fd === leaked) throw new Error("injected-close");
    return realClose(fd);
  });
  api.unlinkat = () => -1;
  try {
    expect(() => createPrivateFileAt(directory, "failed", Buffer.from("bytes"))).toThrow(primary);
  } finally {
    chmod.mockRestore();
    close.mockRestore();
    api.unlinkat = realUnlinkat;
    closeQuietly(leaked);
    try {
      fs.unlinkSync(join(root, "failed"));
    } catch {}
    closePinnedDirectory(directory);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("open-or-create handles a raced file and closes an invalid raced winner", () => {
  for (const mode of [0o600, 0o644] as const) {
    const root = sandbox(`vf-open-race-${mode}-`);
    ensurePrivateDirectory(root);
    const directory = openPrivateDirectory(root, false);
    const api = native();
    const realOpenat = api.openat;
    const path = join(root, "raced");
    let injected = false;
    api.openat = (directoryFd, name, flags, modeType, fileMode) => {
      if (!injected && name === "raced" && (flags & fs.constants.O_CREAT) !== 0) {
        injected = true;
        fs.writeFileSync(path, "winner", { mode });
      }
      return realOpenat(directoryFd, name, flags, modeType, fileMode);
    };
    try {
      if (mode === 0o600) {
        const fd = openOrCreatePrivateFileAt(directory, "raced");
        try {
          expect(fs.readFileSync(fd, "utf8")).toBe("winner");
        } finally {
          fs.closeSync(fd);
        }
      } else {
        expect(() => openOrCreatePrivateFileAt(directory, "raced")).toThrow(/private file mode/);
      }
    } finally {
      api.openat = realOpenat;
      closePinnedDirectory(directory);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("open-or-create preserves a setup failure when close and unlink cleanup also fail", () => {
  const root = sandbox("vf-open-create-cleanup-");
  ensurePrivateDirectory(root);
  const directory = openPrivateDirectory(root, false);
  const api = native();
  const realUnlinkat = api.unlinkat;
  const realClose = fs.closeSync;
  const primary = new Error("injected-created-fsync");
  let createdFd: number | undefined;
  const fsync = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    const stat = fs.fstatSync(fd);
    if (stat.isFile()) {
      createdFd = fd;
      throw primary;
    }
    return undefined;
  });
  const close = spyOn(fs, "closeSync").mockImplementation((fd) => {
    if (fd === createdFd) throw new Error("injected-close");
    return realClose(fd);
  });
  api.unlinkat = () => -1;
  try {
    expect(() => openOrCreatePrivateFileAt(directory, "failed")).toThrow(primary);
  } finally {
    fsync.mockRestore();
    close.mockRestore();
    api.unlinkat = realUnlinkat;
    closeQuietly(createdFd);
    try {
      fs.unlinkSync(join(root, "failed"));
    } catch {}
    closePinnedDirectory(directory);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("native pinned-directory path failures are classified without losing cleanup", () => {
  const root = sandbox("vf-native-path-errors-");
  ensurePrivateDirectory(root);
  const directory = openPrivateDirectory(root, false);
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const readlink = spyOn(fs, "readlinkSync");
  try {
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    readlink.mockReturnValue(root);
    expect(pinnedDirectoryPath(directory.fd)).toBe(root);
    readlink.mockImplementation(() => {
      throw Object.assign(new Error("missing fd link"), { code: "ENOENT" });
    });
    expect(() => pinnedDirectoryPath(directory.fd)).toThrow(/cannot resolve pinned directory/);
    readlink.mockReturnValue(`${root} (deleted)`);
    expect(() => pinnedDirectoryPath(directory.fd)).toThrow(/was removed/);
  } finally {
    readlink.mockRestore();
    if (realPlatform) Object.defineProperty(process, "platform", realPlatform);
    closePinnedDirectory(directory);
    fs.rmSync(root, { recursive: true, force: true });
  }

  const invalid = sandbox("vf-native-realpath-error-");
  ensurePrivateDirectory(invalid);
  const pinned = openPrivateDirectory(invalid, false);
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const realpath = spyOn(fs, "realpathSync").mockImplementation((() => {
    throw Object.assign(new Error("missing fd alias"), { code: "ENOENT" });
  }) as unknown as typeof fs.realpathSync);
  try {
    // Force the non-Linux branch so the mocked realpath (not /proc/self/fd) is exercised.
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    expect(() => pinnedDirectoryPath(pinned.fd)).toThrow(/Bun cannot resolve pinned directory/);
  } finally {
    if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
    realpath.mockRestore();
    closePinnedDirectory(pinned);
    fs.rmSync(invalid, { recursive: true, force: true });
  }
});

test("native runtime initialization exercises Node, unsupported, and Linux loader authorities", async () => {
  const bunDescriptor = Object.getOwnPropertyDescriptor(process.versions, "bun");
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (!bunDescriptor || !platformDescriptor) throw new Error("runtime descriptors are unavailable");
  const realHostPlatform = platformDescriptor.value;
  try {
    const nodeBindings = nativeRuntime.loadNodeBindings();
    expect(nodeBindings.openat).toBeFunction();
    if (process.platform === "darwin") {
      expect(nodeBindings.fcntl).toBeFunction();
    } else {
      expect(nodeBindings.fcntl).toBeNull();
    }
    const syntheticPath = "/private/tmp/vf-pinned-runtime";
    expect(
      pinnedDirectoryPathForRuntime(17, {
        platform: "darwin",
        isBun: false,
        realpath: fs.realpathSync,
        fcntl: (_fd, _command, _pointerType, output) => {
          output.write(`${syntheticPath}\0`, "utf8");
          return 0;
        },
      }),
    ).toBe(syntheticPath);
    nativeRuntime.loadBunBindings();

    expect(
      nativeRuntime.initializeNativeRuntime({ disabled: true, platform: "darwin", isBun: true }),
    ).toEqual({
      bindings: null,
      unavailableReason: "native durability was disabled by the runtime",
    });
    expect(
      nativeRuntime.initializeNativeRuntime({ disabled: false, platform: "win32", isBun: true }),
    ).toEqual({
      bindings: null,
      unavailableReason: "native durability is unsupported on win32",
    });

    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
    const linuxLoader = nativeRuntime.initializeNativeRuntime({
      disabled: false,
      platform: "linux",
      isBun: true,
    });
    // On a real Linux runtime the system libc loads and durability becomes
    // available, so the loader succeeds. Everywhere else the forced non-Linux
    // host has no Linux libc, so the loader authority fails closed.
    if (realHostPlatform === "linux") {
      expect(linuxLoader.unavailableReason).toBe("native durability is not initialized");
    } else {
      expect(linuxLoader.unavailableReason).toMatch(/native durability load failed/);
    }
  } finally {
    Object.defineProperty(process.versions, "bun", bunDescriptor);
    Object.defineProperty(process, "platform", platformDescriptor);
    nativeRuntime.loadBunBindings();
  }
});

test("pinned directory walkers preserve close failures while cleaning the newly opened handle", () => {
  const root = sandbox("vf-native-close-walk-");
  const child = join(root, "child");
  ensurePrivateDirectory(child);
  const realClose = fs.closeSync;
  let leaked: number | undefined;
  let injected = false;
  const close = spyOn(fs, "closeSync").mockImplementation((fd) => {
    if (!injected && descriptorMatches(fd, root)) {
      injected = true;
      leaked = fd;
      throw new Error("injected-open-private-close");
    }
    return realClose(fd);
  });
  try {
    expect(() => openPrivateDirectory(child, false)).toThrow("injected-open-private-close");
  } finally {
    close.mockRestore();
    closeQuietly(leaked);
  }

  const base = openPrivateDirectory(root, false);
  leaked = undefined;
  injected = false;
  const descendantClose = spyOn(fs, "closeSync").mockImplementation((fd) => {
    if (!injected && fd !== base.fd && descriptorMatches(fd, root)) {
      injected = true;
      leaked = fd;
      throw new Error("injected-descendant-close");
    }
    return realClose(fd);
  });
  try {
    expect(() => openPinnedDescendant(base, child, false)).toThrow("injected-descendant-close");
  } finally {
    descendantClose.mockRestore();
    closeQuietly(leaked);
    closePinnedDirectory(base);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("open directory creation preserves fchmod failure and removes the rejected directory", () => {
  const root = sandbox("vf-native-fchmodat-");
  ensurePrivateDirectory(root);
  const base = openPrivateDirectory(root, false);
  const api = native();
  const realFchmodat = api.fchmodat;
  api.fchmodat = () => -1;
  try {
    expect(() => openPinnedDescendant(base, join(root, "rejected"), true)).toThrow(/fchmodat/);
    expect(fs.existsSync(join(root, "rejected"))).toBeFalse();
  } finally {
    api.fchmodat = realFchmodat;
    closePinnedDirectory(base);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("lock acquisition rolls back a committed owner and fences an unrollbackable publication", () => {
  const root = sandbox("vf-lock-rollback-");
  ensurePrivateDirectory(root);
  const path = join(root, "writer.lock");
  try {
    expect(() =>
      acquireProcessLock(path, {
        operation: "rollback-cleanly",
        fault(point) {
          if (point === "acquire-owner-slot-written") throw new Error("publish-failed");
        },
      }),
    ).toThrow("publish-failed");

    const realFsync = fs.fsyncSync;
    let rejectNextFileFsync = false;
    const fsync = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (rejectNextFileFsync && fs.fstatSync(fd).isFile())
        throw new Error("rollback-fsync-failed");
      return realFsync(fd);
    });
    try {
      expect(() =>
        acquireProcessLock(path, {
          operation: "rollback-impossible",
          fault(point) {
            if (point === "acquire-owner-slot-written") {
              rejectNextFileFsync = true;
              throw new Error("publication-failed");
            }
          },
        }),
      ).toThrow(/could not be rolled back safely/);
    } finally {
      fsync.mockRestore();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("lock coverage-root validation closes its acquired root before rethrowing", () => {
  const root = sandbox("vf-lock-coverage-validation-");
  const lockRoot = join(root, "lock-root");
  const outside = join(root, "outside");
  ensurePrivateDirectory(lockRoot);
  ensurePrivateDirectory(outside);
  try {
    expect(() =>
      acquireProcessLock(join(lockRoot, "writer.lock"), {
        operation: "invalid-coverage-root",
        coverageRoot: outside,
      }),
    ).toThrow(/does not own the lock path/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("lock release reports close failures after attempting every held descriptor", () => {
  for (const failureTarget of ["file", "root", "coverage"] as const) {
    const sandboxRoot = sandbox(`vf-lock-release-close-${failureTarget}-`);
    const coverageRoot = join(sandboxRoot, "private");
    const lockRoot = join(coverageRoot, "locks");
    ensurePrivateDirectory(lockRoot);
    const lockPath = join(lockRoot, "writer.lock");
    const lock = acquireProcessLock(lockPath, {
      operation: `release-close-${failureTarget}`,
      coverageRoot,
    });
    const fileFd = descriptorFor(lockPath);
    const rootFd = descriptorFor(lockRoot, new Set([fileFd]));
    const coverageFd = descriptorFor(coverageRoot, new Set([fileFd, rootFd]));
    const targetFd =
      failureTarget === "file" ? fileFd : failureTarget === "root" ? rootFd : coverageFd;
    const primary = new Error(`injected-${failureTarget}-close`);
    const realClose = fs.closeSync;
    const close = spyOn(fs, "closeSync").mockImplementation((fd) => {
      if (fd === targetFd) throw primary;
      return realClose(fd);
    });
    try {
      expect(() => lock.release()).toThrow(primary);
    } finally {
      close.mockRestore();
      closeQuietly(targetFd);
      fs.rmSync(sandboxRoot, { recursive: true, force: true });
    }
  }
});

test("failed lock acquisition tolerates a coverage-root close failure", () => {
  const sandboxRoot = sandbox("vf-lock-attempt-close-");
  const coverageRoot = join(sandboxRoot, "private");
  const lockRoot = join(coverageRoot, "locks");
  ensurePrivateDirectory(lockRoot);
  const path = join(lockRoot, "writer.lock");
  const holder = acquireProcessLock(path, { operation: "holder" });
  const api = native();
  const realFlock = api.flock;
  const realClose = fs.closeSync;
  let cleanupPhase = false;
  let leaked: number | undefined;
  api.flock = (fd, operation) => {
    const result = realFlock(fd, operation);
    if (operation === 6 && result !== 0) cleanupPhase = true;
    return result;
  };
  const close = spyOn(fs, "closeSync").mockImplementation((fd) => {
    if (cleanupPhase && leaked === undefined && descriptorMatches(fd, coverageRoot)) {
      leaked = fd;
      throw new Error("injected-coverage-root-close");
    }
    return realClose(fd);
  });
  try {
    expect(() =>
      acquireProcessLock(path, {
        operation: "contender",
        coverageRoot,
        timeoutMs: 0,
        pollIntervalMs: 1,
      }),
    ).toThrow(/lock busy/);
  } finally {
    close.mockRestore();
    api.flock = realFlock;
    closeQuietly(leaked);
    holder.release();
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test("native syscall failures distinguish unsupported filesystem operations", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const api = native();
  try {
    const fd = (server as unknown as { _handle?: { fd?: number } })._handle?.fd;
    expect(fd).toBeNumber();
    const result = api.flock(fd as number, 6);
    // flock(2) on a socket fails on darwin but is a no-op success on Linux, so
    // only the typed classification is asserted portably (via the errno portal).
    expect(result).toBe(process.platform === "darwin" ? -1 : 0);
    if (process.platform === "darwin") {
      expect(
        nativeRuntime.errnoIs("EOPNOTSUPP") ||
          nativeRuntime.errnoIs("ENOTSUP") ||
          nativeRuntime.errnoIs("ENOSYS"),
      ).toBeTrue();
    }
    const error = nativeRuntime.classifySyscallError(
      "socket flock probe",
      nativeRuntime.errnoValue("EOPNOTSUPP"),
    );
    expect(error).toBeInstanceOf(DurabilityError);
    expect((error as DurabilityError).code).toBe("unsupported");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
