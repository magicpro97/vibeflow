import { CAPABILITY_AUTHORITY_CHANGE } from "../../actions/capability-security-contract.js";
import { canonicalJson } from "../../durability/index.js";
import {
  applyAuthorityEvent,
  foldGrantFrames,
  foldPolicyFrames,
  foldSecretRevocations,
  foldTrustFrames,
} from "../authority/index.js";
import type {
  AuthorityEpochEventV1,
  AuthorityEpochHeadV1,
  AuthorityTransitionEvidenceV1,
} from "../authority/index.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import type { OrdinaryAuthorityDurableStoreV1, OrdinaryAuthorityRawStateV1 } from "./store.js";

export interface OrdinaryAuthorityRecoverySnapshotV1 {
  committed: OrdinaryAuthorityRawStateV1;
  event_tail: AuthorityEpochEventV1[];
  grant_tail: OrdinaryAuthorityRawStateV1["grants"];
  policy_tail: OrdinaryAuthorityRawStateV1["policies"];
  secret_tail: OrdinaryAuthorityRawStateV1["secrets"];
  trust_tail: OrdinaryAuthorityRawStateV1["trust"];
}

function fail(message: string, path = "authority.recovery"): never {
  throw new CapabilityValidationError(message, path, "integrity_failure");
}

function prefixThrough<T>(
  rows: readonly T[],
  digest: string | null,
  read: (row: T) => string,
): number {
  if (digest === null) return 0;
  const index = rows.findIndex((row) => read(row) === digest);
  return index < 0 ? fail("committed domain head is absent from its journal") : index + 1;
}

function secretPrefix(raw: OrdinaryAuthorityRawStateV1): number {
  for (let length = 0; length <= raw.secrets.length; length += 1)
    if (
      foldSecretRevocations(
        raw.secrets.slice(0, length),
        raw.current.scope,
        raw.current.scope_identity_digest,
      ) === raw.current.secret_revocation_digest
    )
      return length;
  return fail("committed secret-revocation state is absent from its journal");
}

function evidenceFor(
  event: AuthorityEpochEventV1,
  state: OrdinaryAuthorityRawStateV1,
  prior: AuthorityEpochHeadV1,
  store: OrdinaryAuthorityDurableStoreV1,
): AuthorityTransitionEvidenceV1 {
  switch (event.change) {
    case CAPABILITY_AUTHORITY_CHANGE.GRANT_CHANGED:
      return {
        change: event.change,
        grant_frames: state.grants.slice(
          0,
          prefixThrough(
            state.grants,
            event.next_state.grant_head_digest,
            (row) => row.frame_digest,
          ),
        ),
      };
    case CAPABILITY_AUTHORITY_CHANGE.POLICY_CHANGED:
      return {
        change: event.change,
        policy_frames: state.policies.slice(
          0,
          prefixThrough(
            state.policies,
            event.next_state.policy_head_digest,
            (row) => row.frame_digest,
          ),
        ),
      };
    case CAPABILITY_AUTHORITY_CHANGE.SECRET_REVOKED: {
      const index = state.secrets.findIndex(
        (row) =>
          row.operation_id === event.operation_id && row.authority_epoch === event.authority_epoch,
      );
      if (index < 0) return fail("committed secret event evidence is absent");
      return { change: event.change, secret_frames: state.secrets.slice(0, index + 1) };
    }
    case CAPABILITY_AUTHORITY_CHANGE.REGISTRY_TRUST_CHANGED:
      return {
        change: event.change,
        trust_frames: state.trust.slice(0, event.next_state.trust_epoch),
      };
    case CAPABILITY_AUTHORITY_CHANGE.AUTHORITY_REPAIRED:
      return { change: event.change, checkpoint_head: store.readCheckpoint(prior.content_digest) };
  }
}

function verifyCommitted(
  store: OrdinaryAuthorityDurableStoreV1,
  state: OrdinaryAuthorityRawStateV1,
): void {
  let rebuilt: AuthorityEpochHeadV1 = store.readInitialHead();
  for (const event of state.events) {
    const checkpoint = store.readCheckpoint(event.previous_head_checkpoint_digest);
    if (canonicalJson(checkpoint) !== canonicalJson(rebuilt))
      fail("authority event checkpoint does not equal its reconstructed prior");
    const evidence = evidenceFor(event, state, rebuilt, store);
    const next = applyAuthorityEvent(rebuilt, event, evidence);
    store.transitionResolver.verify({
      private_root: store.paths.privateRoot,
      prior: structuredClone(rebuilt),
      event: structuredClone(event),
      evidence: structuredClone(evidence),
      next: structuredClone(next),
    });
    rebuilt = next;
  }
  if (canonicalJson(rebuilt) !== canonicalJson(state.current))
    fail("committed journal prefixes do not reconstruct the selected authority head");
  const grants = foldGrantFrames(
    state.grants,
    state.current.scope,
    state.current.scope_identity_digest,
  );
  const policy = foldPolicyFrames(
    state.policies,
    state.current.scope,
    state.current.scope_identity_digest,
  );
  const secret = foldSecretRevocations(
    state.secrets,
    state.current.scope,
    state.current.scope_identity_digest,
  );
  foldTrustFrames(state.trust);
  if (
    grants.head_frame_digest !== state.current.grant_head_digest ||
    grants.grant_digest !== state.current.grant_digest ||
    policy.head_frame_digest !== state.current.policy_head_digest ||
    (policy.policy_digest !== null && policy.policy_digest !== state.current.policy_digest) ||
    secret !== state.current.secret_revocation_digest ||
    (state.trust.at(-1)?.frame_digest ?? null) !== state.current.trust_head_digest ||
    state.trust.length !== state.current.trust_epoch
  )
    fail("committed domain folds disagree with the selected authority head");
}

export function recoverOrdinaryAuthorityPrefixes(
  store: OrdinaryAuthorityDurableStoreV1,
  raw: OrdinaryAuthorityRawStateV1,
): OrdinaryAuthorityRecoverySnapshotV1 {
  if (raw.events.length < raw.current.authority_epoch)
    return fail("authority event journal is shorter than the selected epoch");
  const eventLength = raw.current.authority_epoch;
  if (
    (eventLength === 0 ? null : raw.events[eventLength - 1]?.event_digest) !==
    raw.current.event_head_digest
  )
    return fail("authority event prefix does not end at the selected head");
  const grantLength = prefixThrough(
    raw.grants,
    raw.current.grant_head_digest,
    (row) => row.frame_digest,
  );
  const policyLength = prefixThrough(
    raw.policies,
    raw.current.policy_head_digest,
    (row) => row.frame_digest,
  );
  const secretLength = secretPrefix(raw);
  const trustLength = raw.current.trust_epoch;
  if (trustLength > raw.trust.length)
    return fail("trust journal is shorter than the selected epoch");
  const committed: OrdinaryAuthorityRawStateV1 = {
    current: structuredClone(raw.current),
    events: raw.events.slice(0, eventLength),
    grants: raw.grants.slice(0, grantLength),
    policies: raw.policies.slice(0, policyLength),
    secrets: raw.secrets.slice(0, secretLength),
    trust: raw.trust.slice(0, trustLength),
    settings: Buffer.from(raw.settings),
  };
  verifyCommitted(store, committed);
  return {
    committed,
    event_tail: raw.events.slice(eventLength),
    grant_tail: raw.grants.slice(grantLength),
    policy_tail: raw.policies.slice(policyLength),
    secret_tail: raw.secrets.slice(secretLength),
    trust_tail: raw.trust.slice(trustLength),
  };
}
