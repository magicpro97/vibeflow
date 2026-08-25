import { CapabilityValidationError } from "../wire/primitives.js";
import type { CapabilityPrivateEffectPayloadV1 } from "./types.js";

const BASE_KEYS = [
  "schema_version",
  "payload_kind",
  "payload_digest",
  "ownership_key",
  "expected_preimage_sha256",
  "expected_postimage_sha256",
] as const;
const PRODUCTION_BASE_KEYS = [...BASE_KEYS, "preimage_owner_binding"] as const;

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new CapabilityValidationError("private payload record is invalid", field);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== [...expectedKeys].sort().join("\0"))
    throw new CapabilityValidationError("private payload record keys are not exact", field);
  return record;
}

function assertBase(record: Record<string, unknown>): void {
  if (
    record.schema_version !== "1.0" ||
    typeof record.payload_kind !== "string" ||
    typeof record.payload_digest !== "string" ||
    typeof record.ownership_key !== "string" ||
    !(
      record.expected_preimage_sha256 === null ||
      typeof record.expected_preimage_sha256 === "string"
    ) ||
    !(
      record.expected_postimage_sha256 === null ||
      typeof record.expected_postimage_sha256 === "string"
    )
  )
    throw new CapabilityValidationError(
      "private payload base fields are invalid",
      "private_payload",
    );
}

function assertOwnerBinding(candidate: Record<string, unknown>): void {
  const binding = candidate.preimage_owner_binding;
  if (binding === null) return;
  const owner = exactRecord(
    binding,
    [
      "schema_version",
      "descriptor_schema_id",
      "action_root_locator",
      "action_root_binding_digest",
      "descriptor_digest",
    ],
    "private_payload.preimage_owner_binding",
  );
  const locator = owner.action_root_locator as Record<string, unknown> | null;
  if (locator?.kind === "conversation")
    exactRecord(
      locator,
      ["kind", "root_session_id"],
      "private_payload.preimage_owner_binding.action_root_locator",
    );
  else if (locator?.kind === "capability")
    exactRecord(
      locator,
      ["kind", "scope", "scope_identity_digest"],
      "private_payload.preimage_owner_binding.action_root_locator",
    );
  else
    throw new CapabilityValidationError(
      "owner preimage action root is invalid",
      "private_payload.preimage_owner_binding.action_root_locator",
    );
}

function assertAbsentPreimage(payload: CapabilityPrivateEffectPayloadV1): void {
  if (payload.expected_preimage_sha256 !== null || payload.payload_kind === "memory-test-only")
    return;
  let absent = false;
  if (payload.payload_kind === "owned-file")
    absent = payload.preimage_base64 === null && payload.preimage_marker_base64 === null;
  else if (payload.payload_kind === "json-key-slice")
    absent =
      payload.preimage === null &&
      !payload.preimage_present &&
      payload.preimage_marker === null &&
      payload.auxiliary_files.every((file) => file.preimage_base64 === null);
  else if (payload.payload_kind === "hook-config-slice")
    absent =
      payload.preimage === null &&
      !payload.preimage_present &&
      payload.preimage_marker === null &&
      (payload.codex_feature === null || payload.codex_feature.preimage_block === null);
  else if (payload.payload_kind === "toml-owned-block")
    absent = payload.preimage_block === null && payload.preimage_marker === null;
  if (!absent)
    throw new CapabilityValidationError(
      "absent projection payload contains inline preimage authority",
      payload.ownership_key,
    );
}

function assertJsonSlice(candidate: Record<string, unknown>): void {
  assertBase(
    exactRecord(
      candidate,
      [
        ...PRODUCTION_BASE_KEYS,
        "root",
        "canonical_relative_path",
        "marker_relative_path",
        "key_path",
        "preimage",
        "preimage_present",
        "postimage",
        "postimage_present",
        "preimage_marker",
        "postimage_marker",
        "auxiliary_files",
      ],
      "private_payload",
    ),
  );
  if (!Array.isArray(candidate.key_path) || !Array.isArray(candidate.auxiliary_files))
    throw new CapabilityValidationError(
      "private payload JSON fields are invalid",
      "private_payload",
    );
  for (const [index, file] of candidate.auxiliary_files.entries())
    exactRecord(
      file,
      ["canonical_relative_path", "file_mode", "preimage_base64", "postimage_base64"],
      `private_payload.auxiliary_files[${index}]`,
    );
}

function assertHookSlice(candidate: Record<string, unknown>): void {
  assertBase(
    exactRecord(
      candidate,
      [
        ...PRODUCTION_BASE_KEYS,
        "root",
        "canonical_relative_path",
        "marker_relative_path",
        "key_path",
        "preimage",
        "preimage_present",
        "postimage",
        "postimage_present",
        "preimage_marker",
        "postimage_marker",
        "codex_feature",
      ],
      "private_payload",
    ),
  );
  if (!Array.isArray(candidate.key_path))
    throw new CapabilityValidationError(
      "private payload key path is invalid",
      "private_payload.key_path",
    );
  if (candidate.codex_feature === null) return;
  const feature = exactRecord(
    candidate.codex_feature,
    ["canonical_relative_path", "block_id", "placement", "preimage_block", "postimage_block"],
    "private_payload.codex_feature",
  );
  if (feature.canonical_relative_path !== ".codex/config.toml")
    throw new CapabilityValidationError(
      "Codex hook feature path is not the closed canonical path",
      "private_payload.codex_feature.canonical_relative_path",
    );
}

function assertLegacy(candidate: Record<string, unknown>): void {
  assertBase(
    exactRecord(
      candidate,
      [
        ...PRODUCTION_BASE_KEYS,
        "root",
        "legacy_source",
        "inspection_evidence_digest",
        "evidence_record_digest",
        "projection",
      ],
      "private_payload",
    ),
  );
  const projection = candidate.projection as Record<string, unknown> | null;
  if (projection?.kind === "file") {
    exactRecord(
      projection,
      ["kind", "canonical_relative_path", "preimage_base64"],
      "private_payload.projection",
    );
    return;
  }
  if (projection?.kind === "json-key-slice") {
    const row = exactRecord(
      projection,
      ["kind", "canonical_relative_path", "key_path", "preimage"],
      "private_payload.projection",
    );
    if (Array.isArray(row.key_path)) return;
  }
  throw new CapabilityValidationError(
    "legacy private projection is invalid",
    "private_payload.projection",
  );
}

/** Rejects extension fields so an otherwise correctly digested descriptor
 * cannot smuggle a second copy of raw preimage B. */
export function assertPrivateEffectPayloadShape(value: CapabilityPrivateEffectPayloadV1): void {
  const candidate = value as unknown as Record<string, unknown>;
  const kind = candidate?.payload_kind;
  if (kind === "memory-test-only") {
    assertBase(exactRecord(candidate, BASE_KEYS, "private_payload"));
    return;
  }
  assertOwnerBinding(candidate);
  if (kind === "owned-file")
    assertBase(
      exactRecord(
        candidate,
        [
          ...PRODUCTION_BASE_KEYS,
          "root",
          "canonical_relative_path",
          "marker_relative_path",
          "file_mode",
          "preimage_base64",
          "postimage_base64",
          "preimage_marker_base64",
          "postimage_marker_base64",
        ],
        "private_payload",
      ),
    );
  else if (kind === "json-key-slice") assertJsonSlice(candidate);
  else if (kind === "hook-config-slice") assertHookSlice(candidate);
  else if (kind === "toml-owned-block")
    assertBase(
      exactRecord(
        candidate,
        [
          ...PRODUCTION_BASE_KEYS,
          "root",
          "canonical_relative_path",
          "marker_relative_path",
          "block_id",
          "preimage_block",
          "postimage_block",
          "preimage_marker",
          "postimage_marker",
        ],
        "private_payload",
      ),
    );
  else if (kind === "legacy-claim") assertLegacy(candidate);
  else
    throw new CapabilityValidationError(
      "private descriptor kind is unsupported",
      "private_payload.payload_kind",
    );
  assertAbsentPreimage(value);
}
