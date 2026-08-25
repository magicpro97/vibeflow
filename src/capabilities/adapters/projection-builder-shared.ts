import { createHash } from "node:crypto";
import { digestV1Bytes } from "../../durability/canonical.js";
import { canonicalJsonBytes, digestHex, digestV1 } from "../../durability/index.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import {
  boundedProjectionPath,
  parseProjectionJson,
  projectionStateBytes,
  readProjectionFile,
} from "./filesystem-io.js";
import { privateEffectPayloadDigest } from "./private-descriptors.js";
import type {
  CapabilityEffectPreparationRequestV1,
  CapabilityPrivateEffectPayloadV1,
  CapabilityPrivateJsonV1,
} from "./types.js";

export function rawSha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function projectionOwnershipKey(input: CapabilityEffectPreparationRequestV1): string {
  const { target, package: pkg, component } = input;
  return `vf:${target.scope}:${target.engine}:${target.participant_id ?? "global"}:${component.type}:${pkg.pin.id}:${component.component_id}`;
}

export function projectionName(input: CapabilityEffectPreparationRequestV1): string {
  const base = `${input.package.pin.id}--${input.component.component_id}`;
  if (input.target.participant_id === null) return base;
  return `${base}--p-${digestHex(
    digestV1("VF-CAPABILITY-PARTICIPANT-TARGET\0v1\0", input.target.participant_id),
  ).slice(0, 16)}`;
}

export function markerPath(key: string): string {
  return `.vibeflow/private/capabilities/ownership/v1/${digestHex(digestV1("VF-CAPABILITY-OWNERSHIP-KEY\0v1\0", key))}.json`;
}

export function privatePreimageBytes(
  value: unknown,
  marker: unknown,
  auxiliary: unknown[] = [],
  valuePresent = value !== null,
): Uint8Array | null {
  return projectionStateBytes(value, marker, auxiliary, valuePresent);
}

function privatePreimage(bytes: Uint8Array | null): { digest: string | null; ref: string | null } {
  if (bytes === null) return { digest: null, ref: null };
  const digest = digestV1Bytes("VF-ADAPTER-PRIVATE-PREIMAGE\0v1\0", bytes);
  return { digest, ref: `actions/v1/blobs/${digestHex(digest)}.bin` };
}

export function finalizePayload(
  draft: Omit<CapabilityPrivateEffectPayloadV1, "payload_digest">,
): CapabilityPrivateEffectPayloadV1 {
  const provisional = { ...draft, payload_digest: "" } as CapabilityPrivateEffectPayloadV1;
  return {
    ...draft,
    payload_digest: privateEffectPayloadDigest(provisional),
  } as CapabilityPrivateEffectPayloadV1;
}

export function projectionResource(
  key: string,
  kind: "file" | "config-key",
  target: string,
  preimage: string | null,
  postimage: string | null,
  preimageBytes: Uint8Array | null,
) {
  const retained = privatePreimage(preimageBytes);
  return {
    ownership_key: key,
    kind,
    public_target: target,
    expected_preimage_sha256: preimage,
    expected_postimage_sha256: postimage,
    private_preimage_digest: retained.digest,
    private_preimage_ref: retained.ref,
  };
}

export function readMarker(
  root: string,
  relativePath: string,
): { bytes: Buffer | null; value: CapabilityPrivateJsonV1 | null } {
  const bytes = readProjectionFile(boundedProjectionPath(root, relativePath));
  if (bytes === null) return { bytes, value: null };
  return { bytes, value: parseProjectionJson(bytes, relativePath) };
}

export function assertOwnedOrAbsent(
  key: string,
  live: unknown,
  marker: CapabilityPrivateJsonV1 | null,
): void {
  if (live !== null && marker === null)
    throw new CapabilityValidationError("unmanaged target requires explicit adoption", key);
  if (
    marker !== null &&
    (typeof marker !== "object" || Array.isArray(marker) || marker.ownership_key !== key)
  )
    throw new CapabilityValidationError("ownership marker does not match the target", key);
}
