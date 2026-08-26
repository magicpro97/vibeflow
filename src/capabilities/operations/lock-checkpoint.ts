import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  canonicalJson,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestHex,
  digestV1,
  privateFileBytes,
} from "../../durability/index.js";
import { readCapabilityWal } from "../storage/operation-store.js";
import type { CapabilityScopeLockV1 } from "../storage/scope-lock.js";
import type { CapabilityStorageV1 } from "../storage/store.js";
import type { CapabilityLockV1 } from "../wire/lock.js";
import type { CapabilityWalPayloadV1 } from "../wire/operation.js";
import { CapabilityRuntimeError } from "./errors.js";
import type { CapabilityOperationJournalV1 } from "./operation-journal.js";
import type { CapabilityRuntimeFaultPointV1 } from "./types.js";

type LockCheckpointPayloadV1 = Extract<CapabilityWalPayloadV1, { kind: "lock-checkpoint" }>;

function checkpointPath(storage: CapabilityStorageV1, lockDigest: string): string {
  return join(
    storage.paths.privateRoot,
    "recovery",
    "v1",
    "lock-checkpoints",
    `${digestHex(lockDigest)}.json`,
  );
}

function expectedCheckpoint(
  storage: CapabilityStorageV1,
  base: CapabilityLockV1,
): { payload: LockCheckpointPayloadV1; bytes: Buffer; path: string } {
  const bytes = canonicalJsonBytes(base, { maxBytes: 8 * 1024 * 1024 });
  const checkpoint_bytes_sha256 = createHash("sha256").update(bytes).digest("hex");
  const draft = {
    schema_version: "1.0" as const,
    scope: base.scope,
    prior_generation_id: base.generation_id,
    prior_lock_digest: base.content_digest,
    checkpoint_bytes_sha256,
  };
  return {
    bytes,
    path: checkpointPath(storage, base.content_digest),
    payload: {
      kind: "lock-checkpoint",
      prior_generation_id: base.generation_id,
      prior_lock_digest: base.content_digest,
      checkpoint_bytes_sha256,
      checkpoint_digest: digestV1("VF-CAPABILITY-LOCK-CHECKPOINT\0v1\0", draft),
    },
  };
}

export function ensureCapabilityLockCheckpoint(input: {
  storage: CapabilityStorageV1;
  operationId: string;
  base: CapabilityLockV1 | null;
  held: CapabilityScopeLockV1;
  journal: CapabilityOperationJournalV1;
  fault?: (point: CapabilityRuntimeFaultPointV1) => void;
}): boolean {
  const selected = readCapabilityWal(input.storage.paths, input.operationId).flatMap((event) =>
    event.payload.kind === "lock-checkpoint" ? [event.payload] : [],
  );
  if (input.base === null) {
    if (selected.length > 0)
      throw new CapabilityRuntimeError(
        "initial capability publication contains a prior-lock checkpoint",
        "integrity-failure",
      );
    return false;
  }
  const expected = expectedCheckpoint(input.storage, input.base);
  if (
    selected.length > 1 ||
    (selected[0] && canonicalJson(selected[0]) !== canonicalJson(expected.payload))
  )
    throw new CapabilityRuntimeError(
      "capability lock checkpoint differs from the immutable operation base",
      "integrity-failure",
    );
  createOrVerifyPrivateFile(expected.path, expected.bytes, {
    lock: input.held.processLock,
    maxBytes: 8 * 1024 * 1024,
  });
  input.fault?.("after-lock-checkpoint-materialized");
  const retained = privateFileBytes(expected.path, 8 * 1024 * 1024);
  if (!retained || !Buffer.from(retained).equals(expected.bytes))
    throw new CapabilityRuntimeError(
      "capability lock checkpoint bytes are missing or changed",
      "integrity-failure",
    );
  if (selected.length === 0) {
    input.journal.append(input.operationId, expected.payload, input.held);
    return true;
  }
  return false;
}

export function validateCapabilityLockCheckpoint(input: {
  storage: CapabilityStorageV1;
  base: CapabilityLockV1 | null;
  payload: LockCheckpointPayloadV1 | null;
  required?: boolean;
}): void {
  if (input.base === null) {
    if (input.payload !== null)
      throw new CapabilityRuntimeError(
        "initial operation has a lock checkpoint",
        "integrity-failure",
      );
    return;
  }
  if (input.payload === null && input.required !== true) return;
  const expected = expectedCheckpoint(input.storage, input.base);
  const retained = privateFileBytes(expected.path, 8 * 1024 * 1024);
  if (
    input.payload === null ||
    canonicalJson(input.payload) !== canonicalJson(expected.payload) ||
    !retained ||
    !Buffer.from(retained).equals(expected.bytes)
  )
    throw new CapabilityRuntimeError(
      "required prior-lock checkpoint is absent or inconsistent",
      "integrity-failure",
    );
}
