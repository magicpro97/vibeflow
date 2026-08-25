import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import { dirname, parse, relative, resolve, sep } from "node:path";
import { canonicalJsonBytes } from "../../durability/index.js";
import { errnoIs, native, syscallFailure } from "../../durability/native-runtime.js";
import {
  type PinnedDirectory,
  assertPinnedDirectory,
  canonicalDurabilityPath,
  createAt,
  pinnedDirectoryPath,
  renameAt,
  tryOpenAt,
  unlinkAt,
} from "../../durability/native.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import type { CapabilityPrivateJsonV1 } from "./types.js";

const MAX_PROJECTION_BYTES = 4 * 1024 * 1024;
const OWNER = typeof process.geteuid === "function" ? process.geteuid() : undefined;

export type ProjectionMutationFaultV1 = (point: "before-commit", absolutePath: string) => void;

export type CapabilityInternalCasFaultV1 = (point: {
  phase: "after-cas";
  absolute_path: string;
  surface: "projection" | "private-descriptor" | "owner-binding";
}) => void;

export function boundedProjectionPath(root: string, logical: string): string {
  const absoluteRoot = canonicalDurabilityPath(resolve(root));
  const absolute = canonicalDurabilityPath(resolve(absoluteRoot, ...logical.split("/")));
  const rel = relative(absoluteRoot, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`))
    throw new CapabilityValidationError("projection destination escapes its fixed root", logical);
  return absolute;
}

function pinned(fd: number, path: string): PinnedDirectory {
  const stat = fs.fstatSync(fd);
  if (!stat.isDirectory() || pinnedDirectoryPath(fd) !== path)
    throw new CapabilityValidationError("projection directory cannot be pinned", path);
  const directory = { fd, path, dev: stat.dev, ino: stat.ino };
  assertPinnedDirectory(directory);
  return directory;
}

function openRoot(path: string): PinnedDirectory {
  const root = parse(path).root;
  return pinned(
    fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW),
    root,
  );
}

function childDirectory(
  parent: PinnedDirectory,
  name: string,
  path: string,
  create: boolean,
): PinnedDirectory | null {
  let fd = tryOpenAt(parent, name, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  if (fd === null && create) {
    if (native().mkdirat(parent.fd, name, 0o700) !== 0 && !errnoIs("EEXIST"))
      syscallFailure(`mkdirat projection directory ${path}`);
    fs.fsyncSync(parent.fd);
    fd = tryOpenAt(parent, name, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  }
  return fd === null ? null : pinned(fd, path);
}

function withPinnedParent<T>(
  targetPath: string,
  create: boolean,
  callback: (directory: PinnedDirectory, name: string) => T,
): T | null {
  const target = canonicalDurabilityPath(targetPath);
  const targetParent = dirname(target);
  let current = openRoot(target);
  try {
    const parts = targetParent.slice(parse(targetParent).root.length).split(sep).filter(Boolean);
    let cursor = parse(targetParent).root;
    for (const part of parts) {
      const nextPath = resolve(cursor, part);
      const next = childDirectory(current, part, nextPath, create);
      if (next === null) return null;
      fs.closeSync(current.fd);
      current = next;
      cursor = nextPath;
    }
    assertPinnedDirectory(current);
    return callback(current, target.slice(targetParent.length + 1));
  } finally {
    fs.closeSync(current.fd);
  }
}

function readAt(directory: PinnedDirectory, name: string): Buffer | null {
  const fd = tryOpenAt(directory, name, fs.constants.O_RDONLY);
  if (fd === null) return null;
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > MAX_PROJECTION_BYTES ||
      (OWNER !== undefined && stat.uid !== OWNER)
    )
      throw new CapabilityValidationError("projection file is unsafe or oversized", name);
    const bytes = Buffer.alloc(stat.size);
    for (let offset = 0; offset < bytes.length; ) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0)
        throw new CapabilityValidationError("projection file read made no progress", name);
      offset += count;
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

export function readProjectionFile(path: string): Buffer | null {
  return withPinnedParent(path, false, (directory, name) => readAt(directory, name));
}

export function bytesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function writeTemporary(
  directory: PinnedDirectory,
  name: string,
  bytes: Uint8Array,
  mode: number,
): string {
  if (bytes.byteLength > MAX_PROJECTION_BYTES)
    throw new CapabilityValidationError("projection replacement exceeds byte limit", name);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const temporary = `.vf-capability-${randomBytes(16).toString("hex")}.tmp`;
    const fd = createAt(directory, temporary, fs.constants.O_WRONLY, mode);
    if (fd === null) continue;
    try {
      fs.fchmodSync(fd, mode);
      for (let offset = 0; offset < bytes.byteLength; ) {
        const written = fs.writeSync(fd, bytes, offset, bytes.byteLength - offset, offset);
        if (written <= 0)
          throw new CapabilityValidationError("projection write made no progress", name);
        offset += written;
      }
      fs.fsyncSync(fd);
      return temporary;
    } catch (error) {
      unlinkAt(directory, temporary, true);
      throw error;
    } finally {
      fs.closeSync(fd);
    }
  }
  throw new CapabilityValidationError("cannot allocate projection staging file", name);
}

export function compareAndSwapProjectionFile(
  path: string,
  expected: Uint8Array | null,
  replacement: Uint8Array | null,
  mode = 0o600,
  fault?: ProjectionMutationFaultV1,
): void {
  const result = withPinnedParent(path, true, (directory, name) => {
    if (!bytesEqual(readAt(directory, name), expected))
      throw new CapabilityValidationError("projection CAS preimage mismatch", path);
    let temporary: string | null =
      replacement === null ? null : writeTemporary(directory, name, replacement, mode);
    try {
      fault?.("before-commit", path);
      assertPinnedDirectory(directory);
      if (!bytesEqual(readAt(directory, name), expected))
        throw new CapabilityValidationError("projection CAS preimage changed", path);
      if (temporary === null) unlinkAt(directory, name, true);
      else {
        renameAt(directory, temporary, name);
        temporary = null;
      }
      fs.fsyncSync(directory.fd);
      assertPinnedDirectory(directory);
    } finally {
      if (temporary !== null) unlinkAt(directory, temporary, true);
    }
  });
  if (result === null)
    throw new CapabilityValidationError("projection parent could not be created", path);
}

/** Atomically replaces only one VF-owned TOML block while retaining unrelated
 * bytes as concurrent-user authority. The whole-file bytes observed through
 * the pinned parent are used only as the CAS operand and are never retained in
 * an adapter descriptor or preimage blob. */
export function compareAndSwapTomlOwnedBlock(
  path: string,
  blockId: string,
  expectedBlock: string | null,
  replacementBlock: string | null,
  mode = 0o600,
  placement: "append" | "after-features-header" = "append",
): void {
  for (const [field, block] of [
    ["expected", expectedBlock],
    ["replacement", replacementBlock],
  ] as const) {
    if (block !== null && tomlOwnedBlock(block, blockId) !== block)
      throw new CapabilityValidationError(`TOML ${field} block is not self-contained`, blockId);
  }
  const result = withPinnedParent(path, true, (directory, name) => {
    const currentBytes = readAt(directory, name);
    let currentText: string;
    try {
      currentText =
        currentBytes === null ? "" : new TextDecoder("utf-8", { fatal: true }).decode(currentBytes);
    } catch {
      throw new CapabilityValidationError("TOML projection is not valid UTF-8", path);
    }
    if (tomlOwnedBlock(currentText, blockId) !== expectedBlock)
      throw new CapabilityValidationError("TOML owned block CAS preimage mismatch", blockId);
    const replaced = replaceTomlOwnedBlockAt(currentText, blockId, replacementBlock, placement);
    const replacementBytes = replaced.length === 0 ? null : Buffer.from(replaced);
    let temporary: string | null =
      replacementBytes === null ? null : writeTemporary(directory, name, replacementBytes, mode);
    try {
      assertPinnedDirectory(directory);
      if (!bytesEqual(readAt(directory, name), currentBytes))
        throw new CapabilityValidationError("TOML projection changed during block CAS", path);
      if (temporary === null) unlinkAt(directory, name, true);
      else {
        renameAt(directory, temporary, name);
        temporary = null;
      }
      fs.fsyncSync(directory.fd);
      assertPinnedDirectory(directory);
    } finally {
      if (temporary !== null) unlinkAt(directory, temporary, true);
    }
  });
  if (result === null)
    throw new CapabilityValidationError("projection parent could not be created", path);
}

function replaceTomlOwnedBlockAt(
  text: string,
  blockId: string,
  block: string | null,
  placement: "append" | "after-features-header",
): string {
  if (tomlOwnedBlock(text, blockId) !== null || block === null || placement === "append")
    return replaceTomlOwnedBlock(text, blockId, block);
  const headers = [...text.matchAll(/^\s*\[features\]\s*(?:#.*)?$/gmu)];
  if (headers.length !== 1)
    throw new CapabilityValidationError(
      "Codex feature block insertion anchor is not unique",
      blockId,
    );
  const header = headers[0] as RegExpMatchArray;
  const start = header.index as number;
  const end = start + header[0].length;
  const suffix = text.slice(end);
  return `${text.slice(0, end)}\n${block}${suffix.startsWith("\n") ? suffix : `\n${suffix}`}`;
}

export function projectionStateDigest(
  value: unknown,
  marker: unknown,
  auxiliary: unknown[] = [],
  valuePresent = value !== null,
): string | null {
  const bytes = projectionStateBytes(value, marker, auxiliary, valuePresent);
  return bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
}

export function projectionStateBytes(
  value: unknown,
  marker: unknown,
  auxiliary: unknown[] = [],
  valuePresent = value !== null,
): Buffer | null {
  if (!valuePresent && marker === null && auxiliary.every((item) => item === null)) return null;
  return canonicalJsonBytes({
    schema_version: "1.0",
    value_present: valuePresent,
    value: valuePresent ? value : null,
    marker,
    auxiliary,
  });
}

export function parseProjectionJson(
  bytes: Buffer | null,
  path: string,
): Record<string, CapabilityPrivateJsonV1> {
  if (bytes === null) return {};
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CapabilityValidationError("projection JSON is corrupt", path);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CapabilityValidationError("projection JSON root must be an object", path);
  return value as Record<string, CapabilityPrivateJsonV1>;
}

export function readJsonSlice(
  object: Record<string, CapabilityPrivateJsonV1>,
  keyPath: readonly string[],
): { present: boolean; value: CapabilityPrivateJsonV1 | null } {
  let cursor: CapabilityPrivateJsonV1 = object;
  for (const [index, key] of keyPath.entries()) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor) || !(key in cursor))
      return { present: false, value: null };
    cursor = cursor[key] as CapabilityPrivateJsonV1;
    if (index === keyPath.length - 1) return { present: true, value: structuredClone(cursor) };
  }
  return { present: false, value: null };
}

export function writeJsonSlice(
  object: Record<string, CapabilityPrivateJsonV1>,
  keyPath: readonly string[],
  present: boolean,
  value: CapabilityPrivateJsonV1 | null,
): Record<string, CapabilityPrivateJsonV1> {
  const output = structuredClone(object);
  let cursor: Record<string, CapabilityPrivateJsonV1> = output;
  for (const key of keyPath.slice(0, -1)) {
    const child = cursor[key];
    if (child === undefined) cursor[key] = {};
    else if (!child || typeof child !== "object" || Array.isArray(child))
      throw new CapabilityValidationError(
        "projection key parent is not an object",
        keyPath.join("."),
      );
    cursor = cursor[key] as Record<string, CapabilityPrivateJsonV1>;
  }
  const leaf = keyPath.at(-1) as string;
  if (present) cursor[leaf] = structuredClone(value);
  else delete cursor[leaf];
  return output;
}

export function tomlOwnedBlock(text: string, blockId: string): string | null {
  const start = `# vf-capability:${blockId}:start`;
  const end = `# vf-capability:${blockId}:end`;
  const startAt = text.indexOf(start);
  const endAt = text.indexOf(end);
  if (startAt < 0 && endAt < 0) return null;
  if (
    startAt < 0 ||
    endAt < startAt ||
    text.indexOf(start, startAt + 1) >= 0 ||
    text.indexOf(end, endAt + 1) >= 0
  )
    throw new CapabilityValidationError("TOML owned block markers are corrupt", blockId);
  return text.slice(startAt, endAt + end.length);
}

export function replaceTomlOwnedBlock(text: string, blockId: string, block: string | null): string {
  const current = tomlOwnedBlock(text, blockId);
  if (current === null)
    return block === null ? text : `${text.trimEnd()}${text.trim() ? "\n\n" : ""}${block}\n`;
  const replaced = text.replace(current, block ?? "");
  return `${replaced.replace(/\n{3,}/g, "\n\n").trimEnd()}${replaced.trim() ? "\n" : ""}`;
}
