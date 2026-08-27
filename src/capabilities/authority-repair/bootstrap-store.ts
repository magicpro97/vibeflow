import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import { ACTION_DECISION } from "../../actions/public-action-contract.js";
import type { ActionProposalDraftV1 } from "../../actions/types.js";
import { acquireProcessLock, privateFileBytes } from "../../durability/index.js";
import { canonicalJson } from "../../durability/index.js";
import { RecoveryBootstrapActionObjectStoreV1 } from "./action-object-store.js";
import { readActivatedRecoveryBootstrap } from "./bootstrap-activation.js";
import {
  appendRecoveryBootstrapEvent,
  readRecoveryBootstrapJournalBytes,
} from "./bootstrap-journal.js";
import { assertAuthorityRepairClosure } from "./closure-records.js";
import {
  AUTHORITY_REPAIR_LIMIT,
  AUTHORITY_REPAIR_TERMINAL_STATE,
  RECOVERY_BOOTSTRAP_PAYLOAD_KIND,
} from "./contract.js";
import { authorityRepairActionPlanDigest } from "./digests.js";
import { foldAuthorityRepairOperation } from "./operation-fold.js";
import { recoveryBootstrapPaths } from "./paths.js";
import {
  materializeAuthorityRepairOperation,
  materializeRecoveryBootstrapApproval,
  materializeRecoveryBootstrapProposal,
} from "./records.js";
import type {
  AuthorityRepairActionObjectClosureV1,
  AuthorityRepairActionObjectsV1,
  AuthorityRepairEventV1,
  AuthorityRepairOperationV1,
  RecoveryBootstrapEventV1,
} from "./types.js";

function fail(message: string): never {
  throw new Error(`recovery bootstrap store: ${message}`);
}

export interface AuthorityRepairPreparedArtifactResolverV1 {
  /** Resolves the direct affected-root steps/source/evidence paths; enumeration is forbidden. */
  resolve(objects: AuthorityRepairActionObjectsV1): AuthorityRepairActionObjectClosureV1;
}

export class RecoveryBootstrapStoreV1 {
  readonly paths;
  readonly objects: RecoveryBootstrapActionObjectStoreV1;

  constructor(
    readonly userVibeflowRoot: string,
    readonly preparedArtifacts: AuthorityRepairPreparedArtifactResolverV1,
  ) {
    readActivatedRecoveryBootstrap(userVibeflowRoot);
    this.paths = recoveryBootstrapPaths(userVibeflowRoot);
    this.objects = new RecoveryBootstrapActionObjectStoreV1(userVibeflowRoot);
  }

  private validateFoldObjects(fold: ReturnType<typeof readRecoveryBootstrapJournalBytes>): void {
    for (const state of fold.proposals.values()) {
      if (state.proposal.action.type !== HOST_ACTION_KIND.AUTHORITY_REPAIR)
        fail("bootstrap proposal carries a non-repair action");
      const objects = this.objects.read({
        binding_digest: state.proposal.action.plan.repair_authorization_binding_digest,
        plan_digest: state.proposal.action.plan.plan_digest,
        action_plan_digest: state.proposal.plan_digest,
      });
      const closure = this.preparedArtifacts.resolve(objects);
      assertAuthorityRepairClosure(closure);
      if (
        canonicalJson(closure.authorization) !== canonicalJson(objects.authorization) ||
        canonicalJson(closure.plan) !== canonicalJson(state.proposal.action.plan) ||
        canonicalJson(closure.action_plan) !== canonicalJson(objects.action_plan) ||
        canonicalJson(closure.action_plan.action_root_locator) !==
          canonicalJson(state.proposal.action_root_locator)
      )
        fail("bootstrap journal no longer resolves its immutable action objects");
    }
  }

  private withJournal<T>(
    operation: string,
    body: (
      activation: ReturnType<typeof readActivatedRecoveryBootstrap>,
      fold: ReturnType<typeof readRecoveryBootstrapJournalBytes>,
      append: (payload: RecoveryBootstrapEventV1["payload"], recordedAt: string) => void,
    ) => T,
  ): T {
    const lock = acquireProcessLock(this.paths.writerLock, {
      operation,
      coverageRoot: this.paths.root,
    });
    try {
      const activation = readActivatedRecoveryBootstrap(this.userVibeflowRoot);
      const bytes = privateFileBytes(this.paths.journal, AUTHORITY_REPAIR_LIMIT.JOURNAL_BYTES);
      if (bytes === null) return fail("activated bootstrap journal disappeared");
      let fold = readRecoveryBootstrapJournalBytes(activation.identity, bytes);
      this.validateFoldObjects(fold);
      const append = (payload: RecoveryBootstrapEventV1["payload"], recordedAt: string) => {
        fold = appendRecoveryBootstrapEvent({
          path: this.paths.journal,
          lock,
          identity: activation.identity,
          prior: fold,
          payload,
          recorded_at: recordedAt,
        });
      };
      return body(activation, fold, append);
    } finally {
      lock.release();
    }
  }

  propose(input: {
    draft: ActionProposalDraftV1;
    closure: AuthorityRepairActionObjectClosureV1;
    recorded_at: string;
  }) {
    assertAuthorityRepairClosure(input.closure);
    if (
      input.draft.action.type !== HOST_ACTION_KIND.AUTHORITY_REPAIR ||
      input.draft.action.plan.plan_digest !== input.closure.plan.plan_digest ||
      input.draft.plan_digest !== authorityRepairActionPlanDigest(input.closure.action_plan)
    )
      fail("bootstrap proposal does not bind its exact persisted repair objects");
    this.objects.persist({
      authorization: input.closure.authorization,
      plan: input.closure.plan,
      action_plan: input.closure.action_plan,
    });
    const resolved = this.preparedArtifacts.resolve({
      authorization: input.closure.authorization,
      plan: input.closure.plan,
      action_plan: input.closure.action_plan,
    });
    assertAuthorityRepairClosure(resolved);
    if (canonicalJson(resolved) !== canonicalJson(input.closure))
      fail("bootstrap proposal does not resolve its exact affected-root repair artifacts");
    const proposal = materializeRecoveryBootstrapProposal(input.draft);
    this.withJournal(
      `recovery-bootstrap-proposal:${proposal.proposal_id}`,
      (_activation, fold, append) => {
        if (fold.proposals.has(proposal.proposal_id))
          return fail("bootstrap proposal already exists");
        append(
          {
            kind: RECOVERY_BOOTSTRAP_PAYLOAD_KIND.PROPOSAL_CREATED,
            proposal,
            repair_plan_digest: input.closure.plan.plan_digest,
          },
          input.recorded_at,
        );
      },
    );
    return proposal;
  }

  decide(input: {
    proposal_id: string;
    decision: typeof ACTION_DECISION.APPROVED | typeof ACTION_DECISION.DENIED;
    decided_at: string;
    expires_at: string;
  }) {
    return this.withJournal(
      `recovery-bootstrap-decision:${input.proposal_id}`,
      (_activation, fold, append) => {
        const state = fold.proposals.get(input.proposal_id);
        if (!state || state.approval)
          return fail("bootstrap decision has no unique pending proposal");
        const result = materializeRecoveryBootstrapApproval({ proposal: state.proposal, ...input });
        append(
          {
            kind: RECOVERY_BOOTSTRAP_PAYLOAD_KIND.APPROVAL_DECISION,
            proposal_id: input.proposal_id,
            from: "pending_review",
            to: input.decision,
            approval: result,
          },
          input.decided_at,
        );
        return result;
      },
    );
  }

  dispatch(proposalId: string): AuthorityRepairOperationV1 {
    return this.withJournal(
      `recovery-bootstrap-dispatch:${proposalId}`,
      (_activation, fold, append) => {
        const state = fold.proposals.get(proposalId);
        if (
          !state?.approval ||
          state.approval.decision !== ACTION_DECISION.APPROVED ||
          state.operation
        )
          return fail("bootstrap dispatch has no unique approved proposal");
        const operation = materializeAuthorityRepairOperation(state.proposal, state.approval);
        append(
          {
            kind: RECOVERY_BOOTSTRAP_PAYLOAD_KIND.REPAIR_DISPATCH,
            proposal_id: proposalId,
            operation,
          },
          operation.created_at,
        );
        return operation;
      },
    );
  }

  mirror(input: {
    proposal_id: string;
    operation: AuthorityRepairOperationV1;
    operation_events: readonly AuthorityRepairEventV1[];
    event: AuthorityRepairEventV1;
    recorded_at: string;
  }): void {
    const operationFold = foldAuthorityRepairOperation(input.operation, input.operation_events);
    const eventIndex = operationFold.events.findIndex(
      (event) => event.event_digest === input.event.event_digest,
    );
    if (
      eventIndex < 0 ||
      operationFold.events[eventIndex]?.event_digest !== operationFold.head_event_digest
    )
      fail("mirrored repair event is not the current validated operation descendant");
    if (
      !Object.values(AUTHORITY_REPAIR_TERMINAL_STATE).some((state) => state === input.event.state)
    )
      fail("bootstrap mirror references a non-terminal/recovery repair event");
    this.withJournal(
      `recovery-bootstrap-mirror:${input.operation.operation_id}`,
      (_activation, fold, append) => {
        const state = fold.proposals.get(input.proposal_id);
        if (!state?.operation || state.operation.header_digest !== input.operation.header_digest)
          return fail("bootstrap mirror does not match its dispatch");
        const previous = state.mirrored_event_digest;
        if (previous !== null) {
          const priorIndex = operationFold.events.findIndex(
            (event) => event.event_digest === previous,
          );
          if (priorIndex < 0 || priorIndex >= eventIndex)
            return fail("bootstrap mirror is not a strict descendant of its prior mirror");
        }
        append(
          {
            kind: RECOVERY_BOOTSTRAP_PAYLOAD_KIND.TERMINAL_MIRROR,
            proposal_id: input.proposal_id,
            repair_id: input.operation.repair_id,
            operation_id: input.operation.operation_id,
            header_digest: input.operation.header_digest,
            outcome: input.event
              .state as (typeof AUTHORITY_REPAIR_TERMINAL_STATE)[keyof typeof AUTHORITY_REPAIR_TERMINAL_STATE],
            authority_repair_event_digest: input.event.event_digest,
            previous_mirrored_event_digest: previous,
          },
          input.recorded_at,
        );
      },
    );
  }
}
