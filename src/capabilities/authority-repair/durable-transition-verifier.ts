import { CAPABILITY_AUTHORITY_CHANGE } from "../../actions/capability-security-contract.js";
import {
  ACTION_OPERATION_STATE,
  ACTION_ROOT_LOCATOR_KIND,
  ActionAuthorityStore,
  materializeDispatchRecord,
} from "../../actions/index.js";
import { canonicalJson, privateFileBytes } from "../../durability/index.js";
import type { DurableAuthorityTransitionVerificationInputV1 } from "../source/durable-authority-transition-resolver.js";
import type { DurableAuthorityRepairTransitionVerifierV1 } from "../source/durable-authority-transition-resolver.js";
import {
  OrdinaryAuthorityRepairActionObjectStoreV1,
  RecoveryBootstrapActionObjectStoreV1,
} from "./action-object-store.js";
import { materializeAuthorityRepairedEpochTransition } from "./authority-epoch-transition.js";
import { readActivatedRecoveryBootstrap } from "./bootstrap-activation.js";
import { readRecoveryBootstrapJournalBytes } from "./bootstrap-journal.js";
import {
  AUTHORITY_REPAIR_BINDING_MODE,
  AUTHORITY_REPAIR_EVENT_STATE,
  AUTHORITY_REPAIR_LIMIT,
} from "./contract.js";
import { AuthorityRepairOperationStoreV1 } from "./operation-store.js";
import { recoveryBootstrapPaths } from "./paths.js";
import type { AuthorityRepairProductionRegistryV1 } from "./production-registry.js";
import { materializeAuthorityRepairOperation } from "./records.js";
import { AuthorityRepairArtifactStoreV1 } from "./repair-artifact-store.js";
import type {
  AuthorityRepairActionObjectClosureV1,
  AuthorityRepairActionObjectsV1,
  AuthorityRepairOperationV1,
} from "./types.js";

const exact = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);

function fail(message: string): never {
  throw new Error(`durable authority-repair transition: ${message}`);
}

function resolvedObjects(
  input: DurableAuthorityTransitionVerificationInputV1,
  operation: AuthorityRepairOperationV1,
  userVibeflowRoot: string,
): AuthorityRepairActionObjectsV1 {
  const selector = {
    binding_digest: operation.repair_authorization_binding_digest,
    plan_digest: operation.plan_digest,
    action_plan_digest: operation.action_plan_binding_digest,
  };
  if (operation.action_root_locator.kind === ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP)
    return new RecoveryBootstrapActionObjectStoreV1(userVibeflowRoot).read(selector);
  return new OrdinaryAuthorityRepairActionObjectStoreV1(
    input.private_root,
    operation.action_root_locator,
  ).read(selector);
}

function validateOperationFold(
  input: DurableAuthorityTransitionVerificationInputV1,
): AuthorityRepairOperationV1 {
  const operations = new AuthorityRepairOperationStoreV1(input.private_root);
  const operation = operations.readHeader(input.event.operation_id);
  if (!operation) return fail("operation header is missing");
  const fold = operations.fold(operation.operation_id);
  if (
    fold.resume_anchor !== AUTHORITY_REPAIR_EVENT_STATE.RESTORED &&
    fold.state !== AUTHORITY_REPAIR_EVENT_STATE.VERIFIED
  )
    return fail("operation has not durably restored its approved target");
  if (
    operation.proposal_id !== input.event.proposal_id ||
    operation.approval_id !== input.event.approval_id ||
    operation.plan_digest !== input.event.plan_digest ||
    operation.header_digest !== input.event.operation_header_digest ||
    !exact(operation.action_root_locator, input.event.action_root_locator)
  )
    return fail("epoch event differs from its immutable repair operation");
  return operation;
}

function assertOrdinaryAction(privateRoot: string, operation: AuthorityRepairOperationV1): void {
  const action = new ActionAuthorityStore(privateRoot);
  const snapshot = action.getRecorded(operation.proposal_id);
  const approval = snapshot?.approval;
  const dispatch = action.getDispatch(operation.operation_id);
  if (!snapshot || !approval || !dispatch) fail("ordinary action authority is incomplete");
  const expectedOperation = materializeAuthorityRepairOperation(snapshot.proposal, approval);
  const expectedDispatch = materializeDispatchRecord(
    snapshot.proposal,
    approval,
    operation.header_digest,
  );
  if (
    !exact(expectedOperation, operation) ||
    !exact(expectedDispatch, dispatch) ||
    (snapshot.state !== ACTION_OPERATION_STATE.COMMITTING &&
      snapshot.state !== ACTION_OPERATION_STATE.SUCCEEDED) ||
    snapshot.operation_id !== operation.operation_id ||
    snapshot.dispatch_record_digest !== dispatch.dispatch_record_digest
  )
    fail("ordinary action proposal/approval/dispatch does not authorize the repair event");
}

function assertBootstrapAction(
  userVibeflowRoot: string,
  operation: AuthorityRepairOperationV1,
): void {
  const activation = readActivatedRecoveryBootstrap(userVibeflowRoot);
  const bytes = privateFileBytes(
    recoveryBootstrapPaths(userVibeflowRoot).journal,
    AUTHORITY_REPAIR_LIMIT.JOURNAL_BYTES,
  );
  if (!bytes) fail("recovery bootstrap journal is missing");
  const state = readRecoveryBootstrapJournalBytes(activation.identity, bytes).proposals.get(
    operation.proposal_id,
  );
  if (!state?.approval || !state.operation || !exact(state.operation, operation))
    fail("bootstrap proposal/approval/dispatch does not authorize the repair event");
}

function assertBinding(
  input: DurableAuthorityTransitionVerificationInputV1,
  operation: AuthorityRepairOperationV1,
  closure: AuthorityRepairActionObjectClosureV1,
): void {
  const binding = closure.authorization;
  const checkpointMode = binding.mode === AUTHORITY_REPAIR_BINDING_MODE.RECOVERY_CHECKPOINT;
  if (
    binding.control_scope !== input.prior.scope ||
    binding.control_scope_identity_digest !== input.prior.scope_identity_digest ||
    binding.authority_epoch !== input.prior.authority_epoch ||
    binding.authority_head_digest !== input.prior.content_digest ||
    binding.authority_head_checkpoint_digest !==
      (checkpointMode ? input.prior.content_digest : null) ||
    closure.plan.plan_digest !== operation.plan_digest ||
    closure.plan.repair_authorization_binding_digest !== binding.binding_digest ||
    !exact(closure.action_plan.action_root_locator, operation.action_root_locator)
  )
    fail("repair authorization does not bind the exact authority-event base");
}

export class AuthorityRepairDurableTransitionVerifierV1
  implements DurableAuthorityRepairTransitionVerifierV1
{
  constructor(
    readonly registry: AuthorityRepairProductionRegistryV1,
    readonly userVibeflowRoot: string,
  ) {}

  verify(input: DurableAuthorityTransitionVerificationInputV1): void {
    if (
      input.event.change !== CAPABILITY_AUTHORITY_CHANGE.AUTHORITY_REPAIRED ||
      input.evidence.change !== CAPABILITY_AUTHORITY_CHANGE.AUTHORITY_REPAIRED ||
      input.evidence.checkpoint_head.content_digest !== input.prior.content_digest
    )
      fail("repair verifier received another transition kind or checkpoint");
    const operation = validateOperationFold(input);
    const objects = resolvedObjects(input, operation, this.userVibeflowRoot);
    const closure = new AuthorityRepairArtifactStoreV1(input.private_root).resolvePreparedClosure(
      objects,
    );
    assertBinding(input, operation, closure);
    if (operation.action_root_locator.kind === ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP)
      assertBootstrapAction(this.userVibeflowRoot, operation);
    else assertOrdinaryAction(input.private_root, operation);
    const expected = materializeAuthorityRepairedEpochTransition(input.prior, operation);
    if (!exact(expected.event, input.event) || !exact(expected.next, input.next))
      fail("authority-repaired event/head bytes are not the exact approved transition");
    this.registry.assertCommittedTransition({ operation, closure });
  }
}
