import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { join, relative, resolve } from "node:path";
import lockfile from "proper-lockfile";
import type { ArtifactRegistry, RebuildableArtifactRegistry } from "./artifacts.js";
import {
  type JournalCursor,
  type JournalRefresh,
  appendCursor,
  auditJournal,
  refreshJournal,
  writeFully,
} from "./journal-cursor.js";
import { TRACE_LIMITS } from "./limits.js";
import { assertNoSymlinkPathComponents } from "./path-safety.js";
import { projectPublicStoredTrace } from "./project.js";
import type {
  InternalTraceStoreRecord,
  PublicStoredTraceEvent,
  StoredTraceEvent,
  TraceAppendInput,
  TraceCorrelation,
} from "./types.js";
import { fail, validGenerated, validInput } from "./validation.js";

export class TraceIdempotencyConflictError extends Error {}
export interface TraceStoreOptions {
  dir: string;
  artifactRegistry?: ArtifactRegistry;
  mirror?: { mirrorTrace(event: PublicStoredTraceEvent): void };
  now?: () => string;
  eventId?: () => string;
}
export interface TraceStore {
  readConversation(id: string): Promise<InternalTraceStoreRecord[]>;
  append(
    correlation: TraceCorrelation,
    input: TraceAppendInput,
    native?: string | null,
  ): Promise<StoredTraceEvent>;
}

const inputBytes = (input: TraceAppendInput) =>
  JSON.stringify({ idempotency_key: input.idempotency_key, event: input.event });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const expectedOwner = (): number | undefined =>
  typeof process.geteuid === "function" ? process.geteuid() : undefined;
const ownerMatches = (stat: fs.Stats): boolean =>
  expectedOwner() === undefined || stat.uid === expectedOwner();

export function traceJournalPath(dir: string, id: string): string {
  return join(
    resolve(dir),
    "conversations",
    `${createHash("sha256").update("v1-trace-conversation\0").update(id).digest("hex")}.jsonl`,
  );
}

export const TraceStore: new (options: TraceStoreOptions) => TraceStore = class TraceStore {
  private readonly cursors = new Map<string, JournalCursor>();

  constructor(
    private readonly options: TraceStoreOptions,
    private readonly root: string = "",
  ) {
    const requested = assertNoSymlinkPathComponents(resolve(options.dir), fail);
    this.ensureDirectory(requested, resolve(requested, ".."), false);
    this.root = fs.realpathSync(requested);
  }
  private directoryFd(path: string, privateMode = true): number {
    let fd: number;
    try {
      fd = fs.openSync(
        path,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
      );
    } catch {
      return fail("unsafe directory");
    }
    try {
      const opened = fs.fstatSync(fd);
      const entry = fs.lstatSync(path);
      if (
        !opened.isDirectory() ||
        entry.isSymbolicLink() ||
        !entry.isDirectory() ||
        !ownerMatches(opened) ||
        !ownerMatches(entry) ||
        (privateMode && (opened.mode & 0o777) !== 0o700) ||
        opened.dev !== entry.dev ||
        opened.ino !== entry.ino
      )
        fail("unsafe directory");
      return fd;
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }
  private ensureDirectory(path: string, parent: string, privateParent = true): void {
    const canonical = assertNoSymlinkPathComponents(path, fail);
    try {
      fs.mkdirSync(canonical, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const fd = this.directoryFd(canonical);
    fs.closeSync(fd);
    assertNoSymlinkPathComponents(canonical, fail);
    const parentFd = this.directoryFd(parent, privateParent);
    try {
      fs.fsyncSync(parentFd);
    } finally {
      fs.closeSync(parentFd);
    }
  }
  private path(id: string): string {
    if (!id) fail("conversation id");
    const directory = join(this.root, "conversations");
    this.ensureDirectory(directory, this.root);
    if (relative(this.root, fs.realpathSync(directory)).startsWith(".."))
      fail("unsafe conversations");
    return traceJournalPath(this.root, id);
  }
  private fd(path: string): number {
    const flags =
      fs.constants.O_RDWR |
      fs.constants.O_NOFOLLOW |
      (fs.constants.O_NONBLOCK === undefined ? 0 : fs.constants.O_NONBLOCK);
    let fd: number;
    try {
      fd = fs.openSync(path, flags);
    } catch {
      return fail("unsafe journal");
    }
    try {
      const stat = fs.fstatSync(fd);
      const entry = fs.lstatSync(path);
      if (
        !stat.isFile() ||
        entry.isSymbolicLink() ||
        !entry.isFile() ||
        !ownerMatches(stat) ||
        !ownerMatches(entry) ||
        stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.dev !== entry.dev ||
        stat.ino !== entry.ino
      )
        fail("unsafe journal");
      return fd;
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }
  private create(path: string): boolean {
    let fd: number;
    try {
      fd = fs.openSync(
        path,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false;
    }
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const directoryFd = this.directoryFd(resolve(path, ".."));
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
    return true;
  }
  private async withLockedJournal<T>(id: string, action: (fd: number) => T): Promise<T> {
    const path = this.path(id);
    const created = this.create(path);
    let release: (() => Promise<void>) | undefined;
    let fd: number | undefined;
    try {
      release = await lockfile.lock(path, {
        realpath: false,
        retries: { retries: 100, factor: 1, minTimeout: 50, maxTimeout: 50 },
      });
      fd = this.fd(path);
      if (!created) {
        fs.fsyncSync(fd);
        const directoryFd = this.directoryFd(resolve(path, ".."));
        try {
          fs.fsyncSync(directoryFd);
        } finally {
          fs.closeSync(directoryFd);
        }
      }
      return action(fd);
    } finally {
      try {
        if (fd !== undefined) fs.closeSync(fd);
      } finally {
        if (release) await release();
      }
    }
  }
  private syncRegistry(id: string, refresh: JournalRefresh): void {
    const registry = this.options.artifactRegistry as Partial<RebuildableArtifactRegistry>;
    if (typeof registry?.rebuild !== "function") return;
    if (refresh.rebuilt) {
      if (typeof registry.rebuildConversation === "function")
        registry.rebuildConversation(id, refresh.cursor.records);
      else registry.rebuild(refresh.cursor.records);
    } else if (refresh.additions.length) {
      if (typeof registry.index === "function") registry.index(refresh.additions);
      else registry.rebuild(refresh.cursor.records);
    }
  }
  private indexRecord(record: InternalTraceStoreRecord): void {
    const registry = this.options.artifactRegistry as Partial<RebuildableArtifactRegistry>;
    if (typeof registry?.rebuild !== "function") return;
    if (typeof registry.index === "function") registry.index([record]);
    else registry.rebuild([record]);
  }
  async readConversation(id: string): Promise<InternalTraceStoreRecord[]> {
    return this.withLockedJournal(id, (fd) => {
      const cursor = auditJournal(fd, false, id);
      this.cursors.set(id, cursor);
      this.syncRegistry(id, { cursor, rebuilt: true, additions: [] });
      return clone(cursor.records);
    });
  }
  async append(
    correlation: TraceCorrelation,
    input: TraceAppendInput,
    native: string | null = null,
  ): Promise<StoredTraceEvent> {
    if (!validInput(correlation, input, native)) fail("invalid input");
    let capturedCorrelation: TraceCorrelation;
    let capturedInput: TraceAppendInput;
    let capturedBytes: string;
    try {
      capturedCorrelation = JSON.parse(JSON.stringify(correlation));
      capturedBytes = inputBytes(input);
      capturedInput = JSON.parse(capturedBytes);
    } catch {
      return fail("invalid input");
    }
    if (!validInput(capturedCorrelation, capturedInput, native)) fail("invalid input");
    const nativeSessionId = native;
    return this.withLockedJournal(capturedCorrelation.conversation_id, (fd) => {
      const refresh = refreshJournal(
        fd,
        true,
        capturedCorrelation.conversation_id,
        this.cursors.get(capturedCorrelation.conversation_id),
      );
      const cursor = refresh.cursor;
      this.cursors.set(capturedCorrelation.conversation_id, cursor);
      this.syncRegistry(capturedCorrelation.conversation_id, refresh);
      const old = cursor.idempotency.get(capturedInput.idempotency_key);
      if (old) {
        if (
          inputBytes({
            idempotency_key: old.stored_event.idempotency_key,
            event: old.stored_event.event,
          }) === capturedBytes
        )
          return clone(old.stored_event);
        throw new TraceIdempotencyConflictError("idempotency key conflict");
      }
      const event_id = this.options.eventId?.() ?? randomUUID();
      const ts = this.options.now?.() ?? new Date().toISOString();
      if (!validGenerated(event_id, ts) || cursor.eventIds.has(event_id))
        fail("invalid generated value");
      const stored_event = {
        ...capturedCorrelation,
        event_id,
        seq: cursor.records.length + 1,
        ts,
        idempotency_key: capturedInput.idempotency_key,
        event: capturedInput.event,
      };
      const record = { stored_event, native_session_id: nativeSessionId };
      const encodedRecord = Buffer.from(JSON.stringify(record));
      if (encodedRecord.length > TRACE_LIMITS.maxRecordBytes) fail("record too large");
      const separator = cursor.size && cursor.lastByte !== 10 ? "\n" : "";
      const encoded = Buffer.concat([Buffer.from(separator), encodedRecord, Buffer.from("\n")]);
      if (cursor.size + encoded.length > TRACE_LIMITS.maxJournalBytes) fail("journal too large");
      const registry = this.options.artifactRegistry as Partial<RebuildableArtifactRegistry>;
      const prepared = registry?.prepare?.([record]);
      try {
        writeFully(fd, encoded, cursor.size);
        fs.fsyncSync(fd);
      } catch (error) {
        prepared?.rollback();
        throw error;
      }
      prepared?.commit();
      appendCursor(fd, cursor, clone(record), encoded);
      try {
        if (!prepared) this.indexRecord(record);
        const projected = projectPublicStoredTrace(record, {
          conversationId: capturedCorrelation.conversation_id,
          artifactRegistry: this.options.artifactRegistry,
        });
        this.options.mirror?.mirrorTrace(projected);
      } catch {
        return stored_event;
      }
      return stored_event;
    });
  }
};
