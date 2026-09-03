import { existsSync } from "node:fs";
import { ACTION_OPERATION_STATE } from "../../actions/protocol-contract.js";
import {
  CAPABILITY_PLAN_STATUS,
  CAPABILITY_RUNTIME_ERROR_CODE,
} from "../../core/capability-contract.js";
import { validateCapabilityPlanningGraph } from "../planning/execution-graph-validation.js";
import type {
  CapabilityDurablePlanningGraphV1,
  CapabilityFabricPlanV1,
} from "../planning/types.js";
import { writeCapabilityOperationHeader } from "../storage/operation-store.js";
import { capabilityOperationPaths } from "../storage/paths.js";
import type { CapabilityScopeLockV1 } from "../storage/scope-lock.js";
import {
  CAPABILITY_ADAPTER_RECEIPT_ERROR_CODE,
  CAPABILITY_ADAPTER_RECEIPT_STATE,
  CAPABILITY_OPERATION_RECOVERY_PHASE,
} from "../wire/operation.js";
import { capabilityRecoveryFrontier } from "./authority-frontier.js";
import { reconcileCrashPartialEffect } from "./crash-reconciliation.js";
import { CapabilityRuntimeError, runtimeCodeForRefusal } from "./errors.js";
import {
  foldCapabilityOperation,
  readCapabilityOperationView,
  readOperationGraph,
  readOperationHeader,
} from "./fold.js";
import { readCapabilityHealthCurrent, readCapabilityHealthInventory } from "./health-inventory.js";
import {
  assertCapabilityAuthorizationPlanRoot,
  assertCapabilityExecutionAuthorization,
  capabilityOperationIdForAuthorization,
} from "./operation-closure.js";
import {
  continueCapabilityOperation,
  finishCapabilityOperationAfterRollback,
} from "./operation-commit.js";
import { CapabilityOperationJournalV1 } from "./operation-journal.js";
import {
  assertNoOpInspectionOnly,
  beginCapabilityOperationRecovery,
} from "./operation-preflight.js";
import { recoverCapabilityPublication } from "./publication-recovery.js";
import type {
  CapabilityExecutionAuthorizationV1,
  CapabilityExecutionRequestV1,
  CapabilityOperationExecutorOptionsV1,
  CapabilityOperationObserverV1,
  CapabilityOperationReadRequestV1,
  CapabilityOperationReadV1,
  CapabilityOperationResultV1,
  CapabilityRuntimeFaultPointV1,
} from "./types.js";
import { capabilityRuntimeAuthorityMismatch } from "./validation.js";

export type { CapabilityOperationExecutorOptionsV1 } from "./types.js";

export class CapabilityOperationExecutorV1 {
  fault: ((point: CapabilityRuntimeFaultPointV1) => void) | null = null;
  readonly #journal: CapabilityOperationJournalV1;

  constructor(readonly options: CapabilityOperationExecutorOptionsV1) {
    this.#journal = new CapabilityOperationJournalV1({
      ...options,
      fault: (point) => this.fault?.(point),
    });
  }

  operationId(
    graph: CapabilityDurablePlanningGraphV1,
    authorization: CapabilityExecutionAuthorizationV1,
  ): string {
    validateCapabilityPlanningGraph(graph);
    return capabilityOperationIdForAuthorization(authorization);
  }

  execute(request: CapabilityExecutionRequestV1): CapabilityOperationResultV1 {
    const prepared = this.prepare(request);
    if ("result" in prepared) return prepared.result;
    return this.recover(prepared.operation_id);
  }

  prepare(
    request: CapabilityExecutionRequestV1,
  ): import("./types.js").CapabilityPreparedOperationV1 | { result: CapabilityOperationResultV1 } {
    const graph = validateCapabilityPlanningGraph(request.graph);
    const { plan } = graph;
    if (plan.scope !== this.options.storage.paths.scope)
      throw new CapabilityRuntimeError(
        "plan scope is not owned by this executor",
        CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH,
      );
    if (plan.status === CAPABILITY_PLAN_STATUS.ACTION_REQUIRED)
      throw new CapabilityRuntimeError(
        "plan requires manual/native/unsupported action",
        CAPABILITY_RUNTIME_ERROR_CODE.ACTION_REQUIRED,
      );
    this.assertMutationAuthorities();
    const operationId = this.operationId(graph, request.authorization);
    assertCapabilityAuthorizationPlanRoot(plan, request.authorization);
    const headerPath = capabilityOperationPaths(this.options.storage.paths, operationId).header;
    if (existsSync(headerPath)) {
      const header = readOperationHeader(this.options.storage, operationId);
      readOperationGraph(this.actionAuthority(), header);
      assertCapabilityExecutionAuthorization(header, request.authorization);
      return {
        schema_version: "1.0",
        operation_id: operationId,
        header_digest: header.header_digest,
        prepared_at: header.created_at,
        header,
      };
    }
    const held = this.options.storage.acquire(operationId);
    try {
      this.assertBase(plan);
      this.assertAuthority(graph);
      assertNoOpInspectionOnly(plan);
      const header = this.#journal.createHeader(operationId, graph, request.authorization);
      this.actionAuthority().verifyPrepared(header, plan);
      writeCapabilityOperationHeader(this.options.storage.paths, header, held);
      this.fault?.("after-header");
      return {
        schema_version: "1.0",
        operation_id: operationId,
        header_digest: header.header_digest,
        prepared_at: header.created_at,
        header,
      };
    } finally {
      held.release();
    }
  }

  recover(operationId: string): CapabilityOperationResultV1 {
    this.assertMutationAuthorities();
    const header = readOperationHeader(this.options.storage, operationId);
    const graph = readOperationGraph(this.actionAuthority(), header);
    const { plan } = graph;
    const held = this.options.storage.acquire(operationId);
    try {
      const preflight = beginCapabilityOperationRecovery({
        plan,
        graph,
        operationId,
        header,
        held,
        options: this.options,
        journal: this.#journal,
      });
      if (preflight) return preflight;
      const recoveringFromNeedsRecovery =
        this.#journal.operationState(operationId) === ACTION_OPERATION_STATE.NEEDS_RECOVERY;
      const unresolved = this.#journal.unresolvedReceipt(operationId);
      // A durable prepared receipt proves that no effect frontier was entered.
      // continueCapabilityOperation advances that exact receipt without appending a duplicate.
      if (unresolved && unresolved.state !== CAPABILITY_ADAPTER_RECEIPT_STATE.PREPARED) {
        const unresolvedState = unresolved.state;
        const reconciled = capabilityRecoveryFrontier({
          graph,
          options: this.options,
          operation: `capability-recovery:${operationId}:${unresolved.step_id}`,
          recover: (forwardAuthorityCurrent) => {
            const descriptor = this.#journal.descriptorFor(
              plan,
              unresolved.plan_id,
              unresolved.step_id,
              unresolved.recovery_phase === CAPABILITY_OPERATION_RECOVERY_PHASE.ROLLBACK
                ? CAPABILITY_OPERATION_RECOVERY_PHASE.ROLLBACK
                : "intent",
            );
            const privatePayload = this.options.broker.resolvePrivatePayload(
              descriptor.private_payload_binding,
            );
            const observed = this.options.broker.inspect(
              descriptor.resource,
              privatePayload,
            ).content_sha256;
            const state = forwardAuthorityCurrent
              ? reconcileCrashPartialEffect({
                  state: unresolvedState,
                  phase: unresolved.recovery_phase,
                  observed,
                  descriptor,
                  privatePayload,
                  broker: this.options.broker,
                })
              : unresolved.recovery_phase === CAPABILITY_OPERATION_RECOVERY_PHASE.FORWARD &&
                  observed === descriptor.resource.expected_postimage_sha256
                ? CAPABILITY_ADAPTER_RECEIPT_STATE.APPLIED
                : unresolved.recovery_phase === CAPABILITY_OPERATION_RECOVERY_PHASE.ROLLBACK &&
                    observed === descriptor.resource.expected_preimage_sha256
                  ? CAPABILITY_ADAPTER_RECEIPT_STATE.REVERSED
                  : unresolved.recovery_phase === CAPABILITY_OPERATION_RECOVERY_PHASE.FORWARD &&
                      observed === descriptor.resource.expected_preimage_sha256
                    ? CAPABILITY_ADAPTER_RECEIPT_STATE.FAILED
                    : CAPABILITY_ADAPTER_RECEIPT_STATE.UNCERTAIN;
            const receiptError =
              state === CAPABILITY_ADAPTER_RECEIPT_STATE.FAILED
                ? CAPABILITY_ADAPTER_RECEIPT_ERROR_CODE.EFFECT_NOT_APPLIED
                : state === CAPABILITY_ADAPTER_RECEIPT_STATE.UNCERTAIN
                  ? CAPABILITY_ADAPTER_RECEIPT_ERROR_CODE.THIRD_STATE
                  : null;
            const observedAt = this.options.now();
            this.#journal.appendReceipt({
              operationId,
              plan,
              planId: unresolved.plan_id,
              stepId: unresolved.step_id,
              state,
              evidence: this.#journal.receiptEvidence({
                operationId,
                plan,
                planId: unresolved.plan_id,
                stepId: unresolved.step_id,
                descriptor,
                state,
                error: receiptError,
                observedAt,
                held,
              }),
              error: receiptError,
              observedAt,
              held,
            });
            return state;
          },
        });
        if (
          reconciled === CAPABILITY_ADAPTER_RECEIPT_STATE.FAILED ||
          reconciled === CAPABILITY_ADAPTER_RECEIPT_STATE.REVERSED ||
          (recoveringFromNeedsRecovery && reconciled === CAPABILITY_ADAPTER_RECEIPT_STATE.APPLIED)
        ) {
          return this.failAfterRollback(
            graph,
            operationId,
            held,
            CAPABILITY_RUNTIME_ERROR_CODE.APPLY_FAILED,
          );
        }
        if (reconciled === CAPABILITY_ADAPTER_RECEIPT_STATE.UNCERTAIN) {
          if (!recoveringFromNeedsRecovery)
            this.#journal.terminal(
              operationId,
              ACTION_OPERATION_STATE.NEEDS_RECOVERY,
              CAPABILITY_RUNTIME_ERROR_CODE.SCOPE_NEEDS_RECOVERY,
              held,
            );
          return foldCapabilityOperation(this.options.storage, operationId, this.actionAuthority());
        }
      }
      const publication = recoverCapabilityPublication({
        plan,
        graph,
        operationId,
        held,
        storage: this.options.storage,
        authority: this.options.authority,
        sourceAuthority: this.options.sourceAuthority,
        now: this.options.now,
        journal: this.#journal,
        actionAuthority: this.actionAuthority(),
      });
      if (publication.kind === "result") return publication.result;
      if (publication.kind === "rollback-required")
        return this.failAfterRollback(graph, operationId, held, publication.reason);
      if (recoveringFromNeedsRecovery)
        return foldCapabilityOperation(this.options.storage, operationId, this.actionAuthority());
      return continueCapabilityOperation({
        graph,
        plan,
        header,
        held,
        options: this.options,
        journal: this.#journal,
        fault: this.fault,
      });
    } finally {
      held.release();
    }
  }

  read(request: CapabilityOperationReadRequestV1): CapabilityOperationReadV1 {
    this.assertMutationAuthorities();
    const header = readOperationHeader(this.options.storage, request.operation_id);
    const graph = readOperationGraph(this.actionAuthority(), header);
    this.actionAuthority().verifyReadable(header, graph.plan);
    return readCapabilityOperationView(this.options.storage, request, this.actionAuthority());
  }

  private failAfterRollback(
    graph: CapabilityDurablePlanningGraphV1,
    operationId: string,
    held: CapabilityScopeLockV1,
    reason: string,
  ): CapabilityOperationResultV1 {
    return finishCapabilityOperationAfterRollback({
      graph,
      plan: graph.plan,
      operationId,
      held,
      journal: this.#journal,
      options: this.options,
      fault: this.fault,
      reason,
    });
  }

  private assertBase(plan: CapabilityFabricPlanV1): void {
    const current = this.options.storage.readStatus();
    const currentDigest = current.lock?.content_digest ?? null;
    if (current.state === "corrupt")
      throw new CapabilityRuntimeError(
        "capability scope needs recovery",
        CAPABILITY_RUNTIME_ERROR_CODE.SCOPE_NEEDS_RECOVERY,
      );
    if (currentDigest !== plan.base_lock_digest)
      throw new CapabilityRuntimeError(
        "capability base generation changed",
        CAPABILITY_RUNTIME_ERROR_CODE.SCOPE_BASE_STALE,
      );
    const pointer = readCapabilityHealthCurrent(this.options.storage);
    if (current.lock !== null && pointer === null)
      throw new CapabilityRuntimeError(
        "capability base lock has no selected health inventory",
        CAPABILITY_RUNTIME_ERROR_CODE.SCOPE_NEEDS_RECOVERY,
      );
    if (pointer)
      readCapabilityHealthInventory(this.options.storage, pointer.inventory_digest, current.lock);
  }

  private assertAuthority(graph: CapabilityDurablePlanningGraphV1): void {
    const mismatch = capabilityRuntimeAuthorityMismatch(
      graph,
      this.options.authority,
      this.options.sourceAuthority,
      this.options.now,
    );
    if (mismatch)
      throw new CapabilityRuntimeError(
        "capability authority changed",
        runtimeCodeForRefusal(mismatch),
      );
  }

  private assertMutationAuthorities(): void {
    if (!this.options.sourceAuthority || !this.options.actionAuthority)
      throw new CapabilityRuntimeError(
        "capability mutation authorities are unavailable",
        CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE,
      );
  }

  private actionAuthority(): NonNullable<CapabilityOperationExecutorOptionsV1["actionAuthority"]> {
    const authority = this.options.actionAuthority;
    if (!authority)
      throw new CapabilityRuntimeError(
        "capability action authority is unavailable",
        CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE,
      );
    return authority;
  }
}
