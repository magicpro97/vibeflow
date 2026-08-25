import { canonicalJson } from "../../durability/index.js";
import { CapabilityValidationError, bytewise } from "../wire/primitives.js";
import {
  authorityEpochHeadDigest,
  grantStateDigest,
  secretRevocationStateDigest,
} from "./digests.js";
import type {
  AuthorityEpochEventV1,
  AuthorityEpochHeadV1,
  AuthorityLogicalStateV1,
  GrantFrameV1,
  RegistryTrustKeyFrameV1,
  SecretRevocationFrameV1,
} from "./types.js";
import {
  validateAuthorityEvent,
  validateAuthorityHead,
  validateGrantFrame,
  validateSecretRevocationFrame,
  validateTrustFrame,
} from "./validation.js";

export interface GrantFoldV1 {
  head_frame_digest: string | null;
  latest: Map<string, GrantFrameV1>;
  grant_digest: string;
}

export function foldGrantFrames(
  frames: readonly GrantFrameV1[],
  scope: "project" | "user",
  scopeIdentityDigest: string,
): GrantFoldV1 {
  const latest = new Map<string, GrantFrameV1>();
  let previous: string | null = null;
  let authorityEpoch = 0;
  for (const [index, frame] of frames.entries()) {
    validateGrantFrame(frame);
    if (frame.grant_sequence !== index + 1 || frame.previous_frame_digest !== previous)
      throw new CapabilityValidationError("grant journal is not dense/chained", `frames[${index}]`);
    if (frame.scope !== scope || frame.scope_identity_digest !== scopeIdentityDigest)
      throw new CapabilityValidationError(
        "grant frame copied to wrong authority scope",
        `frames[${index}]`,
      );
    if (frame.authority_epoch <= authorityEpoch)
      throw new CapabilityValidationError(
        "grant authority epochs must increase",
        `frames[${index}].authority_epoch`,
      );
    const prior = latest.get(frame.grant_id);
    if (frame.transition === "issued" ? prior !== undefined : prior === undefined)
      throw new CapabilityValidationError(
        "grant transition has invalid predecessor",
        `frames[${index}]`,
      );
    if (prior?.transition === "revoked")
      throw new CapabilityValidationError(
        "revoked grant authority is terminal",
        `frames[${index}]`,
      );
    if (frame.transition === "revoked" && prior) {
      const stable = (value: GrantFrameV1) => ({
        grant_id: value.grant_id,
        scope: value.scope,
        scope_identity_digest: value.scope_identity_digest,
        principal: value.principal,
        action_types: value.action_types,
        permissions: value.permissions,
        target_engines: value.target_engines,
        not_before: value.not_before,
        expires_at: value.expires_at,
      });
      if (canonicalJson(stable(prior)) !== canonicalJson(stable(frame)))
        throw new CapabilityValidationError(
          "grant revocation must repeat the prior full state",
          `frames[${index}]`,
        );
    }
    latest.set(frame.grant_id, frame);
    previous = frame.frame_digest;
    authorityEpoch = frame.authority_epoch;
  }
  return {
    head_frame_digest: previous,
    latest,
    grant_digest: grantStateDigest(scope, scopeIdentityDigest, previous, latest),
  };
}

export function foldTrustFrames(
  frames: readonly RegistryTrustKeyFrameV1[],
): Map<string, RegistryTrustKeyFrameV1> {
  const latest = new Map<string, RegistryTrustKeyFrameV1>();
  let previous: string | null = null;
  for (const [index, frame] of frames.entries()) {
    validateTrustFrame(frame);
    if (frame.trust_epoch !== index + 1 || frame.previous_frame_digest !== previous)
      throw new CapabilityValidationError("trust journal is not dense/chained", `frames[${index}]`);
    const prior = latest.get(frame.key_id);
    if (frame.transition === "added" ? prior !== undefined : prior === undefined)
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
      if (prior.transition === "revoked")
        throw new CapabilityValidationError(
          "revoked trust authority is terminal",
          `frames[${index}]`,
        );
      if (prior.transition === "deprecated" && frame.transition !== "revoked")
        throw new CapabilityValidationError(
          "deprecated trust may only narrow to revoked",
          `frames[${index}]`,
        );
      if (
        frame.transition !== "rescoped" &&
        (prior.registry_origin !== frame.registry_origin ||
          prior.publisher_id !== frame.publisher_id)
      )
        throw new CapabilityValidationError(
          "only rescope may change trust scope",
          `frames[${index}]`,
        );
    }
    latest.set(frame.key_id, frame);
    previous = frame.frame_digest;
  }
  return new Map([...latest].sort(([a], [b]) => bytewise(a, b)));
}

export function foldSecretRevocations(
  frames: readonly SecretRevocationFrameV1[],
  scope: "project" | "user",
  scopeIdentityDigest: string,
): string {
  let previous: string | null = null;
  const seen = new Set<string>();
  for (const [index, frame] of frames.entries()) {
    validateSecretRevocationFrame(frame);
    if (
      frame.sequence !== index ||
      frame.previous_frame_digest !== previous ||
      frame.scope !== scope ||
      frame.scope_identity_digest !== scopeIdentityDigest
    )
      throw new CapabilityValidationError(
        "secret-revocation journal is not dense/chained/owned",
        `frames[${index}]`,
      );
    const key = `${frame.secret_handle_id_digest}\0${frame.expected_binding_digest}`;
    if (seen.has(key))
      throw new CapabilityValidationError("duplicate secret revocation", `frames[${index}]`);
    seen.add(key);
    previous = frame.frame_digest;
  }
  return secretRevocationStateDigest(scope, scopeIdentityDigest, previous);
}

function changedFields(event: AuthorityEpochEventV1): string[] {
  return Object.keys(event.prior_state).filter(
    (key) =>
      canonicalJson(event.prior_state[key as keyof typeof event.prior_state]) !==
      canonicalJson(event.next_state[key as keyof typeof event.next_state]),
  );
}

export function applyAuthorityEvent(
  prior: AuthorityEpochHeadV1,
  event: AuthorityEpochEventV1,
): AuthorityEpochHeadV1 {
  validateAuthorityHead(prior);
  validateAuthorityEvent(event);
  if (
    event.scope !== prior.scope ||
    event.scope_identity_digest !== prior.scope_identity_digest ||
    event.authority_epoch !== prior.authority_epoch + 1 ||
    event.previous_event_digest !== prior.event_head_digest ||
    event.previous_head_digest !== prior.content_digest
  )
    throw new CapabilityValidationError(
      "authority event does not extend exact current head",
      "event",
    );
  const priorLogicalState: AuthorityLogicalStateV1 = {
    grant_head_digest: prior.grant_head_digest,
    grant_digest: prior.grant_digest,
    policy_head_digest: prior.policy_head_digest,
    policy_digest: prior.policy_digest,
    secret_revocation_digest: prior.secret_revocation_digest,
    trust_head_digest: prior.trust_head_digest,
    trust_epoch: prior.trust_epoch,
  };
  if (canonicalJson(event.prior_state) !== canonicalJson(priorLogicalState))
    throw new CapabilityValidationError(
      "authority event prior state does not equal the current head",
      "event.prior_state",
    );
  const expectedChanges: Record<AuthorityEpochEventV1["change"], string[]> = {
    "grant-changed": ["grant_head_digest", "grant_digest"],
    "policy-changed": ["policy_head_digest", "policy_digest"],
    "secret-revoked": ["secret_revocation_digest"],
    "registry-trust-changed": ["trust_head_digest", "trust_epoch"],
    "authority-repaired": [],
  };
  const changed = changedFields(event).sort(bytewise);
  const allowed = expectedChanges[event.change].sort(bytewise);
  if (canonicalJson(changed) !== canonicalJson(allowed))
    throw new CapabilityValidationError(
      "authority change modifies the wrong logical state fields",
      "event.change",
    );
  const draft = {
    schema_version: "1.0" as const,
    scope: event.scope,
    scope_identity_digest: event.scope_identity_digest,
    authority_epoch: event.authority_epoch,
    event_head_digest: event.event_digest,
    ...event.next_state,
    updated_by_operation_id: event.operation_id,
    updated_at: event.recorded_at,
  };
  return { ...draft, content_digest: authorityEpochHeadDigest({ ...draft, content_digest: "" }) };
}
