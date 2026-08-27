import { canonicalJsonBytes, sha256Digest } from "../../durability/index.js";
import {
  CAPABILITY_OPERATION_RECOVERY_PHASE,
  type CapabilityOperationRecoveryPhaseV1,
} from "../wire/operation-state-contract.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import {
  type CapabilityInternalCasFaultV1,
  boundedProjectionPath,
  compareAndSwapProjectionFile,
  compareAndSwapTomlOwnedBlock,
  parseProjectionJson,
  projectionStateDigest,
  readJsonSlice,
  readProjectionFile,
  tomlOwnedBlock,
  writeJsonSlice,
} from "./filesystem-io.js";
import type { ProjectionBuilderRootsV1 } from "./projection-builders.js";
import type { CapabilityPrivateEffectPayloadV1, CapabilityPrivateJsonV1 } from "./types.js";

function rootFor(
  payload: CapabilityPrivateEffectPayloadV1,
  roots: ProjectionBuilderRootsV1,
): string {
  if (payload.payload_kind === "memory-test-only")
    throw new CapabilityValidationError("payload has no filesystem root", "private_payload");
  return roots[payload.root];
}

function decode(value: string | null): Buffer | null {
  return value === null ? null : Buffer.from(value, "base64");
}

function markerValue(bytes: Buffer | null, path: string): CapabilityPrivateJsonV1 | null {
  return bytes === null ? null : parseProjectionJson(bytes, path);
}

function projectionCas(
  path: string,
  expected: Buffer | null,
  replacement: Buffer | null,
  mode: number,
  fault?: CapabilityInternalCasFaultV1,
): void {
  compareAndSwapProjectionFile(path, expected, replacement, mode);
  fault?.({ phase: "after-cas", absolute_path: path, surface: "projection" });
}

export function observeFilesystemPayload(
  payload: CapabilityPrivateEffectPayloadV1,
  roots: ProjectionBuilderRootsV1,
): string | null {
  if (payload.payload_kind === "legacy-claim") {
    const root = roots[payload.root];
    if (payload.projection.kind === "file") {
      const bytes = readProjectionFile(
        boundedProjectionPath(root, payload.projection.canonical_relative_path),
      );
      return bytes === null ? null : sha256Digest(bytes).slice("sha256:".length);
    }
    const config = parseProjectionJson(
      readProjectionFile(boundedProjectionPath(root, payload.projection.canonical_relative_path)),
      payload.projection.canonical_relative_path,
    );
    const slice = readJsonSlice(config, payload.projection.key_path);
    return slice.present
      ? sha256Digest(canonicalJsonBytes(slice.value)).slice("sha256:".length)
      : null;
  }
  if (payload.payload_kind === "memory-test-only")
    throw new CapabilityValidationError(
      "memory payload reached production filesystem broker",
      "private_payload",
    );
  const root = rootFor(payload, roots);
  if (payload.payload_kind === "owned-file") {
    const value = readProjectionFile(boundedProjectionPath(root, payload.canonical_relative_path));
    const marker = readProjectionFile(boundedProjectionPath(root, payload.marker_relative_path));
    return projectionStateDigest(
      value?.toString("base64") ?? null,
      markerValue(marker, payload.marker_relative_path),
      [],
      value !== null,
    );
  }
  if (payload.payload_kind === "json-key-slice") {
    const config = parseProjectionJson(
      readProjectionFile(boundedProjectionPath(root, payload.canonical_relative_path)),
      payload.canonical_relative_path,
    );
    const slice = readJsonSlice(config, payload.key_path);
    const marker = readProjectionFile(boundedProjectionPath(root, payload.marker_relative_path));
    const auxiliary = payload.auxiliary_files.map(
      (file) =>
        readProjectionFile(boundedProjectionPath(root, file.canonical_relative_path))?.toString(
          "base64",
        ) ?? null,
    );
    return projectionStateDigest(
      slice.value,
      markerValue(marker, payload.marker_relative_path),
      auxiliary,
      slice.present,
    );
  }
  if (payload.payload_kind === "hook-config-slice") {
    const config = parseProjectionJson(
      readProjectionFile(boundedProjectionPath(root, payload.canonical_relative_path)),
      payload.canonical_relative_path,
    );
    const slice = readJsonSlice(config, payload.key_path);
    const marker = readProjectionFile(boundedProjectionPath(root, payload.marker_relative_path));
    const feature =
      payload.codex_feature === null
        ? []
        : [
            tomlOwnedBlock(
              readProjectionFile(
                boundedProjectionPath(root, payload.codex_feature.canonical_relative_path),
              )?.toString("utf8") ?? "",
              payload.codex_feature.block_id,
            ),
          ];
    return projectionStateDigest(
      slice.value,
      markerValue(marker, payload.marker_relative_path),
      feature,
      slice.present,
    );
  }
  const text =
    readProjectionFile(boundedProjectionPath(root, payload.canonical_relative_path))?.toString(
      "utf8",
    ) ?? "";
  const marker = readProjectionFile(boundedProjectionPath(root, payload.marker_relative_path));
  const block = tomlOwnedBlock(text, payload.block_id);
  return projectionStateDigest(
    block,
    markerValue(marker, payload.marker_relative_path),
    [],
    block !== null,
  );
}

function applyFile(
  payload: Extract<CapabilityPrivateEffectPayloadV1, { payload_kind: "owned-file" }>,
  roots: ProjectionBuilderRootsV1,
  forward: boolean,
  fault?: CapabilityInternalCasFaultV1,
): void {
  const root = roots[payload.root];
  const content = decode(forward ? payload.postimage_base64 : payload.preimage_base64);
  const marker = decode(forward ? payload.postimage_marker_base64 : payload.preimage_marker_base64);
  const expectedContent = decode(forward ? payload.preimage_base64 : payload.postimage_base64);
  const expectedMarker = decode(
    forward ? payload.preimage_marker_base64 : payload.postimage_marker_base64,
  );
  projectionCas(
    boundedProjectionPath(root, payload.canonical_relative_path),
    expectedContent,
    content,
    payload.file_mode,
    fault,
  );
  projectionCas(
    boundedProjectionPath(root, payload.marker_relative_path),
    expectedMarker,
    marker,
    0o600,
    fault,
  );
}

function expectedSlice(
  payload: Extract<
    CapabilityPrivateEffectPayloadV1,
    { payload_kind: "json-key-slice" | "hook-config-slice" }
  >,
  forward: boolean,
): {
  present: boolean;
  value: CapabilityPrivateJsonV1 | null;
  marker: CapabilityPrivateJsonV1 | null;
} {
  return forward
    ? {
        present: payload.postimage_present,
        value: payload.postimage,
        marker: payload.postimage_marker,
      }
    : {
        present: payload.preimage_present,
        value: payload.preimage,
        marker: payload.preimage_marker,
      };
}

function applyJson(
  payload: Extract<CapabilityPrivateEffectPayloadV1, { payload_kind: "json-key-slice" }>,
  roots: ProjectionBuilderRootsV1,
  forward: boolean,
  fault?: CapabilityInternalCasFaultV1,
): void {
  const root = roots[payload.root];
  const path = boundedProjectionPath(root, payload.canonical_relative_path);
  const currentBytes = readProjectionFile(path);
  const current = parseProjectionJson(currentBytes, payload.canonical_relative_path);
  const desired = expectedSlice(payload, forward);
  const next = writeJsonSlice(current, payload.key_path, desired.present, desired.value);
  projectionCas(path, currentBytes, canonicalJsonBytes(next), 0o600, fault);
  for (const file of payload.auxiliary_files) {
    const bytes = decode(forward ? file.postimage_base64 : file.preimage_base64);
    const expected = decode(forward ? file.preimage_base64 : file.postimage_base64);
    projectionCas(
      boundedProjectionPath(root, file.canonical_relative_path),
      expected,
      bytes,
      file.file_mode,
      fault,
    );
  }
  const priorMarker = forward ? payload.preimage_marker : payload.postimage_marker;
  projectionCas(
    boundedProjectionPath(root, payload.marker_relative_path),
    priorMarker === null ? null : canonicalJsonBytes(priorMarker),
    desired.marker === null ? null : canonicalJsonBytes(desired.marker),
    0o600,
    fault,
  );
}

function applyHookConfig(
  payload: Extract<CapabilityPrivateEffectPayloadV1, { payload_kind: "hook-config-slice" }>,
  roots: ProjectionBuilderRootsV1,
  forward: boolean,
  fault?: CapabilityInternalCasFaultV1,
): void {
  const root = roots[payload.root];
  const path = boundedProjectionPath(root, payload.canonical_relative_path);
  const currentBytes = readProjectionFile(path);
  const current = parseProjectionJson(currentBytes, payload.canonical_relative_path);
  const desired = expectedSlice(payload, forward);
  const next = writeJsonSlice(current, payload.key_path, desired.present, desired.value);
  projectionCas(path, currentBytes, canonicalJsonBytes(next), 0o600, fault);
  if (payload.codex_feature !== null) {
    const feature = payload.codex_feature;
    const featurePath = boundedProjectionPath(root, feature.canonical_relative_path);
    compareAndSwapTomlOwnedBlock(
      featurePath,
      feature.block_id,
      forward ? feature.preimage_block : feature.postimage_block,
      forward ? feature.postimage_block : feature.preimage_block,
      0o600,
      feature.placement,
    );
    fault?.({ phase: "after-cas", absolute_path: featurePath, surface: "projection" });
  }
  const priorMarker = forward ? payload.preimage_marker : payload.postimage_marker;
  projectionCas(
    boundedProjectionPath(root, payload.marker_relative_path),
    priorMarker === null ? null : canonicalJsonBytes(priorMarker),
    desired.marker === null ? null : canonicalJsonBytes(desired.marker),
    0o600,
    fault,
  );
}

function applyToml(
  payload: Extract<CapabilityPrivateEffectPayloadV1, { payload_kind: "toml-owned-block" }>,
  roots: ProjectionBuilderRootsV1,
  forward: boolean,
  fault?: CapabilityInternalCasFaultV1,
): void {
  const root = roots[payload.root];
  const path = boundedProjectionPath(root, payload.canonical_relative_path);
  const block = forward ? payload.postimage_block : payload.preimage_block;
  const marker = forward ? payload.postimage_marker : payload.preimage_marker;
  compareAndSwapTomlOwnedBlock(
    path,
    payload.block_id,
    forward ? payload.preimage_block : payload.postimage_block,
    block,
    0o600,
  );
  fault?.({ phase: "after-cas", absolute_path: path, surface: "projection" });
  const priorMarker = forward ? payload.preimage_marker : payload.postimage_marker;
  projectionCas(
    boundedProjectionPath(root, payload.marker_relative_path),
    priorMarker === null ? null : canonicalJsonBytes(priorMarker),
    marker === null ? null : canonicalJsonBytes(marker),
    0o600,
    fault,
  );
}

export function mutateFilesystemPayload(
  payload: CapabilityPrivateEffectPayloadV1,
  roots: ProjectionBuilderRootsV1,
  direction: CapabilityOperationRecoveryPhaseV1,
  fault?: CapabilityInternalCasFaultV1,
): void {
  if (payload.payload_kind === "legacy-claim") return;
  if (payload.payload_kind === "memory-test-only")
    throw new CapabilityValidationError(
      "memory payload reached production filesystem broker",
      "private_payload",
    );
  const forward = direction === CAPABILITY_OPERATION_RECOVERY_PHASE.FORWARD;
  if (payload.payload_kind === "owned-file") applyFile(payload, roots, forward, fault);
  else if (payload.payload_kind === "json-key-slice") applyJson(payload, roots, forward, fault);
  else if (payload.payload_kind === "hook-config-slice")
    applyHookConfig(payload, roots, forward, fault);
  else applyToml(payload, roots, forward, fault);
}
