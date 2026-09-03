import { CAPABILITY_TRUST_TRANSITION } from "../../actions/capability-security-contract.js";
import { CapabilityValidationError, bytewise } from "../wire/primitives.js";
import type { RegistryTrustKeyFrameV1 } from "./types.js";
import { validateTrustFrame } from "./validation.js";

export function foldTrustFrames(
  frames: readonly RegistryTrustKeyFrameV1[],
): Map<string, RegistryTrustKeyFrameV1> {
  const latest = new Map<string, RegistryTrustKeyFrameV1>();
  let previous: string | null = null;
  let scope: RegistryTrustKeyFrameV1["scope"] | null = null;
  let scopeIdentityDigest: string | null = null;
  let authorityEpoch = 0;
  for (const [index, frame] of frames.entries()) {
    validateTrustFrame(frame);
    scope ??= frame.scope;
    scopeIdentityDigest ??= frame.scope_identity_digest;
    if (frame.scope !== scope || frame.scope_identity_digest !== scopeIdentityDigest)
      throw new CapabilityValidationError(
        "trust frame copied to wrong authority scope",
        `frames[${index}]`,
      );
    if (frame.trust_epoch !== index + 1 || frame.previous_frame_digest !== previous)
      throw new CapabilityValidationError("trust journal is not dense/chained", `frames[${index}]`);
    if (frame.authority_epoch <= authorityEpoch)
      throw new CapabilityValidationError(
        "trust authority epochs must increase",
        `frames[${index}].authority_epoch`,
      );
    const prior = latest.get(frame.key_id);
    if (
      frame.transition === CAPABILITY_TRUST_TRANSITION.ADDED
        ? prior !== undefined
        : prior === undefined
    )
      throw new CapabilityValidationError(
        "trust transition has invalid predecessor",
        `frames[${index}]`,
      );
    if (prior) {
      if (
        prior.public_key_spki_base64 !== frame.public_key_spki_base64 ||
        prior.algorithm !== frame.algorithm ||
        prior.valid_from !== frame.valid_from ||
        prior.valid_until !== frame.valid_until
      )
        throw new CapabilityValidationError(
          "trust transition changed immutable key bytes/validity",
          `frames[${index}]`,
        );
      if (prior.transition === CAPABILITY_TRUST_TRANSITION.REVOKED)
        throw new CapabilityValidationError(
          "revoked trust authority is terminal",
          `frames[${index}]`,
        );
      if (
        prior.transition === CAPABILITY_TRUST_TRANSITION.DEPRECATED &&
        frame.transition !== CAPABILITY_TRUST_TRANSITION.REVOKED
      )
        throw new CapabilityValidationError(
          "deprecated trust may only narrow to revoked",
          `frames[${index}]`,
        );
      if (
        frame.transition !== CAPABILITY_TRUST_TRANSITION.RESCOPED &&
        (prior.registry_origin !== frame.registry_origin ||
          prior.publisher_id !== frame.publisher_id)
      )
        throw new CapabilityValidationError(
          "only rescope may change trust scope",
          `frames[${index}]`,
        );
      if (
        frame.transition === CAPABILITY_TRUST_TRANSITION.RESCOPED &&
        prior.registry_origin === frame.registry_origin &&
        prior.publisher_id === frame.publisher_id
      )
        throw new CapabilityValidationError(
          "trust rescope must change the exact registry/publisher scope",
          `frames[${index}]`,
        );
    }
    latest.set(frame.key_id, frame);
    previous = frame.frame_digest;
    authorityEpoch = frame.authority_epoch;
  }
  return new Map([...latest].sort(([a], [b]) => bytewise(a, b)));
}
