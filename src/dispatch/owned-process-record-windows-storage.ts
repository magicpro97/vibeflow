import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
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
  realpath: (path: string) => string;
  rename: WindowsRecordRename;
  kernelLocks: WindowsKernelLockProvider;
  wait: (milliseconds: number) => void;
  now: () => number;
  enforceLocalWindowsPath: boolean;
  validateLocalPath: (path: string) => void;
  isAbsolutePath: (path: string) => boolean;
  resolvePath: (path: string) => string;
}

export interface WindowsDirectoryIdentity {
  dev: number;
  ino: number;
  real: string;
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
  const link = runtime.files.lstatSync(path);
  if (link.isSymbolicLink() || !link.isDirectory())
    durabilityError("unsafe_path", `reparse or non-directory storage path rejected: ${path}`);
  const real = runtime.realpath(path);
  const target = runtime.files.statSync(real);
  if (!target.isDirectory() || link.dev !== target.dev || link.ino !== target.ino)
    durabilityError("unsafe_path", `storage directory identity mismatch: ${path}`);
  return { dev: link.dev, ino: link.ino, real };
}

export function assertWindowsDirectory(
  path: string,
  expected: WindowsDirectoryIdentity,
  runtime: WindowsRecordRuntime,
): void {
  const actual = windowsDirectoryIdentity(path, runtime);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.real !== expected.real)
    durabilityError("unsafe_path", `storage directory changed: ${path}`);
}

export function isWindowsDriveQualifiedPath(input: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(input);
}

export function resolveWindowsRecordPath(input: string, runtime: WindowsRecordRuntime): string {
  if (!runtime.isAbsolutePath(input))
    durabilityError("unsafe_path", "Windows record path must be absolute");
  if (runtime.enforceLocalWindowsPath) {
    if (!isWindowsDriveQualifiedPath(input))
      durabilityError("unsafe_path", "Windows record storage must use a drive-qualified path");
  }
  const absolute = runtime.resolvePath(input);
  if (runtime.enforceLocalWindowsPath) {
    runtime.validateLocalPath(absolute);
  }
  return absolute;
}

export function ensureWindowsRecordDirectory(input: string, runtime: WindowsRecordRuntime): string {
  const absolute = resolveWindowsRecordPath(input, runtime);
  const root = parse(absolute).root;
  let cursor = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    safeWindowsRecordLeaf(part);
    cursor = join(cursor, part);
    try {
      windowsDirectoryIdentity(cursor, runtime);
    } catch (error) {
      if (windowsErrorCode(error) !== "ENOENT") throw error;
      try {
        runtime.files.mkdirSync(cursor, { mode: 0o700 });
      } catch (race) {
        if (windowsErrorCode(race) !== "EEXIST") throw race;
      }
      windowsDirectoryIdentity(cursor, runtime);
    }
  }
  windowsDirectoryIdentity(absolute, runtime);
  return absolute;
}

export function createWindowsRecordRuntime(
  overrides: Partial<WindowsRecordRuntime>,
): WindowsRecordRuntime {
  const rename =
    overrides.rename ??
    (process.platform === RUNTIME_PLATFORM.WINDOWS ? createWindowsWriteThroughRename() : undefined);
  const kernelLocks =
    overrides.kernelLocks ??
    (process.platform === RUNTIME_PLATFORM.WINDOWS ? createWindowsKernelLockProvider() : undefined);
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
    realpath: fs.realpathSync.native,
    wait: (milliseconds) => {
      if (milliseconds > 0)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
    },
    now: () => Date.now(),
    enforceLocalWindowsPath: process.platform === RUNTIME_PLATFORM.WINDOWS,
    validateLocalPath:
      process.platform === RUNTIME_PLATFORM.WINDOWS ? assertWindowsLocalRecordPath : () => {},
    isAbsolutePath: isAbsolute,
    resolvePath: resolve,
    ...overrides,
    rename,
    kernelLocks,
  };
}

export function readWindowsRecordPath(
  path: string,
  maxBytes: number,
  parent: WindowsDirectoryIdentity,
  runtime: WindowsRecordRuntime,
): Buffer | null {
  assertWindowsDirectory(dirname(path), parent, runtime);
  let before: fs.Stats;
  try {
    before = runtime.files.lstatSync(path);
  } catch (error) {
    if (windowsErrorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size > maxBytes)
    durabilityError("unsafe_path", `unsafe or oversized Windows record: ${path}`);
  const fd = runtime.files.openSync(path, fs.constants.O_RDONLY);
  try {
    const opened = runtime.files.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
      durabilityError("unsafe_path", `Windows record identity changed before read: ${path}`);
    const output = Buffer.alloc(opened.size);
    for (let offset = 0; offset < output.length; ) {
      const count = runtime.files.readSync(fd, output, offset, output.length - offset, offset);
      if (count < 1) durabilityError("corrupt", `short Windows record read: ${path}`);
      offset += count;
    }
    const after = runtime.files.fstatSync(fd);
    const current = runtime.files.lstatSync(path);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.nlink !== 1 ||
      current.size !== opened.size
    )
      durabilityError("unsafe_path", `Windows record changed during read: ${path}`);
    assertWindowsDirectory(dirname(path), parent, runtime);
    return output;
  } finally {
    runtime.files.closeSync(fd);
  }
}

export function writeWindowsRecordFile(
  path: string,
  bytes: Uint8Array,
  maxBytes: number,
  parent: WindowsDirectoryIdentity,
  runtime: WindowsRecordRuntime,
): void {
  assertWindowsDirectory(dirname(path), parent, runtime);
  const fd = runtime.files.openSync(
    path,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    0o600,
  );
  try {
    for (let offset = 0; offset < bytes.length; ) {
      const count = runtime.files.writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count < 1) durabilityError("corrupt", "Windows durable write made no progress");
      offset += count;
    }
    runtime.files.fsyncSync(fd);
  } finally {
    runtime.files.closeSync(fd);
  }
  if (!exactWindowsBytes(readWindowsRecordPath(path, maxBytes, parent, runtime), bytes))
    durabilityError("corrupt", "Windows durable staging verification failed");
}
