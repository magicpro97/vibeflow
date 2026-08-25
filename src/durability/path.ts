import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { cleanupThenThrow, withCleanup } from "./cleanup.js";
import { durabilityError } from "./errors.js";
import { positiveSafeLimit } from "./limits.js";
import {
  type PinnedDirectory,
  assertPinnedDirectory,
  canonicalDurabilityPath,
  closePinnedDirectory,
  createAt,
  openAt,
  openPrivateDirectory,
  tryOpenAt,
  unlinkAt,
} from "./native.js";

const OWNER = typeof process.geteuid === "function" ? process.geteuid() : undefined;

function trustedSystemAlias(path: string): string | null {
  if (process.platform !== "darwin") return null;
  const expected = (
    { "/etc": "/private/etc", "/tmp": "/private/tmp", "/var": "/private/var" } as Record<
      string,
      string
    >
  )[path];
  if (!expected) return null;
  try {
    const entry = fs.lstatSync(path);
    return entry.uid === 0 && entry.isSymbolicLink() && fs.realpathSync(path) === expected
      ? expected
      : null;
  } catch {
    return null;
  }
}

/** Read-only compatibility check. Authoritative mutations use pinned directory handles. */
export function assertNoSymlinkComponents(input: string): string {
  if (typeof input !== "string" || input.includes("\0"))
    durabilityError("unsafe_path", "durability path contains NUL or is not a string");
  const absolute = resolve(input);
  if (!isAbsolute(absolute)) durabilityError("unsafe_path", "path must be absolute");
  const root = parse(absolute).root;
  const parts = absolute
    .slice(root.length)
    .split(/[\\/]+/)
    .filter(Boolean);
  let cursor = root;
  for (let index = 0; index < parts.length; index++) {
    cursor = join(cursor, parts[index] as string);
    try {
      const entry = fs.lstatSync(cursor);
      if (!entry.isSymbolicLink()) continue;
      const trusted = trustedSystemAlias(cursor);
      if (!trusted) durabilityError("unsafe_path", `symlink path component rejected: ${cursor}`);
      cursor = trusted;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return join(cursor, ...parts.slice(index + 1));
      throw error;
    }
  }
  return cursor;
}

export function syncPrivateDirectory(path: string): void {
  const directory = openPrivateDirectory(path, false);
  withCleanup(() => {
    fs.fsyncSync(directory.fd);
    assertPinnedDirectory(directory);
  }, [() => closePinnedDirectory(directory)]);
}

export function ensurePrivateDirectory(input: string): string {
  const directory = openPrivateDirectory(input, true);
  return withCleanup(() => {
    fs.fsyncSync(directory.fd);
    assertPinnedDirectory(directory);
    return directory.path;
  }, [() => closePinnedDirectory(directory)]);
}

function assertPrivateFile(fd: number, label: string, maxLinks: number): fs.Stats {
  const stat = fs.fstatSync(fd);
  if (
    !stat.isFile() ||
    (OWNER !== undefined && stat.uid !== OWNER) ||
    (stat.mode & 0o7777) !== 0o600 ||
    stat.nlink < 1 ||
    stat.nlink > maxLinks
  )
    durabilityError(
      "unsafe_path",
      `private file mode, ownership, or link count rejected: ${label}`,
    );
  return stat;
}

export function readPrivateFd(fd: number, label: string, maxBytes: number, maxLinks = 1): Buffer {
  positiveSafeLimit(maxBytes, "private file byte limit");
  const stat = assertPrivateFile(fd, label, maxLinks);
  if (stat.size > maxBytes) durabilityError("bounds", `private file exceeds byte limit: ${label}`);
  const output = Buffer.allocUnsafe(stat.size);
  let offset = 0;
  while (offset < output.length) {
    const count = fs.readSync(fd, output, offset, output.length - offset, offset);
    if (count <= 0) durabilityError("corrupt", `short private file read: ${label}`);
    offset += count;
  }
  return output;
}

export function readPrivateFileAt(
  directory: PinnedDirectory,
  name: string,
  maxBytes: number,
  maxLinks = 1,
): Buffer | null {
  assertPinnedDirectory(directory);
  const fd = tryOpenAt(directory, name, fs.constants.O_RDONLY);
  if (fd === null) return null;
  return withCleanup(() => readPrivateFd(fd, name, maxBytes, maxLinks), [() => fs.closeSync(fd)]);
}

export function privateFileBytes(path: string, maxBytes: number): Buffer | null {
  positiveSafeLimit(maxBytes, "private file byte limit");
  const target = canonicalDurabilityPath(path);
  try {
    fs.lstatSync(dirname(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const directory = openPrivateDirectory(dirname(target), false);
  return withCleanup(() => {
    const bytes = readPrivateFileAt(directory, basename(target), maxBytes);
    assertPinnedDirectory(directory);
    return bytes;
  }, [() => closePinnedDirectory(directory)]);
}

export function writeAll(fd: number, bytes: Uint8Array, position: number | null): void {
  for (let offset = 0; offset < bytes.length; ) {
    const count = fs.writeSync(
      fd,
      bytes,
      offset,
      bytes.length - offset,
      position === null ? null : position + offset,
    );
    if (count <= 0) durabilityError("corrupt", "private write made no progress");
    offset += count;
  }
}

export function createPrivateFileAt(
  directory: PinnedDirectory,
  name: string,
  bytes: Uint8Array,
): number | null {
  const fd = createAt(directory, name, fs.constants.O_RDWR, 0o600);
  if (fd === null) return null;
  try {
    fs.fchmodSync(fd, 0o600);
    writeAll(fd, bytes, 0);
    fs.fsyncSync(fd);
    assertPrivateFile(fd, name, 1);
    return fd;
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      // Best-effort cleanup must not replace the primary creation error.
    }
    try {
      unlinkAt(directory, name, true);
    } catch {
      // Best-effort cleanup must not replace the primary creation error.
    }
    throw error;
  }
}

export function writePrivateTemporaryAt(
  directory: PinnedDirectory,
  stem: string,
  bytes: Uint8Array,
): string {
  const safeStem =
    basename(stem)
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .slice(0, 64) || "state";
  for (let attempt = 0; attempt < 8; attempt++) {
    const name = `.${safeStem}-${randomBytes(16).toString("hex")}.tmp`;
    const fd = createPrivateFileAt(directory, name, bytes);
    if (fd === null) continue;
    fs.closeSync(fd);
    return name;
  }
  durabilityError("conflict", "cannot allocate a unique private temporary file");
}

export function validatePrivateFileFd(fd: number, label: string, maxLinks = 1): fs.Stats {
  return assertPrivateFile(fd, label, maxLinks);
}

export function openExistingPrivateFileAt(
  directory: PinnedDirectory,
  name: string,
  flags = fs.constants.O_RDWR,
  maxLinks = 1,
): number | null {
  const fd = tryOpenAt(directory, name, flags);
  if (fd === null) return null;
  try {
    assertPrivateFile(fd, name, maxLinks);
    return fd;
  } catch (error) {
    return cleanupThenThrow(error, [() => fs.closeSync(fd)]);
  }
}

export function openOrCreatePrivateFileAt(directory: PinnedDirectory, name: string): number {
  const existing = openExistingPrivateFileAt(directory, name);
  if (existing !== null) return existing;
  const created = createAt(directory, name, fs.constants.O_RDWR, 0o600);
  if (created !== null) {
    try {
      fs.fchmodSync(created, 0o600);
      fs.fsyncSync(created);
      return created;
    } catch (error) {
      try {
        fs.closeSync(created);
      } catch {
        // Best-effort cleanup must not replace the primary creation error.
      }
      try {
        unlinkAt(directory, name, true);
      } catch {
        // Best-effort cleanup must not replace the primary creation error.
      }
      throw error;
    }
  }
  const raced = openAt(directory, name, fs.constants.O_RDWR);
  try {
    assertPrivateFile(raced, name, 1);
    return raced;
  } catch (error) {
    return cleanupThenThrow(error, [() => fs.closeSync(raced)]);
  }
}
