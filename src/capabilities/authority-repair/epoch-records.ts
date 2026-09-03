import { assertDigest, assertOpaqueId } from "../../actions/record-primitives.js";
import { exactObject } from "../../actions/strict-json.js";
import { isCapabilityScope } from "../../core/capability-contract.js";
import { digestV1 } from "../../durability/index.js";
import {
  AUTHORITY_REPAIR_DIGEST_DOMAIN,
  AUTHORITY_REPAIR_JOURNAL_SOURCE_KIND,
  AUTHORITY_REPAIR_SCHEMA_VERSION,
} from "./contract.js";
import type { AuthorityEpochRepairBaseV1 } from "./types.js";
import { assertJournalSource, assertRawSha256, invalid } from "./validation.js";

function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const clone = { ...value };
  delete clone[key];
  return clone;
}

export function materializeAuthorityEpochRepairBase(
  draft: Omit<AuthorityEpochRepairBaseV1, "base_digest">,
): AuthorityEpochRepairBaseV1 {
  return assertAuthorityEpochRepairBase({
    ...structuredClone(draft),
    base_digest: digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.EPOCH_BASE, draft),
  });
}

export function assertAuthorityEpochRepairBase(
  value: AuthorityEpochRepairBaseV1,
): AuthorityEpochRepairBaseV1 {
  exactObject(
    value,
    [
      "schema_version",
      "authority_scope",
      "scope_id",
      "head_corrupt_bytes_sha256",
      "head_quarantine_ref",
      "head_restore_source_ref",
      "restored_head_bytes_sha256",
      "restored_head_digest",
      "head_expected_current_pointer_digest",
      "head_replacement_pointer_digest",
      "event_journal_identity_digest",
      "event_source_selector",
      "event_corrupt_bytes_sha256",
      "event_quarantine_ref",
      "event_restore_source_ref",
      "event_restore_bytes_sha256",
      "event_last_valid_record_digest",
      "event_lost_tail_sha256",
      "event_lost_tail_digest",
      "event_expected_current_pointer_digest",
      "event_repair_base_generation_digest",
      "event_repair_base_pointer_digest",
      "base_digest",
    ],
    [],
    "$.authority_epoch_repair_base",
  );
  if (
    value.schema_version !== AUTHORITY_REPAIR_SCHEMA_VERSION ||
    !isCapabilityScope(value.authority_scope)
  )
    invalid("authority epoch base scope is invalid");
  assertOpaqueId(value.scope_id, "$.authority_epoch_repair_base.scope_id");
  for (const key of [
    "head_corrupt_bytes_sha256",
    "restored_head_bytes_sha256",
    "event_corrupt_bytes_sha256",
    "event_restore_bytes_sha256",
  ] as const)
    assertRawSha256(value[key], `$.authority_epoch_repair_base.${key}`);
  for (const key of [
    "head_quarantine_ref",
    "head_restore_source_ref",
    "restored_head_digest",
    "head_expected_current_pointer_digest",
    "head_replacement_pointer_digest",
    "event_journal_identity_digest",
    "event_quarantine_ref",
    "event_restore_source_ref",
    "event_repair_base_generation_digest",
    "event_repair_base_pointer_digest",
    "base_digest",
  ] as const)
    assertDigest(value[key], `$.authority_epoch_repair_base.${key}`);
  assertJournalSource(value.event_source_selector);
  if (value.event_last_valid_record_digest === null)
    invalid("compound base requires a valid event prefix");
  assertDigest(
    value.event_last_valid_record_digest,
    "$.authority_epoch_repair_base.event_last_valid_record_digest",
  );
  if ((value.event_lost_tail_sha256 === null) !== (value.event_lost_tail_digest === null))
    invalid("base lost-tail fields mismatch");
  if (value.event_lost_tail_sha256 !== null)
    assertRawSha256(value.event_lost_tail_sha256, "base event lost-tail SHA-256");
  if (value.event_lost_tail_digest !== null)
    assertDigest(
      value.event_lost_tail_digest,
      "$.authority_epoch_repair_base.event_lost_tail_digest",
    );
  if (value.event_expected_current_pointer_digest !== null)
    assertDigest(
      value.event_expected_current_pointer_digest,
      "$.authority_epoch_repair_base.event_expected_current_pointer_digest",
    );
  const headExpected = digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.JSON_HEAD_CURRENT, {
    schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
    domain: "authority-epoch",
    authority_scope: value.authority_scope,
    scope_id: value.scope_id,
    current_bytes_sha256: value.head_corrupt_bytes_sha256,
  });
  const headReplacement = digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.JSON_HEAD_CURRENT, {
    schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
    domain: "authority-epoch",
    authority_scope: value.authority_scope,
    scope_id: value.scope_id,
    current_bytes_sha256: value.restored_head_bytes_sha256,
  });
  const eventQuarantine = digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.QUARANTINE, {
    schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
    domain: "authority-epoch",
    authority_scope: value.authority_scope,
    scope_id: value.scope_id,
    journal_identity_digest: value.event_journal_identity_digest,
    corrupt_bytes_sha256: value.event_corrupt_bytes_sha256,
  });
  const eventRestore = digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.RESTORE_SOURCE, {
    schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
    domain: "authority-epoch",
    authority_scope: value.authority_scope,
    scope_id: value.scope_id,
    journal_identity_digest: value.event_journal_identity_digest,
    restore_bytes_sha256: value.event_restore_bytes_sha256,
    last_valid_record_digest: value.event_last_valid_record_digest,
  });
  const eventLost =
    value.event_lost_tail_sha256 === null
      ? null
      : digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.LOST_TAIL, {
          corrupt_bytes_sha256: value.event_corrupt_bytes_sha256,
          last_valid_record_digest: value.event_last_valid_record_digest,
          lost_tail_sha256: value.event_lost_tail_sha256,
        });
  const selectorExpected =
    value.event_source_selector.kind === AUTHORITY_REPAIR_JOURNAL_SOURCE_KIND.CANONICAL
      ? null
      : value.event_source_selector.expected_current_pointer_digest;
  if (
    value.head_expected_current_pointer_digest !== headExpected ||
    value.head_replacement_pointer_digest !== headReplacement ||
    value.event_quarantine_ref !== eventQuarantine ||
    value.event_restore_source_ref !== eventRestore ||
    value.event_lost_tail_digest !== eventLost ||
    value.event_expected_current_pointer_digest !== selectorExpected
  )
    invalid("authority epoch base derived pointer/evidence fields mismatch");
  if (
    value.base_digest !==
    digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.EPOCH_BASE, omit(value, "base_digest"))
  )
    invalid("authority epoch base digest mismatch");
  return value;
}
