import * as fs from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { cleanupThenThrow, withFailureCleanup } from "./cleanup.js";
import { durabilityError } from "./errors.js";
import {
  IS_BUN,
  O_CLOEXEC,
  assertNativeDurabilityAvailable,
  errnoIs,
  native,
  syscallFailure,
} from "./native-runtime.js";
import { RUNTIME_PLATFORM } from "./process-identity-contract.js";

export interface PinnedDirectory {
  fd: number;
  path: string;
  dev: number;
  ino: number;
}

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const F_GETPATH = 50;
const AT_REMOVEDIR = process.platform === RUNTIME_PLATFORM.DARWIN ? 0x80 : 0x200;
const DIRECTORY_FLAGS =
  fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | O_CLOEXEC;
const OWNER = typeof process.geteuid === "function" ? process.geteuid() : undefined;

export function canonicalDurabilityPath(input: string): string {
  if (typeof input !== "string" || input.includes("\0"))
    durabilityError("unsafe_path", "durability path contains NUL or is not a string");
  if (!isAbsolute(input)) durabilityError("unsafe_path", "durability path must be absolute");
  let path = resolve(input);
  if (process.platform !== RUNTIME_PLATFORM.DARWIN) return path;
  for (const [alias, target] of [
    ["/var", "/private/var"],
    ["/tmp", "/private/tmp"],
    ["/etc", "/private/etc"],
  ] as const) {
    if (path === alias || path.startsWith(`${alias}/`)) {
      const observed = fs.lstatSync(alias);
      if (!observed.isSymbolicLink() || observed.uid !== 0 || fs.realpathSync(alias) !== target)
        durabilityError("unsafe_path", `untrusted system path alias: ${alias}`);
      path = `${target}${path.slice(alias.length)}`;
      break;
    }
  }
  return path;
}

function assertDirectory(fd: number, path: string, privateMode: boolean): PinnedDirectory {
  const stat = fs.fstatSync(fd);
  if (
    !stat.isDirectory() ||
    (privateMode && OWNER !== undefined && stat.uid !== OWNER) ||
    (privateMode && (stat.mode & 0o7777) !== 0o700)
  )
    durabilityError("unsafe_path", `unsafe pinned directory: ${path}`);
  const pinned = { fd, path, dev: stat.dev, ino: stat.ino };
  assertPinnedDirectory(pinned);
  return pinned;
}

function openDirectoryAt(parentFd: number, name: string, path: string, create: boolean): number {
  const api = native();
  let fd = api.openat(parentFd, name, DIRECTORY_FLAGS, "int", 0);
  if (fd >= 0) return fd;
  if (!create || !errnoIs("ENOENT")) syscallFailure(`openat directory ${path}`);
  const created = api.mkdirat(parentFd, name, 0o700) === 0;
  if (!created && !errnoIs("EEXIST")) syscallFailure(`mkdirat directory ${path}`);
  if (created && api.fchmodat(parentFd, name, 0o700, 0) !== 0) {
    let primary: unknown;
    try {
      syscallFailure(`fchmodat directory ${path}`);
    } catch (error) {
      primary = error;
    }
    api.unlinkat(parentFd, name, AT_REMOVEDIR);
    throw primary;
  }
  fs.fsyncSync(parentFd);
  fd = api.openat(parentFd, name, DIRECTORY_FLAGS, "int", 0);
  if (fd < 0) syscallFailure(`openat created directory ${path}`);
  return fd;
}

export function openPrivateDirectory(input: string, create: boolean): PinnedDirectory {
  const path = canonicalDurabilityPath(input);
  assertNativeDurabilityAvailable();
  const root = parse(path).root;
  let fd = fs.openSync(
    root,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  let cursor = root;
  try {
    if (pinnedDirectoryPath(fd) !== root)
      durabilityError("unsupported", "runtime cannot prove the durability root path");
    const parts = path.slice(root.length).split(sep).filter(Boolean);
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index] as string;
      const nextPath = join(cursor, part);
      const nextFd = openDirectoryAt(fd, part, nextPath, create);
      let next: PinnedDirectory;
      try {
        next = assertDirectory(nextFd, nextPath, index === parts.length - 1);
      } catch (error) {
        return cleanupThenThrow(error, [() => fs.closeSync(nextFd)]);
      }
      const previous = fd;
      fd = -1;
      try {
        fs.closeSync(previous);
      } catch (error) {
        return cleanupThenThrow(error, [() => fs.closeSync(next.fd)]);
      }
      fd = next.fd;
      cursor = nextPath;
    }
    return assertDirectory(fd, path, true);
  } catch (error) {
    return cleanupThenThrow(error, fd >= 0 ? [() => fs.closeSync(fd)] : []);
  }
}

export function duplicatePinnedDirectory(directory: PinnedDirectory): PinnedDirectory {
  assertPinnedDirectory(directory);
  const fd = native().openat(directory.fd, ".", DIRECTORY_FLAGS, "int", 0);
  if (fd < 0) syscallFailure("openat duplicate pinned directory");
  return withFailureCleanup(
    () => assertDirectory(fd, directory.path, true),
    [() => fs.closeSync(fd)],
  );
}

export function openPinnedDescendant(
  root: PinnedDirectory,
  targetDirectory: string,
  create: boolean,
): PinnedDirectory {
  assertPinnedDirectory(root);
  const target = canonicalDurabilityPath(targetDirectory);
  const relationship = relative(root.path, target);
  if (isAbsolute(relationship) || relationship === ".." || relationship.startsWith(`..${sep}`))
    durabilityError("lock_lost", "owning lock does not cover target directory");
  let current: PinnedDirectory | null = duplicatePinnedDirectory(root);
  try {
    for (const part of relationship.split(sep).filter(Boolean)) {
      const previous = current;
      const nextPath = join(previous.path, part);
      const nextFd = openDirectoryAt(previous.fd, part, nextPath, create);
      let next: PinnedDirectory;
      try {
        next = assertDirectory(nextFd, nextPath, true);
      } catch (error) {
        return cleanupThenThrow(error, [() => fs.closeSync(nextFd)]);
      }
      current = null;
      try {
        fs.closeSync(previous.fd);
      } catch (error) {
        return cleanupThenThrow(error, [() => fs.closeSync(next.fd)]);
      }
      current = next;
    }
    return current as PinnedDirectory;
  } catch (error) {
    const remaining = current;
    return cleanupThenThrow(error, remaining ? [() => fs.closeSync(remaining.fd)] : []);
  }
}

export interface PinnedDirectoryRuntimeV1 {
  platform: NodeJS.Platform;
  isBun: boolean;
  realpath: typeof fs.realpathSync;
  fcntl: ReturnType<typeof native>["fcntl"];
}

export function pinnedDirectoryPathForRuntime(
  fd: number,
  runtime: PinnedDirectoryRuntimeV1,
): string {
  if (runtime.platform === RUNTIME_PLATFORM.LINUX) {
    let observed: string;
    try {
      observed = fs.readlinkSync(`/proc/self/fd/${fd}`);
    } catch (error) {
      return durabilityError(
        "unsupported",
        "runtime cannot resolve pinned directory handles",
        error,
      );
    }
    if (observed.endsWith(" (deleted)"))
      durabilityError("unsafe_path", "pinned directory was removed");
    return observed;
  }
  if (runtime.isBun) {
    try {
      return runtime.realpath(`/dev/fd/${fd}`);
    } catch (error) {
      return durabilityError("unsupported", "Bun cannot resolve pinned directory handles", error);
    }
  }
  const output = Buffer.alloc(1024);
  const { fcntl } = runtime;
  if (!fcntl || fcntl(fd, F_GETPATH, "void *", output) !== 0) syscallFailure("fcntl F_GETPATH");
  const end = output.indexOf(0);
  return output.subarray(0, end < 0 ? output.length : end).toString("utf8");
}

export function pinnedDirectoryPath(fd: number): string {
  return pinnedDirectoryPathForRuntime(fd, {
    platform: process.platform,
    isBun: IS_BUN,
    realpath: fs.realpathSync,
    fcntl: native().fcntl,
  });
}

export function assertPinnedDirectory(directory: PinnedDirectory): void {
  const stat = fs.fstatSync(directory.fd);
  if (stat.dev !== directory.dev || stat.ino !== directory.ino || !stat.isDirectory())
    durabilityError("unsafe_path", "pinned directory identity changed");
  if (pinnedDirectoryPath(directory.fd) !== directory.path)
    durabilityError("unsafe_path", "pinned directory path changed during mutation");
}

export function closePinnedDirectory(directory: PinnedDirectory): void {
  fs.closeSync(directory.fd);
}

export function openAt(directory: PinnedDirectory, name: string, flags: number, mode = 0): number {
  assertSafeName(name);
  const fd = native().openat(
    directory.fd,
    name,
    flags | fs.constants.O_NOFOLLOW | O_CLOEXEC,
    "int",
    mode,
  );
  if (fd < 0) syscallFailure(`openat file ${name}`);
  return fd;
}

export function tryOpenAt(
  directory: PinnedDirectory,
  name: string,
  flags: number,
  mode = 0,
): number | null {
  assertSafeName(name);
  const fd = native().openat(
    directory.fd,
    name,
    flags | fs.constants.O_NOFOLLOW | O_CLOEXEC,
    "int",
    mode,
  );
  if (fd >= 0) return fd;
  if (errnoIs("ENOENT")) return null;
  syscallFailure(`openat file ${name}`);
}

export function createAt(
  directory: PinnedDirectory,
  name: string,
  flags: number,
  mode = 0o600,
): number | null {
  assertSafeName(name);
  const fd = native().openat(
    directory.fd,
    name,
    flags | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | O_CLOEXEC,
    "int",
    mode,
  );
  if (fd >= 0) return fd;
  if (errnoIs("EEXIST")) return null;
  syscallFailure(`createat file ${name}`);
}

export function renameAt(directory: PinnedDirectory, from: string, to: string): void {
  assertSafeName(from);
  assertSafeName(to);
  if (native().renameat(directory.fd, from, directory.fd, to) !== 0) syscallFailure("renameat");
}

export function linkAt(directory: PinnedDirectory, from: string, to: string): void {
  assertSafeName(from);
  assertSafeName(to);
  if (native().linkat(directory.fd, from, directory.fd, to, 0) !== 0) syscallFailure("linkat");
}

export function tryLinkAt(directory: PinnedDirectory, from: string, to: string): boolean {
  assertSafeName(from);
  assertSafeName(to);
  if (native().linkat(directory.fd, from, directory.fd, to, 0) === 0) return true;
  if (errnoIs("EEXIST")) return false;
  syscallFailure("linkat");
}

export function unlinkAt(directory: PinnedDirectory, name: string, missingOk = false): void {
  assertSafeName(name);
  if (native().unlinkat(directory.fd, name, 0) === 0) return;
  if (missingOk && errnoIs("ENOENT")) return;
  syscallFailure(`unlinkat file ${name}`);
}

export function tryAdvisoryLock(fd: number): boolean {
  if (native().flock(fd, LOCK_EX | LOCK_NB) === 0) return true;
  if (errnoIs("EAGAIN") || errnoIs("EWOULDBLOCK")) return false;
  syscallFailure("advisory writer lock");
}

export function releaseAdvisoryLock(fd: number): void {
  if (native().flock(fd, LOCK_UN) !== 0) syscallFailure("advisory writer unlock");
}

export { assertNativeDurabilityAvailable };

function assertSafeName(name: string): void {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0"))
    durabilityError("unsafe_path", "unsafe relative native path name");
}
