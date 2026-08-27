import { digestHex, digestV1 } from "../durability/index.js";
import {
  ACTION_AUTHORITY_REPAIR_TARGET_PREIMAGE_PRESENCE,
  isAuthorityRepairDomain,
  isAuthorityRepairScopeAllowed,
} from "./internal-action-vocabulary-contract.js";
import { EMPTY_PERMISSION_DIGEST } from "./proposal-content-validation.js";
import {
  ACTION_RISK,
  ACTION_SCOPE,
  PUBLIC_ACTION_SCHEMA_VERSION,
} from "./public-action-contract.js";
import { assertDigest, assertOpaqueId, assertTimestamp } from "./record-primitives.js";
import { ActionValidationError, exactObject } from "./strict-json.js";

export function validateRepairPlan(value: unknown): void {
  const row = exactObject(
    value,
    [
      "schema_version",
      "repair_id",
      "domain",
      "authority_scope",
      "scope_id",
      "target_preimage",
      "last_valid_record_digest",
      "proposed_restored_authority_digest",
      "lost_tail_digest",
      "journal_identity_digest",
      "repair_steps_digest",
      "repair_authorization_binding_digest",
      "permission_digest",
      "risk",
      "created_at",
      "expires_at",
      "plan_digest",
    ],
    [],
    "$.action.plan",
  );
  if (row.schema_version !== PUBLIC_ACTION_SCHEMA_VERSION || row.risk !== ACTION_RISK.CRITICAL)
    invalid("invalid repair plan version or risk");
  if (!Object.values(ACTION_SCOPE).some((scope) => scope === row.authority_scope))
    invalid("invalid repair authority scope");
  if (!isAuthorityRepairDomain(row.domain)) invalid("invalid repair domain");
  const target = exactObject(
    row.target_preimage,
    ["presence", "corrupt_bytes_sha256", "quarantine_ref", "absence_evidence_digest"],
    [],
    "$.action.plan.target_preimage",
  );
  if (target.presence === ACTION_AUTHORITY_REPAIR_TARGET_PREIMAGE_PRESENCE.PRESENT) {
    if (
      typeof target.corrupt_bytes_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(target.corrupt_bytes_sha256) ||
      target.quarantine_ref === null ||
      target.absence_evidence_digest !== null
    )
      invalid("invalid present repair preimage");
    assertDigest(target.quarantine_ref, "$.action.plan.target_preimage.quarantine_ref");
  } else if (target.presence === ACTION_AUTHORITY_REPAIR_TARGET_PREIMAGE_PRESENCE.ABSENT) {
    if (
      target.corrupt_bytes_sha256 !== null ||
      target.quarantine_ref !== null ||
      target.absence_evidence_digest === null
    )
      invalid("invalid absent repair preimage");
    assertDigest(
      target.absence_evidence_digest,
      "$.action.plan.target_preimage.absence_evidence_digest",
    );
  } else invalid("invalid repair preimage presence");
  assertOpaqueId(row.scope_id, "$.action.plan.scope_id");
  for (const key of [
    "last_valid_record_digest",
    "proposed_restored_authority_digest",
    "repair_steps_digest",
    "repair_authorization_binding_digest",
    "permission_digest",
    "plan_digest",
  ])
    assertDigest(row[key], `$.action.plan.${key}`);
  for (const key of ["lost_tail_digest", "journal_identity_digest"])
    if (row[key] !== null) assertDigest(row[key], `$.action.plan.${key}`);
  if (row.permission_digest !== EMPTY_PERMISSION_DIGEST)
    invalid("repair plan must use the canonical empty permission binding");
  if (!isAuthorityRepairScopeAllowed(row.domain, row.authority_scope))
    invalid("repair domain and authority scope mismatch");
  const created = assertTimestamp(row.created_at, "$.action.plan.created_at");
  if (assertTimestamp(row.expires_at, "$.action.plan.expires_at") <= created)
    invalid("repair plan expiry is invalid");
  const { repair_id: observedId, plan_digest: observedDigest, ...preimage } = row;
  const expectedDigest = digestV1("VF-AUTHORITY-REPAIR-PLAN\0v1\0", preimage);
  if (
    observedDigest !== expectedDigest ||
    observedId !== `vf-authority-repair-${digestHex(expectedDigest)}`
  )
    invalid("repair plan identity mismatch");
}

function invalid(message: string): never {
  throw new ActionValidationError(message, "$.action.plan");
}
