import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import { basename, dirname } from "node:path";
import {
  type PinnedDirectory,
  assertPinnedDirectory,
  canonicalDurabilityPath,
  closePinnedDirectory,
  createAt,
  renameAt,
  tryOpenAt,
  unlinkAt,
} from "../../durability/native.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import {
  type CapabilityPortableCasLockV1,
  type CapabilityScopeLockV1,
  assertCapabilityPortableCasLock,
} from "./scope-lock.js";

const MAX_LOCK_BYTES = 8 * 1024 * 1024;
const OWNER = typeof process.geteuid === "function" ? process.geteuid() : undefined;

export type CapabilityPortableCasFaultPointV1 = "after-staging-fsync" | "after-publication-fsync";

function exact(left: Buffer | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === null && right === null;
  return left.length === right.length && timingSafeEqual(left, right);
}

function pinnedParent(path: string): PinnedDirectory {
  const canonical = canonicalDurabilityPath(dirname(path));
  const fd = fs.openSync(
    canonical,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isDirectory() ||
      (OWNER !== undefined && stat.uid !== OWNER) ||
      (stat.mode & 0o022) !== 0
    )
      throw new CapabilityValidationError("portable record parent is not owner-safe", canonical);
    const directory = { fd, path: canonical, dev: stat.dev, ino: stat.ino };
    assertPinnedDirectory(directory);
    return directory;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function readAt(directory: PinnedDirectory, name: string, maxBytes: number): Buffer | null {
  assertPinnedDirectory(directory);
  const fd = tryOpenAt(directory, name, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  if (fd === null) return null;
  try {
    const before = fs.fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size > maxBytes ||
      (OWNER !== undefined && before.uid !== OWNER)
    )
      throw new CapabilityValidationError("unsafe or oversized portable record", name);
    const bytes = Buffer.alloc(before.size);
    for (let offset = 0; offset < bytes.length; ) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new CapabilityValidationError("short portable record read", name);
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      throw new CapabilityValidationError("portable record changed during read", name);
    assertPinnedDirectory(directory);
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

export function readPortableBytes(path: string, maxBytes = MAX_LOCK_BYTES): Buffer | null {
  let directory: PinnedDirectory;
  try {
    directory = pinnedParent(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return readAt(directory, basename(path), maxBytes);
  } finally {
    closePinnedDirectory(directory);
  }
}

export function compareAndSwapPortableBytes(
  path: string,
  expected: Uint8Array | null,
  replacement: Uint8Array,
  lock: CapabilityScopeLockV1 | CapabilityPortableCasLockV1,
  options: { fault?: (point: CapabilityPortableCasFaultPointV1) => void } = {},
): void {
  if (replacement.byteLength > MAX_LOCK_BYTES)
    throw new CapabilityValidationError("portable lock exceeds byte limit", path, "bounds");
  assertCapabilityPortableCasLock(lock, path);
  const directory = pinnedParent(path);
  const name = basename(path);
  const temporary = `.${name}.${randomBytes(16).toString("hex")}.tmp`;
  let staged = false;
  try {
    if (!exact(readAt(directory, name, MAX_LOCK_BYTES), expected))
      throw new CapabilityValidationError(
        "portable lock CAS preimage mismatch",
        path,
        "integrity_failure",
      );
    const fd = createAt(directory, temporary, fs.constants.O_WRONLY, 0o600);
    if (fd === null) throw new CapabilityValidationError("portable CAS staging entry raced", path);
    staged = true;
    try {
      fs.fchmodSync(fd, 0o600);
      for (let offset = 0; offset < replacement.byteLength; ) {
        const count = fs.writeSync(
          fd,
          replacement,
          offset,
          replacement.byteLength - offset,
          offset,
        );
        if (count <= 0)
          throw new CapabilityValidationError("portable lock write made no progress", path);
        offset += count;
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    options.fault?.("after-staging-fsync");
    lock.assertHeld();
    assertPinnedDirectory(directory);
    if (!exact(readAt(directory, name, MAX_LOCK_BYTES), expected))
      throw new CapabilityValidationError(
        "portable lock CAS preimage changed",
        path,
        "integrity_failure",
      );
    renameAt(directory, temporary, name);
    staged = false;
    fs.fsyncSync(directory.fd);
    options.fault?.("after-publication-fsync");
    assertPinnedDirectory(directory);
    lock.assertHeld();
    if (!exact(readAt(directory, name, MAX_LOCK_BYTES), replacement))
      throw new CapabilityValidationError(
        "portable lock CAS publication differs",
        path,
        "integrity_failure",
      );
  } finally {
    if (staged) unlinkAt(directory, temporary, true);
    closePinnedDirectory(directory);
  }
}
