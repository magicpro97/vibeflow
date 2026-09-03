import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestHex,
  digestV1,
  privateFileBytes,
} from "../../durability/index.js";
import { activationHeadPath } from "../source/authority-activation-records.js";
import type { CapabilityStorePathsV1 } from "../storage/paths.js";
import { readPortableBytes } from "../storage/portable-cas.js";
import type { CapabilityScopeLockV1 } from "../storage/scope-lock.js";
import { AUTHORITY_REPAIR_LIMIT } from "./contract.js";
import type { AuthorityRepairExecutionContextV1 } from "./executor.js";
import {
  AUTHORITY_REPAIR_RECONCILIATION_PREDICATE,
  type AuthorityRepairReconciliationClaimsV1,
  type AuthorityRepairReconciliationPredicateV1,
} from "./reconciliation.js";
import type { AuthorityRepairArtifactStoreV1 } from "./repair-artifact-store.js";

export const authorityRepairRawSha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export function singleReconciliationClaim(
  selected: AuthorityRepairReconciliationPredicateV1,
): AuthorityRepairReconciliationClaimsV1 {
  return Object.fromEntries(
    Object.values(AUTHORITY_REPAIR_RECONCILIATION_PREDICATE).map((value) => [
      value,
      value === selected,
    ]),
  ) as unknown as AuthorityRepairReconciliationClaimsV1;
}

const observedRaw = (bytes: Buffer | null) =>
  bytes
    ? { present: true, byte_length: bytes.length, raw_sha256: authorityRepairRawSha256(bytes) }
    : { present: false, byte_length: null, raw_sha256: null };

export function persistCapabilityLockRepairObservationV1(input: {
  context: AuthorityRepairExecutionContextV1;
  paths: CapabilityStorePathsV1;
  scope_lock: CapabilityScopeLockV1;
  artifacts: AuthorityRepairArtifactStoreV1;
}): string {
  const preimage = {
    schema_version: "1.0" as const,
    repair_id: input.context.operation.repair_id,
    repair_steps_digest: input.context.closure.steps.steps_digest,
    strategy: input.context.closure.steps.strategy,
    target_bytes: observedRaw(readPortableBytes(input.paths.currentLock)),
    control_head_bytes: observedRaw(
      privateFileBytes(activationHeadPath(input.paths), AUTHORITY_REPAIR_LIMIT.JSON_BYTES),
    ),
  };
  const digest = digestV1("VF-AUTHORITY-REPAIR-NONCOMPOUND-OBSERVED-STATE\0v1\0", preimage);
  createOrVerifyPrivateFile(
    join(input.artifacts.paths.observations, `${digestHex(digest)}.json`),
    canonicalJsonBytes({ ...preimage, observation_digest: digest }),
    { lock: input.scope_lock.processLock, maxBytes: AUTHORITY_REPAIR_LIMIT.JSON_BYTES },
  );
  return digest;
}
