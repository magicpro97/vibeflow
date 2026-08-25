import { canonicalJson } from "../../durability/index.js";
import { CapabilityValidationError, bytewise } from "../wire/primitives.js";
import {
  authorityEpochHeadDigest,
  grantStateDigest,
  secretRevocationStateDigest,
} from "./digests.js";
import { foldPolicyFrames } from "./policy-fold.js";
import { foldTrustFrames } from "./trust-fold.js";
import type {
  AuthorityEpochEventV1,
  AuthorityEpochHeadV1,
  AuthorityLogicalStateV1,
  GrantFrameV1,
  RegistryTrustKeyFrameV1,
  SecretRevocationFrameV1,
} from "./types.js";
import type { PolicyAuthorityFrameV1 } from "./types.js";
import {
  validateAuthorityEvent,
  validateAuthorityHead,
  validateGrantFrame,
  validateSecretRevocationFrame,
} from "./validation.js";

export { foldTrustFrames } from "./trust-fold.js";

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

export type AuthorityTransitionEvidenceV1 =
  | { change: "grant-changed"; grant_frames: readonly GrantFrameV1[] }
  | { change: "policy-changed"; policy_frames: readonly PolicyAuthorityFrameV1[] }
  | { change: "secret-revoked"; secret_frames: readonly SecretRevocationFrameV1[] }
  | { change: "registry-trust-changed"; trust_frames: readonly RegistryTrustKeyFrameV1[] }
  | { change: "authority-repaired"; checkpoint_head: AuthorityEpochHeadV1 };

function assertStagedEventIdentity(
  record: {
    authority_epoch: number;
    operation_id: string;
    proposal_id: string;
    approval_id: string;
    plan_digest: string;
    action_root_locator: unknown;
    operation_header_digest: string;
  },
  event: AuthorityEpochEventV1,
): void {
  if (
    record.authority_epoch !== event.authority_epoch ||
    record.operation_id !== event.operation_id ||
    record.proposal_id !== event.proposal_id ||
    record.approval_id !== event.approval_id ||
    record.plan_digest !== event.plan_digest ||
    record.operation_header_digest !== event.operation_header_digest ||
    canonicalJson(record.action_root_locator) !== canonicalJson(event.action_root_locator)
  )
    throw new CapabilityValidationError(
      "authority event does not bind the exact staged domain evidence",
      "event",
    );
}

function validateTransitionEvidence(
  prior: AuthorityEpochHeadV1,
  event: AuthorityEpochEventV1,
  evidence: AuthorityTransitionEvidenceV1,
): void {
  if (!evidence || evidence.change !== event.change)
    throw new CapabilityValidationError("authority event evidence kind mismatch", "evidence");
  if (evidence.change === "grant-changed") {
    const folded = foldGrantFrames(evidence.grant_frames, event.scope, event.scope_identity_digest);
    const staged = evidence.grant_frames.at(-1);
    const priorFold = foldGrantFrames(
      evidence.grant_frames.slice(0, -1),
      event.scope,
      event.scope_identity_digest,
    );
    if (
      !staged ||
      folded.head_frame_digest !== event.next_state.grant_head_digest ||
      folded.grant_digest !== event.next_state.grant_digest
    )
      throw new CapabilityValidationError(
        "staged grant evidence does not derive event state",
        "evidence",
      );
    if (
      priorFold.head_frame_digest !== prior.grant_head_digest ||
      priorFold.grant_digest !== prior.grant_digest ||
      staged.previous_frame_digest !== prior.grant_head_digest
    )
      throw new CapabilityValidationError(
        "staged grant evidence does not extend prior authority",
        "evidence",
      );
    assertStagedEventIdentity(staged, event);
  } else if (evidence.change === "policy-changed") {
    const folded = foldPolicyFrames(
      evidence.policy_frames,
      event.scope,
      event.scope_identity_digest,
    );
    const staged = folded.latest_observed;
    const prepared = evidence.policy_frames.at(-3);
    const priorFold = foldPolicyFrames(
      evidence.policy_frames.slice(0, -3),
      event.scope,
      event.scope_identity_digest,
    );
    if (
      !staged ||
      folded.head_frame_digest !== event.next_state.policy_head_digest ||
      folded.policy_digest !== event.next_state.policy_digest
    )
      throw new CapabilityValidationError(
        "staged policy evidence does not derive event state",
        "evidence",
      );
    if (
      !prepared ||
      priorFold.head_frame_digest !== prior.policy_head_digest ||
      (prior.policy_head_digest !== null && priorFold.policy_digest !== prior.policy_digest) ||
      prepared.previous_frame_digest !== prior.policy_head_digest ||
      prepared.prior_policy_digest !== prior.policy_digest
    )
      throw new CapabilityValidationError(
        "staged policy evidence does not extend prior authority",
        "evidence",
      );
    assertStagedEventIdentity(staged, event);
  } else if (evidence.change === "secret-revoked") {
    const digest = foldSecretRevocations(
      evidence.secret_frames,
      event.scope,
      event.scope_identity_digest,
    );
    const staged = evidence.secret_frames.at(-1);
    const priorDigest = foldSecretRevocations(
      evidence.secret_frames.slice(0, -1),
      event.scope,
      event.scope_identity_digest,
    );
    if (!staged || digest !== event.next_state.secret_revocation_digest)
      throw new CapabilityValidationError(
        "staged secret evidence does not derive event state",
        "evidence",
      );
    if (priorDigest !== prior.secret_revocation_digest)
      throw new CapabilityValidationError(
        "staged secret evidence does not extend prior authority",
        "evidence",
      );
    assertStagedEventIdentity(staged, event);
  } else if (evidence.change === "registry-trust-changed") {
    foldTrustFrames(evidence.trust_frames);
    const staged = evidence.trust_frames.at(-1);
    if (
      !staged ||
      staged.scope !== event.scope ||
      staged.scope_identity_digest !== event.scope_identity_digest ||
      staged.frame_digest !== event.next_state.trust_head_digest ||
      staged.trust_epoch !== event.next_state.trust_epoch
    )
      throw new CapabilityValidationError(
        "staged trust evidence does not derive event state",
        "evidence",
      );
    const priorFrame = evidence.trust_frames.at(-2) ?? null;
    if (
      (priorFrame?.frame_digest ?? null) !== prior.trust_head_digest ||
      (priorFrame?.trust_epoch ?? 0) !== prior.trust_epoch ||
      staged.previous_frame_digest !== prior.trust_head_digest ||
      staged.trust_epoch !== prior.trust_epoch + 1
    )
      throw new CapabilityValidationError(
        "staged trust evidence does not extend prior authority",
        "evidence",
      );
    assertStagedEventIdentity(staged, event);
  } else {
    validateAuthorityHead(evidence.checkpoint_head);
    if (evidence.checkpoint_head.content_digest !== prior.content_digest)
      throw new CapabilityValidationError(
        "repair checkpoint is not the exact prior head",
        "evidence",
      );
  }
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
  evidence: AuthorityTransitionEvidenceV1,
): AuthorityEpochHeadV1 {
  validateAuthorityHead(prior);
  validateAuthorityEvent(event);
  validateTransitionEvidence(prior, event, evidence);
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
