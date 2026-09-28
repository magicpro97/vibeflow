import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { cleanupThenThrow, withCleanup } from "../durability/cleanup.js";
import { durabilityError } from "../durability/errors.js";
import {
  type ProcessLockOwnerV1,
  processLockOwnerIsAlive,
  processStartIdentity,
} from "../durability/lock-owner.js";
import { RUNTIME_PLATFORM } from "../durability/process-identity-contract.js";
import {
  type WindowsKernelLockProvider,
  type WindowsRecordRename,
  assertWindowsLocalRecordPath,
  createWindowsKernelLockProvider,
  createWindowsWriteThroughRename,
  trustedWindowsSystemRoot,
} from "./owned-process-record-windows-native.js";
import {
  type WindowsPathAuthority,
  createNativeWindowsPathAuthority,
} from "./windows-path-authority.js";
import { createWindowsPrivateAuthority } from "./windows-private-authority.js";

type FileRuntime = Pick<
  typeof fs,
  | "closeSync"
  | "fstatSync"
  | "fsyncSync"
  | "lstatSync"
  | "mkdirSync"
  | "openSync"
  | "readSync"
  | "readdirSync"
  | "statSync"
  | "unlinkSync"
  | "writeSync"
>;

export interface WindowsRecordRuntime {
  files: FileRuntime;
  pid: number;
  host: string;
  identity: (pid: number) => string | null;
  ownerAlive: (owner: ProcessLockOwnerV1) => boolean | null;
  nonce: () => string;
  rename: WindowsRecordRename;
  kernelLocks: WindowsKernelLockProvider;
  wait: (milliseconds: number) => void;
  now: () => number;
  enforceLocalWindowsPath: boolean;
  validateLocalPath: (path: string) => void;
  protectPath: (path: string) => void;
  verifyPrivatePath: (path: string) => void;
  pathAuthority: WindowsPathAuthority;
  isAbsolutePath: (path: string) => boolean;
  resolvePath: (path: string) => string;
}

export interface WindowsDirectoryIdentity {
  value: string;
}

export function windowsErrorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

export function exactWindowsBytes(left: Buffer | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === null && right === null;
  return left.length === right.length && timingSafeEqual(left, right);
}

const FORBIDDEN_WINDOWS_NAME_CHARACTERS = '<>:"/\\|?*';

export function safeWindowsRecordLeaf(name: string): string {
  const forbidden = [...name].some(
    (character) =>
      character.charCodeAt(0) < 0x20 || FORBIDDEN_WINDOWS_NAME_CHARACTERS.includes(character),
  );
  if (
    !name ||
    name === "." ||
    name === ".." ||
    forbidden ||
    /[ .]$/u.test(name) ||
    /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)
  )
    durabilityError("unsafe_path", `unsafe Windows storage name: ${name}`);
  return name;
}

export function windowsRecordLimit(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const output = value ?? fallback;
  if (!Number.isSafeInteger(output) || output < 1) durabilityError("bounds", `invalid ${label}`);
  return output;
}

export function windowsDirectoryIdentity(
  path: string,
  runtime: WindowsRecordRuntime,
): WindowsDirectoryIdentity {
  const identity = runtime.pathAuthority.directoryIdentity(path, true);
  if (!identity) durabilityError("unsafe_path", `storage directory disappeared: ${path}`);
  return { value: identity.value };
}

export function isWindowsDriveQualifiedPath(input: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(input);
}

export function resolveWindowsRecordPath(input: string, runtime: WindowsRecordRuntime): string {
  // The drive-qualified guard is asked first when this runtime enforces local Windows storage: it
  // names the actual requirement, so a UNC path is judged by it on every host instead of being
  // reported as "not absolute" by whichever absoluteness rule the host happens to have.
  if (runtime.enforceLocalWindowsPath && !isWindowsDriveQualifiedPath(input))
    durabilityError("unsafe_path", "Windows record storage must use a drive-qualified path");
  if (!runtime.isAbsolutePath(input))
    durabilityError("unsafe_path", "Windows record path must be absolute");
  const absolute = runtime.resolvePath(input);
  if (runtime.enforceLocalWindowsPath) {
    runtime.validateLocalPath(absolute);
  }
  return absolute;
}

function ensureWindowsDirectoryComponents(absolute: string, runtime: WindowsRecordRuntime): void {
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  // Create what is missing and adopt only what this install owns. A component above the leaf is the
  // user's own filesystem — a previous release, a plain fs call, mkdtemp — and re-securing it means
  // opening %TEMP% or C:\ with WRITE_DAC and migrating a descriptor we were merely handed. The leaf
  // is the storage surface itself, so it is the one component adopted: a directory this install did
  // not create carries whatever DACL its parent handed it, the private write refuses that, and
  // adoption is what migrates it instead of failing the first write.
  // ponytail: <root>/<dir> is the whole storage surface; only the trailing component is ours.
  for (const [index, part] of parts.entries()) {
    safeWindowsRecordLeaf(part);
    const cursor = join(root, ...parts.slice(0, index + 1));
    if (index < parts.length - 1) {
      if (!runtime.pathAuthority.directoryIdentity(cursor, false))
        runtime.pathAuthority.createPrivateDirectory(cursor);
      continue;
    }
    try {
      runtime.pathAuthority.createPrivateDirectory(cursor);
    } catch (error) {
      // createPrivateDirectory mints a missing name and adopts an existing one, so an EEXIST here
      // is a lost race with another creator: the name now exists and owes the adoption the first
      // attempt never got to perform. One retry decides it — the second call finds the directory.
      if (windowsErrorCode(error) !== "EEXIST") throw error;
      runtime.pathAuthority.createPrivateDirectory(cursor);
    }
    if (!runtime.pathAuthority.directoryIdentity(cursor, false))
      durabilityError("unsafe_path", `storage ancestor changed: ${cursor}`);
  }
}

export function ensureWindowsRecordParent(input: string, runtime: WindowsRecordRuntime): string {
  const absolute = resolveWindowsRecordPath(input, runtime);
  safeWindowsRecordLeaf(parse(absolute).base);
  const parent = dirname(absolute);
  ensureWindowsDirectoryComponents(parent, runtime);
  return parent;
}

export function ensureWindowsRecordDirectory(input: string, runtime: WindowsRecordRuntime): string {
  const absolute = resolveWindowsRecordPath(input, runtime);
  ensureWindowsDirectoryComponents(absolute, runtime);
  windowsDirectoryIdentity(absolute, runtime);
  return absolute;
}

export function createPortableWindowsPathAuthority(
  files: FileRuntime,
  protect: (path: string) => void,
  verify: (path: string) => void,
): WindowsPathAuthority {
  const directoryIdentity = (path: string, verifyPrivate: boolean) => {
    let link: fs.BigIntStats;
    try {
      link = files.lstatSync(path, { bigint: true });
    } catch (error) {
      if (windowsErrorCode(error) === "ENOENT") return null;
      throw error;
    }
    if (link.isSymbolicLink())
      durabilityError("unsafe_path", `Windows authority reparse point rejected: ${path}`);
    if (!link.isDirectory())
      durabilityError("unsafe_path", `Windows authority path type changed: ${path}`);
    const target = files.statSync(path, { bigint: true });
    if (!target.isDirectory() || link.dev !== target.dev || link.ino !== target.ino)
      durabilityError("unsafe_path", `storage directory identity mismatch: ${path}`);
    if (verifyPrivate) verify(path);
    return { value: `${link.dev.toString(16)}:${link.ino.toString(16)}`, size: link.size };
  };
  return {
    withVerifiedDirectory(path, expectedIdentity, operation) {
      const before = directoryIdentity(path, true);
      if (!before || before.value !== expectedIdentity)
        durabilityError("unsafe_path", `storage directory changed: ${path}`);
      const result = operation();
      const after = directoryIdentity(path, true);
      if (!after || after.value !== expectedIdentity)
        durabilityError("unsafe_path", `storage directory changed: ${path}`);
      return result;
    },
    directoryIdentity,
    createPrivateDirectory(path) {
      // Mint when the name is missing, adopt when it is already there. The two seams answer the same
      // question because the caller cannot tell which one it got, and the native authority adopts an
      // existing directory rather than refusing it: a re-run that hit EEXIST and stopped left the
      // inherited DACL in place, which is the whole defect. The policy is then applied to whatever
      // was found, so a first run and a re-run land on the same descriptor.
      try {
        files.mkdirSync(path, { mode: 0o700 });
      } catch (error) {
        if (windowsErrorCode(error) !== "EEXIST") throw error;
      }
      protect(path);
      if (!directoryIdentity(path, true))
        durabilityError("unsafe_path", "created directory vanished");
    },
    readPrivateFile(path, maxBytes) {
      let before: fs.BigIntStats;
      try {
        before = files.lstatSync(path, { bigint: true });
      } catch (error) {
        if (windowsErrorCode(error) === "ENOENT") return null;
        throw error;
      }
      if (before.isSymbolicLink())
        durabilityError("unsafe_path", `Windows authority reparse point rejected: ${path}`);
      if (!before.isFile())
        durabilityError("unsafe_path", `Windows authority path type changed: ${path}`);
      if (before.nlink !== 1n)
        durabilityError("unsafe_path", `unsafe Windows authority link state: ${path}`);
      if (before.size > BigInt(maxBytes))
        durabilityError("unsafe_path", `unsafe or oversized Windows record: ${path}`);
      const fd = files.openSync(path, fs.constants.O_RDONLY);
      return withCleanup(() => {
        verify(path);
        const opened = files.fstatSync(fd, { bigint: true });
        if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
          durabilityError("unsafe_path", `Windows record identity changed before read: ${path}`);
        const output = Buffer.alloc(Number(opened.size));
        for (let offset = 0; offset < output.length; ) {
          const count = files.readSync(fd, output, offset, output.length - offset, offset);
          if (count < 1) durabilityError("corrupt", `short Windows record read: ${path}`);
          offset += count;
        }
        const after = files.fstatSync(fd, { bigint: true });
        const current = files.lstatSync(path, { bigint: true });
        if (
          after.dev !== opened.dev ||
          after.ino !== opened.ino ||
          after.size !== opened.size ||
          after.mtimeMs !== opened.mtimeMs ||
          current.dev !== opened.dev ||
          current.ino !== opened.ino ||
          current.isSymbolicLink() ||
          !current.isFile() ||
          current.nlink !== 1n ||
          current.size !== opened.size
        )
          durabilityError("unsafe_path", `Windows record changed during read: ${path}`);
        return output;
      }, [() => files.closeSync(fd)]);
    },
    writePrivateFile(path, bytes, maxBytes) {
      if (bytes.length > maxBytes)
        durabilityError("bounds", "Windows authority value exceeds limit");
      const fd = files.openSync(
        path,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o600,
      );
      let open = true;
      try {
        protect(path);
        for (let offset = 0; offset < bytes.length; ) {
          const count = files.writeSync(fd, bytes, offset, bytes.length - offset, offset);
          if (count < 1) durabilityError("corrupt", "Windows durable write made no progress");
          offset += count;
        }
        files.fsyncSync(fd);
        files.closeSync(fd);
        open = false;
        if (!this.readPrivateFile(path, maxBytes)?.equals(bytes))
          durabilityError("corrupt", "Windows durable staging verification failed");
      } catch (error) {
        return cleanupThenThrow(error, [
          () => {
            if (open) files.closeSync(fd);
          },
          () => files.unlinkSync(path),
        ]);
      }
    },
  };
}

export function createWindowsRecordRuntime(
  overrides: Partial<WindowsRecordRuntime>,
): WindowsRecordRuntime {
  const onWindows = process.platform === RUNTIME_PLATFORM.WINDOWS;
  const protectPath = overrides.protectPath ?? (() => {});
  const verifyPrivatePath = overrides.verifyPrivatePath ?? (() => {});
  const nativePrivacy =
    onWindows && !overrides.pathAuthority ? createWindowsPrivateAuthority() : undefined;
  const pathAuthority =
    overrides.pathAuthority ??
    (onWindows
      ? createNativeWindowsPathAuthority(undefined, nativePrivacy)
      : createPortableWindowsPathAuthority(overrides.files ?? fs, protectPath, verifyPrivatePath));
  const rename =
    overrides.rename ??
    (process.platform === RUNTIME_PLATFORM.WINDOWS ? createWindowsWriteThroughRename() : undefined);
  const kernelLocks =
    overrides.kernelLocks ??
    (process.platform === RUNTIME_PLATFORM.WINDOWS
      ? createWindowsKernelLockProvider(undefined, nativePrivacy)
      : undefined);
  if (!rename || !kernelLocks)
    durabilityError(
      "unsupported",
      "Windows record backend requires injected kernel seams off win32",
    );
  const systemRoot =
    process.platform === RUNTIME_PLATFORM.WINDOWS && (!overrides.identity || !overrides.ownerAlive)
      ? trustedWindowsSystemRoot()
      : undefined;
  const processRuntime = systemRoot
    ? { platform: RUNTIME_PLATFORM.WINDOWS, windowsSystemRoot: systemRoot }
    : {};
  return {
    files: fs,
    pid: process.pid,
    host: hostname(),
    identity: (pid) => processStartIdentity(pid, processRuntime),
    ownerAlive: (owner) => processLockOwnerIsAlive(owner, processRuntime),
    nonce: () => randomBytes(32).toString("hex"),
    wait: (milliseconds) => {
      if (milliseconds > 0)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
    },
    now: () => performance.now(),
    enforceLocalWindowsPath: process.platform === RUNTIME_PLATFORM.WINDOWS,
    validateLocalPath:
      process.platform === RUNTIME_PLATFORM.WINDOWS ? assertWindowsLocalRecordPath : () => {},
    protectPath,
    verifyPrivatePath,
    pathAuthority,
    isAbsolutePath: isAbsolute,
    resolvePath: resolve,
    ...overrides,
    rename,
    kernelLocks,
  };
}

export function withWindowsDirectoryAuthority<T>(
  path: string,
  expected: WindowsDirectoryIdentity,
  runtime: WindowsRecordRuntime,
  operation: () => T,
): T {
  return runtime.pathAuthority.withVerifiedDirectory(path, expected.value, operation);
}

export function readWindowsRecordPath(
  path: string,
  maxBytes: number,
  parent: WindowsDirectoryIdentity,
  runtime: WindowsRecordRuntime,
): Buffer | null {
  return withWindowsDirectoryAuthority(dirname(path), parent, runtime, () =>
    runtime.pathAuthority.readPrivateFile(path, maxBytes),
  );
}

export function writeWindowsRecordFile(
  path: string,
  bytes: Uint8Array,
  maxBytes: number,
  parent: WindowsDirectoryIdentity,
  runtime: WindowsRecordRuntime,
): void {
  withWindowsDirectoryAuthority(dirname(path), parent, runtime, () =>
    runtime.pathAuthority.writePrivateFile(path, bytes, maxBytes),
  );
}
