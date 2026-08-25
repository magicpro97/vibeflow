import { timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import { basename, join } from "node:path";
import {
  type CanonicalJsonOptions,
  canonicalJsonBytes,
  digestHex,
  digestV1Bytes,
  sha256Digest,
} from "./canonical.js";
import { cleanupThenThrow, runCleanups, withCleanup } from "./cleanup.js";
import { durabilityError } from "./errors.js";
import { positiveSafeLimit } from "./limits.js";
import { type ProcessLock, assertProcessLockCovers, withLockedParent } from "./lock.js";
import {
  type PinnedDirectory,
  assertPinnedDirectory,
  canonicalDurabilityPath,
  renameAt,
  tryLinkAt,
  unlinkAt,
} from "./native.js";
import { createPrivateFileAt, openExistingPrivateFileAt, readPrivateFileAt } from "./path.js";

export interface StoredObject {
  digest: string;
  path: string;
  byteLength: number;
  disposition: "created" | "verified";
}

export interface ObjectStoreOptions {
  lock: ProcessLock;
  extension?: string;
  maxBytes?: number;
  canonical?: CanonicalJsonOptions;
}

export interface CreateOrVerifyOptions {
  lock: ProcessLock;
  maxBytes?: number;
  fault?: (point: "after-link") => void;
}

function safeExtension(value: string | undefined, fallback: string): string {
  const extension = value ?? fallback;
  if (!/^\.[a-z0-9]{1,16}$/.test(extension))
    durabilityError("invalid_value", "object extension must be short lowercase ASCII");
  return extension;
}

function exact(left: Buffer | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === null && right === null;
  return left.length === right.length && timingSafeEqual(left, right);
}

function publicationEntries(
  directory: PinnedDirectory,
  leftName: string,
  rightName: string,
): { same: boolean; finalLinks: number } | null {
  const left = openExistingPrivateFileAt(directory, leftName, fs.constants.O_RDONLY, 2);
  let right: number | null;
  try {
    right = openExistingPrivateFileAt(directory, rightName, fs.constants.O_RDONLY, 2);
  } catch (error) {
    return cleanupThenThrow(error, left !== null ? [() => fs.closeSync(left)] : []);
  }
  if (left === null || right === null) {
    runCleanups([
      () => {
        if (left !== null) fs.closeSync(left);
      },
      () => {
        if (right !== null) fs.closeSync(right);
      },
    ]);
    return null;
  }
  return withCleanup(() => {
    const leftStat = fs.fstatSync(left);
    const rightStat = fs.fstatSync(right);
    return {
      same: leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino,
      finalLinks: leftStat.nlink,
    };
  }, [() => fs.closeSync(left), () => fs.closeSync(right)]);
}

function recoverPublication(
  directory: PinnedDirectory,
  name: string,
  stagedName: string,
  bytes: Uint8Array,
  maxBytes: number,
): boolean {
  const existing = readPrivateFileAt(directory, name, maxBytes, 2);
  if (!existing) return false;
  if (!exact(existing, bytes)) durabilityError("conflict", `immutable object conflict at ${name}`);
  const staged = readPrivateFileAt(directory, stagedName, maxBytes, 2);
  if (!staged) {
    const final = openExistingPrivateFileAt(directory, name, fs.constants.O_RDONLY);
    if (final === null) durabilityError("corrupt", `immutable object disappeared at ${name}`);
    fs.closeSync(final);
    return true;
  }
  if (!exact(staged, bytes)) durabilityError("conflict", `immutable staging conflict at ${name}`);
  const entries = publicationEntries(directory, name, stagedName);
  if (!entries) durabilityError("corrupt", `immutable recovery entries disappeared at ${name}`);
  if (entries.finalLinks === 2 && !entries.same)
    durabilityError("corrupt", `immutable object has an unbound hard link at ${name}`);
  unlinkAt(directory, stagedName);
  fs.fsyncSync(directory.fd);
  const verified = readPrivateFileAt(directory, name, maxBytes);
  if (!exact(verified, bytes)) durabilityError("corrupt", `immutable recovery failed at ${name}`);
  return true;
}

export function createOrVerifyPrivateFile(
  path: string,
  bytes: Uint8Array,
  options: CreateOrVerifyOptions,
): "created" | "verified" {
  const maxBytes = positiveSafeLimit(options.maxBytes ?? 8 * 1024 * 1024, "immutable byte limit");
  if (bytes.length > maxBytes) durabilityError("bounds", "immutable object exceeds byte limit");
  if (options.lock.path === canonicalDurabilityPath(path))
    durabilityError("lock_lost", "immutable object cannot replace its owning process lock");
  return withLockedParent(options.lock, path, true, (directory, name) => {
    const stagedName = `.${basename(name)}.create-object`;
    if (recoverPublication(directory, name, stagedName, bytes, maxBytes)) return "verified";
    const staged = readPrivateFileAt(directory, stagedName, maxBytes);
    if (staged && !exact(staged, bytes))
      durabilityError("conflict", `immutable object staging conflict at ${name}`);
    if (!staged) {
      const fd = createPrivateFileAt(directory, stagedName, bytes);
      if (fd === null) {
        const raced = readPrivateFileAt(directory, stagedName, maxBytes);
        if (!exact(raced, bytes))
          durabilityError("conflict", `immutable staging conflict at ${name}`);
      } else {
        fs.closeSync(fd);
      }
    }
    assertPinnedDirectory(directory);
    if (!tryLinkAt(directory, stagedName, name)) {
      if (!recoverPublication(directory, name, stagedName, bytes, maxBytes))
        durabilityError("conflict", `immutable publication conflict at ${name}`);
      return "verified";
    }
    options.fault?.("after-link");
    assertPinnedDirectory(directory);
    unlinkAt(directory, stagedName);
    fs.fsyncSync(directory.fd);
    if (!exact(readPrivateFileAt(directory, name, maxBytes), bytes))
      durabilityError("corrupt", `immutable publication verification failed at ${name}`);
    return "created";
  });
}

export function createCanonicalObject(
  root: string,
  domain: string,
  value: unknown,
  options: ObjectStoreOptions,
): StoredObject {
  const bytes = canonicalJsonBytes(value, options.canonical);
  const maxBytes = positiveSafeLimit(options.maxBytes ?? 8 * 1024 * 1024, "object byte limit");
  if (bytes.length > maxBytes) durabilityError("bounds", "canonical object exceeds byte limit");
  const digest = digestV1Bytes(domain, bytes);
  const path = join(root, `${digestHex(digest)}${safeExtension(options.extension, ".json")}`);
  const disposition = createOrVerifyPrivateFile(path, bytes, { lock: options.lock, maxBytes });
  return { digest, path, byteLength: bytes.length, disposition };
}

export function createRawObject(
  root: string,
  bytes: Uint8Array,
  options: ObjectStoreOptions,
): StoredObject {
  const maxBytes = positiveSafeLimit(options.maxBytes ?? 64 * 1024 * 1024, "object byte limit");
  if (bytes.length > maxBytes) durabilityError("bounds", "raw object exceeds byte limit");
  const digest = sha256Digest(bytes);
  const path = join(root, `${digestHex(digest)}${safeExtension(options.extension, ".bin")}`);
  const disposition = createOrVerifyPrivateFile(path, bytes, { lock: options.lock, maxBytes });
  return { digest, path, byteLength: bytes.length, disposition };
}

export type AtomicCasFaultPoint = "after-file-fsync" | "after-rename" | "after-directory-fsync";

export interface AtomicCasOptions {
  lock: ProcessLock;
  maxBytes?: number;
  fault?: (point: AtomicCasFaultPoint) => void;
}

function casStageName(name: string): string {
  const identity = digestHex(sha256Digest(Buffer.from(name, "utf8")));
  return `.cas-stage-${identity}`;
}

function prepareCasStage(
  directory: PinnedDirectory,
  name: string,
  replacement: Uint8Array,
  maxBytes: number,
): string {
  const stagedName = casStageName(name);
  const staged = readPrivateFileAt(directory, stagedName, maxBytes);
  if (staged !== null) {
    if (exact(staged, replacement)) return stagedName;
    unlinkAt(directory, stagedName);
    fs.fsyncSync(directory.fd);
  }
  const fd = createPrivateFileAt(directory, stagedName, replacement);
  if (fd === null) durabilityError("conflict", `CAS staging entry raced at ${name}`);
  fs.closeSync(fd);
  return stagedName;
}

export function atomicCompareAndSwap(
  path: string,
  expected: Uint8Array | null,
  replacement: Uint8Array,
  options: AtomicCasOptions,
): void {
  const maxBytes = positiveSafeLimit(options.maxBytes ?? 8 * 1024 * 1024, "CAS byte limit");
  if (replacement.length > maxBytes || (expected?.length ?? 0) > maxBytes)
    durabilityError("bounds", "CAS value exceeds byte limit");
  assertProcessLockCovers(options.lock, path);
  if (options.lock.path === canonicalDurabilityPath(path))
    durabilityError("lock_lost", "CAS target cannot be its owning process lock");
  withLockedParent(options.lock, path, true, (directory, name) => {
    if (!exact(readPrivateFileAt(directory, name, maxBytes), expected))
      durabilityError("cas_mismatch", `CAS preimage mismatch at ${path}`);
    let temporary: string | null = prepareCasStage(directory, name, replacement, maxBytes);
    withCleanup(() => {
      options.fault?.("after-file-fsync");
      assertPinnedDirectory(directory);
      if (!exact(readPrivateFileAt(directory, name, maxBytes), expected))
        durabilityError("cas_mismatch", `CAS preimage changed at ${path}`);
      renameAt(directory, temporary as string, name);
      temporary = null;
      options.fault?.("after-rename");
      assertPinnedDirectory(directory);
      fs.fsyncSync(directory.fd);
      options.fault?.("after-directory-fsync");
    }, [
      () => {
        if (temporary) unlinkAt(directory, temporary, true);
      },
    ]);
  });
}
