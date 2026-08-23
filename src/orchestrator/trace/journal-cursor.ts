import * as fs from "node:fs";
import { TRACE_LIMITS } from "./limits.js";
import type { InternalTraceStoreRecord } from "./types.js";
import { decodeRecord, fail, validReplayEvent } from "./validation.js";

const TAIL_BYTES = 512;

export interface JournalCursor {
  readonly records: InternalTraceStoreRecord[];
  readonly eventIds: Set<string>;
  readonly idempotency: Map<string, InternalTraceStoreRecord>;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  tail: Buffer;
  lastByte: number | null;
}

export interface JournalRefresh {
  readonly cursor: JournalCursor;
  readonly rebuilt: boolean;
  readonly additions: readonly InternalTraceStoreRecord[];
}

const decodeText = (buffer: Buffer): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return fail("invalid encoding");
  }
};

const readExact = (fd: number, length: number, position: number): Buffer => {
  const buffer = Buffer.alloc(length);
  for (let offset = 0; offset < length; ) {
    const count = fs.readSync(fd, buffer, offset, length - offset, position + offset);
    if (count <= 0) fail("short read");
    offset += count;
  }
  return buffer;
};

const parseRecords = (
  buffer: Buffer,
  conversationId: string,
  recover: boolean,
): { records: InternalTraceStoreRecord[]; validBytes: number } => {
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
  const body = buffer.subarray(0, end);
  const text = decodeText(body);
  const lines = text ? text.replace(/\n$/, "").split("\n") : [];
  const records = lines.map(decodeRecord);
  records.forEach(({ stored_event: event }, index) => {
    if (!validReplayEvent(event, conversationId, index + 1)) fail("invalid record");
  });
  return { records, validBytes: end };
};

const makeCursor = (
  fd: number,
  records: InternalTraceStoreRecord[],
  tail: Buffer,
): JournalCursor => {
  const stat = fs.fstatSync(fd);
  const eventIds = new Set<string>();
  const idempotency = new Map<string, InternalTraceStoreRecord>();
  for (const record of records) {
    const event = record.stored_event;
    if (eventIds.has(event.event_id) || idempotency.has(event.idempotency_key))
      fail("invalid record");
    eventIds.add(event.event_id);
    idempotency.set(event.idempotency_key, record);
  }
  return {
    records,
    eventIds,
    idempotency,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    tail,
    lastByte: stat.size ? (tail.at(-1) ?? null) : null,
  };
};

function completeBatchPrefix(
  records: readonly InternalTraceStoreRecord[],
  recover: boolean,
): number {
  for (let index = 0; index < records.length; ) {
    const first = records[index] as InternalTraceStoreRecord;
    if (first.batch_id === undefined) {
      index += 1;
      continue;
    }
    const batchSize = first.batch_size;
    if (batchSize === undefined) throw new Error("invalid batch frame");
    if (first.batch_index !== 0) fail("invalid batch frame");
    if (index + batchSize > records.length) {
      if (recover) return index;
      return fail("incomplete batch");
    }
    for (let offset = 0; offset < batchSize; offset++) {
      const record = records[index + offset] as InternalTraceStoreRecord;
      if (
        record.batch_id !== first.batch_id ||
        record.batch_size !== batchSize ||
        record.batch_index !== offset
      )
        fail("invalid batch frame");
    }
    index += batchSize;
  }
  return records.length;
}

function prefixBytes(buffer: Buffer, recordCount: number): number {
  let end = 0;
  for (let index = 0; index < recordCount; index++) {
    const newline = buffer.indexOf(10, end);
    if (newline < 0) return fail("invalid batch boundary");
    end = newline + 1;
  }
  return end;
}

export function auditJournal(fd: number, recover: boolean, conversationId: string): JournalCursor {
  const size = fs.fstatSync(fd).size;
  if (size > TRACE_LIMITS.maxJournalBytes) fail("journal too large");
  const buffer = readExact(fd, size, 0);
  const parsed = parseRecords(buffer, conversationId, recover);
  const completeRecords = completeBatchPrefix(parsed.records, recover);
  const validBytes =
    completeRecords === parsed.records.length
      ? parsed.validBytes
      : prefixBytes(buffer.subarray(0, parsed.validBytes), completeRecords);
  if (recover && validBytes !== size) {
    fs.ftruncateSync(fd, validBytes);
    fs.fsyncSync(fd);
  }
  return makeCursor(
    fd,
    parsed.records.slice(0, completeRecords),
    buffer.subarray(0, validBytes).subarray(-TAIL_BYTES),
  );
}

const unchanged = (cursor: JournalCursor, stat: fs.Stats): boolean =>
  cursor.dev === stat.dev &&
  cursor.ino === stat.ino &&
  cursor.size === stat.size &&
  cursor.mtimeMs === stat.mtimeMs &&
  cursor.ctimeMs === stat.ctimeMs;

export function refreshJournal(
  fd: number,
  recover: boolean,
  conversationId: string,
  previous?: JournalCursor,
): JournalRefresh {
  const stat = fs.fstatSync(fd);
  if (stat.size > TRACE_LIMITS.maxJournalBytes) fail("journal too large");
  if (!previous)
    return { cursor: auditJournal(fd, recover, conversationId), rebuilt: true, additions: [] };
  if (unchanged(previous, stat)) return { cursor: previous, rebuilt: false, additions: [] };
  const externalGrowth =
    stat.dev === previous.dev && stat.ino === previous.ino && stat.size > previous.size;
  if (
    recover &&
    externalGrowth &&
    previous.lastByte !== null &&
    previous.lastByte !== 10 &&
    readExact(fd, 1, previous.size)[0] !== 10
  ) {
    fs.ftruncateSync(fd, previous.size);
    fs.fsyncSync(fd);
  }
  const cursor = auditJournal(fd, recover, conversationId);
  return { cursor, rebuilt: true, additions: [] };
}

export function appendCursor(
  fd: number,
  cursor: JournalCursor,
  record: InternalTraceStoreRecord,
  encoded: Buffer,
): boolean {
  try {
    const stat = fs.fstatSync(fd);
    const tail = Buffer.concat([cursor.tail, encoded]).subarray(-TAIL_BYTES);
    cursor.records.push(record);
    cursor.eventIds.add(record.stored_event.event_id);
    cursor.idempotency.set(record.stored_event.idempotency_key, record);
    cursor.dev = stat.dev;
    cursor.ino = stat.ino;
    cursor.size = stat.size;
    cursor.mtimeMs = stat.mtimeMs;
    cursor.ctimeMs = stat.ctimeMs;
    cursor.tail = tail;
    cursor.lastByte = tail.at(-1) ?? null;
    return true;
  } catch {
    return false;
  }
}

export function appendCursorBatch(
  fd: number,
  cursor: JournalCursor,
  records: readonly InternalTraceStoreRecord[],
  encoded: readonly Buffer[],
): boolean {
  return records.every((record, index) =>
    appendCursor(fd, cursor, record, encoded[index] as Buffer),
  );
}

export function writeFully(fd: number, buffer: Buffer, position: number): void {
  for (let offset = 0; offset < buffer.length; ) {
    const count = fs.writeSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (count <= 0) fail("short write");
    offset += count;
  }
}
