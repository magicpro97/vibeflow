import type { PrivateActionRootLocatorV1 } from "../../actions/types.js";
import type { CapabilityEffectPreparationRequestV1 } from "./types.js";

export function legacyClaimKey(inspectionEvidenceDigest: string, ownershipKey: string): string {
  return `${inspectionEvidenceDigest}\0${ownershipKey}`;
}

export function requestActionRoot(
  request: CapabilityEffectPreparationRequestV1,
): Exclude<PrivateActionRootLocatorV1, { kind: "recovery-bootstrap" }> {
  return (
    request.request.action_root_locator ?? {
      kind: "capability",
      scope: request.request.scope,
      scope_identity_digest: request.request.scope_identity_digest,
    }
  );
}
