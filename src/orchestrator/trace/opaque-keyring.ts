import { createHmac, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import {
  createPrivateAtomic,
  ensurePrivateDirectory,
  openPrivateFile,
  safeEntry,
  writeAll,
  writePrivateAtomic,
} from "./path-safety.js";

const KEY_FILE = ".opaque-hmac-key";
const INDEX_KEY_FILE = ".opaque-hmac-index-key";
const HISTORY_FILE = ".opaque-hmac-key-history.json";
const ASSIGNMENTS_FILE = ".opaque-hmac-assignments.jsonl";
const LOCK_FILE = ".opaque-key.lock";
const KEY_BYTES = 32;
const ASSIGNMENT_RECORD_BYTES = 160;

export interface OpaqueKeyLimits {
  maxRetiredKeys: number;
  maxAssignments: number;
}

export const DEFAULT_OPAQUE_KEY_LIMITS: OpaqueKeyLimits = {
  maxRetiredKeys: 8,
  maxAssignments: 32_768,
};

export interface OpaqueIdentityInput {
  kind: "artifact" | "session";
  conversationId: string;
  value: string;
}

interface AssignmentSnapshot {
  readonly values: Map<string, string>;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly tail: Buffer;
}

export interface OpaqueKeyring {
  readonly root: string;
  readonly activeKey: Buffer;
  readonly retiredKeys: Buffer[];
  readonly indexKey: Buffer;
  readonly assignments: AssignmentSnapshot;
  readonly limits: OpaqueKeyLimits;
  readonly stamp: string;
}

export interface OpaqueReservation {
  readonly ids: string[];
  readonly keyring: OpaqueKeyring;
  commit(): OpaqueKeyring;
  rollback(): void;
}

const keyError = (message: string): never => {
  throw new Error(`artifact registry: ${message}`);
};
const entry = (path: string): fs.Stats | null => safeEntry(path, keyError, "unsafe opaque state");
const privateFileFd = (path: string, max: number, label: string, empty = false): number =>
  openPrivateFile(path, max, keyError, label, empty);
const writePrivate = (root: string, path: string, data: Buffer, max: number): void =>
  writePrivateAtomic(root, path, data, max, keyError);
const createInitial = (root: string, name: string, data: Buffer, recoverEmpty = false): void =>
  createPrivateAtomic(root, name, data, keyError, recoverEmpty);

const readPrivate = (path: string, maxBytes: number, label: string, allowEmpty = false): Buffer => {
  const fd = privateFileFd(path, maxBytes, label, allowEmpty);
  try {
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};
const readKey = (root: string, name: string): Buffer => {
  const key = readPrivate(join(root, name), KEY_BYTES, "unsafe opaque key");
  if (key.length !== KEY_BYTES) keyError("unsafe opaque key");
  return key;
};
const readHistory = (root: string, limit: number): Buffer[] => {
  const path = join(root, HISTORY_FILE);
  if (!entry(path)) return [];
  const maxBytes = Math.max(2, limit * 64);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readPrivate(path, maxBytes, "unsafe opaque key history").toString("utf8"));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("artifact registry:")) throw error;
    return keyError("unsafe opaque key history");
  }
  if (!Array.isArray(parsed) || parsed.length > limit) keyError("unsafe opaque key history");
  return (parsed as unknown[]).map((value: unknown) => {
    if (typeof value !== "string") return keyError("unsafe opaque key history");
    const key = Buffer.from(value, "base64url");
    if (key.length !== KEY_BYTES || key.toString("base64url") !== value)
      keyError("unsafe opaque key history");
    return key;
  });
};

const assignmentPath = (root: string) => join(root, ASSIGNMENTS_FILE);
const assignmentMaxBytes = (limits: OpaqueKeyLimits) =>
  Math.max(1, limits.maxAssignments * ASSIGNMENT_RECORD_BYTES);
const readRange = (fd: number, length: number, position: number): Buffer => {
  const buffer = Buffer.alloc(length);
  if (length && fs.readSync(fd, buffer, 0, length, position) !== length)
    keyError("unsafe opaque assignments");
  return buffer;
};
const parseAssignmentLines = (text: string, values: Map<string, string>): void => {
  for (const line of text ? text.replace(/\n$/, "").split("\n") : []) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      keyError("unsafe opaque assignments");
    }
    const object =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    const lookupValue = object?.lookup;
    const id = object?.id;
    if (
      !object ||
      Object.keys(object).sort().join(",") !== "id,lookup" ||
      typeof lookupValue !== "string" ||
      !/^lookup_[A-Za-z0-9_-]{43}$/.test(lookupValue) ||
      typeof id !== "string" ||
      !/^(?:artifact|session)_[A-Za-z0-9_-]{43}$/.test(id)
    )
      keyError("unsafe opaque assignments");
    const safeLookup = lookupValue as string;
    const safeId = id as string;
    const previous = values.get(safeLookup);
    if (previous !== undefined && previous !== safeId) keyError("opaque assignment conflict");
    values.set(safeLookup, safeId);
  }
};
const loadAssignments = (
  root: string,
  limits: OpaqueKeyLimits,
  previous?: AssignmentSnapshot,
): AssignmentSnapshot => {
  const path = assignmentPath(root);
  createInitial(root, ASSIGNMENTS_FILE, Buffer.alloc(0));
  const fd = privateFileFd(path, assignmentMaxBytes(limits), "unsafe opaque assignments", true);
  try {
    const stat = fs.fstatSync(fd);
    const sameFile =
      previous !== undefined && previous.dev === stat.dev && previous.ino === stat.ino;
    if (
      previous !== undefined &&
      sameFile &&
      stat.size === previous.size &&
      stat.mtimeMs === previous.mtimeMs &&
      stat.ctimeMs === previous.ctimeMs
    )
      return previous;
    const oldTailLength = previous ? Math.min(previous.size, 256) : 0;
    const canTail =
      previous !== undefined &&
      sameFile &&
      stat.size > previous.size &&
      readRange(fd, oldTailLength, previous.size - oldTailLength).equals(previous.tail);
    const values = canTail && previous ? previous.values : new Map<string, string>();
    const start = canTail && previous ? previous.size : 0;
    const buffer = Buffer.alloc(stat.size - start);
    if (buffer.length) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, start);
      if (count !== buffer.length) keyError("unsafe opaque assignments");
      const newline = buffer.lastIndexOf(10);
      if (newline !== buffer.length - 1) {
        fs.ftruncateSync(fd, start + Math.max(0, newline + 1));
        fs.fsyncSync(fd);
      }
      const parsed = new Map<string, string>();
      parseAssignmentLines(buffer.subarray(0, Math.max(0, newline + 1)).toString("utf8"), parsed);
      for (const [key, id] of parsed) {
        const old = values.get(key);
        if (old !== undefined && old !== id) keyError("opaque assignment conflict");
      }
      for (const [key, id] of parsed) values.set(key, id);
    }
    if (values.size > limits.maxAssignments) keyError("assignment limit reached");
    const final = fs.fstatSync(fd);
    const tailLength = Math.min(final.size, 256);
    return {
      values,
      dev: final.dev,
      ino: final.ino,
      size: final.size,
      mtimeMs: final.mtimeMs,
      ctimeMs: final.ctimeMs,
      tail: readRange(fd, tailLength, final.size - tailLength),
    };
  } finally {
    fs.closeSync(fd);
  }
};

const fileStamp = (path: string): string => {
  const observed = entry(path);
  return observed
    ? `${observed.dev}:${observed.ino}:${observed.size}:${observed.mtimeMs}:${observed.ctimeMs}`
    : "missing";
};
const stamp = (root: string): string =>
  [KEY_FILE, INDEX_KEY_FILE, HISTORY_FILE, ASSIGNMENTS_FILE]
    .map((name) => fileStamp(join(root, name)))
    .join("|");
const validateLimits = (limits: OpaqueKeyLimits): OpaqueKeyLimits => {
  if (
    !Number.isSafeInteger(limits.maxRetiredKeys) ||
    limits.maxRetiredKeys < 1 ||
    limits.maxRetiredKeys > 64 ||
    !Number.isSafeInteger(limits.maxAssignments) ||
    limits.maxAssignments < 1 ||
    limits.maxAssignments > 131_072
  )
    keyError("invalid registry limits");
  return Object.freeze({ ...limits });
};
const loadKeyring = (root: string, limits: OpaqueKeyLimits, previous?: OpaqueKeyring) => {
  createInitial(root, KEY_FILE, randomBytes(KEY_BYTES), true);
  createInitial(root, INDEX_KEY_FILE, randomBytes(KEY_BYTES), true);
  return {
    root,
    activeKey: readKey(root, KEY_FILE),
    retiredKeys: readHistory(root, limits.maxRetiredKeys),
    indexKey: readKey(root, INDEX_KEY_FILE),
    assignments: loadAssignments(root, limits, previous?.assignments),
    limits,
    stamp: stamp(root),
  } satisfies OpaqueKeyring;
};

const acquire = (root: string): (() => void) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return lockfile.lockSync(root, {
        realpath: false,
        lockfilePath: join(root, LOCK_FILE),
        stale: 10_000,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || attempt === 199)
        keyError("opaque key lock failed");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
};
const derive = (key: Uint8Array, input: OpaqueIdentityInput): string =>
  `${input.kind}_${createHmac("sha256", key)
    .update("v7-public-opaque\0", "utf8")
    .update(input.kind, "utf8")
    .update("\0", "utf8")
    .update(String(Buffer.byteLength(input.conversationId, "utf8")), "utf8")
    .update("\0", "utf8")
    .update(input.conversationId, "utf8")
    .update("\0", "utf8")
    .update(input.value, "utf8")
    .digest("base64url")}`;
const lookup = (key: Uint8Array, input: OpaqueIdentityInput): string =>
  `lookup_${createHmac("sha256", key)
    .update("v7-public-assignment\0", "utf8")
    .update(input.kind, "utf8")
    .update(`\0${Buffer.byteLength(input.conversationId, "utf8")}\0`, "utf8")
    .update(input.conversationId, "utf8")
    .update(`\0${Buffer.byteLength(input.value, "utf8")}\0`, "utf8")
    .update(input.value, "utf8")
    .digest("base64url")}`;

export const opaqueRegistryKeyPath = (dir: string): string => join(resolve(dir), KEY_FILE);

export function openOpaqueKeyring(
  dir: string,
  requested: Partial<OpaqueKeyLimits> = {},
): OpaqueKeyring {
  const limits = validateLimits({ ...DEFAULT_OPAQUE_KEY_LIMITS, ...requested });
  const root = ensurePrivateDirectory(resolve(dir), keyError);
  const release = acquire(root);
  try {
    return loadKeyring(root, limits);
  } finally {
    release();
  }
}

export function refreshOpaqueKeyring(current: OpaqueKeyring): OpaqueKeyring {
  if (stamp(current.root) === current.stamp) return current;
  const release = acquire(current.root);
  try {
    return loadKeyring(current.root, current.limits, current);
  } finally {
    release();
  }
}

export function reserveOpaqueIds(
  current: OpaqueKeyring,
  inputs: readonly OpaqueIdentityInput[],
): OpaqueReservation {
  const release = acquire(current.root);
  let settled = false;
  try {
    const keyring = loadKeyring(current.root, current.limits, current);
    const pending = new Map<string, string>();
    const ids = inputs.map((input) => {
      const key = lookup(keyring.indexKey, input);
      const existing = keyring.assignments.values.get(key) ?? pending.get(key);
      if (existing) return existing;
      const id = derive(keyring.activeKey, input);
      pending.set(key, id);
      return id;
    });
    if (keyring.assignments.values.size + pending.size > keyring.limits.maxAssignments)
      keyError("assignment limit reached");
    const finish = () => {
      if (settled) return;
      settled = true;
      release();
    };
    return {
      ids,
      keyring,
      commit() {
        if (settled) return keyError("opaque reservation already settled");
        try {
          if (pending.size) {
            const data = Buffer.from(
              [...pending].map(([lookup, id]) => `${JSON.stringify({ lookup, id })}\n`).join(""),
            );
            const path = assignmentPath(keyring.root);
            const fd = privateFileFd(
              path,
              assignmentMaxBytes(keyring.limits),
              "unsafe opaque assignments",
              true,
            );
            try {
              const size = fs.fstatSync(fd).size;
              if (size + data.length > assignmentMaxBytes(keyring.limits))
                keyError("assignment limit reached");
              writeAll(fd, data, size, keyError);
              fs.fsyncSync(fd);
            } finally {
              fs.closeSync(fd);
            }
          }
          return loadKeyring(keyring.root, keyring.limits, keyring);
        } finally {
          finish();
        }
      },
      rollback: finish,
    };
  } catch (error) {
    if (!settled) release();
    throw error;
  }
}

export function opaqueAliases(current: OpaqueKeyring, input: OpaqueIdentityInput): string[] {
  const assigned = current.assignments.values.get(lookup(current.indexKey, input));
  const derived = [current.activeKey, ...current.retiredKeys].map((key) => derive(key, input));
  return [...new Set(assigned ? [assigned, ...derived] : derived)];
}

export function rotateOpaqueKeyring(current: OpaqueKeyring): OpaqueKeyring {
  const release = acquire(current.root);
  try {
    const observed = loadKeyring(current.root, current.limits, current);
    const retired = [observed.activeKey, ...observed.retiredKeys]
      .slice(0, observed.limits.maxRetiredKeys)
      .map((key) => key.toString("base64url"));
    writePrivate(
      observed.root,
      join(observed.root, HISTORY_FILE),
      Buffer.from(`${JSON.stringify(retired)}\n`),
      Math.max(2, observed.limits.maxRetiredKeys * 64),
    );
    writePrivate(observed.root, join(observed.root, KEY_FILE), randomBytes(KEY_BYTES), KEY_BYTES);
    return loadKeyring(observed.root, observed.limits, observed);
  } finally {
    release();
  }
}
