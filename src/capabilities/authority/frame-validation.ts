import { createHash, createPublicKey } from "node:crypto";
import { canonicalJsonBytes } from "../../durability/index.js";
import { canonicalRelativePrefix } from "../permissions/scope.js";
import { assertCanonicalRegistryOrigin } from "../source/url.js";
import {
  CapabilityValidationError,
  digest,
  enumeration,
  integer,
  rawSha256,
  text,
  timestamp,
} from "../wire/primitives.js";
import { assertAuthorityLocatorScope } from "./binding-validation.js";
import {
  policyAuthorityFrameDigest,
  registryTrustFrameDigest,
  secretRevocationFrameDigest,
} from "./digests.js";
import {
  AUTHORITY_SCOPES,
  nullableAuthorityDigest,
  validateCommonAuthorityFrame,
} from "./record-validation.js";
import {
  assertPolicyFrameShape,
  assertSecretFrameShape,
  assertTrustFrameShape,
  validatePublicActor,
} from "./shapes.js";
import type {
  PolicyAuthorityFrameV1,
  RegistryTrustKeyFrameV1,
  SecretRevocationFrameV1,
} from "./types.js";

export function validateTrustFrame(frame: RegistryTrustKeyFrameV1): void {
  assertTrustFrameShape(frame);
  validateCommonAuthorityFrame(frame);
  enumeration(frame.scope, AUTHORITY_SCOPES, "trust.scope");
  assertAuthorityLocatorScope(
    frame.action_root_locator,
    frame.scope,
    frame.scope_identity_digest,
    "trust.action_root_locator",
  );
  enumeration(
    frame.transition,
    ["added", "rescoped", "deprecated", "revoked"] as const,
    "trust.transition",
  );
  if (frame.algorithm !== "Ed25519")
    throw new CapabilityValidationError("unsupported trust algorithm", "trust.algorithm");
  integer(frame.trust_epoch, "trust.trust_epoch", 1);
  nullableAuthorityDigest(frame.previous_frame_digest, "trust.previous_frame_digest");
  digest(frame.scope_identity_digest, "trust.scope_identity_digest");
  digest(frame.key_id, "trust.key_id");
  const encoded = text(frame.public_key_spki_base64, "trust.public_key_spki_base64", {
    min: 1,
    max: 16_384,
    ascii: true,
  });
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0)
    throw new CapabilityValidationError(
      "invalid canonical trust-key base64",
      "trust.public_key_spki_base64",
    );
  const keyBytes = Buffer.from(encoded, "base64");
  if (keyBytes.toString("base64") !== encoded)
    throw new CapabilityValidationError(
      "non-canonical trust-key base64",
      "trust.public_key_spki_base64",
    );
  if (`sha256:${createHash("sha256").update(keyBytes).digest("hex")}` !== frame.key_id)
    throw new CapabilityValidationError(
      "trust key ID does not match SPKI",
      "trust.key_id",
      "integrity_failure",
    );
  try {
    if (
      createPublicKey({ key: keyBytes, format: "der", type: "spki" }).asymmetricKeyType !==
      "ed25519"
    )
      throw new Error("wrong type");
  } catch {
    throw new CapabilityValidationError(
      "trust SPKI is not Ed25519",
      "trust.public_key_spki_base64",
    );
  }
  assertCanonicalRegistryOrigin(frame.registry_origin);
  if (frame.publisher_id !== null)
    text(frame.publisher_id, "trust.publisher_id", { min: 1, max: 128, ascii: true });
  const validFrom = timestamp(frame.valid_from, "trust.valid_from");
  const validUntil = timestamp(frame.valid_until, "trust.valid_until");
  if (validUntil <= validFrom)
    throw new CapabilityValidationError("trust validity interval is empty", "trust.valid_until");
  nullableAuthorityDigest(frame.reason_digest, "trust.reason_digest");
  if (frame.frame_digest !== registryTrustFrameDigest(frame))
    throw new CapabilityValidationError(
      "trust frame digest mismatch",
      "trust.frame_digest",
      "integrity_failure",
    );
  if (canonicalJsonBytes(frame).length > 256 * 1024)
    throw new CapabilityValidationError("trust frame exceeds byte limit", "trust", "bounds");
}

export function validateSecretRevocationFrame(frame: SecretRevocationFrameV1): void {
  assertSecretFrameShape(frame);
  validateCommonAuthorityFrame(frame);
  enumeration(frame.scope, AUTHORITY_SCOPES, "secret.scope");
  assertAuthorityLocatorScope(
    frame.action_root_locator,
    frame.scope,
    frame.scope_identity_digest,
    "secret.action_root_locator",
  );
  integer(frame.sequence, "secret.sequence");
  nullableAuthorityDigest(frame.previous_frame_digest, "secret.previous_frame_digest");
  digest(frame.scope_identity_digest, "secret.scope_identity_digest");
  digest(frame.secret_handle_id_digest, "secret.secret_handle_id_digest");
  digest(frame.expected_binding_digest, "secret.expected_binding_digest");
  timestamp(frame.revoked_at, "secret.revoked_at");
  validatePublicActor(frame.revoked_by, "secret.revoked_by");
  nullableAuthorityDigest(frame.reason_digest, "secret.reason_digest");
  if (frame.frame_digest !== secretRevocationFrameDigest(frame))
    throw new CapabilityValidationError(
      "secret revocation digest mismatch",
      "secret.frame_digest",
      "integrity_failure",
    );
}

export function validatePolicyFrame(frame: PolicyAuthorityFrameV1): void {
  assertPolicyFrameShape(frame);
  validateCommonAuthorityFrame(frame);
  enumeration(frame.scope, AUTHORITY_SCOPES, "policy.scope");
  assertAuthorityLocatorScope(
    frame.action_root_locator,
    frame.scope,
    frame.scope_identity_digest,
    "policy.action_root_locator",
  );
  enumeration(frame.state, ["prepared", "effect_in_progress", "observed"] as const, "policy.state");
  integer(frame.sequence, "policy.sequence");
  nullableAuthorityDigest(frame.previous_frame_digest, "policy.previous_frame_digest");
  digest(frame.scope_identity_digest, "policy.scope_identity_digest");
  rawSha256(frame.expected_settings_sha256, "policy.expected_settings_sha256");
  rawSha256(frame.replacement_settings_sha256, "policy.replacement_settings_sha256");
  integer(frame.expected_settings_byte_length, "policy.expected_settings_byte_length");
  integer(frame.replacement_settings_byte_length, "policy.replacement_settings_byte_length");
  text(frame.settings_schema_version, "policy.settings_schema_version", {
    min: 1,
    max: 128,
    ascii: true,
  });
  canonicalRelativePrefix(frame.private_preimage_ref, "policy.private_preimage_ref", false);
  canonicalRelativePrefix(frame.private_replacement_ref, "policy.private_replacement_ref", false);
  for (const field of [
    "private_preimage_content_digest",
    "private_replacement_content_digest",
    "prior_policy_digest",
    "replacement_policy_digest",
  ] as const)
    digest(frame[field], `policy.${field}`);
  if ((frame.state === "observed") !== (frame.observed_settings_sha256 !== null))
    throw new CapabilityValidationError(
      "observed policy hash nullability mismatch",
      "policy.observed_settings_sha256",
    );
  if (
    frame.observed_settings_sha256 !== null &&
    frame.observed_settings_sha256 !== frame.replacement_settings_sha256
  )
    throw new CapabilityValidationError(
      "observed policy bytes differ from replacement",
      "policy.observed_settings_sha256",
    );
  if (frame.frame_digest !== policyAuthorityFrameDigest(frame))
    throw new CapabilityValidationError(
      "policy frame digest mismatch",
      "policy.frame_digest",
      "integrity_failure",
    );
}
