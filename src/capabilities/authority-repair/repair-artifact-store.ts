import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseStrictJson } from "../../actions/strict-json.js";
import {
  canonicalJson,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestHex,
  privateFileBytes,
} from "../../durability/index.js";
import type { ProcessLock } from "../../durability/index.js";
import { assertAuthorityRepairClosure } from "./closure-records.js";
import { AUTHORITY_REPAIR_LIMIT } from "./contract.js";
import { authorityRepairQuarantineRef, authorityRepairRestoreSourceRef } from "./digests.js";
import { assertAuthorityEpochRepairBase } from "./epoch-records.js";
import { authorityRepairOwnerPaths } from "./paths.js";
import {
  assertAuthorityRepairAbsenceEvidence,
  assertAuthorityRepairSteps,
} from "./repair-objects.js";
import type {
  AuthorityEpochRepairBaseV1,
  AuthorityRepairAbsenceEvidenceV1,
  AuthorityRepairActionObjectClosureV1,
  AuthorityRepairActionObjectsV1,
  AuthorityRepairStepsV1,
} from "./types.js";

function fail(message: string): never {
  throw new Error(`authority repair artifact store: ${message}`);
}

function rawSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readCanonical<T>(path: string, label: string): T {
  const bytes = privateFileBytes(path, AUTHORITY_REPAIR_LIMIT.JSON_BYTES);
  if (bytes === null) return fail(`${label} is missing`);
  let parsed: unknown;
  try {
    parsed = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail(`${label} is corrupt`);
  }
  if (!Buffer.from(bytes).equals(canonicalJsonBytes(parsed)))
    return fail(`${label} is not canonical`);
  return parsed as T;
}

export class AuthorityRepairArtifactStoreV1 {
  readonly paths;

  constructor(readonly ownerRoot: string) {
    this.paths = authorityRepairOwnerPaths(ownerRoot);
  }

  persistPlanArtifacts(
    lock: ProcessLock,
    input: {
      closure: AuthorityRepairActionObjectClosureV1;
      restore_bytes: Uint8Array;
      absence_evidence?: AuthorityRepairAbsenceEvidenceV1;
      epoch_base?: AuthorityEpochRepairBaseV1;
    },
  ): void {
    const closure = assertAuthorityRepairClosure(input.closure);
    const steps = closure.steps;
    if (
      rawSha256(input.restore_bytes) !== steps.restore_bytes_sha256 ||
      authorityRepairRestoreSourceRef(steps) !== steps.restore_source_ref
    )
      fail("restore source bytes/ref do not match repair steps");
    createOrVerifyPrivateFile(
      join(this.paths.restoreSources, `${digestHex(steps.restore_source_ref)}.bytes`),
      input.restore_bytes,
      {
        lock,
        maxBytes: AUTHORITY_REPAIR_LIMIT.RESTORE_BYTES,
      },
    );
    createOrVerifyPrivateFile(
      join(this.paths.objects, `${digestHex(steps.steps_digest)}.json`),
      canonicalJsonBytes(steps),
      {
        lock,
        maxBytes: AUTHORITY_REPAIR_LIMIT.JSON_BYTES,
      },
    );
    if (steps.target_preimage.presence === "absent") {
      const evidence = input.absence_evidence ?? fail("absent repair lacks its evidence marker");
      assertAuthorityRepairAbsenceEvidence(evidence);
      if (
        evidence.evidence_digest !== steps.target_preimage.absence_evidence_digest ||
        evidence.domain !== steps.domain ||
        evidence.authority_scope !== steps.authority_scope ||
        evidence.scope_id !== steps.scope_id ||
        canonicalJson(evidence.target_locator) !== canonicalJson(steps.target_locator) ||
        evidence.observed_at !== closure.plan.created_at
      )
        fail("absence evidence does not match repair steps");
      createOrVerifyPrivateFile(
        join(this.paths.absence, `${digestHex(evidence.evidence_digest)}.json`),
        canonicalJsonBytes(evidence),
        {
          lock,
          maxBytes: AUTHORITY_REPAIR_LIMIT.JSON_BYTES,
        },
      );
    } else if (authorityRepairQuarantineRef(steps) !== steps.target_preimage.quarantine_ref) {
      fail("present preimage quarantine reference is not derived from repair steps");
    }
    if (steps.authority_epoch_repair_base_digest !== null) {
      const base = input.epoch_base ?? fail("compound repair lacks its epoch base");
      assertAuthorityEpochRepairBase(base);
      if (
        base.base_digest !== steps.authority_epoch_repair_base_digest ||
        base.authority_scope !== steps.authority_scope ||
        base.scope_id !== steps.scope_id ||
        steps.target_preimage.presence !== "present" ||
        base.head_corrupt_bytes_sha256 !== steps.target_preimage.corrupt_bytes_sha256 ||
        base.head_quarantine_ref !== steps.target_preimage.quarantine_ref ||
        base.head_restore_source_ref !== steps.restore_source_ref ||
        base.restored_head_bytes_sha256 !== steps.restore_bytes_sha256 ||
        base.event_journal_identity_digest !== steps.journal_identity_digest ||
        base.event_last_valid_record_digest !== steps.last_valid_record_digest ||
        base.event_lost_tail_sha256 !== steps.lost_tail_sha256 ||
        base.event_lost_tail_digest !== steps.lost_tail_digest ||
        base.event_expected_current_pointer_digest !== steps.expected_current_pointer_digest ||
        base.event_repair_base_pointer_digest !== steps.replacement_current_pointer_digest ||
        base.event_repair_base_generation_digest !== steps.recovery_link_digest
      )
        fail("compound base and repair steps differ");
      createOrVerifyPrivateFile(
        join(this.paths.objects, `${digestHex(base.base_digest)}.json`),
        canonicalJsonBytes(base),
        {
          lock,
          maxBytes: AUTHORITY_REPAIR_LIMIT.JSON_BYTES,
        },
      );
    } else if (input.epoch_base) fail("non-compound repair supplied an epoch base");
  }

  writeQuarantine(
    lock: ProcessLock,
    steps: AuthorityRepairStepsV1,
    corruptBytes: Uint8Array,
  ): void {
    assertAuthorityRepairSteps(steps);
    if (
      steps.target_preimage.presence !== "present" ||
      rawSha256(corruptBytes) !== steps.target_preimage.corrupt_bytes_sha256 ||
      authorityRepairQuarantineRef(steps) !== steps.target_preimage.quarantine_ref
    )
      fail("quarantine bytes do not match the approved present preimage");
    createOrVerifyPrivateFile(
      join(this.paths.quarantine, `${digestHex(steps.target_preimage.quarantine_ref)}.bytes`),
      corruptBytes,
      {
        lock,
        maxBytes: AUTHORITY_REPAIR_LIMIT.RESTORE_BYTES,
      },
    );
  }

  readSteps(digest: string): AuthorityRepairStepsV1 {
    const value = readCanonical<AuthorityRepairStepsV1>(
      join(this.paths.objects, `${digestHex(digest)}.json`),
      "repair steps",
    );
    if (assertAuthorityRepairSteps(value).steps_digest !== digest)
      fail("repair steps path/digest mismatch");
    return value;
  }

  readRestoreSource(steps: AuthorityRepairStepsV1): Buffer {
    assertAuthorityRepairSteps(steps);
    const bytes = privateFileBytes(
      join(this.paths.restoreSources, `${digestHex(steps.restore_source_ref)}.bytes`),
      AUTHORITY_REPAIR_LIMIT.RESTORE_BYTES,
    );
    if (
      bytes === null ||
      rawSha256(bytes) !== steps.restore_bytes_sha256 ||
      authorityRepairRestoreSourceRef(steps) !== steps.restore_source_ref
    )
      return fail("restore source is missing or mismatched");
    return bytes;
  }

  readQuarantine(steps: AuthorityRepairStepsV1): Buffer {
    assertAuthorityRepairSteps(steps);
    if (steps.target_preimage.presence !== "present")
      return fail("absent repair has no quarantine object");
    const bytes = privateFileBytes(
      join(this.paths.quarantine, `${digestHex(steps.target_preimage.quarantine_ref)}.bytes`),
      AUTHORITY_REPAIR_LIMIT.RESTORE_BYTES,
    );
    if (
      bytes === null ||
      rawSha256(bytes) !== steps.target_preimage.corrupt_bytes_sha256 ||
      authorityRepairQuarantineRef(steps) !== steps.target_preimage.quarantine_ref
    )
      return fail("quarantine object is missing or mismatched");
    return bytes;
  }

  readAbsenceEvidence(steps: AuthorityRepairStepsV1): AuthorityRepairAbsenceEvidenceV1 {
    assertAuthorityRepairSteps(steps);
    if (steps.target_preimage.presence !== "absent")
      return fail("present repair has no absence evidence");
    const digest = steps.target_preimage.absence_evidence_digest;
    const value = readCanonical<AuthorityRepairAbsenceEvidenceV1>(
      join(this.paths.absence, `${digestHex(digest)}.json`),
      "repair absence evidence",
    );
    if (
      assertAuthorityRepairAbsenceEvidence(value).evidence_digest !== digest ||
      value.domain !== steps.domain ||
      value.authority_scope !== steps.authority_scope ||
      value.scope_id !== steps.scope_id ||
      canonicalJson(value.target_locator) !== canonicalJson(steps.target_locator)
    )
      return fail("repair absence evidence does not match steps");
    return value;
  }

  resolvePreparedClosure(
    objects: AuthorityRepairActionObjectsV1,
  ): AuthorityRepairActionObjectClosureV1 {
    const steps = this.readSteps(objects.plan.repair_steps_digest);
    const closure = { ...structuredClone(objects), steps };
    assertAuthorityRepairClosure(closure);
    this.readRestoreSource(steps);
    if (steps.target_preimage.presence === "absent") {
      const evidence = this.readAbsenceEvidence(steps);
      if (evidence.observed_at !== objects.plan.created_at)
        return fail("absence evidence timestamp differs from the approved plan");
    }
    if (steps.authority_epoch_repair_base_digest !== null)
      this.readEpochBase(steps.authority_epoch_repair_base_digest);
    return closure;
  }

  readEpochBase(digest: string): AuthorityEpochRepairBaseV1 {
    const value = readCanonical<AuthorityEpochRepairBaseV1>(
      join(this.paths.objects, `${digestHex(digest)}.json`),
      "authority epoch repair base",
    );
    if (assertAuthorityEpochRepairBase(value).base_digest !== digest)
      fail("authority epoch base path/digest mismatch");
    return value;
  }
}
