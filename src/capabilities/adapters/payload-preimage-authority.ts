import { parseStrictJson } from "../../actions/strict-json.js";
import { digestV1Bytes } from "../../durability/canonical.js";
import {
  canonicalJson,
  canonicalJsonBytes,
  digestHex,
  sha256Digest,
} from "../../durability/index.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import { projectionStateBytes } from "./filesystem-io.js";
import { assertPrivateEffectPayloadShape } from "./private-payload-shape.js";
import type {
  CapabilityOwnedResourceV1,
  CapabilityPrivateEffectPayloadV1,
  CapabilityPrivateJsonV1,
} from "./types.js";

/** Removes every value that could restore or CAS against a prior projection. */
export function persistedPrivateEffectPayload(
  value: CapabilityPrivateEffectPayloadV1,
): CapabilityPrivateEffectPayloadV1 {
  const payload = structuredClone(value);
  if (payload.payload_kind === "memory-test-only") return payload;
  if (payload.payload_kind === "owned-file") {
    payload.preimage_base64 = null;
    payload.preimage_marker_base64 = null;
  } else if (payload.payload_kind === "json-key-slice") {
    payload.preimage = null;
    payload.preimage_present = false;
    payload.preimage_marker = null;
    for (const file of payload.auxiliary_files) file.preimage_base64 = null;
  } else if (payload.payload_kind === "hook-config-slice") {
    payload.preimage = null;
    payload.preimage_present = false;
    payload.preimage_marker = null;
    if (payload.codex_feature) {
      payload.codex_feature.preimage_block = null;
    }
  } else if (payload.payload_kind === "toml-owned-block") {
    payload.preimage_block = null;
    payload.preimage_marker = null;
  } else if (payload.projection.kind === "file") payload.projection.preimage_base64 = "";
  else payload.projection.preimage = null;
  return payload;
}

export function assertPersistedPrivateEffectPayload(value: CapabilityPrivateEffectPayloadV1): void {
  assertPrivateEffectPayloadShape(value);
  if (
    value.payload_kind !== "memory-test-only" &&
    canonicalJson(persistedPrivateEffectPayload(value)) !== canonicalJson(value)
  )
    throw new CapabilityValidationError(
      "persisted private payload contains inline preimage authority",
      value.ownership_key,
    );
}

export function privateEffectPreimageBytes(
  payload: CapabilityPrivateEffectPayloadV1,
): Uint8Array | null {
  if (payload.payload_kind === "memory-test-only") return null;
  let bytes: Uint8Array | null;
  if (payload.payload_kind === "owned-file") {
    bytes = projectionStateBytes(
      payload.preimage_base64,
      jsonFromBase64(payload.preimage_marker_base64, payload.ownership_key),
      [],
      payload.preimage_base64 !== null,
    );
  } else if (payload.payload_kind === "json-key-slice") {
    bytes = projectionStateBytes(
      payload.preimage,
      payload.preimage_marker,
      payload.auxiliary_files.map((file) => file.preimage_base64),
      payload.preimage_present,
    );
  } else if (payload.payload_kind === "hook-config-slice") {
    bytes = projectionStateBytes(
      payload.preimage,
      payload.preimage_marker,
      payload.codex_feature === null ? [] : [payload.codex_feature.preimage_block],
      payload.preimage_present,
    );
  } else if (payload.payload_kind === "toml-owned-block") {
    bytes = projectionStateBytes(
      payload.preimage_block,
      payload.preimage_marker,
      [],
      payload.preimage_block !== null,
    );
  } else if (payload.projection.kind === "file") {
    bytes = Buffer.from(payload.projection.preimage_base64, "base64");
    if (Buffer.from(bytes).toString("base64") !== payload.projection.preimage_base64)
      throw new CapabilityValidationError(
        "legacy projection preimage is not canonical base64",
        payload.ownership_key,
      );
  } else {
    bytes = canonicalJsonBytes(payload.projection.preimage);
  }
  const rawSha = bytes === null ? null : sha256Digest(bytes).slice("sha256:".length);
  if (rawSha !== payload.expected_preimage_sha256)
    throw new CapabilityValidationError(
      "owned projection raw preimage differs from its expected SHA-256",
      payload.ownership_key,
    );
  return bytes;
}

export function bindResourcePreimage(
  resource: CapabilityOwnedResourceV1,
  bytes: Uint8Array | null,
): CapabilityOwnedResourceV1 {
  if (bytes === null) {
    if (resource.expected_preimage_sha256 !== null)
      throw new CapabilityValidationError(
        "owned projection lacks its raw preimage authority",
        resource.ownership_key,
      );
    return { ...resource, private_preimage_digest: null, private_preimage_ref: null };
  }
  if (sha256Digest(bytes).slice("sha256:".length) !== resource.expected_preimage_sha256)
    throw new CapabilityValidationError(
      "owned projection expected preimage differs from raw blob SHA-256",
      resource.ownership_key,
    );
  const digest = digestV1Bytes("VF-ADAPTER-PRIVATE-PREIMAGE\0v1\0", bytes);
  return {
    ...resource,
    private_preimage_digest: digest,
    private_preimage_ref: `actions/v1/blobs/${digestHex(digest)}.bin`,
  };
}

export function hydratePrivateEffectPayload(
  persisted: CapabilityPrivateEffectPayloadV1,
  bytes: Uint8Array | null,
): CapabilityPrivateEffectPayloadV1 {
  assertPersistedPrivateEffectPayload(persisted);
  if (persisted.payload_kind === "memory-test-only") return structuredClone(persisted);
  if (bytes === null) {
    if (persisted.expected_preimage_sha256 !== null)
      throw new CapabilityValidationError(
        "owned projection preimage authority is absent",
        persisted.ownership_key,
      );
    return structuredClone(persisted);
  }
  if (persisted.payload_kind === "legacy-claim") return hydrateLegacyPreimage(persisted, bytes);
  let decoded: unknown;
  try {
    decoded = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CapabilityValidationError(
      "owned projection preimage authority is corrupt",
      persisted.ownership_key,
    );
  }
  if (!Buffer.from(bytes).equals(canonicalJsonBytes(decoded)))
    throw new CapabilityValidationError(
      "owned projection preimage authority is not canonical",
      persisted.ownership_key,
    );
  const record = decoded as {
    schema_version?: unknown;
    value_present?: unknown;
    value?: unknown;
    marker?: unknown;
    auxiliary?: unknown;
  };
  if (
    record.schema_version !== "1.0" ||
    typeof record.value_present !== "boolean" ||
    !("value" in record) ||
    !("marker" in record) ||
    !Array.isArray(record.auxiliary) ||
    Object.keys(record).sort().join("\0") !==
      ["auxiliary", "marker", "schema_version", "value", "value_present"].join("\0") ||
    (!record.value_present && record.value !== null) ||
    sha256Digest(bytes).slice("sha256:".length) !== persisted.expected_preimage_sha256
  )
    throw new CapabilityValidationError(
      "owned projection blob is not bound to its private descriptor",
      persisted.ownership_key,
    );
  const marker = record.marker as CapabilityPrivateJsonV1 | null;
  const hydrated = hydratePayloadFields(persisted, {
    present: record.value_present,
    value: record.value,
    marker,
    auxiliary: record.auxiliary,
  });
  privateEffectPreimageBytes(hydrated);
  return hydrated;
}

interface ProjectionPreimageStateV1 {
  present: boolean;
  value: unknown;
  marker: CapabilityPrivateJsonV1 | null;
  auxiliary: unknown[];
}

function jsonFromBase64(value: string | null, field: string): CapabilityPrivateJsonV1 | null {
  if (value === null) return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value)
    throw new CapabilityValidationError("owned projection marker is not canonical base64", field);
  let decoded: unknown;
  try {
    decoded = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CapabilityValidationError("owned projection marker is corrupt", field);
  }
  if (!bytes.equals(canonicalJsonBytes(decoded)))
    throw new CapabilityValidationError("owned projection marker is not canonical JSON", field);
  return decoded as CapabilityPrivateJsonV1;
}

function canonicalBase64(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string")
    throw new CapabilityValidationError("owned projection preimage is not base64", field);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value)
    throw new CapabilityValidationError("owned projection preimage is not canonical base64", field);
  return value;
}

function assertNoAuxiliary(state: ProjectionPreimageStateV1, field: string): void {
  if (state.auxiliary.length !== 0)
    throw new CapabilityValidationError(
      "owned projection preimage has extra auxiliary state",
      field,
    );
}

function hydratePayloadFields(
  persisted: Exclude<
    CapabilityPrivateEffectPayloadV1,
    { payload_kind: "legacy-claim" | "memory-test-only" }
  >,
  state: ProjectionPreimageStateV1,
): CapabilityPrivateEffectPayloadV1 {
  const payload = structuredClone(persisted);
  if (payload.payload_kind === "owned-file") {
    assertNoAuxiliary(state, payload.ownership_key);
    payload.preimage_base64 = state.present
      ? canonicalBase64(state.value, payload.ownership_key)
      : null;
    if (state.present && payload.preimage_base64 === null)
      throw new CapabilityValidationError(
        "owned file preimage presence is invalid",
        payload.ownership_key,
      );
    payload.preimage_marker_base64 =
      state.marker === null ? null : canonicalJsonBytes(state.marker).toString("base64");
    return payload;
  }
  if (payload.payload_kind === "json-key-slice") {
    if (state.auxiliary.length !== payload.auxiliary_files.length)
      throw new CapabilityValidationError(
        "JSON owned projection auxiliary preimage count differs",
        payload.ownership_key,
      );
    payload.preimage = structuredClone(state.value as CapabilityPrivateJsonV1 | null);
    payload.preimage_present = state.present;
    payload.preimage_marker = structuredClone(state.marker);
    for (const [index, file] of payload.auxiliary_files.entries())
      file.preimage_base64 = canonicalBase64(
        state.auxiliary[index],
        `${payload.ownership_key}.auxiliary[${index}]`,
      );
    return payload;
  }
  if (payload.payload_kind === "hook-config-slice") {
    const expectedAuxiliary = payload.codex_feature === null ? 0 : 1;
    if (state.auxiliary.length !== expectedAuxiliary)
      throw new CapabilityValidationError(
        "hook owned projection auxiliary preimage count differs",
        payload.ownership_key,
      );
    payload.preimage = structuredClone(state.value as CapabilityPrivateJsonV1 | null);
    payload.preimage_present = state.present;
    payload.preimage_marker = structuredClone(state.marker);
    if (payload.codex_feature !== null) {
      const block = state.auxiliary[0];
      if (block !== null && typeof block !== "string")
        throw new CapabilityValidationError(
          "Codex hook preimage block is invalid",
          payload.ownership_key,
        );
      payload.codex_feature.preimage_block = block as string | null;
    }
    return payload;
  }
  assertNoAuxiliary(state, payload.ownership_key);
  if (state.value !== null && typeof state.value !== "string")
    throw new CapabilityValidationError(
      "TOML owned block preimage is invalid",
      payload.ownership_key,
    );
  payload.preimage_block = state.present ? (state.value as string) : null;
  payload.preimage_marker = structuredClone(state.marker);
  return payload;
}

function hydrateLegacyPreimage(
  persisted: Extract<CapabilityPrivateEffectPayloadV1, { payload_kind: "legacy-claim" }>,
  bytes: Uint8Array,
): CapabilityPrivateEffectPayloadV1 {
  if (sha256Digest(bytes).slice("sha256:".length) !== persisted.expected_preimage_sha256)
    throw new CapabilityValidationError(
      "legacy projection raw preimage differs from its expected SHA-256",
      persisted.ownership_key,
    );
  const payload = structuredClone(persisted);
  if (payload.projection.kind === "file") {
    payload.projection.preimage_base64 = Buffer.from(bytes).toString("base64");
  } else {
    let decoded: unknown;
    try {
      decoded = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new CapabilityValidationError(
        "legacy JSON projection preimage is corrupt",
        payload.ownership_key,
      );
    }
    if (!Buffer.from(bytes).equals(canonicalJsonBytes(decoded)))
      throw new CapabilityValidationError(
        "legacy JSON projection preimage is not canonical",
        payload.ownership_key,
      );
    payload.projection.preimage = decoded as CapabilityPrivateJsonV1;
  }
  return payload;
}
