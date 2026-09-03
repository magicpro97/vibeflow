import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import type { ActionAuthoritySnapshotV1 } from "../../actions/types.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import { assertCurrentAutomationGrantBinding } from "./automation-grant-authority.js";
import { assertOrdinaryAuthorityOperationBinding } from "./binding.js";
import {
  type StagedOrdinaryAuthorityTransitionV1,
  materializeStagedAuthorityTransition,
} from "./frames.js";
import { settingsPolicyState } from "./policy.js";
import type { OrdinaryAuthorityRecoverySnapshotV1 } from "./recovery.js";
import type { OrdinaryAuthorityDurableStoreV1 } from "./store.js";
import { prevalidateOrdinaryAuthorityTransition } from "./transition-prevalidation.js";
import type { AuthorityChangeOperationV1, OrdinaryAuthorityMutationOptionsV1 } from "./types.js";

function fail(message: string): never {
  throw new CapabilityValidationError(message, "authority.pre_effect", "integrity_failure");
}

export function prevalidateOrdinaryAuthorityExecution(input: {
  store: OrdinaryAuthorityDurableStoreV1;
  options: OrdinaryAuthorityMutationOptionsV1;
  recorded: ActionAuthoritySnapshotV1;
  header: AuthorityChangeOperationV1;
  snapshot: OrdinaryAuthorityRecoverySnapshotV1;
}): {
  closure: ReturnType<typeof assertOrdinaryAuthorityOperationBinding>;
  staged: StagedOrdinaryAuthorityTransitionV1;
} {
  const approval = input.recorded.approval;
  if (!approval) return fail("committing Action approval is absent");
  const closure = assertOrdinaryAuthorityOperationBinding({
    store: input.store,
    proposal: input.recorded.proposal,
    approval,
    header: input.header,
  });
  if (closure.plan.automation_grant_binding)
    assertCurrentAutomationGrantBinding({
      store: input.store,
      binding: closure.plan.automation_grant_binding,
      actor: input.recorded.proposal.requested_by,
      now: input.options.now?.() ?? new Date().toISOString(),
    });
  if (closure.candidate)
    input.options.secret_candidate_authority?.validateCurrent(closure.candidate);
  const prior = input.snapshot.committed.current;
  if (!closure.preimage) {
    const policy = settingsPolicyState({
      scope: prior.scope,
      scope_identity_digest: prior.scope_identity_digest,
      bytes: input.snapshot.committed.settings,
    });
    if (policy.policy_digest !== prior.policy_digest)
      return fail("live settings policy changed before a non-policy authority effect");
  }
  prevalidateOrdinaryAuthorityTransition({
    state: input.snapshot.committed,
    action: closure.plan.authority_action,
    generated_grant_id:
      closure.plan.authority_action.type === HOST_ACTION_KIND.GRANT_CREATE
        ? closure.plan.authority_subject_id
        : null,
  });
  const recordedAt = input.recorded.events.at(-1)?.recorded_at;
  if (!recordedAt) return fail("committing Action event is absent");
  return {
    closure,
    staged: materializeStagedAuthorityTransition({
      prior,
      raw: input.snapshot.committed,
      header: input.header,
      plan: closure.plan,
      effect: closure.effect,
      approval,
      candidate: closure.candidate,
      recorded_at: recordedAt,
    }),
  };
}
