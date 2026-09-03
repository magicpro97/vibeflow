import { canonicalJsonBytes } from "../../durability/index.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import {
  boundedProjectionPath,
  bytesEqual,
  parseProjectionJson,
  readJsonSlice,
  readProjectionFile,
  tomlOwnedBlock,
} from "./filesystem-io.js";
import type { ProjectionBuilderRootsV1 } from "./projection-builders.js";
import type { CapabilityPrivateEffectPayloadV1 } from "./types.js";

function decode(value: string | null): Buffer | null {
  return value === null ? null : Buffer.from(value, "base64");
}

export function assertPayloadPreimageBytes(
  payload: CapabilityPrivateEffectPayloadV1,
  roots: ProjectionBuilderRootsV1,
): void {
  if (payload.payload_kind === "legacy-claim") {
    const root = roots[payload.root];
    if (payload.projection.kind === "file") {
      if (
        !bytesEqual(
          readProjectionFile(
            boundedProjectionPath(root, payload.projection.canonical_relative_path),
          ),
          decode(payload.projection.preimage_base64),
        )
      )
        throw new CapabilityValidationError(
          "legacy file exact preimage changed",
          payload.ownership_key,
        );
      return;
    }
    const config = parseProjectionJson(
      readProjectionFile(boundedProjectionPath(root, payload.projection.canonical_relative_path)),
      payload.projection.canonical_relative_path,
    );
    const slice = readJsonSlice(config, payload.projection.key_path);
    if (
      !slice.present ||
      !bytesEqual(canonicalJsonBytes(slice.value), canonicalJsonBytes(payload.projection.preimage))
    )
      throw new CapabilityValidationError(
        "legacy config exact preimage changed",
        payload.ownership_key,
      );
    return;
  }
  if (payload.payload_kind === "owned-file") {
    const root = roots[payload.root];
    if (
      !bytesEqual(
        readProjectionFile(boundedProjectionPath(root, payload.canonical_relative_path)),
        decode(payload.preimage_base64),
      ) ||
      !bytesEqual(
        readProjectionFile(boundedProjectionPath(root, payload.marker_relative_path)),
        decode(payload.preimage_marker_base64),
      )
    )
      throw new CapabilityValidationError(
        "owned file exact preimage bytes changed",
        payload.ownership_key,
      );
    return;
  }
  if (payload.payload_kind === "json-key-slice") {
    assertJsonPreimage(payload, roots);
    return;
  }
  if (payload.payload_kind === "hook-config-slice") {
    assertHookPreimage(payload, roots);
    return;
  }
  if (payload.payload_kind === "toml-owned-block") assertTomlPreimage(payload, roots);
}

function assertJsonPreimage(
  payload: Extract<CapabilityPrivateEffectPayloadV1, { payload_kind: "json-key-slice" }>,
  roots: ProjectionBuilderRootsV1,
): void {
  const root = roots[payload.root];
  const config = parseProjectionJson(
    readProjectionFile(boundedProjectionPath(root, payload.canonical_relative_path)),
    payload.canonical_relative_path,
  );
  const slice = readJsonSlice(config, payload.key_path);
  const marker = readProjectionFile(boundedProjectionPath(root, payload.marker_relative_path));
  const expectedMarker =
    payload.preimage_marker === null ? null : canonicalJsonBytes(payload.preimage_marker);
  const auxiliaryExact = payload.auxiliary_files.every((file) =>
    bytesEqual(
      readProjectionFile(boundedProjectionPath(root, file.canonical_relative_path)),
      decode(file.preimage_base64),
    ),
  );
  if (
    slice.present !== payload.preimage_present ||
    !bytesEqual(canonicalJsonBytes(slice.value), canonicalJsonBytes(payload.preimage)) ||
    !bytesEqual(marker, expectedMarker) ||
    !auxiliaryExact
  )
    throw new CapabilityValidationError(
      "JSON owned slice exact preimage changed",
      payload.ownership_key,
    );
}

function assertHookPreimage(
  payload: Extract<CapabilityPrivateEffectPayloadV1, { payload_kind: "hook-config-slice" }>,
  roots: ProjectionBuilderRootsV1,
): void {
  const root = roots[payload.root];
  const config = parseProjectionJson(
    readProjectionFile(boundedProjectionPath(root, payload.canonical_relative_path)),
    payload.canonical_relative_path,
  );
  const slice = readJsonSlice(config, payload.key_path);
  const marker = readProjectionFile(boundedProjectionPath(root, payload.marker_relative_path));
  const expectedMarker =
    payload.preimage_marker === null ? null : canonicalJsonBytes(payload.preimage_marker);
  const featureExact =
    payload.codex_feature === null ||
    tomlOwnedBlock(
      readProjectionFile(
        boundedProjectionPath(root, payload.codex_feature.canonical_relative_path),
      )?.toString("utf8") ?? "",
      payload.codex_feature.block_id,
    ) === payload.codex_feature.preimage_block;
  if (
    slice.present !== payload.preimage_present ||
    !bytesEqual(canonicalJsonBytes(slice.value), canonicalJsonBytes(payload.preimage)) ||
    !bytesEqual(marker, expectedMarker) ||
    !featureExact
  )
    throw new CapabilityValidationError(
      "hook config exact preimage changed",
      payload.ownership_key,
    );
}

function assertTomlPreimage(
  payload: Extract<CapabilityPrivateEffectPayloadV1, { payload_kind: "toml-owned-block" }>,
  roots: ProjectionBuilderRootsV1,
): void {
  const root = roots[payload.root];
  const text =
    readProjectionFile(boundedProjectionPath(root, payload.canonical_relative_path))?.toString(
      "utf8",
    ) ?? "";
  const marker = readProjectionFile(boundedProjectionPath(root, payload.marker_relative_path));
  const expectedMarker =
    payload.preimage_marker === null ? null : canonicalJsonBytes(payload.preimage_marker);
  if (
    tomlOwnedBlock(text, payload.block_id) !== payload.preimage_block ||
    !bytesEqual(marker, expectedMarker)
  )
    throw new CapabilityValidationError(
      "TOML owned block exact preimage changed",
      payload.ownership_key,
    );
}
