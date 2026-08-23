import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { isAbsolute, join, parse, resolve } from "node:path";

type Reject = (message: string) => never;

const expectedOwner = (): number | undefined =>
  typeof process.geteuid === "function" ? process.geteuid() : undefined;

export const effectiveOwnerMatches = (stat: fs.Stats): boolean =>
  expectedOwner() === undefined || stat.uid === expectedOwner();

const trustedAliasTarget = (path: string): string | null => {
  if (process.platform !== "darwin") return null;
  const allowed: Record<string, string> = {
    "/etc": "/private/etc",
    "/tmp": "/private/tmp",
    "/var": "/private/var",
  };
  const target = allowed[path];
  if (!target) return null;
  try {
    const observed = fs.lstatSync(path);
    const resolved = fs.realpathSync(path);
    return observed.uid === 0 && resolved === target ? resolved : null;
  } catch {
    return null;
  }
};

/** Canonicalize explicit root-owned OS aliases, then reject every remaining symlink component. */
export function assertNoSymlinkPathComponents(input: string, reject: Reject): string {
  const absolute = resolve(input);
  if (!isAbsolute(absolute)) reject("invalid path");
  const root = parse(absolute).root;
  const parts = absolute
    .slice(root.length)
    .split(/[\\/]+/)
    .filter(Boolean);
  let cursor = root;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index] as string;
    cursor = join(cursor, part);
    let entry: fs.Stats;
    try {
      entry = fs.lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return join(cursor, ...parts.slice(index + 1));
      reject("unsafe path component");
    }
    if (entry.isSymbolicLink()) {
      const trusted = trustedAliasTarget(cursor);
      if (!trusted) reject("symlink path component");
      cursor = trusted;
    }
  }
  return cursor;
}

export function ensurePrivateDirectory(input: string, reject: Reject): string {
  let requested = assertNoSymlinkPathComponents(resolve(input), reject);
  try {
    fs.mkdirSync(requested, { recursive: true, mode: 0o700 });
  } catch {
    return reject("unsafe directory");
  }
  requested = assertNoSymlinkPathComponents(requested, reject);
  let fd: number;
  try {
    fd = fs.openSync(
      requested,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
  } catch {
    return reject("unsafe directory");
  }
  try {
    const opened = fs.fstatSync(fd);
    const entry = fs.lstatSync(requested);
    if (
      !opened.isDirectory() ||
      entry.isSymbolicLink() ||
      !entry.isDirectory() ||
      (opened.mode & 0o777) !== 0o700 ||
      !effectiveOwnerMatches(opened) ||
      !effectiveOwnerMatches(entry) ||
      opened.dev !== entry.dev ||
      opened.ino !== entry.ino
    ) {
      reject("unsafe directory");
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return fs.realpathSync(requested);
}

export function safeEntry(path: string, reject: Reject, message: string): fs.Stats | null {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return reject(message);
  }
}

export function openPrivateFile(
  path: string,
  maxBytes: number,
  reject: Reject,
  label: string,
  allowEmpty = false,
): number {
  let fd: number;
  try {
    fd = fs.openSync(path, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
  } catch {
    return reject(label);
  }
  try {
    const opened = fs.fstatSync(fd);
    const observed = fs.lstatSync(path);
    if (
      !opened.isFile() ||
      observed.isSymbolicLink() ||
      !observed.isFile() ||
      !effectiveOwnerMatches(opened) ||
      !effectiveOwnerMatches(observed) ||
      opened.nlink !== 1 ||
      (opened.mode & 0o777) !== 0o600 ||
      opened.dev !== observed.dev ||
      opened.ino !== observed.ino ||
      (!allowEmpty && opened.size < 1) ||
      opened.size > maxBytes
    )
      reject(label);
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

export function writeAll(fd: number, data: Buffer, position: number, reject: Reject): void {
  for (let offset = 0; offset < data.length; ) {
    const count = fs.writeSync(fd, data, offset, data.length - offset, position + offset);
    if (count <= 0) reject("opaque state write failed");
    offset += count;
  }
}

export function syncPrivateDirectory(root: string, reject: Reject): void {
  const canonical = assertNoSymlinkPathComponents(root, reject);
  let fd: number;
  try {
    fd = fs.openSync(
      canonical,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
  } catch {
    reject("unsafe registry directory");
  }
  try {
    const opened = fs.fstatSync(fd);
    const observed = fs.lstatSync(canonical);
    if (
      !opened.isDirectory() ||
      observed.isSymbolicLink() ||
      !observed.isDirectory() ||
      !effectiveOwnerMatches(opened) ||
      !effectiveOwnerMatches(observed) ||
      (opened.mode & 0o777) !== 0o700 ||
      opened.dev !== observed.dev ||
      opened.ino !== observed.ino
    )
      reject("unsafe registry directory");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

const temporaryPath = (root: string): string =>
  join(root, `.opaque-state-${randomBytes(12).toString("hex")}.tmp`);

const writeTemporary = (root: string, data: Buffer, reject: Reject): string => {
  const temporary = temporaryPath(root);
  const fd = fs.openSync(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.fchmodSync(fd, 0o600);
    writeAll(fd, data, 0, reject);
    fs.fsyncSync(fd);
    return temporary;
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  } finally {
    fs.closeSync(fd);
  }
};

export function writePrivateAtomic(
  root: string,
  path: string,
  data: Buffer,
  maxBytes: number,
  reject: Reject,
): void {
  if (!data.length || data.length > maxBytes) reject("unsafe opaque state");
  if (safeEntry(path, reject, "unsafe opaque state"))
    fs.closeSync(openPrivateFile(path, maxBytes, reject, "unsafe opaque state"));
  const temporary = writeTemporary(root, data, reject);
  try {
    fs.renameSync(temporary, path);
    syncPrivateDirectory(root, reject);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function createPrivateAtomic(
  root: string,
  name: string,
  data: Buffer,
  reject: Reject,
  recoverEmpty = false,
): void {
  const path = join(root, name);
  const observed = safeEntry(path, reject, "unsafe opaque state");
  if (observed?.size === 0 && recoverEmpty) {
    const fd = openPrivateFile(path, 0, reject, "unsafe opaque key", true);
    try {
      const opened = fs.fstatSync(fd);
      const revalidated = fs.lstatSync(path);
      if (opened.dev !== revalidated.dev || opened.ino !== revalidated.ino)
        reject("unsafe opaque key");
      fs.unlinkSync(path);
    } finally {
      fs.closeSync(fd);
    }
  } else if (observed) return;
  const temporary = writeTemporary(root, data, reject);
  try {
    fs.renameSync(temporary, path);
    syncPrivateDirectory(root, reject);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
