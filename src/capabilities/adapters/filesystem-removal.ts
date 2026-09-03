import { digestV1Bytes } from "../../durability/canonical.js";
import { digestHex } from "../../durability/index.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import { observeFilesystemPayload } from "./filesystem-effects.js";
import {
  boundedProjectionPath,
  parseProjectionJson,
  readJsonSlice,
  readProjectionFile,
  tomlOwnedBlock,
} from "./filesystem-io.js";
import { privateEffectPayloadDigest } from "./private-descriptors.js";
import { privatePreimageBytes } from "./projection-builder-shared.js";
import type {
  BuiltFilesystemProjectionV1,
  ProjectionBuilderRootsV1,
} from "./projection-builders.js";
import type { CapabilityOwnedResourceV1, CapabilityPrivateEffectPayloadV1 } from "./types.js";

function markerValue(bytes: Buffer | null, field: string) {
  return bytes === null ? null : parseProjectionJson(bytes, field);
}

type PayloadDraft = CapabilityPrivateEffectPayloadV1 extends infer T
  ? T extends { payload_digest: string }
    ? Omit<T, "payload_digest">
    : never
  : never;

function finalize(draft: PayloadDraft) {
  const provisional = { ...draft, payload_digest: "" } as CapabilityPrivateEffectPayloadV1;
  return {
    ...draft,
    payload_digest: privateEffectPayloadDigest(provisional),
  } as CapabilityPrivateEffectPayloadV1;
}

function retainedPreimage(
  value: unknown,
  marker: unknown,
  auxiliary: unknown[],
  valuePresent = value !== null,
): {
  bytes: Uint8Array | null;
  digest: string | null;
  ref: string | null;
} {
  const bytes = privatePreimageBytes(value, marker, auxiliary, valuePresent);
  if (bytes === null) return { bytes, digest: null, ref: null };
  const digest = digestV1Bytes("VF-ADAPTER-PRIVATE-PREIMAGE\0v1\0", bytes);
  return { bytes, digest, ref: `actions/v1/blobs/${digestHex(digest)}.bin` };
}

export function buildFilesystemRemoval(
  resource: CapabilityOwnedResourceV1,
  original: CapabilityPrivateEffectPayloadV1,
  roots: ProjectionBuilderRootsV1,
): BuiltFilesystemProjectionV1 {
  if (original.payload_kind === "memory-test-only" || original.payload_kind === "legacy-claim")
    throw new CapabilityValidationError(
      "projection cannot be removed by filesystem broker",
      resource.ownership_key,
    );
  const root = roots[original.root];
  const observed = observeFilesystemPayload(original, roots);
  let payload: CapabilityPrivateEffectPayloadV1;
  let preimageValue: unknown;
  let preimagePresent: boolean;
  let preimageMarker: unknown = null;
  let preimageAuxiliary: unknown[] = [];
  if (original.payload_kind === "owned-file") {
    const value = readProjectionFile(boundedProjectionPath(root, original.canonical_relative_path));
    const marker = readProjectionFile(boundedProjectionPath(root, original.marker_relative_path));
    preimageValue = value?.toString("base64") ?? null;
    preimagePresent = value !== null;
    preimageMarker = markerValue(marker, original.marker_relative_path);
    payload = finalize({
      ...original,
      expected_preimage_sha256: observed,
      expected_postimage_sha256: null,
      preimage_base64: value?.toString("base64") ?? null,
      postimage_base64: null,
      preimage_marker_base64: marker?.toString("base64") ?? null,
      postimage_marker_base64: null,
    });
  } else if (original.payload_kind === "json-key-slice") {
    const config = parseProjectionJson(
      readProjectionFile(boundedProjectionPath(root, original.canonical_relative_path)),
      original.canonical_relative_path,
    );
    const slice = readJsonSlice(config, original.key_path);
    const markerBytes = readProjectionFile(
      boundedProjectionPath(root, original.marker_relative_path),
    );
    const marker = markerValue(markerBytes, original.marker_relative_path);
    const auxiliary = original.auxiliary_files.map((file) => ({
      ...file,
      preimage_base64:
        readProjectionFile(boundedProjectionPath(root, file.canonical_relative_path))?.toString(
          "base64",
        ) ?? null,
      postimage_base64: null,
    }));
    preimageValue = slice.present ? slice.value : null;
    preimagePresent = slice.present;
    preimageMarker = marker;
    preimageAuxiliary = auxiliary.map((file) => file.preimage_base64);
    payload = finalize({
      ...original,
      expected_preimage_sha256: observed,
      expected_postimage_sha256: null,
      preimage: slice.value,
      preimage_present: slice.present,
      postimage: null,
      postimage_present: false,
      preimage_marker: marker,
      postimage_marker: null,
      auxiliary_files: auxiliary,
    });
  } else if (original.payload_kind === "hook-config-slice") {
    const config = parseProjectionJson(
      readProjectionFile(boundedProjectionPath(root, original.canonical_relative_path)),
      original.canonical_relative_path,
    );
    const slice = readJsonSlice(config, original.key_path);
    const markerBytes = readProjectionFile(
      boundedProjectionPath(root, original.marker_relative_path),
    );
    const marker = markerValue(markerBytes, original.marker_relative_path);
    let feature = original.codex_feature;
    let featureBlock: string | null = null;
    if (feature !== null) {
      const current =
        readProjectionFile(boundedProjectionPath(root, feature.canonical_relative_path))?.toString(
          "utf8",
        ) ?? "";
      featureBlock = tomlOwnedBlock(current, feature.block_id);
      feature = {
        ...feature,
        preimage_block: featureBlock,
        postimage_block: null,
      };
    }
    preimageValue = slice.present ? slice.value : null;
    preimagePresent = slice.present;
    preimageMarker = marker;
    preimageAuxiliary = feature === null ? [] : [featureBlock];
    payload = finalize({
      ...original,
      expected_preimage_sha256: observed,
      expected_postimage_sha256: null,
      preimage: slice.value,
      preimage_present: slice.present,
      postimage: null,
      postimage_present: false,
      preimage_marker: marker,
      postimage_marker: null,
      codex_feature: feature,
    });
  } else {
    const text =
      readProjectionFile(boundedProjectionPath(root, original.canonical_relative_path))?.toString(
        "utf8",
      ) ?? "";
    const markerBytes = readProjectionFile(
      boundedProjectionPath(root, original.marker_relative_path),
    );
    const marker = markerValue(markerBytes, original.marker_relative_path);
    const block = tomlOwnedBlock(text, original.block_id);
    preimageValue = block;
    preimagePresent = block !== null;
    preimageMarker = marker;
    payload = finalize({
      ...original,
      expected_preimage_sha256: observed,
      expected_postimage_sha256: null,
      preimage_block: block,
      postimage_block: null,
      preimage_marker: marker,
      postimage_marker: null,
    });
  }
  const retained = retainedPreimage(
    preimageValue,
    preimageMarker,
    preimageAuxiliary,
    preimagePresent,
  );
  return {
    resource: {
      ...resource,
      expected_preimage_sha256: observed,
      expected_postimage_sha256: null,
      private_preimage_digest: retained.digest,
      private_preimage_ref: retained.ref,
    },
    private_payload: payload,
    private_preimage_bytes: retained.bytes,
  };
}
