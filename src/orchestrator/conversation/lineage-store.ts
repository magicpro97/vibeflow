import { timingSafeEqual } from "node:crypto";
import { join, resolve } from "node:path";
import {
  acquireProcessLock,
  atomicCompareAndSwap,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestHex,
  digestV1,
  privateFileBytes,
} from "../../durability/index.js";
import type { AtomicCasFaultPoint, ProcessLock } from "../../durability/index.js";
import {
  closePrivateDirectorySnapshot,
  inspectPrivateDirectoryReadOnly,
  readPrivateDirectoryNames,
  readPrivateFileBytesAt,
} from "./catalog-read-safety.js";
import { CONVERSATION_HEAD_STATUS } from "./conversation-catalog-contract.js";
import { assertConversationLineageWritable } from "./conversation-lineage-mutation-guard.js";
import {
  type LineageAssociationRecordV1,
  assertLineageAssociationRecordV1,
  validateLineageAssociationAuthority,
} from "./lineage-association.js";
import { validateLineageHeadForRead } from "./lineage-head-reader.js";
import type { ConversationLineageReadV1 } from "./lineage-reader.js";
import {
  type RevisionReservationRecordV1,
  assertRevisionReservationRecordV1,
} from "./lineage-reservation.js";
import { lineageStorageKey } from "./lineage-storage-key.js";
import {
  type LineageHeadRecordV1,
  assertLineageHeadRecordV1,
  lineageHeadDigest,
} from "./lineage-types.js";

const ASSOCIATION_FILE = /^vf-lineage-association-[0-9a-f]{64}\.json$/;
const MAX_HEAD_BYTES = 256 * 1024;
const MAX_ASSOCIATIONS = 4_096;

export class LineageAuthorityCorruptError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LineageAuthorityCorruptError";
  }
}

function sameBytes(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function decodeCanonical<T>(bytes: Buffer, validate: (value: unknown) => void, label: string): T {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    validate(value);
    const canonical = canonicalJsonBytes(value, { maxBytes: MAX_HEAD_BYTES });
    if (!sameBytes(canonical, bytes)) throw new Error("non-canonical authority bytes");
    return structuredClone(value) as T;
  } catch (error) {
    throw new LineageAuthorityCorruptError(`${label} is corrupt`, { cause: error });
  }
}

function deferredInitialHead(lineage: ConversationLineageReadV1): LineageHeadRecordV1 {
  const initial = lineage.initial_head_candidate;
  if (!initial || initial.head_status !== CONVERSATION_HEAD_STATUS.COMMITTED || !initial.active)
    throw new Error("only one eligible legacy leaf may be explicitly deferred");
  const { content_digest: _initialDigest, ...initialPreimage } = initial;
  const preimage: Omit<LineageHeadRecordV1, "content_digest"> = {
    ...structuredClone(initialPreimage),
    head_status: CONVERSATION_HEAD_STATUS.UNCLAIMED,
    active: null,
    candidate_heads: [structuredClone(initial.active)],
  };
  return { ...preimage, content_digest: lineageHeadDigest(preimage) };
}

function nodeKey(value: {
  conversation_id: string;
  revision_id: string;
  revision_ordinal: number;
}): string {
  return `${value.conversation_id}\0${value.revision_id}\0${value.revision_ordinal}`;
}

function assertReservationEdge(
  prior: RevisionReservationRecordV1 | null,
  next: RevisionReservationRecordV1,
): void {
  if (prior === null) {
    if (
      next.reservation_epoch !== 1 ||
      next.previous_reservation_digest !== null ||
      next.status !== "active" ||
      next.revision_claim_epoch !== 1
    )
      throw new Error("invalid initial reservation edge");
    return;
  }
  if (
    next.root_session_id !== prior.root_session_id ||
    next.reservation_epoch !== prior.reservation_epoch + 1 ||
    next.previous_reservation_digest !== prior.content_digest
  )
    throw new Error("reservation CAS edge is discontinuous");
  if (next.status === "active") {
    const expectedParent = prior.status === "consumed" ? prior.child : prior.parent;
    if (
      prior.status === "active" ||
      next.revision_claim_epoch !== prior.revision_claim_epoch + 1 ||
      nodeKey(next.parent) !== nodeKey(expectedParent)
    )
      throw new Error("invalid active reservation edge");
    return;
  }
  if (
    prior.status !== "active" ||
    next.revision_claim_epoch !== prior.revision_claim_epoch ||
    next.operation_id !== prior.operation_id ||
    next.proposal_id !== prior.proposal_id ||
    next.plan_digest !== prior.plan_digest ||
    next.created_at !== prior.created_at ||
    nodeKey(next.parent) !== nodeKey(prior.parent) ||
    nodeKey(next.child) !== nodeKey(prior.child)
  )
    throw new Error("invalid terminal reservation edge");
}

export class LineageAuthorityStore {
  readonly paths: {
    root: string;
    heads: string;
    reservations: string;
    associations: string;
    checkpoints: string;
    lock: string;
  };

  constructor(options: { artifactRoot: string }) {
    const root = resolve(options.artifactRoot);
    this.paths = Object.freeze({
      root,
      heads: join(root, "lineage", "v1", "heads"),
      reservations: join(root, "lineage", "v1", "reservations"),
      associations: join(root, "lineage", "v1", "associations"),
      checkpoints: join(root, "recovery", "v1", "checkpoints"),
      lock: join(root, "lineage.writer.lock"),
    });
  }

  private authorityPath(kind: "heads" | "reservations", rootSessionId: string): string {
    return join(this.paths[kind], `${digestHex(lineageStorageKey(rootSessionId))}.json`);
  }

  private withLock<T>(operation: string, run: (lock: ProcessLock) => T): T {
    const lock = acquireProcessLock(this.paths.lock, { operation });
    try {
      return run(lock);
    } finally {
      lock.release();
    }
  }

  readHead(rootSessionId: string): LineageHeadRecordV1 | null {
    const bytes = privateFileBytes(this.authorityPath("heads", rootSessionId), MAX_HEAD_BYTES);
    if (bytes === null) return null;
    const head = decodeCanonical<LineageHeadRecordV1>(
      bytes,
      assertLineageHeadRecordV1,
      "lineage head",
    );
    if (head.root_session_id !== rootSessionId)
      throw new LineageAuthorityCorruptError("lineage head storage key mismatch");
    return head;
  }

  initializeHead(
    lineage: ConversationLineageReadV1,
    options: { deferSingleCandidate?: boolean; fault?: (point: AtomicCasFaultPoint) => void } = {},
  ): LineageHeadRecordV1 {
    const candidate = options.deferSingleCandidate
      ? deferredInitialHead(lineage)
      : lineage.initial_head_candidate;
    if (!candidate) throw new Error("lineage has zero eligible leaves");
    validateLineageHeadForRead(candidate, lineage);
    return this.withLock("lineage-initialize-head", (lock) => {
      const path = this.authorityPath("heads", lineage.root_session_id);
      const existing = privateFileBytes(path, MAX_HEAD_BYTES);
      if (existing !== null) {
        const current = decodeCanonical<LineageHeadRecordV1>(
          existing,
          assertLineageHeadRecordV1,
          "lineage head",
        );
        return validateLineageHeadForRead(current, lineage);
      }
      atomicCompareAndSwap(path, null, canonicalJsonBytes(candidate), {
        lock,
        maxBytes: MAX_HEAD_BYTES,
        fault: options.fault,
      });
      return structuredClone(candidate);
    });
  }

  commitHead(
    lineage: ConversationLineageReadV1,
    prior: LineageHeadRecordV1,
    replacement: LineageHeadRecordV1,
    transitions: ReadonlyMap<string, unknown>,
    options: { fault?: (point: AtomicCasFaultPoint) => void } = {},
  ): LineageHeadRecordV1 {
    assertLineageHeadRecordV1(prior);
    if (prior.root_session_id !== lineage.root_session_id)
      throw new Error("lineage prior head root mismatch");
    validateLineageHeadForRead(replacement, lineage, transitions);
    if (
      replacement.head_epoch !== prior.head_epoch + 1 ||
      replacement.previous_head_digest !== prior.content_digest ||
      replacement.root_session_id !== prior.root_session_id
    )
      throw new Error("invalid lineage head replacement edge");
    return this.withLock("lineage-commit-head", (lock) => {
      assertConversationLineageWritable(this.paths.root, lineage.root_session_id);
      const path = this.authorityPath("heads", lineage.root_session_id);
      const expected = canonicalJsonBytes(prior);
      const current = privateFileBytes(path, MAX_HEAD_BYTES);
      if (current === null || !sameBytes(current, expected))
        throw new Error("lineage head CAS mismatch");
      createOrVerifyPrivateFile(
        join(this.paths.checkpoints, `${digestHex(prior.content_digest)}.json`),
        expected,
        { lock, maxBytes: MAX_HEAD_BYTES },
      );
      atomicCompareAndSwap(path, expected, canonicalJsonBytes(replacement), {
        lock,
        maxBytes: MAX_HEAD_BYTES,
        fault: options.fault,
      });
      return structuredClone(replacement);
    });
  }

  readReservation(rootSessionId: string): RevisionReservationRecordV1 | null {
    const bytes = privateFileBytes(
      this.authorityPath("reservations", rootSessionId),
      MAX_HEAD_BYTES,
    );
    if (bytes === null) return null;
    const record = decodeCanonical<RevisionReservationRecordV1>(
      bytes,
      assertRevisionReservationRecordV1,
      "lineage reservation",
    );
    if (record.root_session_id !== rootSessionId)
      throw new LineageAuthorityCorruptError("reservation storage key mismatch");
    return record;
  }

  readReservationHistory(rootSessionId: string): ReadonlyMap<string, unknown> {
    const current = this.readReservation(rootSessionId);
    const history = new Map<string, unknown>();
    let digest = current?.previous_reservation_digest ?? null;
    for (let count = 0; digest !== null && count < 4_096; count += 1) {
      const bytes = privateFileBytes(
        join(this.paths.checkpoints, `${digestHex(digest)}.json`),
        MAX_HEAD_BYTES,
      );
      if (bytes === null)
        throw new LineageAuthorityCorruptError("reservation checkpoint is absent");
      const record = decodeCanonical<RevisionReservationRecordV1>(
        bytes,
        assertRevisionReservationRecordV1,
        "revision reservation checkpoint",
      );
      if (record.root_session_id !== rootSessionId || record.content_digest !== digest)
        throw new LineageAuthorityCorruptError("reservation checkpoint identity mismatch");
      history.set(digest, record);
      digest = record.previous_reservation_digest;
    }
    if (digest !== null)
      throw new LineageAuthorityCorruptError("reservation checkpoint history exceeds bound");
    return history;
  }

  commitReservation(
    prior: RevisionReservationRecordV1 | null,
    replacement: RevisionReservationRecordV1,
    options: { fault?: (point: AtomicCasFaultPoint) => void } = {},
  ): RevisionReservationRecordV1 {
    assertRevisionReservationRecordV1(replacement);
    if (prior) assertRevisionReservationRecordV1(prior);
    assertReservationEdge(prior, replacement);
    return this.withLock("lineage-commit-reservation", (lock) => {
      assertConversationLineageWritable(this.paths.root, replacement.root_session_id);
      const path = this.authorityPath("reservations", replacement.root_session_id);
      const expected = prior ? canonicalJsonBytes(prior) : null;
      if (prior)
        createOrVerifyPrivateFile(
          join(this.paths.checkpoints, `${digestHex(prior.content_digest)}.json`),
          expected as Buffer,
          { lock, maxBytes: MAX_HEAD_BYTES },
        );
      atomicCompareAndSwap(path, expected, canonicalJsonBytes(replacement), {
        lock,
        maxBytes: MAX_HEAD_BYTES,
        fault: options.fault,
      });
      return structuredClone(replacement);
    });
  }

  commitAssociation(
    authority: unknown,
    heads: ReadonlyMap<string, LineageHeadRecordV1>,
  ): LineageAssociationRecordV1 {
    const record = validateLineageAssociationAuthority(authority, heads);
    return this.withLock("lineage-commit-association", (lock) => {
      createOrVerifyPrivateFile(
        join(this.paths.associations, `${record.association_id}.json`),
        canonicalJsonBytes(record),
        { lock, maxBytes: MAX_HEAD_BYTES },
      );
      return structuredClone(record);
    });
  }

  readAssociationRecords(): { records: LineageAssociationRecordV1[]; invalid_entries: number } {
    const snapshot = inspectPrivateDirectoryReadOnly(this.paths.associations);
    if (snapshot.state === "missing") return { records: [], invalid_entries: 0 };
    if (snapshot.state !== "valid")
      throw new LineageAuthorityCorruptError("lineage association directory is unsafe");
    const records: LineageAssociationRecordV1[] = [];
    let invalidEntries = 0;
    try {
      const names = readPrivateDirectoryNames(snapshot);
      if (names.length > MAX_ASSOCIATIONS)
        throw new LineageAuthorityCorruptError("too many lineage associations");
      for (const name of names) {
        if (!ASSOCIATION_FILE.test(name)) {
          invalidEntries += 1;
          continue;
        }
        try {
          const bytes = readPrivateFileBytesAt(snapshot, name, MAX_HEAD_BYTES);
          const record = decodeCanonical<LineageAssociationRecordV1>(
            bytes,
            assertLineageAssociationRecordV1,
            "lineage association",
          );
          if (`${record.association_id}.json` !== name)
            throw new Error("association filename mismatch");
          records.push(record);
        } catch {
          invalidEntries += 1;
        }
      }
    } finally {
      closePrivateDirectorySnapshot(snapshot);
    }
    records.sort((left, right) =>
      Buffer.compare(Buffer.from(left.association_id), Buffer.from(right.association_id)),
    );
    return { records, invalid_entries: invalidEntries };
  }
}
