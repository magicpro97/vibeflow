import {
  ACTION_AUTHORITY_REPAIR_TARGET_PREIMAGE_PRESENCE,
  isAuthorityRepairDomain,
  isAuthorityRepairScopeAllowed,
} from "../../actions/internal-action-vocabulary-contract.js";
import { ACTION_ROOT_LOCATOR_KIND } from "../../actions/protocol-contract.js";
import {
  ACTION_APPROVAL_ID_PATTERN,
  ACTION_OPERATION_ID_PATTERN,
  ACTION_PROPOSAL_ID_PATTERN,
  ACTOR_KIND,
  CREDENTIAL_CLASS,
} from "../../actions/public-action-contract.js";
import { assertDigest, assertOpaqueId } from "../../actions/record-primitives.js";
import { exactObject } from "../../actions/strict-json.js";
import type { PrivateActionRootLocatorV1, PublicActor } from "../../actions/types.js";
import { isCapabilityScope } from "../../core/capability-contract.js";
import { canonicalJson } from "../../durability/index.js";
import {
  AUTHORITY_REPAIR_CONTENT_TARGET_KIND,
  AUTHORITY_REPAIR_JOURNAL_SOURCE_KIND,
  AUTHORITY_REPAIR_JSON_HEAD_TARGET_KIND,
  AUTHORITY_REPAIR_SCHEMA_VERSION,
} from "./contract.js";
import type {
  AuthorityRepairJournalSourceSelectorV1,
  AuthorityRepairNonCompoundTargetLocatorV1,
} from "./types.js";

const RAW_SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function invalid(message: string): never {
  throw new Error(`invalid authority repair record: ${message}`);
}

export function exact(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function assertRawSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !RAW_SHA256_PATTERN.test(value)) invalid(`${label} is invalid`);
}

export function assertScopeTriple(value: {
  schema_version: unknown;
  domain: unknown;
  authority_scope: unknown;
  scope_id: unknown;
}): void {
  if (value.schema_version !== AUTHORITY_REPAIR_SCHEMA_VERSION) invalid("schema version mismatch");
  if (!isAuthorityRepairDomain(value.domain)) invalid("domain is invalid");
  if (!isAuthorityRepairScopeAllowed(value.domain, value.authority_scope))
    invalid("domain and authority scope mismatch");
  assertOpaqueId(value.scope_id, "$.scope_id");
}

export function assertAuthorityRepairIdentityFields(value: {
  repair_id: unknown;
  operation_id: unknown;
  proposal_id: unknown;
  approval_id: unknown;
}): void {
  if (
    typeof value.repair_id !== "string" ||
    !/^vf-authority-repair-[a-f0-9]{64}$/u.test(value.repair_id)
  )
    invalid("repair ID is invalid");
  if (
    typeof value.operation_id !== "string" ||
    !ACTION_OPERATION_ID_PATTERN.test(value.operation_id)
  )
    invalid("repair operation ID is invalid");
  if (typeof value.proposal_id !== "string" || !ACTION_PROPOSAL_ID_PATTERN.test(value.proposal_id))
    invalid("repair proposal ID is invalid");
  if (typeof value.approval_id !== "string" || !ACTION_APPROVAL_ID_PATTERN.test(value.approval_id))
    invalid("repair approval ID is invalid");
}

export function assertPrivateActionRootLocator(value: PrivateActionRootLocatorV1): void {
  const row = exactObject(
    value,
    ["kind"],
    ["root_session_id", "scope", "scope_identity_digest", "bootstrap_identity_digest"],
    "$.action_root_locator",
  );
  if (row.kind === ACTION_ROOT_LOCATOR_KIND.CONVERSATION) {
    exactObject(row, ["kind", "root_session_id"], [], "$.action_root_locator");
    assertOpaqueId(row.root_session_id, "$.action_root_locator.root_session_id");
  } else if (row.kind === ACTION_ROOT_LOCATOR_KIND.CAPABILITY) {
    exactObject(row, ["kind", "scope", "scope_identity_digest"], [], "$.action_root_locator");
    if (!isCapabilityScope(row.scope)) invalid("action-root scope is invalid");
    assertDigest(row.scope_identity_digest, "$.action_root_locator.scope_identity_digest");
  } else if (row.kind === ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP) {
    exactObject(row, ["kind", "bootstrap_identity_digest"], [], "$.action_root_locator");
    assertDigest(row.bootstrap_identity_digest, "$.action_root_locator.bootstrap_identity_digest");
  } else invalid("action-root locator kind is invalid");
}

export function assertPublicActor(value: PublicActor): void {
  exactObject(value, ["kind", "public_actor_id", "credential_class"], [], "$.created_by");
  if (!Object.values(ACTOR_KIND).some((candidate) => candidate === value.kind))
    invalid("repair actor kind is invalid");
  if (!Object.values(CREDENTIAL_CLASS).some((candidate) => candidate === value.credential_class))
    invalid("repair actor credential is invalid");
  assertOpaqueId(value.public_actor_id, "$.created_by.public_actor_id");
}

export function assertTargetPreimage(value: unknown): void {
  const row = exactObject(
    value,
    ["presence", "corrupt_bytes_sha256", "quarantine_ref", "absence_evidence_digest"],
    [],
    "$.target_preimage",
  );
  if (row.presence === ACTION_AUTHORITY_REPAIR_TARGET_PREIMAGE_PRESENCE.PRESENT) {
    assertRawSha256(row.corrupt_bytes_sha256, "target preimage SHA-256");
    assertDigest(row.quarantine_ref, "$.target_preimage.quarantine_ref");
    if (row.absence_evidence_digest !== null) invalid("present target has absence evidence");
  } else if (row.presence === ACTION_AUTHORITY_REPAIR_TARGET_PREIMAGE_PRESENCE.ABSENT) {
    if (row.corrupt_bytes_sha256 !== null || row.quarantine_ref !== null)
      invalid("absent target carries corrupt preimage");
    assertDigest(row.absence_evidence_digest, "$.target_preimage.absence_evidence_digest");
  } else invalid("target preimage presence is invalid");
}

export function assertJournalSource(
  value: unknown,
): asserts value is AuthorityRepairJournalSourceSelectorV1 {
  const row = exactObject(
    value,
    ["kind"],
    ["expected_current_pointer_digest", "generation_id", "generation_digest"],
    "$.source_selector",
  );
  if (row.kind === AUTHORITY_REPAIR_JOURNAL_SOURCE_KIND.CANONICAL) {
    if (Object.keys(row).length !== 1) invalid("canonical journal source has recovery fields");
    return;
  }
  if (row.kind !== AUTHORITY_REPAIR_JOURNAL_SOURCE_KIND.RECOVERY_GENERATION)
    invalid("journal source kind is invalid");
  if (Object.keys(row).length !== 4) invalid("recovery journal source is incomplete");
  assertDigest(
    row.expected_current_pointer_digest,
    "$.source_selector.expected_current_pointer_digest",
  );
  assertOpaqueId(row.generation_id, "$.source_selector.generation_id");
  assertDigest(row.generation_digest, "$.source_selector.generation_digest");
}

function assertJsonTarget(value: unknown): void {
  const row = exactObject(
    value,
    ["kind"],
    ["conversation_id", "root_session_id", "lineage_storage_key", "scope", "scope_identity_digest"],
    "$.target_locator.target",
  );
  switch (row.kind) {
    case AUTHORITY_REPAIR_JSON_HEAD_TARGET_KIND.CONVERSATION_MANIFEST:
      exactObject(row, ["kind", "conversation_id"], [], "$.target_locator.target");
      assertOpaqueId(row.conversation_id, "$.target_locator.target.conversation_id");
      return;
    case AUTHORITY_REPAIR_JSON_HEAD_TARGET_KIND.LINEAGE_HEAD:
    case AUTHORITY_REPAIR_JSON_HEAD_TARGET_KIND.LINEAGE_RESERVATION:
      exactObject(
        row,
        ["kind", "root_session_id", "lineage_storage_key"],
        [],
        "$.target_locator.target",
      );
      assertOpaqueId(row.root_session_id, "$.target_locator.target.root_session_id");
      assertOpaqueId(row.lineage_storage_key, "$.target_locator.target.lineage_storage_key");
      return;
    case AUTHORITY_REPAIR_JSON_HEAD_TARGET_KIND.CAPABILITY_LOCK:
    case AUTHORITY_REPAIR_JSON_HEAD_TARGET_KIND.AUTHORITY_EPOCH_ZERO_HEAD:
      exactObject(row, ["kind", "scope", "scope_identity_digest"], [], "$.target_locator.target");
      if (!isCapabilityScope(row.scope)) invalid("JSON-head capability scope is invalid");
      assertDigest(row.scope_identity_digest, "$.target_locator.target.scope_identity_digest");
      return;
    case AUTHORITY_REPAIR_JSON_HEAD_TARGET_KIND.SCOPE_IDENTITY:
      exactObject(row, ["kind", "scope"], [], "$.target_locator.target");
      if (!isCapabilityScope(row.scope)) invalid("scope-identity target scope is invalid");
      return;
    default:
      invalid("JSON-head target kind is invalid");
  }
}

function assertContentTarget(value: unknown): void {
  const row = exactObject(
    value,
    ["kind"],
    [
      "object_schema_id",
      "record_digest",
      "association_id",
      "operation_id",
      "key",
      "blob_kind",
      "content_digest",
      "raw_sha256",
      "byte_length",
      "binding_record_digest",
      "generation_id",
      "binding_digest",
      "public_payload_digest",
    ],
    "$.target_locator.target",
  );
  if (!Object.values(AUTHORITY_REPAIR_CONTENT_TARGET_KIND).includes(row.kind as never))
    invalid("content target kind is invalid");
  switch (row.kind) {
    case AUTHORITY_REPAIR_CONTENT_TARGET_KIND.CONVERSATION_OBJECT:
    case AUTHORITY_REPAIR_CONTENT_TARGET_KIND.AUTHORITY_REPAIR_OBJECT:
    case AUTHORITY_REPAIR_CONTENT_TARGET_KIND.CAPABILITY_OBJECT:
      exactObject(
        row,
        ["kind", "object_schema_id", "record_digest"],
        [],
        "$.target_locator.target",
      );
      break;
    case AUTHORITY_REPAIR_CONTENT_TARGET_KIND.LINEAGE_ASSOCIATION:
      exactObject(row, ["kind", "association_id", "record_digest"], [], "$.target_locator.target");
      break;
    case AUTHORITY_REPAIR_CONTENT_TARGET_KIND.REVISION_OPERATION_HEADER:
    case AUTHORITY_REPAIR_CONTENT_TARGET_KIND.CAPABILITY_OPERATION_HEADER:
    case AUTHORITY_REPAIR_CONTENT_TARGET_KIND.AUTHORITY_CHANGE_OPERATION_HEADER:
    case AUTHORITY_REPAIR_CONTENT_TARGET_KIND.AUTHORITY_REPAIR_HEADER:
      exactObject(row, ["kind", "operation_id", "record_digest"], [], "$.target_locator.target");
      break;
    case AUTHORITY_REPAIR_CONTENT_TARGET_KIND.ACTION_RECORD:
      exactObject(row, ["kind", "key"], [], "$.target_locator.target");
      break;
    case AUTHORITY_REPAIR_CONTENT_TARGET_KIND.ACTION_BLOB:
      exactObject(
        row,
        [
          "kind",
          "blob_kind",
          "content_digest",
          "raw_sha256",
          "byte_length",
          "binding_record_digest",
        ],
        [],
        "$.target_locator.target",
      );
      break;
    case AUTHORITY_REPAIR_CONTENT_TARGET_KIND.CAPABILITY_GENERATION:
      exactObject(row, ["kind", "generation_id", "record_digest"], [], "$.target_locator.target");
      break;
    case AUTHORITY_REPAIR_CONTENT_TARGET_KIND.CAPABILITY_RUNTIME_EVIDENCE_BLOB:
      exactObject(
        row,
        ["kind", "content_digest", "raw_sha256", "byte_length", "binding_digest"],
        [],
        "$.target_locator.target",
      );
      break;
    case AUTHORITY_REPAIR_CONTENT_TARGET_KIND.CAPABILITY_RUNTIME_EVIDENCE_BINDING:
      exactObject(row, ["kind", "content_digest", "binding_digest"], [], "$.target_locator.target");
      break;
    case AUTHORITY_REPAIR_CONTENT_TARGET_KIND.CAPABILITY_OUTBOX_PAYLOAD:
      exactObject(row, ["kind", "public_payload_digest"], [], "$.target_locator.target");
      break;
    default:
      invalid("content target kind is invalid");
  }
  const digestFields = [
    "record_digest",
    "content_digest",
    "binding_record_digest",
    "binding_digest",
    "public_payload_digest",
  ];
  for (const key of digestFields)
    if (row[key] !== undefined) assertDigest(row[key], `$.target_locator.target.${key}`);
  if (row.raw_sha256 !== undefined) assertRawSha256(row.raw_sha256, "content raw SHA-256");
  for (const key of ["association_id", "operation_id", "generation_id"])
    if (row[key] !== undefined) assertOpaqueId(row[key], `$.target_locator.target.${key}`);
  if (
    row.byte_length !== undefined &&
    (typeof row.byte_length !== "number" ||
      !Number.isSafeInteger(row.byte_length) ||
      row.byte_length < 0)
  )
    invalid("content byte length is invalid");
  if (row.key !== undefined && (!row.key || typeof row.key !== "object" || Array.isArray(row.key)))
    invalid("action record key is invalid");
}

export function assertNonCompoundLocator(
  value: unknown,
): asserts value is AuthorityRepairNonCompoundTargetLocatorV1 {
  const row = exactObject(
    value,
    ["strategy"],
    ["target", "journal_identity_digest", "source_selector"],
    "$.target_locator",
  );
  if (row.strategy === "replace-json-head") {
    exactObject(row, ["strategy", "target"], [], "$.target_locator");
    assertJsonTarget(row.target);
  } else if (row.strategy === "new-journal-generation") {
    exactObject(
      row,
      ["strategy", "journal_identity_digest", "source_selector"],
      [],
      "$.target_locator",
    );
    assertDigest(row.journal_identity_digest, "$.target_locator.journal_identity_digest");
    assertJournalSource(row.source_selector);
  } else if (row.strategy === "restore-content-addressed-object") {
    exactObject(row, ["strategy", "target"], [], "$.target_locator");
    assertContentTarget(row.target);
  } else invalid("target locator strategy is invalid");
}
