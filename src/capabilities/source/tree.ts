import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { ProcessLock } from "../../durability/index.js";
import { assertNoSymlinkComponents, createOrVerifyPrivateFile } from "../../durability/index.js";
import { inTreePath } from "../manifest/validation-helpers.js";
import { CapabilityValidationError, assertSortedUnique, bytewise } from "../wire/primitives.js";

const TREE_DOMAIN = Buffer.from("VF-CAPABILITY-PACKAGE-TREE\0v1\0", "utf8");
const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 64;

export interface PackageTreeEntryV1 {
  path: string;
  bytes: Uint8Array;
}

export interface PackageTreeV1 {
  content_sha256: string;
  entry_count: number;
  expanded_byte_length: number;
  entries: PackageTreeEntryV1[];
  files: ReadonlyMap<string, Uint8Array>;
}

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function u64(value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function validateEntries(entries: readonly PackageTreeEntryV1[]): PackageTreeEntryV1[] {
  if (entries.length === 0 || entries.length > MAX_FILES)
    throw new CapabilityValidationError(
      "package tree entry count is out of bounds",
      "entries",
      "bounds",
    );
  const output = entries.map((entry, index) => {
    const path = inTreePath(entry.path, `entries[${index}].path`);
    if (path.split("/").length > MAX_DEPTH)
      throw new CapabilityValidationError(
        "package path nesting exceeds limit",
        `entries[${index}].path`,
        "bounds",
      );
    const bytes = Buffer.from(entry.bytes);
    if (bytes.byteLength > MAX_FILE_BYTES)
      throw new CapabilityValidationError(
        "package file exceeds byte limit",
        `entries[${index}]`,
        "bounds",
      );
    return { path, bytes };
  });
  output.sort((left, right) => bytewise(left.path, right.path));
  assertSortedUnique(output, (left, right) => bytewise(left.path, right.path), "entries");
  const caseFolded = output.map((entry) => entry.path.toLowerCase());
  if (new Set(caseFolded).size !== caseFolded.length)
    throw new CapabilityValidationError(
      "case-fold-colliding package paths are forbidden",
      "entries",
    );
  const fileNames = new Set(output.map((entry) => entry.path));
  for (const entry of output) {
    const segments = entry.path.split("/");
    for (let end = 1; end < segments.length; end += 1) {
      if (fileNames.has(segments.slice(0, end).join("/")))
        throw new CapabilityValidationError(
          "a package file is an ancestor of another entry",
          entry.path,
        );
    }
  }
  const total = output.reduce((sum, entry) => sum + entry.bytes.byteLength, 0);
  if (total > MAX_TOTAL_BYTES)
    throw new CapabilityValidationError("expanded package exceeds byte limit", "entries", "bounds");
  return output;
}

export function computePackageTree(entries: readonly PackageTreeEntryV1[]): PackageTreeV1 {
  const normalized = validateEntries(entries);
  const hash = createHash("sha256").update(TREE_DOMAIN).update(u32(normalized.length));
  for (const entry of normalized) {
    const pathBytes = Buffer.from(entry.path, "utf8");
    hash
      .update(u32(pathBytes.length))
      .update(pathBytes)
      .update(u64(entry.bytes.byteLength))
      .update(createHash("sha256").update(entry.bytes).digest());
  }
  const immutable = normalized.map((entry) => ({
    path: entry.path,
    bytes: Buffer.from(entry.bytes),
  }));
  return {
    content_sha256: hash.digest("hex"),
    entry_count: immutable.length,
    expanded_byte_length: immutable.reduce((sum, entry) => sum + entry.bytes.byteLength, 0),
    entries: immutable,
    files: new Map(immutable.map((entry) => [entry.path, Buffer.from(entry.bytes)])),
  };
}

function readRegularFile(path: string, expected: fs.Stats): Buffer {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(path, flags);
  try {
    const opened = fs.fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino
    )
      throw new CapabilityValidationError("package file identity/link safety check failed", path);
    if (opened.size > MAX_FILE_BYTES)
      throw new CapabilityValidationError("package file exceeds byte limit", path, "bounds");
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new CapabilityValidationError("package file changed during read", path);
      offset += count;
    }
    const final = fs.fstatSync(fd);
    if (final.size !== opened.size || final.mtimeMs !== opened.mtimeMs || final.ino !== opened.ino)
      throw new CapabilityValidationError("package file changed during read", path);
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

export function readPackageTree(root: string): PackageTreeV1 {
  const absolute = resolve(root);
  assertNoSymlinkComponents(absolute);
  const rootStat = fs.lstatSync(absolute);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new CapabilityValidationError("package root must be a real directory", "root");
  const entries: PackageTreeEntryV1[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > MAX_DEPTH)
      throw new CapabilityValidationError("package nesting exceeds limit", directory, "bounds");
    const names = fs.readdirSync(directory).sort(bytewise);
    for (const name of names) {
      const absoluteEntry = join(directory, name);
      const stat = fs.lstatSync(absoluteEntry);
      if (stat.isSymbolicLink())
        throw new CapabilityValidationError("package symlink is forbidden", absoluteEntry);
      if (stat.isDirectory()) {
        visit(absoluteEntry, depth + 1);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1)
        throw new CapabilityValidationError(
          "special or hard-linked package entry is forbidden",
          absoluteEntry,
        );
      const logical = relative(absolute, absoluteEntry).split(sep).join("/");
      if (logical.normalize("NFC") !== logical)
        throw new CapabilityValidationError("package path must already be NFC", logical);
      entries.push({ path: logical, bytes: readRegularFile(absoluteEntry, stat) });
      if (entries.length > MAX_FILES)
        throw new CapabilityValidationError("package entry count exceeds limit", "root", "bounds");
    }
  };
  visit(absolute, 0);
  return computePackageTree(entries);
}

export function materializePackageTree(
  destination: string,
  tree: PackageTreeV1,
  lock: ProcessLock,
): void {
  const validated = computePackageTree(tree.entries);
  if (validated.content_sha256 !== tree.content_sha256)
    throw new CapabilityValidationError(
      "package tree digest mismatch",
      "content_sha256",
      "integrity_failure",
    );
  for (const entry of validated.entries) {
    createOrVerifyPrivateFile(join(destination, ...entry.path.split("/")), entry.bytes, {
      lock,
      maxBytes: MAX_FILE_BYTES,
    });
  }
}
