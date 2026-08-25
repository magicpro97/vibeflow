import {
  assertDigest,
  assertOpaqueId,
  assertPackageId,
  assertRawSha256,
  assertSafeInteger,
  assertTimestamp,
  bytewise,
} from "./record-primitives.js";
import { ActionValidationError, exactObject } from "./strict-json.js";
import type { ActionProposalDraftV1 } from "./types.js";

export function validateCapabilityGeneration(base: Record<string, unknown>): void {
  const values = [
    base.capability_generation_ordinal,
    base.capability_generation_id,
    base.capability_lock_digest,
  ];
  const count = values.filter((value) => value !== null).length;
  if (count !== 0 && count !== values.length) invalid("capability generation is partially bound");
  const parents = base.capability_parent_generation_digests as string[];
  if (count === 0) {
    if (parents.length) invalid("first generation cannot name parent locks");
    return;
  }
  assertSafeInteger(
    base.capability_generation_ordinal,
    "$.proposal.base.capability_generation_ordinal",
  );
  assertOpaqueId(base.capability_generation_id, "$.proposal.base.capability_generation_id");
  const lock = assertDigest(base.capability_lock_digest, "$.proposal.base.capability_lock_digest");
  if (!parents.includes(lock)) invalid("capability parent set omits the current lock");
}

export function validateUserPrerequisites(draft: ActionProposalDraftV1, value: unknown): void {
  if (!Array.isArray(value) || value.length > 256) invalid("user prerequisite set is invalid");
  const identities: string[] = [];
  const packages: string[] = [];
  for (const [index, item] of value.entries()) {
    const path = `$.proposal.base.user_prerequisites[${index}]`;
    const row = exactObject(
      item,
      [
        "schema_version",
        "user_scope_identity_digest",
        "package_id",
        "version",
        "content_sha256",
        "user_generation_id",
        "user_lock_digest",
        "user_lock_entry_digest",
        "user_authority_epoch",
        "user_authority_head_digest",
        "required_health_digest",
        "checked_at",
        "expires_at",
      ],
      [],
      path,
    );
    if (row.schema_version !== "1.0") invalid("invalid user prerequisite version");
    assertDigest(row.user_scope_identity_digest, `${path}.user_scope_identity_digest`);
    const packageId = assertPackageId(row.package_id, `${path}.package_id`);
    assertOpaqueId(row.version, `${path}.version`, 128);
    assertRawSha256(row.content_sha256, `${path}.content_sha256`);
    assertOpaqueId(row.user_generation_id, `${path}.user_generation_id`);
    for (const key of [
      "user_lock_digest",
      "user_lock_entry_digest",
      "user_authority_head_digest",
      "required_health_digest",
    ])
      assertDigest(row[key], `${path}.${key}`);
    assertSafeInteger(row.user_authority_epoch, `${path}.user_authority_epoch`);
    const checked = assertTimestamp(row.checked_at, `${path}.checked_at`);
    const expires = assertTimestamp(row.expires_at, `${path}.expires_at`);
    if (row.checked_at !== draft.created_at || expires <= checked || expires > checked + 300_000)
      invalid("user prerequisite lease is invalid");
    identities.push(
      [
        row.user_scope_identity_digest,
        packageId,
        row.version,
        row.content_sha256,
        row.user_generation_id,
        row.user_lock_digest,
        row.user_lock_entry_digest,
      ].join("\0"),
    );
    packages.push(packageId);
  }
  if (
    new Set(identities).size !== identities.length ||
    new Set(packages).size !== packages.length ||
    identities.some((identity, index) => identity !== [...identities].sort(bytewise)[index])
  )
    invalid("user prerequisites are duplicated or not canonically ordered");
}

function invalid(message: string): never {
  throw new ActionValidationError(message, "$.proposal.base.user_prerequisites");
}
