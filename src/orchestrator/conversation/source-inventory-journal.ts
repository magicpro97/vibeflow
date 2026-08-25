import * as fs from "node:fs";
import { auditJournal } from "../trace/journal-cursor.js";
import type { InternalTraceStoreRecord } from "../trace/types.js";
import {
  type PrivateFileSnapshotV1,
  assertPrivateFileSnapshot,
  tryOpenPrivateFileReadOnlyAt,
} from "./catalog-read-safety.js";

export const MAX_CONVERSATION_JOURNAL_BYTES = 16 * 1024 * 1024;
const MAX_STABLE_JOURNAL_READS = 8;

export function readStableConversationJournal(
  initialSnapshot: PrivateFileSnapshotV1,
  conversationId: string,
): { bytesLength: number; records: InternalTraceStoreRecord[] } {
  let snapshot = initialSnapshot;
  for (let attempt = 0; attempt < MAX_STABLE_JOURNAL_READS; attempt += 1) {
    let result: { bytesLength: number; records: InternalTraceStoreRecord[] } | null = null;
    let failure: unknown;
    try {
      const records = auditJournal(snapshot.fd, false, conversationId).records;
      assertPrivateFileSnapshot(snapshot);
      result = { bytesLength: snapshot.size, records };
    } catch (error) {
      failure = error;
    }
    if (result) {
      fs.closeSync(snapshot.fd);
      return result;
    }
    let next: PrivateFileSnapshotV1 | null = null;
    try {
      next = tryOpenPrivateFileReadOnlyAt(
        snapshot.directory,
        snapshot.name,
        MAX_CONVERSATION_JOURNAL_BYTES,
        true,
      );
    } catch {
      fs.closeSync(snapshot.fd);
      throw failure;
    }
    if (
      !next ||
      next.dev !== snapshot.dev ||
      next.ino !== snapshot.ino ||
      next.size <= snapshot.size ||
      attempt + 1 >= MAX_STABLE_JOURNAL_READS
    ) {
      fs.closeSync(snapshot.fd);
      if (next) fs.closeSync(next.fd);
      throw failure;
    }
    fs.closeSync(snapshot.fd);
    snapshot = next;
  }
  throw new Error("journal changed during every bounded read");
}
