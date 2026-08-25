import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import { basename, dirname } from "node:path";
import { assertNoSymlinkComponents } from "../../durability/index.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import type { CapabilityScopeLockV1 } from "./scope-lock.js";

const MAX_LOCK_BYTES = 8 * 1024 * 1024;

function exact(left: Buffer | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === null && right === null;
  return left.length === right.length && timingSafeEqual(left, right);
}

export function readPortableBytes(path: string, maxBytes = MAX_LOCK_BYTES): Buffer | null {
  try {
    const stat = fs.lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes)
      throw new CapabilityValidationError("unsafe or oversized portable record", path);
    const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size)
        throw new CapabilityValidationError("portable record changed during open", path);
      const bytes = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count <= 0) throw new CapabilityValidationError("short portable record read", path);
        offset += count;
      }
      return bytes;
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function compareAndSwapPortableBytes(
  path: string,
  expected: Uint8Array | null,
  replacement: Uint8Array,
  lock: CapabilityScopeLockV1,
): void {
  if (replacement.byteLength > MAX_LOCK_BYTES)
    throw new CapabilityValidationError("portable lock exceeds byte limit", path, "bounds");
  lock.assertHeld();
  const parent = dirname(path);
  assertNoSymlinkComponents(parent);
  if (!exact(readPortableBytes(path), expected))
    throw new CapabilityValidationError(
      "portable lock CAS preimage mismatch",
      path,
      "integrity_failure",
    );
  const temporary = `${basename(path)}.${randomBytes(16).toString("hex")}.tmp`;
  const tempPath = `${parent}/${temporary}`;
  let fd: number | null = null;
  const cleanup = (): void => {
    if (fd !== null) {
      fs.closeSync(fd);
      fd = null;
    }
    try {
      fs.unlinkSync(tempPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  try {
    fd = fs.openSync(
      tempPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fs.fchmodSync(fd, 0o600);
    for (let offset = 0; offset < replacement.byteLength; ) {
      const count = fs.writeSync(fd, replacement, offset, replacement.byteLength - offset, offset);
      if (count <= 0)
        throw new CapabilityValidationError("portable lock write made no progress", path);
      offset += count;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    lock.assertHeld();
    if (!exact(readPortableBytes(path), expected))
      throw new CapabilityValidationError(
        "portable lock CAS preimage changed",
        path,
        "integrity_failure",
      );
    fs.renameSync(tempPath, path);
    const directory = fs.openSync(
      parent,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
    lock.assertHeld();
  } catch (error) {
    try {
      cleanup();
    } catch {
      // Preserve the primary mutation failure over a best-effort cleanup failure.
    }
    throw error;
  }
  cleanup();
}
