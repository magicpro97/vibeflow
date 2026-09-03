import {
  ACTION_ROOT_LOCATOR_KIND,
  ACTOR_KIND,
  CREDENTIAL_CLASS,
  actionIdempotencyScopeDigest,
} from "../../actions/index.js";
import type { ActionRequestAuthorityV1, PublicActor } from "../../actions/types.js";
import {
  AUTHORITY_REPAIR_CONTROL_STATE,
  AUTHORITY_REPAIR_GUIDED_STATUS,
  AUTHORITY_REPAIR_TERMINAL_STATE,
} from "../../capabilities/authority-repair/index.js";
import type {
  AuthorityRepairCandidateIdentityV1,
  AuthorityRepairEventV1,
  AuthorityRepairPreparedCandidateV1,
  PlannedAuthorityRepairV1,
} from "../../capabilities/authority-repair/index.js";
import type { AuthorityRepairCliCandidateOptionV1 } from "../../capabilities/cli/ports.js";
import { digestV1 } from "../../durability/index.js";

export function publicAuthorityRepairCandidate(
  identity: AuthorityRepairCandidateIdentityV1,
  prepared: AuthorityRepairPreparedCandidateV1,
): AuthorityRepairCliCandidateOptionV1 {
  return Object.freeze({
    candidate_id: identity.candidate_id,
    action_domain: identity.authority_scope === "conversation" ? "conversation" : "capability",
    authority_scope: identity.authority_scope,
    scope_id: identity.scope_id,
    control_state: prepared.control_state,
    strategy: prepared.steps.strategy,
    created_at: prepared.created_at,
    expires_at: prepared.expires_at,
  });
}

function ordinaryActor(actor: PublicActor): PublicActor {
  if (actor.kind !== ACTOR_KIND.HUMAN_CLI)
    throw new Error("authority repair requires an authenticated human CLI actor");
  return {
    ...structuredClone(actor),
    credential_class: CREDENTIAL_CLASS.INTERACTIVE_TTY,
  };
}

export function ordinaryAuthorityRepairAuthority(
  locator: Exclude<
    PlannedAuthorityRepairV1["closure"]["action_plan"]["action_root_locator"],
    { kind: typeof ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP }
  >,
  actor: PublicActor,
  randomBytes: (size: number) => Uint8Array,
): ActionRequestAuthorityV1 {
  const nonce = (label: string) => {
    const bytes = Buffer.from(randomBytes(32));
    if (bytes.byteLength !== 32)
      throw new Error("authority repair CSPRNG did not return exactly 256 bits");
    return digestV1(`VF-AUTHORITY-REPAIR-${label}\0v1\0`, bytes.toString("hex"));
  };
  const interactive = ordinaryActor(actor);
  return {
    schema_version: "1.0",
    principal_digest: digestV1("VF-AUTHORITY-REPAIR-CLI-PRINCIPAL\0v1\0", {
      locator,
      actor: interactive,
    }),
    authority_scope_digest: actionIdempotencyScopeDigest(locator),
    control_session_digest: nonce("CONTROL"),
    csrf_epoch_digest: nonce("CSRF"),
    actor: interactive,
  };
}

export function authorityRepairPlanningCandidate(
  prepared: AuthorityRepairPreparedCandidateV1,
  bootstrapIdentityDigest: string | null,
) {
  const checkpoint =
    prepared.control_state === AUTHORITY_REPAIR_CONTROL_STATE.RECOVERY_CHECKPOINT_ONLY;
  if (checkpoint !== (bootstrapIdentityDigest !== null))
    throw new Error("authority repair candidate and bootstrap selection disagree");
  const locator = (() => {
    if (checkpoint) {
      if (bootstrapIdentityDigest === null)
        throw new Error("checkpoint repair omitted its bootstrap identity");
      return {
        kind: ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP,
        bootstrap_identity_digest: bootstrapIdentityDigest,
      } as const;
    }
    return prepared.steps.authority_scope === "conversation"
      ? ({
          kind: ACTION_ROOT_LOCATOR_KIND.CONVERSATION,
          root_session_id: prepared.steps.scope_id,
        } as const)
      : ({
          kind: ACTION_ROOT_LOCATOR_KIND.CAPABILITY,
          scope: prepared.steps.authority_scope,
          scope_identity_digest: prepared.steps.scope_id,
        } as const);
  })();
  return {
    candidate_id: prepared.candidate_id,
    control_state: prepared.control_state,
    action_domain:
      prepared.steps.authority_scope === "conversation" ? "conversation" : "capability",
    action_root_locator: locator,
    authorization: structuredClone(prepared.authorization),
    steps: structuredClone(prepared.steps),
    created_at: prepared.created_at,
    expires_at: prepared.expires_at,
  } as const;
}

export function authorityRepairTerminalStatus(
  event: AuthorityRepairEventV1,
):
  | typeof AUTHORITY_REPAIR_GUIDED_STATUS.VERIFIED
  | typeof AUTHORITY_REPAIR_GUIDED_STATUS.FAILED
  | typeof AUTHORITY_REPAIR_GUIDED_STATUS.NEEDS_RECOVERY {
  if (event.state === AUTHORITY_REPAIR_TERMINAL_STATE.VERIFIED)
    return AUTHORITY_REPAIR_GUIDED_STATUS.VERIFIED;
  if (event.state === AUTHORITY_REPAIR_TERMINAL_STATE.FAILED)
    return AUTHORITY_REPAIR_GUIDED_STATUS.FAILED;
  if (event.state === AUTHORITY_REPAIR_TERMINAL_STATE.NEEDS_RECOVERY)
    return AUTHORITY_REPAIR_GUIDED_STATUS.NEEDS_RECOVERY;
  throw new Error("authority repair executor returned a non-terminal event");
}
