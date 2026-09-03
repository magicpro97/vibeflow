import { ACTION_ROOT_LOCATOR_KIND } from "../../actions/protocol-contract.js";
import type { PrivateActionRootLocatorV1 } from "../../actions/types.js";
import type { CapabilityEffectPreparationRequestV1 } from "./types.js";

export function legacyClaimKey(inspectionEvidenceDigest: string, ownershipKey: string): string {
  return `${inspectionEvidenceDigest}\0${ownershipKey}`;
}

export function requestActionRoot(
  request: CapabilityEffectPreparationRequestV1,
): Exclude<
  PrivateActionRootLocatorV1,
  { kind: typeof ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP }
> {
  return (
    request.request.action_root_locator ?? {
      kind: ACTION_ROOT_LOCATOR_KIND.CAPABILITY,
      scope: request.request.scope,
      scope_identity_digest: request.request.scope_identity_digest,
    }
  );
}
