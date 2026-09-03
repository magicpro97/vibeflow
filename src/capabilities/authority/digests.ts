import type { CapabilityScope } from "../../core/capability-contract.js";
import { digestV1 } from "../../durability/index.js";
import type {
  AuthorityEpochEventV1,
  AuthorityEpochHeadV1,
  AuthorityScopeIdentityRecordV1,
  GrantFrameV1,
  PolicyAuthorityFrameV1,
  RegistryTrustKeyFrameV1,
  SecretRevocationFrameV1,
} from "./types.js";

function without<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}

export const authorityScopeIdentityDigest = (value: AuthorityScopeIdentityRecordV1): string =>
  digestV1("VF-AUTHORITY-SCOPE-IDENTITY\0v1\0", without(value, "content_digest"));
export const authorityEpochHeadDigest = (value: AuthorityEpochHeadV1): string =>
  digestV1("VF-AUTHORITY-EPOCH-HEAD\0v1\0", without(value, "content_digest"));
export const authorityEpochEventDigest = (value: AuthorityEpochEventV1): string =>
  digestV1("VF-AUTHORITY-EPOCH-EVENT\0v1\0", without(value, "event_digest"));
export const grantFrameDigest = (value: GrantFrameV1): string =>
  digestV1("VF-GRANT-FRAME\0v1\0", without(value, "frame_id", "frame_digest"));
export const registryTrustFrameDigest = (value: RegistryTrustKeyFrameV1): string =>
  digestV1("VF-REGISTRY-TRUST-KEY-FRAME\0v1\0", without(value, "frame_digest"));
export const secretRevocationFrameDigest = (value: SecretRevocationFrameV1): string =>
  digestV1("VF-SECRET-REVOCATION-FRAME\0v1\0", without(value, "frame_digest"));
export const policyAuthorityFrameDigest = (value: PolicyAuthorityFrameV1): string =>
  digestV1("VF-POLICY-AUTHORITY-FRAME\0v1\0", without(value, "frame_digest"));

export function grantStateDigest(
  scope: CapabilityScope,
  scopeIdentityDigest: string,
  headFrameDigest: string | null,
  latest: ReadonlyMap<string, GrantFrameV1>,
): string {
  return digestV1("VF-GRANT-STATE\0v1\0", {
    schema_version: "1.0",
    scope,
    scope_identity_digest: scopeIdentityDigest,
    head_frame_digest: headFrameDigest,
    latest_grant_frames: [...latest.values()]
      .map((frame) => ({ grant_id: frame.grant_id, frame_digest: frame.frame_digest }))
      .sort((a, b) => Buffer.from(a.grant_id).compare(Buffer.from(b.grant_id))),
  });
}

export function secretRevocationStateDigest(
  scope: CapabilityScope,
  scopeIdentityDigest: string,
  headFrameDigest: string | null,
): string {
  return digestV1("VF-SECRET-REVOCATION-STATE\0v1\0", {
    schema_version: "1.0",
    scope,
    scope_identity_digest: scopeIdentityDigest,
    head_frame_digest: headFrameDigest,
  });
}
