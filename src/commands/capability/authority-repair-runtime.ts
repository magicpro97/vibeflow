import { randomBytes as systemRandomBytes } from "node:crypto";
import {
  ACTION_DECISION,
  ACTION_ROOT_LOCATOR_KIND,
  ACTOR_KIND,
  ActionAuthorityStore,
  CREDENTIAL_CLASS,
} from "../../actions/index.js";
import type { ActionApprovalV1, ActionProposalV1 } from "../../actions/types.js";
import {
  AUTHORITY_REPAIR_BINDING_MODE,
  AUTHORITY_REPAIR_CONTROL_STATE,
  AUTHORITY_REPAIR_GUIDED_STATUS,
  AUTHORITY_REPAIR_LIMIT,
  AUTHORITY_REPAIR_SCHEMA_VERSION,
  AuthorityRepairArtifactStoreV1,
  AuthorityRepairExecutorV1,
  AuthorityRepairOperationStoreV1,
  AuthorityRepairOrdinaryActionResolverV1,
  OrdinaryAuthorityRepairActionObjectStoreV1,
  RecoveryBootstrapStoreV1,
  materializeAuthorityRepairAbsenceEvidence,
  materializeAuthorityRepairOperation,
  materializeCheckpointAuthorityRepairProposal,
  materializeOrdinaryAuthorityRepairProposal,
  materializeRecoveryBootstrapApproval,
  planAuthorityRepair,
  readActivatedRecoveryBootstrap,
} from "../../capabilities/authority-repair/index.js";
import type {
  AuthorityRepairEventV1,
  AuthorityRepairPreparedCandidateV1,
  AuthorityRepairProductionRegistryV1,
  PlannedAuthorityRepairV1,
} from "../../capabilities/authority-repair/index.js";
import type {
  AuthorityRepairCliCandidateOptionV1,
  AuthorityRepairCliInteractionV1,
  CapabilityCliAuthorityRepairExecutionV1,
} from "../../capabilities/cli/ports.js";
import { CapabilityRuntimeError } from "../../capabilities/operations/errors.js";
import { CAPABILITY_RUNTIME_ERROR_CODE } from "../../core/capability-contract.js";
import {
  authorityRepairPlanningCandidate,
  authorityRepairTerminalStatus,
  ordinaryAuthorityRepairAuthority,
  publicAuthorityRepairCandidate,
} from "./authority-repair-runtime-helpers.js";

export type AuthorityRepairGuidedOutcomeV1 =
  | {
      status: typeof AUTHORITY_REPAIR_GUIDED_STATUS.DENIED;
      proposal: ActionProposalV1;
      approval: ActionApprovalV1;
      planned: PlannedAuthorityRepairV1;
    }
  | {
      status:
        | typeof AUTHORITY_REPAIR_GUIDED_STATUS.VERIFIED
        | typeof AUTHORITY_REPAIR_GUIDED_STATUS.FAILED
        | typeof AUTHORITY_REPAIR_GUIDED_STATUS.NEEDS_RECOVERY;
      proposal: ActionProposalV1;
      approval: ActionApprovalV1;
      operation: ReturnType<typeof materializeAuthorityRepairOperation>;
      event: AuthorityRepairEventV1;
      planned: PlannedAuthorityRepairV1;
    };

export interface AuthorityRepairGuidedRuntimeOptionsV1 {
  registry: AuthorityRepairProductionRegistryV1;
  user_vibeflow_root: string;
  now?: () => string;
  random_bytes?: (size: number) => Uint8Array;
}

export class AuthorityRepairGuidedMutationRuntimeV1 {
  readonly now: () => string;
  readonly randomBytes: (size: number) => Uint8Array;

  constructor(readonly options: AuthorityRepairGuidedRuntimeOptionsV1) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.randomBytes = options.random_bytes ?? systemRandomBytes;
  }

  private persistArtifacts(
    prepared: AuthorityRepairPreparedCandidateV1,
    planned: PlannedAuthorityRepairV1,
    operationStore: AuthorityRepairOperationStoreV1,
  ): void {
    const artifacts = new AuthorityRepairArtifactStoreV1(operationStore.ownerRoot);
    const steps = planned.closure.steps;
    let absence: ReturnType<typeof materializeAuthorityRepairAbsenceEvidence> | undefined;
    if (steps.target_preimage.presence === "absent") {
      if (
        steps.target_locator === null ||
        steps.target_locator.strategy === "new-journal-generation"
      )
        throw new Error("absent repair target has no legal direct locator");
      absence = materializeAuthorityRepairAbsenceEvidence({
        schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
        domain: steps.domain,
        authority_scope: steps.authority_scope,
        scope_id: steps.scope_id,
        target_locator: steps.target_locator,
        observed_at: planned.closure.plan.created_at,
      });
    }
    if (
      absence &&
      steps.target_preimage.presence === "absent" &&
      absence.evidence_digest !== steps.target_preimage.absence_evidence_digest
    )
      throw new Error("prepared absence checkpoint does not match its derived evidence");
    operationStore.withLock(
      `authority-repair-artifacts:${planned.closure.plan.repair_id}`,
      (lock) =>
        artifacts.persistPlanArtifacts(lock, {
          closure: planned.closure,
          restore_bytes: prepared.restore_bytes,
          ...(absence ? { absence_evidence: absence } : {}),
          ...(prepared.epoch_base ? { epoch_base: prepared.epoch_base } : {}),
        }),
    );
  }

  private executeOrdinary(
    input: CapabilityCliAuthorityRepairExecutionV1,
    prepared: AuthorityRepairPreparedCandidateV1,
    planned: PlannedAuthorityRepairV1,
    operations: AuthorityRepairOperationStoreV1,
    approved: boolean,
  ): AuthorityRepairGuidedOutcomeV1 {
    const locator = planned.closure.action_plan.action_root_locator;
    if (locator.kind === ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP)
      throw new Error("ordinary authority repair received a bootstrap locator");
    const ownerRoot = operations.ownerRoot;
    const objects = new OrdinaryAuthorityRepairActionObjectStoreV1(ownerRoot, locator);
    objects.persist({
      authorization: planned.closure.authorization,
      plan: planned.closure.plan,
      action_plan: planned.closure.action_plan,
    });
    const authority = ordinaryAuthorityRepairAuthority(
      locator,
      input.context.actor,
      this.randomBytes,
    );
    const resolver = new AuthorityRepairOrdinaryActionResolverV1(
      ownerRoot,
      locator,
      this.options.registry,
      operations,
    );
    let storeNow = Date.parse(planned.closure.plan.created_at);
    const actionStore = new ActionAuthorityStore(ownerRoot, {
      authority_resolver: resolver,
      now: () => storeNow,
    });
    const proposalMaterial = materializeOrdinaryAuthorityRepairProposal({
      closure: planned.closure,
      context: {
        base: prepared.proposal_base,
        policy_digest: prepared.policy_digest,
        grant_digest: prepared.grant_digest,
      },
      authority,
    });
    const proposal = actionStore.createProposal({
      authority,
      canonical_request: proposalMaterial.canonical_request,
      proposal: proposalMaterial.proposal,
    }).proposal;
    storeNow = Date.parse(this.now());
    const approval = actionStore.decide({
      proposal_id: proposal.proposal_id,
      proposal_digest: proposal.proposal_digest,
      authority,
      decision: approved ? ACTION_DECISION.APPROVED : ACTION_DECISION.DENIED,
      challenge_id: null,
      challenge_response: null,
    });
    if (!approved)
      return { status: AUTHORITY_REPAIR_GUIDED_STATUS.DENIED, proposal, approval, planned };
    const operation = materializeAuthorityRepairOperation(proposal, approval);
    operations.withLock(operation.operation_id, (lock) => operations.createHeader(lock, operation));
    actionStore.prepareDispatch(proposal.proposal_id, approval.approval_id);
    actionStore.beginDispatch(proposal.proposal_id, approval.approval_id);
    const event = new AuthorityRepairExecutorV1(
      operations,
      this.options.registry.execution,
      this.now,
    ).execute({ proposal, approval, operation, closure: planned.closure });
    actionStore.recordTerminal(proposal.proposal_id);
    return {
      status: authorityRepairTerminalStatus(event),
      proposal,
      approval,
      operation,
      event,
      planned,
    };
  }

  private executeBootstrap(
    input: CapabilityCliAuthorityRepairExecutionV1,
    selected: AuthorityRepairCliCandidateOptionV1,
    prepared: AuthorityRepairPreparedCandidateV1,
    planned: PlannedAuthorityRepairV1,
    operations: AuthorityRepairOperationStoreV1,
    interaction: AuthorityRepairCliInteractionV1,
    criticalApproved: boolean,
  ): AuthorityRepairGuidedOutcomeV1 {
    if (
      input.context.actor.kind !== ACTOR_KIND.HUMAN_CLI ||
      input.context.actor.credential_class !== CREDENTIAL_CLASS.RECOVERY
    )
      throw new Error("bootstrap authority repair requires recovery CLI credentials");
    const material = materializeCheckpointAuthorityRepairProposal({
      closure: planned.closure,
      context: {
        base: prepared.proposal_base,
        policy_digest: prepared.policy_digest,
        grant_digest: prepared.grant_digest,
      },
      actor: input.context.actor,
    });
    const bootstrap = new RecoveryBootstrapStoreV1(
      this.options.user_vibeflow_root,
      this.options.registry,
    );
    const proposal = bootstrap.propose({
      draft: material.draft,
      closure: planned.closure,
      recorded_at: planned.closure.plan.created_at,
    });
    const decidedAt = this.now();
    const expiresAt = new Date(
      Math.min(
        Date.parse(proposal.expires_at),
        Date.parse(decidedAt) + AUTHORITY_REPAIR_LIMIT.APPROVAL_TTL_MS,
      ),
    ).toISOString();
    const predictedApproval = criticalApproved
      ? materializeRecoveryBootstrapApproval({
          proposal,
          decision: ACTION_DECISION.APPROVED,
          decided_at: decidedAt,
          expires_at: expiresAt,
        })
      : null;
    const recoveryApproved =
      predictedApproval !== null &&
      interaction.confirmRecoveryReview({
        scope: input.scope,
        conversation_id: input.conversation_id,
        candidate: selected,
        operation_id: materializeAuthorityRepairOperation(proposal, predictedApproval).operation_id,
        observed_authority_digest: null,
      });
    const approval = bootstrap.decide({
      proposal_id: proposal.proposal_id,
      decision: recoveryApproved ? ACTION_DECISION.APPROVED : ACTION_DECISION.DENIED,
      decided_at: decidedAt,
      expires_at: expiresAt,
    });
    if (!recoveryApproved)
      return { status: AUTHORITY_REPAIR_GUIDED_STATUS.DENIED, proposal, approval, planned };
    if (
      predictedApproval === null ||
      approval.approval_digest !== predictedApproval.approval_digest
    )
      throw new Error("bootstrap approval changed after recovery review");
    const operation = bootstrap.dispatch(proposal.proposal_id);
    const event = new AuthorityRepairExecutorV1(
      operations,
      this.options.registry.execution,
      this.now,
    ).execute({ proposal, approval, operation, closure: planned.closure });
    bootstrap.mirror({
      proposal_id: proposal.proposal_id,
      operation,
      operation_events: operations.readEvents(operation),
      event,
      recorded_at: event.recorded_at,
    });
    return {
      status: authorityRepairTerminalStatus(event),
      proposal,
      approval,
      operation,
      event,
      planned,
    };
  }

  executeGuided(
    input: CapabilityCliAuthorityRepairExecutionV1,
    interaction: AuthorityRepairCliInteractionV1,
  ): AuthorityRepairGuidedOutcomeV1 {
    if (
      !input.context.stdin_is_tty ||
      interaction.authenticated_local_tty !== true ||
      input.context.actor.kind !== ACTOR_KIND.HUMAN_CLI ||
      input.context.actor.credential_class !== CREDENTIAL_CLASS.RECOVERY
    )
      throw new CapabilityRuntimeError(
        "authority repair requires an authenticated interactive local TTY",
        CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH,
      );
    const snapshot = this.options.registry.snapshot();
    const candidates = snapshot.identities
      .map((row) => ({ identity: row, prepared: snapshot.prepared(row.candidate_id) }))
      .filter(
        ({ prepared }) =>
          prepared.authorization.control_scope === input.scope &&
          (input.conversation_id === null || prepared.conversation_id === input.conversation_id),
      )
      .map(({ identity, prepared }) => publicAuthorityRepairCandidate(identity, prepared));
    if (candidates.length === 0)
      throw new CapabilityRuntimeError(
        "no checksum-valid authority repair checkpoint is available",
        CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
      );
    const selectedId = interaction.selectCandidate({
      scope: input.scope,
      conversation_id: input.conversation_id,
      candidates,
    });
    const selected = candidates.find((candidate) => candidate.candidate_id === selectedId);
    if (!selected)
      throw new CapabilityRuntimeError(
        "guided authority repair selected an unknown candidate",
        CAPABILITY_RUNTIME_ERROR_CODE.INVALID_PLAN,
      );
    const prepared = snapshot.prepared(selected.candidate_id);
    const checkpoint =
      prepared.control_state === AUTHORITY_REPAIR_CONTROL_STATE.RECOVERY_CHECKPOINT_ONLY;
    const bootstrapIdentity = checkpoint
      ? readActivatedRecoveryBootstrap(this.options.user_vibeflow_root).identity.content_digest
      : null;
    const planned = planAuthorityRepair(
      authorityRepairPlanningCandidate(prepared, bootstrapIdentity),
    );
    if (
      checkpoint !== planned.bootstrap_required ||
      (checkpoint &&
        planned.closure.authorization.mode !== AUTHORITY_REPAIR_BINDING_MODE.RECOVERY_CHECKPOINT) ||
      (!checkpoint && planned.closure.authorization.mode !== AUTHORITY_REPAIR_BINDING_MODE.CURRENT)
    )
      throw new Error("authority repair planner changed the selected authority path");
    const criticalApproved = interaction.confirmCriticalReview({
      scope: input.scope,
      conversation_id: input.conversation_id,
      candidate: selected,
      plan_digest: planned.closure.plan.plan_digest,
      repair_id: planned.closure.plan.repair_id,
      bootstrap_required: checkpoint,
    });
    const ownerRoot = this.options.registry.ownerRoot(planned.closure.plan);
    const operations = new AuthorityRepairOperationStoreV1(ownerRoot);
    this.persistArtifacts(prepared, planned, operations);
    return checkpoint
      ? this.executeBootstrap(
          input,
          selected,
          prepared,
          planned,
          operations,
          interaction,
          criticalApproved,
        )
      : this.executeOrdinary(input, prepared, planned, operations, criticalApproved);
  }
}
