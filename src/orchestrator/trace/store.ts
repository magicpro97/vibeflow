import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { join, relative, resolve } from "node:path";
import lockfile from "proper-lockfile";
import type {
  InternalTraceStoreRecord,
  StoredTraceEvent,
  TraceAppendInput,
  TraceCorrelation,
} from "./types.js";
import { decodeRecord, fail, validGenerated, validInput, validReplayEvent } from "./validation.js";

export class TraceIdempotencyConflictError extends Error {}
export interface TraceStoreOptions {
  dir: string;
  mirror?: { mirrorTrace(event: StoredTraceEvent): void };
  now?: () => string;
  eventId?: () => string;
}

const decodeText = (buffer: Buffer): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return fail("invalid encoding");
  }
};

const readFully = (fd: number): Buffer => {
  const buffer = Buffer.alloc(fs.fstatSync(fd).size);
  for (let offset = 0; offset < buffer.length; ) {
    const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
    if (count <= 0) fail("short read");
    offset += count;
  }
  return buffer;
};
const writeFully = (fd: number, buffer: Buffer, position: number): void => {
  for (let offset = 0; offset < buffer.length; ) {
    const count = fs.writeSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (count <= 0) fail("short write");
    offset += count;
  }
};

const replay = (
  fd: number,
  recover: boolean,
  conversationId: string,
): InternalTraceStoreRecord[] => {
  const buffer = readFully(fd);
  let end = buffer.length;
  const newline = buffer.lastIndexOf(10);
  if (buffer.length && newline !== buffer.length - 1) {
    try {
      JSON.parse(decodeText(buffer.subarray(newline + 1)));
    } catch {
      if (!recover) fail("unterminated record");
      end = newline + 1;
    }
  }
  const text = decodeText(buffer.subarray(0, end));
  const lines = text ? text.replace(/\n$/, "").split("\n") : [];
  const records = lines.map(decodeRecord);
  const ids = new Set<string>();
  const keys = new Set<string>();
  records.forEach(({ stored_event: event }, index) => {
    if (
      !validReplayEvent(event, conversationId, index + 1) ||
      ids.has(event.event_id) ||
      keys.has(event.idempotency_key)
    )
      fail("invalid record");
    ids.add(event.event_id);
    keys.add(event.idempotency_key);
  });
  if (recover && end !== buffer.length) {
    fs.ftruncateSync(fd, end);
    fs.fsyncSync(fd);
  }
  return records;
};
const bytes = (input: TraceAppendInput) =>
  JSON.stringify({ idempotency_key: input.idempotency_key, event: input.event });
export function traceJournalPath(dir: string, id: string): string {
  return join(
    resolve(dir),
    "conversations",
    `${createHash("sha256").update("v1-trace-conversation\0").update(id).digest("hex")}.jsonl`,
  );
}

export const TraceStore = class TraceStore {
  constructor(options: TraceStoreOptions);
  constructor(
    private readonly options: TraceStoreOptions,
    private readonly root: string = "",
  ) {
    const requested = resolve(options.dir);
    this.ensureDirectory(requested, resolve(requested, ".."), false);
    this.root = fs.realpathSync(requested);
  }
  private directoryFd(path: string, privateMode = true): number {
    const fd = fs.openSync(
      path,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    try {
      const opened = fs.fstatSync(fd);
      const entry = fs.lstatSync(path);
      if (
        !opened.isDirectory() ||
        entry.isSymbolicLink() ||
        !entry.isDirectory() ||
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
    try {
      fs.mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const fd = this.directoryFd(path);
    fs.closeSync(fd);
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
    const fd = fs.openSync(path, flags);
    try {
      const stat = fs.fstatSync(fd);
      const entry = fs.lstatSync(path);
      if (
        !stat.isFile() ||
        entry.isSymbolicLink() ||
        !entry.isFile() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.dev !== entry.dev ||
        stat.ino !== entry.ino
      ) {
        fail("unsafe journal");
      }
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
  async readConversation(id: string): Promise<InternalTraceStoreRecord[]> {
    return this.withLockedJournal(id, (fd) => replay(fd, false, id));
  }
  async append(
    correlation: TraceCorrelation,
    input: TraceAppendInput,
    native: string | null = null,
  ): Promise<StoredTraceEvent> {
    if (!validInput(correlation, input, native)) fail("invalid input");
    let capturedCorrelation: TraceCorrelation;
    let capturedInput: TraceAppendInput;
    let inputBytes: string;
    try {
      capturedCorrelation = JSON.parse(JSON.stringify(correlation));
      inputBytes = JSON.stringify({ idempotency_key: input.idempotency_key, event: input.event });
      capturedInput = JSON.parse(inputBytes);
    } catch {
      return fail("invalid input");
    }
    if (!validInput(capturedCorrelation, capturedInput, native)) fail("invalid input");
    const nativeSessionId = native;
    return this.withLockedJournal(capturedCorrelation.conversation_id, (fd) => {
      const records = replay(fd, true, capturedCorrelation.conversation_id);
      const old = records.find(
        (record) => record.stored_event.idempotency_key === capturedInput.idempotency_key,
      );
      if (old) {
        if (
          bytes({
            idempotency_key: old.stored_event.idempotency_key,
            event: old.stored_event.event,
          }) === inputBytes
        )
          return old.stored_event;
        throw new TraceIdempotencyConflictError("idempotency key conflict");
      }
      const event_id = this.options.eventId?.() ?? randomUUID();
      const ts = this.options.now?.() ?? new Date().toISOString();
      if (
        !validGenerated(event_id, ts) ||
        records.some((record) => record.stored_event.event_id === event_id)
      )
        fail("invalid generated value");
      const stored_event = {
        ...capturedCorrelation,
        event_id,
        seq: records.length + 1,
        ts,
        idempotency_key: capturedInput.idempotency_key,
        event: capturedInput.event,
      };
      const stat = fs.fstatSync(fd);
      const last = Buffer.alloc(1);
      if (stat.size && fs.readSync(fd, last, 0, 1, stat.size - 1) !== 1) fail("short read");
      const separator = stat.size && last[0] !== 10 ? "\n" : "";
      writeFully(
        fd,
        Buffer.from(
          `${separator}${JSON.stringify({ stored_event, native_session_id: nativeSessionId })}\n`,
        ),
        stat.size,
      );
      fs.fsyncSync(fd);
      try {
        this.options.mirror?.mirrorTrace(JSON.parse(JSON.stringify(stored_event)));
      } catch {
        return stored_event;
      }
      return stored_event;
    });
  }
};

export type TraceStore = InstanceType<typeof TraceStore>;
