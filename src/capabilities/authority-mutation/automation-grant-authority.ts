import { CAPABILITY_GRANT_TRANSITION } from "../../actions/capability-security-contract.js";
import { ACTOR_KIND, CREDENTIAL_CLASS } from "../../actions/public-action-contract.js";
import type { PublicActor } from "../../actions/types.js";
import type { CapabilityScope } from "../../core/capability-contract.js";
import { canonicalJson, digestV1 } from "../../durability/index.js";
import { foldGrantFrames } from "../authority/index.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import type { OrdinaryAuthorityDurableStoreV1 } from "./store.js";
import type {
  AuthorityAutomationGrantBindingV1,
  AuthorityAutomationGrantProofV1,
  OrdinaryAuthorityActionKindV1,
} from "./types.js";

export const AUTOMATION_GRANT_BINDING_DIGEST_DOMAIN = "VF-AUTHORITY-AUTOMATION-GRANT-BINDING\0v1\0";

function fail(message: string, path = "authority.automation_grant"): never {
  throw new CapabilityValidationError(message, path, "integrity_failure");
}

function exact(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function timestamp(value: string, field: string): number {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value)
    return fail(`automation grant has non-canonical ${field}`);
  return epoch;
}

function bindingDraft(binding: AuthorityAutomationGrantBindingV1) {
  const { binding_digest: _digest, ...draft } = binding;
  return draft;
}

export function validateAutomationGrantBinding(
  value: AuthorityAutomationGrantBindingV1,
): AuthorityAutomationGrantBindingV1 {
  if (
    value.schema_version !== "1.0" ||
    !Number.isSafeInteger(value.authority_epoch) ||
    value.authority_epoch < 0 ||
    value.binding_digest !== digestV1(AUTOMATION_GRANT_BINDING_DIGEST_DOMAIN, bindingDraft(value))
  )
    return fail("automation grant binding digest is invalid");
  timestamp(value.not_before, "not_before");
  timestamp(value.expires_at, "expires_at");
  return value;
}

export function bindCurrentAutomationGrant(input: {
  store: OrdinaryAuthorityDurableStoreV1;
  scope: CapabilityScope;
  action_type: OrdinaryAuthorityActionKindV1;
  actor: PublicActor;
  proof: AuthorityAutomationGrantProofV1;
  now: string;
}): AuthorityAutomationGrantBindingV1 {
  const state = input.store.readCommitted();
  const current = state.current;
  const folded = foldGrantFrames(state.grants, current.scope, current.scope_identity_digest);
  const frame = folded.latest.get(input.proof.grant_id);
  const now = timestamp(input.now, "current time");
  if (
    input.actor.kind !== ACTOR_KIND.HUMAN_CLI ||
    input.actor.credential_class !== CREDENTIAL_CLASS.AUTOMATION_GRANT ||
    input.actor.public_actor_id !== input.proof.public_actor_id ||
    input.proof.schema_version !== "1.0" ||
    input.proof.scope !== input.scope ||
    current.scope !== input.scope ||
    input.proof.authority_epoch !== current.authority_epoch ||
    input.proof.authority_head_digest !== current.content_digest ||
    !frame ||
    frame.frame_digest !== input.proof.grant_frame_digest ||
    frame.grant_id !== input.proof.grant_id ||
    frame.scope !== input.scope ||
    frame.scope_identity_digest !== current.scope_identity_digest ||
    frame.principal.public_actor_id !== input.proof.public_actor_id ||
    frame.principal.credential_class !== CREDENTIAL_CLASS.AUTOMATION_GRANT ||
    frame.transition === CAPABILITY_GRANT_TRANSITION.REVOKED ||
    frame.revoked_at !== null ||
    !frame.action_types.some((actionType) => actionType === input.action_type) ||
    now < timestamp(frame.not_before, "not_before") ||
    now >= timestamp(frame.expires_at, "expires_at")
  )
    return fail("automation grant proof is not exact, current, active authority");
  const draft = {
    ...structuredClone(input.proof),
    scope_identity_digest: current.scope_identity_digest,
    action_type: input.action_type,
    not_before: frame.not_before,
    expires_at: frame.expires_at,
  };
  return validateAutomationGrantBinding({
    ...draft,
    binding_digest: digestV1(AUTOMATION_GRANT_BINDING_DIGEST_DOMAIN, draft),
  });
}

export function assertCurrentAutomationGrantBinding(input: {
  store: OrdinaryAuthorityDurableStoreV1;
  binding: AuthorityAutomationGrantBindingV1;
  actor: PublicActor;
  now: string;
}): AuthorityAutomationGrantBindingV1 {
  try {
    const binding = assertRetainedAutomationGrantBinding(input);
    const current = input.store.readCommitted().current;
    if (
      current.authority_epoch !== binding.authority_epoch ||
      current.content_digest !== binding.authority_head_digest
    )
      return fail("automation grant binding changed");
    return binding;
  } catch (error) {
    if (error instanceof CapabilityValidationError)
      throw new CapabilityValidationError(
        "automation grant authority is no longer current",
        "authority.stale",
        "integrity_failure",
      );
    throw error;
  }
}

function assertRetainedAutomationGrantBinding(input: {
  store: OrdinaryAuthorityDurableStoreV1;
  binding: AuthorityAutomationGrantBindingV1;
  actor: PublicActor;
  now: string;
}): AuthorityAutomationGrantBindingV1 {
  const binding = validateAutomationGrantBinding(input.binding);
  const state = input.store.readCommitted();
  const current = state.current;
  const frame = foldGrantFrames(
    state.grants,
    current.scope,
    current.scope_identity_digest,
  ).latest.get(binding.grant_id);
  const now = timestamp(input.now, "current time");
  if (
    input.actor.kind !== ACTOR_KIND.HUMAN_CLI ||
    input.actor.credential_class !== CREDENTIAL_CLASS.AUTOMATION_GRANT ||
    input.actor.public_actor_id !== binding.public_actor_id ||
    current.scope !== binding.scope ||
    current.scope_identity_digest !== binding.scope_identity_digest ||
    !frame ||
    frame.frame_digest !== binding.grant_frame_digest ||
    frame.principal.public_actor_id !== binding.public_actor_id ||
    frame.principal.credential_class !== CREDENTIAL_CLASS.AUTOMATION_GRANT ||
    frame.transition === CAPABILITY_GRANT_TRANSITION.REVOKED ||
    frame.revoked_at !== null ||
    !frame.action_types.some((actionType) => actionType === binding.action_type) ||
    frame.not_before !== binding.not_before ||
    frame.expires_at !== binding.expires_at ||
    now < timestamp(frame.not_before, "not_before") ||
    now >= timestamp(frame.expires_at, "expires_at")
  )
    return fail("automation grant binding is no longer retained active authority");
  return binding;
}

function proofFromBinding(
  binding: AuthorityAutomationGrantBindingV1,
): AuthorityAutomationGrantProofV1 {
  return {
    schema_version: binding.schema_version,
    scope: binding.scope,
    public_actor_id: binding.public_actor_id,
    grant_id: binding.grant_id,
    grant_frame_digest: binding.grant_frame_digest,
    authority_epoch: binding.authority_epoch,
    authority_head_digest: binding.authority_head_digest,
  };
}

export function resolveAutomationGrantBinding(input: {
  store: OrdinaryAuthorityDurableStoreV1;
  scope: CapabilityScope;
  action_type: OrdinaryAuthorityActionKindV1;
  actor: PublicActor;
  proof: AuthorityAutomationGrantProofV1 | null;
  now: string;
}): AuthorityAutomationGrantBindingV1 | null {
  if (input.actor.credential_class === CREDENTIAL_CLASS.AUTOMATION_GRANT) {
    if (!input.proof) return fail("automation authority requires an exact durable grant proof");
    return bindCurrentAutomationGrant({ ...input, proof: input.proof });
  }
  if (
    input.proof ||
    input.actor.kind !== ACTOR_KIND.HUMAN_CLI ||
    input.actor.credential_class !== CREDENTIAL_CLASS.INTERACTIVE_TTY
  )
    return fail("ordinary authority requires interactive TTY or automation grant authority");
  return null;
}

export function assertRequestAutomationGrant(input: {
  store: OrdinaryAuthorityDurableStoreV1;
  binding: AuthorityAutomationGrantBindingV1 | null;
  scope: CapabilityScope;
  action_type: OrdinaryAuthorityActionKindV1;
  actor: PublicActor;
  proof: AuthorityAutomationGrantProofV1 | null;
  now: string;
}): void {
  if (input.actor.credential_class === CREDENTIAL_CLASS.AUTOMATION_GRANT) {
    if (!input.binding || !input.proof)
      fail("automation replay requires its retained grant binding and proof");
    const binding = assertRetainedAutomationGrantBinding({
      store: input.store,
      binding: input.binding,
      actor: input.actor,
      now: input.now,
    });
    if (exact(input.proof, proofFromBinding(binding))) return;
  }
  const resolved = resolveAutomationGrantBinding({
    store: input.store,
    scope: input.scope,
    action_type: input.action_type,
    actor: input.actor,
    proof: input.proof,
    now: input.now,
  });
  const stable = (value: AuthorityAutomationGrantBindingV1 | null) =>
    value && {
      schema_version: value.schema_version,
      scope: value.scope,
      scope_identity_digest: value.scope_identity_digest,
      public_actor_id: value.public_actor_id,
      grant_id: value.grant_id,
      grant_frame_digest: value.grant_frame_digest,
      action_type: value.action_type,
      not_before: value.not_before,
      expires_at: value.expires_at,
    };
  if (!exact(stable(resolved), stable(input.binding)))
    fail("request automation grant proof does not equal the proposal authority binding");
}
