import { parseStrictJson } from "../../actions/strict-json.js";
import {
  acquireProcessLock,
  appendVffrFrame,
  canonicalJson,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestV1,
  privateFileBytes,
  readVffrFile,
} from "../../durability/index.js";
import type { JsonValue, ProcessLock, VffrReadOptions } from "../../durability/index.js";
import { AUTHORITY_REPAIR_DIGEST_DOMAIN, AUTHORITY_REPAIR_LIMIT } from "./contract.js";
import { foldAuthorityRepairOperation, sameAuthorityRepairEvent } from "./operation-fold.js";
import { authorityRepairOperationPaths, authorityRepairOwnerPaths } from "./paths.js";
import { assertAuthorityRepairEvent, assertAuthorityRepairOperation } from "./records.js";
import type { AuthorityRepairEventV1, AuthorityRepairOperationV1 } from "./types.js";

export const AUTHORITY_REPAIR_OPERATION_FAULT = Object.freeze({
  AFTER_HEADER_FSYNC: "after-header-fsync",
  AFTER_EVENT_FSYNC: "after-event-fsync",
} as const);
export type AuthorityRepairOperationFaultPointV1 =
  (typeof AUTHORITY_REPAIR_OPERATION_FAULT)[keyof typeof AUTHORITY_REPAIR_OPERATION_FAULT];

function fail(message: string): never {
  throw new Error(`authority repair operation store: ${message}`);
}

function codec(operation: AuthorityRepairOperationV1): VffrReadOptions {
  return {
    domain: "authority-repair",
    maxFrames: AUTHORITY_REPAIR_LIMIT.FRAMES,
    maxPayloadBytes: AUTHORITY_REPAIR_LIMIT.FRAME_BYTES,
    maxAggregateBytes: AUTHORITY_REPAIR_LIMIT.JOURNAL_BYTES,
    sequenceStart: 0,
    initialPreviousDigest: null,
    validatePayload: (payload) =>
      assertAuthorityRepairEvent(payload as unknown as AuthorityRepairEventV1),
    computePayloadDigest: (payload) => {
      const { event_digest: _, ...preimage } = payload;
      return digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.EVENT, preimage);
    },
    validateJournalIdentity: (payload) =>
      payload.operation_id === operation.operation_id &&
      payload.header_digest === operation.header_digest &&
      payload.repair_id === operation.repair_id,
  };
}

function readHeaderPath(path: string): AuthorityRepairOperationV1 | null {
  const bytes = privateFileBytes(path, AUTHORITY_REPAIR_LIMIT.JSON_BYTES);
  if (bytes === null) return null;
  let parsed: unknown;
  try {
    parsed = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail("operation header is corrupt");
  }
  if (
    !Buffer.from(bytes).equals(
      canonicalJsonBytes(parsed, { maxBytes: AUTHORITY_REPAIR_LIMIT.JSON_BYTES }),
    )
  )
    return fail("operation header is not canonical");
  assertAuthorityRepairOperation(parsed as AuthorityRepairOperationV1);
  return parsed as AuthorityRepairOperationV1;
}

export class AuthorityRepairOperationStoreV1 {
  readonly paths;

  constructor(
    readonly ownerRoot: string,
    readonly fault?: (point: AuthorityRepairOperationFaultPointV1) => void,
  ) {
    this.paths = authorityRepairOwnerPaths(ownerRoot);
  }

  withLock<T>(operation: string, body: (lock: ProcessLock) => T): T {
    const lock = acquireProcessLock(this.paths.writerLock, {
      operation,
      coverageRoot: this.paths.root,
    });
    try {
      return body(lock);
    } finally {
      lock.release();
    }
  }

  createHeader(
    lock: ProcessLock,
    operation: AuthorityRepairOperationV1,
  ): ReturnType<typeof createOrVerifyPrivateFile> {
    assertAuthorityRepairOperation(operation);
    const paths = authorityRepairOperationPaths(this.ownerRoot, operation.operation_id);
    const disposition = createOrVerifyPrivateFile(paths.header, canonicalJsonBytes(operation), {
      lock,
      maxBytes: AUTHORITY_REPAIR_LIMIT.JSON_BYTES,
    });
    this.fault?.(AUTHORITY_REPAIR_OPERATION_FAULT.AFTER_HEADER_FSYNC);
    return disposition;
  }

  readHeader(operationId: string): AuthorityRepairOperationV1 | null {
    return readHeaderPath(authorityRepairOperationPaths(this.ownerRoot, operationId).header);
  }

  readEvents(operation: AuthorityRepairOperationV1): AuthorityRepairEventV1[] {
    assertAuthorityRepairOperation(operation);
    const path = authorityRepairOperationPaths(this.ownerRoot, operation.operation_id).events;
    if (privateFileBytes(path, AUTHORITY_REPAIR_LIMIT.JOURNAL_BYTES) === null) return [];
    const events = readVffrFile(path, codec(operation)).map(
      (frame) => frame.payload as unknown as AuthorityRepairEventV1,
    );
    foldAuthorityRepairOperation(operation, events);
    return events;
  }

  fold(operationId: string) {
    const operation = this.readHeader(operationId);
    if (!operation) return fail("operation header is missing");
    return foldAuthorityRepairOperation(operation, this.readEvents(operation));
  }

  append(
    lock: ProcessLock,
    operation: AuthorityRepairOperationV1,
    event: AuthorityRepairEventV1,
  ): "appended" | "replayed" {
    const stored = this.readHeader(operation.operation_id);
    if (!stored || canonicalJson(stored) !== canonicalJson(operation))
      return fail("event has no byte-identical stored header");
    const prior = this.readEvents(operation);
    if (event.sequence < prior.length) {
      const existing = prior[event.sequence];
      if (existing && sameAuthorityRepairEvent(existing, event)) return "replayed";
      return fail("event replay conflicts with persisted history");
    }
    if (event.sequence !== prior.length) return fail("event append skipped sequence");
    foldAuthorityRepairOperation(operation, [...prior, event]);
    appendVffrFrame(
      authorityRepairOperationPaths(this.ownerRoot, operation.operation_id).events,
      "authority-repair",
      event as unknown as JsonValue,
      { ...codec(operation), lock },
    );
    this.fault?.(AUTHORITY_REPAIR_OPERATION_FAULT.AFTER_EVENT_FSYNC);
    return "appended";
  }
}
