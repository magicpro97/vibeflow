import {
  CAPABILITY_GRANT_TRANSITION,
  CAPABILITY_TRUST_TRANSITION,
} from "../../actions/capability-security-contract.js";
import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import { foldGrantFrames, foldTrustFrames } from "../authority/index.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import type { OrdinaryAuthorityRawStateV1 } from "./store.js";
import type { OrdinaryAuthorityActionV1 } from "./types.js";

function fail(message: string): never {
  throw new CapabilityValidationError(message, "authority.transition", "integrity_failure");
}

function prevalidateGrant(
  state: OrdinaryAuthorityRawStateV1,
  action: Extract<
    OrdinaryAuthorityActionV1,
    {
      type:
        | typeof HOST_ACTION_KIND.GRANT_CREATE
        | typeof HOST_ACTION_KIND.GRANT_RENEW
        | typeof HOST_ACTION_KIND.GRANT_REVOKE;
    }
  >,
  generatedGrantId: string | null,
): void {
  const folded = foldGrantFrames(
    state.grants,
    state.current.scope,
    state.current.scope_identity_digest,
  );
  const grantId =
    action.type === HOST_ACTION_KIND.GRANT_CREATE ? generatedGrantId : action.grant_id;
  if (!grantId) fail("grant issuance omitted its generated grant ID");
  const previous = folded.latest.get(grantId);
  if (action.type === HOST_ACTION_KIND.GRANT_CREATE) {
    if (previous) fail("grant issuance duplicates an existing grant ID");
    return;
  }
  if (!previous) fail("grant transition has no current predecessor");
  if (previous.transition === CAPABILITY_GRANT_TRANSITION.REVOKED)
    fail("revoked grant authority is terminal");
}

function prevalidateTrust(
  state: OrdinaryAuthorityRawStateV1,
  action: Extract<OrdinaryAuthorityActionV1, { type: typeof HOST_ACTION_KIND.REGISTRY_TRUST_KEY }>,
): void {
  const latest = foldTrustFrames(state.trust);
  const change = action.change;
  const previous = latest.get(change.key_id);
  if (change.transition === CAPABILITY_TRUST_TRANSITION.ADDED) {
    if (previous) fail("trust add duplicates an existing key");
    return;
  }
  if (!previous) fail("trust transition has no current predecessor");
  if (previous.transition === CAPABILITY_TRUST_TRANSITION.REVOKED)
    fail("revoked trust authority is terminal");
  if (
    previous.public_key_spki_base64 !== change.public_key_spki_base64 ||
    previous.algorithm !== change.algorithm ||
    previous.valid_from !== change.valid_from ||
    previous.valid_until !== change.valid_until
  )
    fail("trust transition changed immutable key bytes or validity");
  if (
    previous.transition === CAPABILITY_TRUST_TRANSITION.DEPRECATED &&
    change.transition !== CAPABILITY_TRUST_TRANSITION.REVOKED
  )
    fail("deprecated trust may only narrow to revoked");
  const scopeChanged =
    previous.registry_origin !== change.registry_origin ||
    previous.publisher_id !== change.publisher_id;
  if (change.transition === CAPABILITY_TRUST_TRANSITION.RESCOPED ? !scopeChanged : scopeChanged)
    fail(
      change.transition === CAPABILITY_TRUST_TRANSITION.RESCOPED
        ? "trust rescope must change the registry or publisher scope"
        : "only trust rescope may change registry or publisher scope",
    );
}

export function prevalidateOrdinaryAuthorityTransition(input: {
  state: OrdinaryAuthorityRawStateV1;
  action: OrdinaryAuthorityActionV1;
  generated_grant_id: string | null;
}): void {
  switch (input.action.type) {
    case HOST_ACTION_KIND.GRANT_CREATE:
    case HOST_ACTION_KIND.GRANT_RENEW:
    case HOST_ACTION_KIND.GRANT_REVOKE:
      prevalidateGrant(input.state, input.action, input.generated_grant_id);
      return;
    case HOST_ACTION_KIND.REGISTRY_TRUST_KEY:
      prevalidateTrust(input.state, input.action);
      return;
    default:
      return;
  }
}
