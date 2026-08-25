import { digestHex, digestV1 } from "../durability/index.js";
import { EMPTY_PERMISSION_DIGEST } from "./proposal-content-validation.js";
import { assertDigest, assertOpaqueId, assertTimestamp } from "./record-primitives.js";
import { ActionValidationError, exactObject } from "./strict-json.js";

const DOMAINS = new Set([
  "conversation-manifest",
  "conversation-journal",
  "conversation-content",
  "lineage-head",
  "lineage-reservation",
  "lineage-association",
  "revision-operation",
  "action-authority",
  "capability-lock",
  "capability-operation",
  "capability-outbox",
  "scope-identity",
  "authority-epoch",
  "grant-authority",
  "policy-authority",
  "registry-trust",
  "secret-revocation",
  "authority-repair",
]);

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
  if (row.schema_version !== "1.0" || row.risk !== "critical")
    invalid("invalid repair plan version or risk");
  if (!["conversation", "project", "user"].includes(row.authority_scope as string))
    invalid("invalid repair authority scope");
  if (!DOMAINS.has(row.domain as string)) invalid("invalid repair domain");
  const target = exactObject(
    row.target_preimage,
    ["presence", "corrupt_bytes_sha256", "quarantine_ref", "absence_evidence_digest"],
    [],
    "$.action.plan.target_preimage",
  );
  if (target.presence === "present") {
    if (
      typeof target.corrupt_bytes_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(target.corrupt_bytes_sha256) ||
      target.quarantine_ref === null ||
      target.absence_evidence_digest !== null
    )
      invalid("invalid present repair preimage");
    assertDigest(target.quarantine_ref, "$.action.plan.target_preimage.quarantine_ref");
  } else if (target.presence === "absent") {
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
  const conversationDomains = new Set([
    "conversation-manifest",
    "conversation-journal",
    "conversation-content",
    "lineage-head",
    "lineage-reservation",
    "lineage-association",
    "revision-operation",
  ]);
  const capabilityDomains = new Set([
    "capability-lock",
    "capability-operation",
    "capability-outbox",
    "scope-identity",
    "authority-epoch",
    "grant-authority",
    "policy-authority",
    "registry-trust",
    "secret-revocation",
  ]);
  if (
    (conversationDomains.has(row.domain as string) && row.authority_scope !== "conversation") ||
    (capabilityDomains.has(row.domain as string) && row.authority_scope === "conversation")
  )
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
