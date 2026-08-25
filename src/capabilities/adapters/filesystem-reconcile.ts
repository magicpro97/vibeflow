import { canonicalJson, canonicalJsonBytes } from "../../durability/index.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import {
  boundedProjectionPath,
  bytesEqual,
  compareAndSwapProjectionFile,
  compareAndSwapTomlOwnedBlock,
  parseProjectionJson,
  readJsonSlice,
  readProjectionFile,
  tomlOwnedBlock,
  writeJsonSlice,
} from "./filesystem-io.js";
import type { ProjectionBuilderRootsV1 } from "./projection-builders.js";
import type { CapabilityPrivateEffectPayloadV1, CapabilityPrivateJsonV1 } from "./types.js";

function decode(value: string | null): Buffer | null {
  return value === null ? null : Buffer.from(value, "base64");
}

function reconcileBytes(input: {
  path: string;
  preimage: Buffer | null;
  postimage: Buffer | null;
  desired: Buffer | null;
  mode: number;
}): void {
  const current = readProjectionFile(input.path);
  if (bytesEqual(current, input.desired)) return;
  if (!bytesEqual(current, input.preimage) && !bytesEqual(current, input.postimage))
    throw new CapabilityValidationError("repair encountered an unapproved file state", input.path);
  compareAndSwapProjectionFile(input.path, current, input.desired, input.mode);
}

function sliceEqual(
  current: { present: boolean; value: CapabilityPrivateJsonV1 | null },
  present: boolean,
  value: CapabilityPrivateJsonV1 | null,
): boolean {
  return current.present === present && canonicalJson(current.value) === canonicalJson(value);
}

type SlicePayload = Extract<
  CapabilityPrivateEffectPayloadV1,
  { payload_kind: "json-key-slice" | "hook-config-slice" }
>;

function reconcileJsonSlice(
  payload: SlicePayload,
  roots: ProjectionBuilderRootsV1,
  direction: "forward" | "rollback",
): void {
  const root = roots[payload.root];
  const path = boundedProjectionPath(root, payload.canonical_relative_path);
  const currentBytes = readProjectionFile(path);
  const currentObject = parseProjectionJson(currentBytes, payload.canonical_relative_path);
  const current = readJsonSlice(currentObject, payload.key_path);
  const desiredPresent =
    direction === "forward" ? payload.postimage_present : payload.preimage_present;
  const desiredValue = direction === "forward" ? payload.postimage : payload.preimage;
  if (!sliceEqual(current, desiredPresent, desiredValue)) {
    const isPre = sliceEqual(current, payload.preimage_present, payload.preimage);
    const isPost = sliceEqual(current, payload.postimage_present, payload.postimage);
    if (!isPre && !isPost)
      throw new CapabilityValidationError(
        "repair encountered an unapproved JSON slice",
        payload.ownership_key,
      );
    const replacement = writeJsonSlice(
      currentObject,
      payload.key_path,
      desiredPresent,
      desiredValue,
    );
    compareAndSwapProjectionFile(path, currentBytes, canonicalJsonBytes(replacement), 0o600);
  }
  if (payload.payload_kind === "json-key-slice") {
    for (const file of payload.auxiliary_files) {
      reconcileBytes({
        path: boundedProjectionPath(root, file.canonical_relative_path),
        preimage: decode(file.preimage_base64),
        postimage: decode(file.postimage_base64),
        desired: decode(direction === "forward" ? file.postimage_base64 : file.preimage_base64),
        mode: file.file_mode,
      });
    }
  } else if (payload.codex_feature !== null) {
    const feature = payload.codex_feature;
    reconcileTomlBlock(
      boundedProjectionPath(root, feature.canonical_relative_path),
      feature.block_id,
      feature.preimage_block,
      feature.postimage_block,
      direction === "forward" ? feature.postimage_block : feature.preimage_block,
      feature.placement,
    );
  }
  const preMarker =
    payload.preimage_marker === null ? null : canonicalJsonBytes(payload.preimage_marker);
  const postMarker =
    payload.postimage_marker === null ? null : canonicalJsonBytes(payload.postimage_marker);
  reconcileBytes({
    path: boundedProjectionPath(root, payload.marker_relative_path),
    preimage: preMarker,
    postimage: postMarker,
    desired: direction === "forward" ? postMarker : preMarker,
    mode: 0o600,
  });
}

function reconcileOwnedFile(
  payload: Extract<CapabilityPrivateEffectPayloadV1, { payload_kind: "owned-file" }>,
  roots: ProjectionBuilderRootsV1,
  direction: "forward" | "rollback",
): void {
  const root = roots[payload.root];
  const pre = decode(payload.preimage_base64);
  const post = decode(payload.postimage_base64);
  reconcileBytes({
    path: boundedProjectionPath(root, payload.canonical_relative_path),
    preimage: pre,
    postimage: post,
    desired: direction === "forward" ? post : pre,
    mode: payload.file_mode,
  });
  const preMarker = decode(payload.preimage_marker_base64);
  const postMarker = decode(payload.postimage_marker_base64);
  reconcileBytes({
    path: boundedProjectionPath(root, payload.marker_relative_path),
    preimage: preMarker,
    postimage: postMarker,
    desired: direction === "forward" ? postMarker : preMarker,
    mode: 0o600,
  });
}

function reconcileToml(
  payload: Extract<CapabilityPrivateEffectPayloadV1, { payload_kind: "toml-owned-block" }>,
  roots: ProjectionBuilderRootsV1,
  direction: "forward" | "rollback",
): void {
  const root = roots[payload.root];
  const path = boundedProjectionPath(root, payload.canonical_relative_path);
  const desired = direction === "forward" ? payload.postimage_block : payload.preimage_block;
  reconcileTomlBlock(
    path,
    payload.block_id,
    payload.preimage_block,
    payload.postimage_block,
    desired,
  );
  const preMarker =
    payload.preimage_marker === null ? null : canonicalJsonBytes(payload.preimage_marker);
  const postMarker =
    payload.postimage_marker === null ? null : canonicalJsonBytes(payload.postimage_marker);
  reconcileBytes({
    path: boundedProjectionPath(root, payload.marker_relative_path),
    preimage: preMarker,
    postimage: postMarker,
    desired: direction === "forward" ? postMarker : preMarker,
    mode: 0o600,
  });
}

function reconcileTomlBlock(
  path: string,
  blockId: string,
  preimage: string | null,
  postimage: string | null,
  desired: string | null,
  placement: "append" | "after-features-header" = "append",
): void {
  const currentBytes = readProjectionFile(path);
  const currentText = currentBytes?.toString("utf8") ?? "";
  const current = tomlOwnedBlock(currentText, blockId);
  if (current === desired) return;
  if (current !== preimage && current !== postimage)
    throw new CapabilityValidationError("repair encountered an unapproved TOML block", blockId);
  compareAndSwapTomlOwnedBlock(path, blockId, current, desired, 0o600, placement);
}

export function reconcileFilesystemPayload(
  payload: CapabilityPrivateEffectPayloadV1,
  roots: ProjectionBuilderRootsV1,
  direction: "forward" | "rollback",
): void {
  // A claim changes only the owner registry. Projection bytes are immutable
  // across both approved terminal directions.
  if (payload.payload_kind === "legacy-claim") return;
  if (payload.payload_kind === "memory-test-only")
    throw new CapabilityValidationError(
      "memory payload reached filesystem repair",
      payload.ownership_key,
    );
  if (payload.payload_kind === "owned-file") reconcileOwnedFile(payload, roots, direction);
  else if (payload.payload_kind === "toml-owned-block") reconcileToml(payload, roots, direction);
  else reconcileJsonSlice(payload, roots, direction);
}
