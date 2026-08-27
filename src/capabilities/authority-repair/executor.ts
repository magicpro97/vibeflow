import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import type { AuthorityRepairDomainV1 } from "../../actions/internal-action-vocabulary-contract.js";
import { ACTION_AUTHORITY_REPAIR_DOMAINS } from "../../actions/internal-action-vocabulary-contract.js";
import { ACTION_DECISION } from "../../actions/public-action-contract.js";
import type { ActionApprovalV1, ActionProposalV1 } from "../../actions/types.js";
import { canonicalJson } from "../../durability/index.js";
import { assertAuthorityRepairDomainLocator } from "./adapter-registry.js";
import { assertAuthorityRepairClosure } from "./closure-records.js";
import {
  AUTHORITY_REPAIR_EVENT_STATE,
  AUTHORITY_REPAIR_STRATEGY,
  AUTHORITY_REPAIR_TERMINAL_STATE,
} from "./contract.js";
import type { AuthorityRepairEventStateV1 } from "./contract.js";
import { authorityRepairActionPlanDigest } from "./digests.js";
import type { AuthorityRepairOperationFoldV1 } from "./operation-fold.js";
import type { AuthorityRepairOperationStoreV1 } from "./operation-store.js";
import {
  AUTHORITY_REPAIR_RECONCILIATION_DISPOSITION as D,
  dispatchAuthorityRepairReconciliation,
} from "./reconciliation.js";
import type {
  AuthorityRepairReconciliationClaimsV1,
  AuthorityRepairReconciliationRowV1,
} from "./reconciliation.js";
import {
  assertAuthorityRepairEvent,
  materializeAuthorityRepairEvent,
  materializeAuthorityRepairOperation,
} from "./records.js";
import type {
  AuthorityRepairActionObjectClosureV1,
  AuthorityRepairEventV1,
  AuthorityRepairOperationV1,
} from "./types.js";

export interface AuthorityRepairExecutionObservationV1 {
  claims: AuthorityRepairReconciliationClaimsV1;
  observation_digest: string | null;
}

export interface AuthorityRepairExecutionContextV1 {
  operation: Readonly<AuthorityRepairOperationV1>;
  closure: Readonly<AuthorityRepairActionObjectClosureV1>;
  current_event: Readonly<AuthorityRepairEventV1>;
  fold: Readonly<AuthorityRepairOperationFoldV1>;
}

export interface AuthorityRepairExecutionAdapterV1 {
  readonly domain: AuthorityRepairDomainV1;
  /** Must acquire every domain/control lock in the normative order and hold through callback return. */
  withLocks<T>(operation: AuthorityRepairOperationV1, callback: () => T): T;
  observe(context: AuthorityRepairExecutionContextV1): AuthorityRepairExecutionObservationV1;
  /** Executes only the exact table disposition; it cannot substitute a different repair candidate. */
  advance(
    context: AuthorityRepairExecutionContextV1,
    row: AuthorityRepairReconciliationRowV1,
  ): AuthorityRepairExecutionObservationV1;
}

export type AuthorityRepairExecutionAdapterSetV1 = {
  readonly [Domain in AuthorityRepairDomainV1]: AuthorityRepairExecutionAdapterV1 & {
    readonly domain: Domain;
  };
};

export class AuthorityRepairExecutionAdapterRegistryV1 {
  constructor(readonly adapters: AuthorityRepairExecutionAdapterSetV1) {
    for (const domain of ACTION_AUTHORITY_REPAIR_DOMAINS)
      if (adapters[domain].domain !== domain)
        throw new Error(`authority repair execution adapter misregistered for ${domain}`);
    Object.freeze(adapters);
  }
}

export interface ExecuteAuthorityRepairInputV1 {
  proposal: ActionProposalV1;
  approval: ActionApprovalV1;
  operation: AuthorityRepairOperationV1;
  closure: AuthorityRepairActionObjectClosureV1;
}

function exact(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function nextState(row: AuthorityRepairReconciliationRowV1): AuthorityRepairEventStateV1 | null {
  switch (row.disposition) {
    case D.FAILED:
      return AUTHORITY_REPAIR_EVENT_STATE.FAILED;
    case D.NEEDS_RECOVERY:
      return AUTHORITY_REPAIR_EVENT_STATE.NEEDS_RECOVERY;
    case D.PREIMAGE_FSYNCED:
      return AUTHORITY_REPAIR_EVENT_STATE.PREIMAGE_FSYNCED;
    case D.RESTORE_IN_PROGRESS:
      return AUTHORITY_REPAIR_EVENT_STATE.RESTORE_IN_PROGRESS;
    case D.RESTORED:
      return AUTHORITY_REPAIR_EVENT_STATE.RESTORED;
    case D.VERIFIED:
      return AUTHORITY_REPAIR_EVENT_STATE.VERIFIED;
    case D.RETRY_TARGET_CAS:
    case D.RETRY_POINTER_CAS:
    case D.PREPARE_COMPOUND:
    case D.RETRY_COMPOUND_HEAD_CAS:
    case D.APPEND_AUTHORITY_EVENT:
    case D.COMMIT_AUTHORITY_HEAD:
      return null;
  }
}

function strategyClass(
  closure: AuthorityRepairActionObjectClosureV1,
): "json-content" | "journal" | "compound" {
  if (closure.steps.strategy === AUTHORITY_REPAIR_STRATEGY.REPLACE_AUTHORITY_EPOCH_COMPOUND)
    return "compound";
  if (closure.steps.strategy === AUTHORITY_REPAIR_STRATEGY.NEW_JOURNAL_GENERATION) return "journal";
  return "json-content";
}

export class AuthorityRepairExecutorV1 {
  constructor(
    readonly store: AuthorityRepairOperationStoreV1,
    readonly adapters: AuthorityRepairExecutionAdapterRegistryV1,
    readonly now: () => string = () => new Date().toISOString(),
    readonly maxAdvances = 64,
  ) {}

  execute(input: ExecuteAuthorityRepairInputV1): AuthorityRepairEventV1 {
    if (input.approval.decision !== ACTION_DECISION.APPROVED)
      throw new Error("authority repair execution requires an approved proposal");
    assertAuthorityRepairClosure(input.closure);
    const expectedOperation = materializeAuthorityRepairOperation(input.proposal, input.approval);
    if (
      !exact(expectedOperation, input.operation) ||
      input.proposal.action.type !== HOST_ACTION_KIND.AUTHORITY_REPAIR ||
      !exact(input.proposal.action.plan, input.closure.plan) ||
      input.proposal.plan_digest !== input.operation.action_plan_binding_digest
    )
      throw new Error("authority repair execution escaped its approved immutable closure");
    if (
      input.proposal.plan_digest !== authorityRepairActionPlanDigest(input.closure.action_plan) ||
      !exact(input.proposal.action_root_locator, input.closure.action_plan.action_root_locator)
    )
      throw new Error("authority repair proposal does not bind the resolved action objects");
    assertAuthorityRepairDomainLocator(input.operation.domain, input.closure.steps);

    this.store.withLock(input.operation.operation_id, (lock) => {
      this.store.createHeader(lock, input.operation);
      const fold = this.store.fold(input.operation.operation_id);
      if (fold.events.length === 0) {
        const prepared = materializeAuthorityRepairEvent(input.operation, {
          sequence: 0,
          previous_event_digest: null,
          state: AUTHORITY_REPAIR_EVENT_STATE.PREPARED,
          observed_authority_digest: null,
          reason_code: null,
          recorded_at: this.now(),
        });
        this.store.append(lock, input.operation, prepared);
      }
    });

    const adapter = this.adapters.adapters[input.operation.domain];
    for (let advance = 0; advance < this.maxAdvances; advance += 1) {
      const fold = this.store.fold(input.operation.operation_id);
      const current = fold.events.at(-1);
      if (!current) throw new Error("authority repair prepared event disappeared");
      if (
        current.state === AUTHORITY_REPAIR_TERMINAL_STATE.VERIFIED ||
        current.state === AUTHORITY_REPAIR_TERMINAL_STATE.FAILED
      )
        return current;
      const result = adapter.withLocks(input.operation, () => {
        const context: AuthorityRepairExecutionContextV1 = {
          operation: input.operation,
          closure: input.closure,
          current_event: current,
          fold,
        };
        const before = adapter.observe(context);
        const anchor = fold.resume_anchor;
        if (
          anchor !== AUTHORITY_REPAIR_EVENT_STATE.PREPARED &&
          anchor !== AUTHORITY_REPAIR_EVENT_STATE.PREIMAGE_FSYNCED &&
          anchor !== AUTHORITY_REPAIR_EVENT_STATE.RESTORE_IN_PROGRESS &&
          anchor !== AUTHORITY_REPAIR_EVENT_STATE.RESTORED
        )
          throw new Error("authority repair fold has no resumable reconciliation anchor");
        const row = dispatchAuthorityRepairReconciliation({
          claims: before.claims,
          strategy: strategyClass(input.closure),
          preimage: input.closure.steps.target_preimage.presence,
          resume_anchor: anchor,
          reconciling: current.state === AUTHORITY_REPAIR_EVENT_STATE.NEEDS_RECOVERY,
        });
        const after = adapter.advance(context, row);
        const state = nextState(row);
        if (state === null) return null;
        const observed =
          state === AUTHORITY_REPAIR_EVENT_STATE.RESTORED ||
          state === AUTHORITY_REPAIR_EVENT_STATE.VERIFIED
            ? input.operation.proposed_restored_authority_digest
            : state === AUTHORITY_REPAIR_EVENT_STATE.FAILED ||
                state === AUTHORITY_REPAIR_EVENT_STATE.NEEDS_RECOVERY
              ? after.observation_digest
              : null;
        if (
          (state === AUTHORITY_REPAIR_EVENT_STATE.FAILED ||
            state === AUTHORITY_REPAIR_EVENT_STATE.NEEDS_RECOVERY) &&
          observed === null
        )
          throw new Error(
            "repair failure/recovery disposition lacks its persisted observation digest",
          );
        const event = materializeAuthorityRepairEvent(input.operation, {
          sequence: current.sequence + 1,
          previous_event_digest: current.event_digest,
          state,
          observed_authority_digest: observed,
          reason_code: row.reason_code,
          recorded_at: this.now(),
        });
        assertAuthorityRepairEvent(event);
        this.store.withLock(input.operation.operation_id, (lock) =>
          this.store.append(lock, input.operation, event),
        );
        return event;
      });
      if (
        result &&
        (result.state === AUTHORITY_REPAIR_TERMINAL_STATE.VERIFIED ||
          result.state === AUTHORITY_REPAIR_TERMINAL_STATE.FAILED ||
          result.state === AUTHORITY_REPAIR_TERMINAL_STATE.NEEDS_RECOVERY)
      )
        return result;
    }
    throw new Error("authority repair executor exceeded its bounded reconciliation advances");
  }
}
