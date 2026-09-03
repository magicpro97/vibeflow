import {
  constants,
  type Stats,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import lockfile from "proper-lockfile";
import {
  type CapturedTraceAppendV1,
  TraceIdempotencyConflictError,
  TraceRequestedEventConflictError,
  planTraceAppend,
  traceInputBytes,
} from "./append-planner.js";
import type { RebuildableArtifactRegistry } from "./artifacts.js";
import {
  type JournalCursor,
  type JournalRefresh,
  appendCursorBatch,
  auditJournal,
  refreshJournal,
  writeFully,
} from "./journal-cursor.js";
import { TraceLifecycleConflictError, assertCanonicalLifecycleAppend } from "./lifecycle-cas.js";
import { TRACE_LIMITS } from "./limits.js";
import { assertNoSymlinkPathComponents } from "./path-safety.js";
import { projectPublicStoredTrace } from "./project.js";
import { settleDurableRegistry } from "./registry-settlement.js";
import type {
  TraceBatchAppend,
  TraceRequestedEventAppendV1,
  TraceStore as TraceStoreContract,
  TraceStoreOptions,
} from "./store-contract.js";
import { traceJournalPath } from "./trace-journal-path.js";
import type {
  InternalTraceStoreRecord,
  StoredTraceEvent,
  TraceAppendInput,
  TraceCorrelation,
} from "./types.js";
import { fail, validInput } from "./validation.js";
export type {
  TraceBatchAppend,
  TraceRequestedEventAppendV1,
  TraceStoreOptions,
} from "./store-contract.js";
export { traceJournalPath } from "./trace-journal-path.js";
export { TraceIdempotencyConflictError, TraceRequestedEventConflictError };
export class TraceHeadConflictError extends Error {}
export { TraceLifecycleConflictError };
export interface TraceStore extends TraceStoreContract {}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const expectedOwner = (): number | undefined =>
  typeof process.geteuid === "function" ? process.geteuid() : undefined;
const ownerMatches = (stat: Stats): boolean =>
  expectedOwner() === undefined || stat.uid === expectedOwner();
export const TraceStore: new (options: TraceStoreOptions) => TraceStoreContract = class TraceStore {
  private readonly cursors = new Map<string, JournalCursor>();
  private requestedEventAuthority: ((input: TraceRequestedEventAppendV1) => void) | undefined;
  constructor(
    private readonly options: TraceStoreOptions,
    private readonly root: string = "",
  ) {
    const requested = assertNoSymlinkPathComponents(resolve(options.dir), fail);
    this.ensureDirectory(requested, resolve(requested, ".."), false);
    this.root = realpathSync(requested);
  }
  private directoryFd(path: string, privateMode = true): number {
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch {
      return fail("unsafe directory");
    }
    try {
      const opened = fstatSync(fd);
      const entry = lstatSync(path);
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
      closeSync(fd);
      throw error;
    }
  }
  private ensureDirectory(path: string, parent: string, privateParent = true): void {
    const canonical = assertNoSymlinkPathComponents(path, fail);
    try {
      mkdirSync(canonical, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const fd = this.directoryFd(canonical);
    closeSync(fd);
    assertNoSymlinkPathComponents(canonical, fail);
    const parentFd = this.directoryFd(parent, privateParent);
    try {
      fsyncSync(parentFd);
    } finally {
      closeSync(parentFd);
    }
  }
  private path(id: string): string {
    if (!id) fail("conversation id");
    const directory = join(this.root, "conversations");
    this.ensureDirectory(directory, this.root);
    if (relative(this.root, realpathSync(directory)).startsWith("..")) fail("unsafe conversations");
    return traceJournalPath(this.root, id);
  }
  private fd(path: string): number {
    const flags =
      constants.O_RDWR |
      constants.O_NOFOLLOW |
      (constants.O_NONBLOCK === undefined ? 0 : constants.O_NONBLOCK);
    let fd: number;
    try {
      fd = openSync(path, flags);
    } catch {
      return fail("unsafe journal");
    }
    try {
      const stat = fstatSync(fd);
      const entry = lstatSync(path);
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
      closeSync(fd);
      throw error;
    }
  }
  private create(path: string): boolean {
    let fd: number;
    try {
      fd = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false;
    }
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const directoryFd = this.directoryFd(resolve(path, ".."));
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
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
        fsyncSync(fd);
        const directoryFd = this.directoryFd(resolve(path, ".."));
        try {
          fsyncSync(directoryFd);
        } finally {
          closeSync(directoryFd);
        }
      }
      return action(fd);
    } finally {
      try {
        if (fd !== undefined) closeSync(fd);
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
  async recoverConversation(id: string): Promise<InternalTraceStoreRecord[]> {
    return this.withLockedJournal(id, (fd) => {
      const cursor = auditJournal(fd, true, id);
      this.cursors.set(id, cursor);
      this.syncRegistry(id, { cursor, rebuilt: true, additions: [] });
      return clone(cursor.records);
    });
  }
  async append(
    correlation: TraceCorrelation,
    input: TraceAppendInput,
    native: string | null = null,
    expectedLastSeq?: number,
  ): Promise<StoredTraceEvent> {
    const stored = await this.appendBatch([{ correlation, input, native }], expectedLastSeq);
    return stored[0] ?? fail("invalid batch result");
  }

  bindRequestedEventAuthority(validate: (input: TraceRequestedEventAppendV1) => void): void {
    if (this.requestedEventAuthority && this.requestedEventAuthority !== validate)
      throw new Error("trace requested event authority is already bound");
    this.requestedEventAuthority = validate;
  }

  async appendRequestedEvent(
    correlation: TraceCorrelation,
    input: TraceAppendInput,
    requestedEventId: string,
    native: string | null = null,
    expectedLastSeq?: number,
  ): Promise<StoredTraceEvent> {
    const validate = this.requestedEventAuthority;
    if (!validate) throw new Error("trace requested event authority is absent");
    validate({ correlation, input, native, requested_event_id: requestedEventId });
    const stored = await this.appendBatchInternal(
      [{ correlation, input, native }],
      expectedLastSeq,
      [requestedEventId],
    );
    return stored[0] ?? fail("invalid requested event result");
  }

  async appendBatch(
    entries: readonly TraceBatchAppend[],
    expectedLastSeq?: number,
  ): Promise<StoredTraceEvent[]> {
    return this.appendBatchInternal(entries, expectedLastSeq);
  }

  private async appendBatchInternal(
    entries: readonly TraceBatchAppend[],
    expectedLastSeq?: number,
    requestedEventIds?: readonly string[],
  ): Promise<StoredTraceEvent[]> {
    if (!entries.length || entries.length > 64) fail("invalid batch");
    if (requestedEventIds && requestedEventIds.length !== entries.length) fail("invalid batch");
    let captured: CapturedTraceAppendV1[];
    try {
      if (
        entries.some(
          (entry) =>
            !entry ||
            !validInput(
              entry.correlation,
              entry.input,
              entry.native === undefined ? null : entry.native,
            ),
        )
      )
        return fail("invalid input");
      captured = entries.map(({ correlation, input, native = null }) => {
        const bytes = traceInputBytes(input);
        return {
          correlation: JSON.parse(JSON.stringify(correlation)),
          input: JSON.parse(bytes),
          native,
          bytes,
        };
      });
    } catch {
      return fail("invalid input");
    }
    const first = captured[0];
    if (!first) return fail("invalid batch");
    const conversationId = first.correlation.conversation_id;
    if (
      !conversationId ||
      captured.some(
        ({ correlation, input, native }) =>
          correlation.conversation_id !== conversationId || !validInput(correlation, input, native),
      )
    )
      fail("invalid input");
    return this.withLockedJournal(conversationId, (fd) => {
      const refresh = refreshJournal(fd, true, conversationId, this.cursors.get(conversationId));
      const cursor = refresh.cursor;
      if (expectedLastSeq !== undefined && cursor.records.length !== expectedLastSeq)
        throw new TraceHeadConflictError("trace journal head changed");
      this.cursors.set(conversationId, cursor);
      this.syncRegistry(conversationId, refresh);
      const { output, records } = planTraceAppend({
        captured,
        durable: cursor.records,
        idempotency: cursor.idempotency,
        ...(requestedEventIds ? { requestedEventIds } : {}),
        ...(this.options.eventId ? { eventId: this.options.eventId } : {}),
        ...(this.options.now ? { now: this.options.now } : {}),
      });
      if (!records.length) return output;
      assertCanonicalLifecycleAppend(cursor.records, records);
      if (records.length > 1) {
        const batchId = records[0]?.stored_event.event_id as string;
        records.forEach((record, batchIndex) => {
          record.batch_id = batchId;
          record.batch_index = batchIndex;
          record.batch_size = records.length;
        });
      }
      const encoded = records.map((record, index) => {
        const body = Buffer.from(JSON.stringify(record));
        if (body.length > TRACE_LIMITS.maxRecordBytes) fail("record too large");
        const separator = index === 0 && cursor.size && cursor.lastByte !== 10 ? "\n" : "";
        return Buffer.concat([Buffer.from(separator), body, Buffer.from("\n")]);
      });
      const batch = Buffer.concat(encoded);
      if (cursor.size + batch.length > TRACE_LIMITS.maxJournalBytes) fail("journal too large");
      const appended = records.map((record) => clone(record));
      const durableRecords = [...cursor.records, ...appended];
      const registry = this.options.artifactRegistry as Partial<RebuildableArtifactRegistry>;
      const prepared = registry?.prepare?.(records);
      try {
        writeFully(fd, batch, cursor.size);
        fsyncSync(fd);
      } catch (error) {
        prepared?.rollback();
        throw error;
      }
      if (!appendCursorBatch(fd, cursor, appended, encoded)) {
        this.cursors.delete(conversationId);
      }
      settleDurableRegistry(prepared, registry, conversationId, durableRecords);
      for (const record of records) {
        try {
          if (!prepared) this.indexRecord(record);
          const projected = projectPublicStoredTrace(record, {
            conversationId,
            artifactRegistry: this.options.artifactRegistry,
          });
          this.options.mirror?.mirrorTrace(projected);
        } catch (error) {
          void error;
        }
      }
      return output;
    });
  }
};
