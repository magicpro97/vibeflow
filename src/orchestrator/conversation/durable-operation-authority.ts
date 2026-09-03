import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import {
  createPrivateAtomic,
  ensurePrivateDirectory,
  openPrivateFile,
  safeEntry,
} from "../trace/path-safety.js";

const MAX_AUTHORITY_BYTES = 16 * 1024;
const MAX_REFERENCE_BYTES = 4 * 1024;
const fail = (message: string): never => {
  throw new Error(message);
};
const reference = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  Buffer.byteLength(value, "utf8") <= MAX_REFERENCE_BYTES &&
  !/\p{Cc}/u.test(value);

interface DurableOperationAuthority {
  version: 1;
  operation_id: string;
  conversation_id: string;
}

interface DurableCancellationClaim extends DurableOperationAuthority {
  state: "cancelled";
}

export interface OperationCancellationAuthority {
  readonly scopeKey: string;
  commitCancellation(conversationId: string, operationId: string): boolean;
  isCancellationClaimed(conversationId: string, operationId: string): boolean;
  owner?(operationId: string): string | null;
}

export function conversationManifestPath(dir: string, conversationId: string): string {
  if (!reference(conversationId)) throw new Error("invalid conversation identity");
  const name = createHash("sha256")
    .update("v1-conversation-manifest\0")
    .update(conversationId)
    .digest("hex");
  return join(resolve(dir), `${name}.json`);
}

export function operationAuthorityPath(dir: string, operationId: string): string {
  return join(resolve(dir), "operation-authorities", operationAuthorityName(operationId));
}

const operationAuthorityName = (operationId: string): string => {
  if (!reference(operationId)) throw new Error("invalid operation identity");
  const name = createHash("sha256")
    .update("v1-conversation-operation\0")
    .update(operationId)
    .digest("hex");
  return `${name}.json`;
};

/** O(1) durable operation owner lookup; files are immutable once atomically claimed. */
export class DurableOperationAuthorityIndex {
  private readonly artifactRoot: string;
  private readonly root: string;
  private readonly cancellationRoot: string;
  readonly scopeKey: string;

  constructor(root: string) {
    this.artifactRoot = ensurePrivateDirectory(root, fail);
    this.root = ensurePrivateDirectory(join(this.artifactRoot, "operation-authorities"), fail);
    this.cancellationRoot = ensurePrivateDirectory(
      join(this.artifactRoot, "operation-cancellations"),
      fail,
    );
    this.scopeKey = createHash("sha256")
      .update("v1-operation-authority-scope\0")
      .update(this.artifactRoot)
      .digest("hex");
  }

  private name(operationId: string): string {
    return operationAuthorityName(operationId);
  }

  private read(operationId: string): DurableOperationAuthority | null {
    const path = join(this.root, this.name(operationId));
    if (!safeEntry(path, fail, "unsafe operation authority")) return null;
    const fd = openPrivateFile(path, MAX_AUTHORITY_BYTES, fail, "unsafe operation authority");
    try {
      const opened = fs.fstatSync(fd);
      const observed = fs.lstatSync(path);
      const data = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < data.length) {
        const count = fs.readSync(fd, data, offset, data.length - offset, offset);
        if (count <= 0) fail("unsafe operation authority");
        offset += count;
      }
      const after = fs.fstatSync(fd);
      const current = fs.lstatSync(path);
      if (
        opened.dev !== after.dev ||
        opened.ino !== after.ino ||
        opened.size !== after.size ||
        opened.mtimeMs !== after.mtimeMs ||
        observed.dev !== current.dev ||
        observed.ino !== current.ino
      )
        fail("unsafe operation authority");
      let decoded: unknown;
      try {
        decoded = JSON.parse(data.toString("utf8"));
      } catch {
        return fail("invalid operation authority");
      }
      if (
        !decoded ||
        typeof decoded !== "object" ||
        Array.isArray(decoded) ||
        Object.getPrototypeOf(decoded) !== Object.prototype ||
        Object.keys(decoded).sort().join(",") !== "conversation_id,operation_id,version" ||
        (decoded as Record<string, unknown>).version !== 1 ||
        !reference((decoded as Record<string, unknown>).conversation_id) ||
        (decoded as Record<string, unknown>).operation_id !== operationId
      )
        fail("invalid operation authority");
      return decoded as DurableOperationAuthority;
    } finally {
      fs.closeSync(fd);
    }
  }

  private cancellationName(operationId: string): string {
    return this.name(operationId).replace(/\.json$/, ".cancel.json");
  }

  private readCancellation(operationId: string): DurableCancellationClaim | null {
    const path = join(this.cancellationRoot, this.cancellationName(operationId));
    if (!safeEntry(path, fail, "unsafe cancellation authority")) return null;
    const fd = openPrivateFile(path, MAX_AUTHORITY_BYTES, fail, "unsafe cancellation authority");
    try {
      const opened = fs.fstatSync(fd);
      const observed = fs.lstatSync(path);
      const data = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < data.length) {
        const count = fs.readSync(fd, data, offset, data.length - offset, offset);
        if (count <= 0) fail("unsafe cancellation authority");
        offset += count;
      }
      const after = fs.fstatSync(fd);
      const current = fs.lstatSync(path);
      if (
        opened.dev !== after.dev ||
        opened.ino !== after.ino ||
        opened.size !== after.size ||
        opened.mtimeMs !== after.mtimeMs ||
        observed.dev !== current.dev ||
        observed.ino !== current.ino
      )
        fail("unsafe cancellation authority");
      let decoded: unknown;
      try {
        decoded = JSON.parse(data.toString("utf8"));
      } catch {
        return fail("invalid cancellation authority");
      }
      if (
        !decoded ||
        typeof decoded !== "object" ||
        Array.isArray(decoded) ||
        Object.getPrototypeOf(decoded) !== Object.prototype ||
        Object.keys(decoded).sort().join(",") !== "conversation_id,operation_id,state,version" ||
        (decoded as Record<string, unknown>).version !== 1 ||
        !reference((decoded as Record<string, unknown>).conversation_id) ||
        (decoded as Record<string, unknown>).operation_id !== operationId ||
        (decoded as Record<string, unknown>).state !== "cancelled"
      )
        fail("invalid cancellation authority");
      return decoded as DurableCancellationClaim;
    } finally {
      fs.closeSync(fd);
    }
  }

  private withLock<T>(action: () => T): T {
    const release = lockfile.lockSync(this.artifactRoot, { realpath: false });
    try {
      return action();
    } finally {
      release();
    }
  }

  owner(operationId: string): string | null {
    return this.read(operationId)?.conversation_id ?? null;
  }

  claim(conversationId: string, operationId: string): void {
    if (!reference(conversationId)) throw new Error("invalid conversation identity");
    const prior = this.read(operationId);
    if (prior) {
      if (prior.conversation_id !== conversationId)
        throw new Error("durable operation authority conflict");
      return;
    }
    const authority: DurableOperationAuthority = {
      version: 1,
      operation_id: operationId,
      conversation_id: conversationId,
    };
    createPrivateAtomic(
      this.root,
      this.name(operationId),
      Buffer.from(JSON.stringify(authority)),
      fail,
    );
    const stored = this.read(operationId);
    if (stored?.conversation_id !== conversationId) fail("durable operation authority conflict");
  }

  commitCancellation(conversationId: string, operationId: string): boolean {
    return this.withLock(() => {
      const owner = this.read(operationId)?.conversation_id;
      if (!owner) fail("operation authority missing");
      if (owner !== conversationId) fail("cancellation authority conflict");
      const prior = this.readCancellation(operationId);
      if (prior) {
        if (prior.conversation_id !== conversationId) fail("cancellation authority conflict");
        return false;
      }
      const claim: DurableCancellationClaim = {
        version: 1,
        operation_id: operationId,
        conversation_id: conversationId,
        state: "cancelled",
      };
      createPrivateAtomic(
        this.cancellationRoot,
        this.cancellationName(operationId),
        Buffer.from(JSON.stringify(claim)),
        fail,
      );
      const stored = this.readCancellation(operationId);
      if (stored?.conversation_id !== conversationId) fail("cancellation authority conflict");
      return true;
    });
  }

  isCancellationClaimed(conversationId: string, operationId: string): boolean {
    return this.withLock(() => {
      const stored = this.readCancellation(operationId);
      if (!stored) return false;
      if (stored.conversation_id !== conversationId) fail("cancellation authority conflict");
      return stored.state === "cancelled";
    });
  }
}
