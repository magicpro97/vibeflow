import { existsSync } from "node:fs";
import {
  ACTION_OPERATION_STATE,
  type ActionOperationDomainTerminalState,
} from "../../actions/protocol-contract.js";
import type { CapabilityEffectDescriptorV1 } from "../adapters/types.js";
import type {
  CapabilityAdapterPlanV1,
  CapabilityDurablePlanningGraphV1,
  CapabilityFabricPlanV1,
} from "../planning/types.js";
import {
  appendCapabilityWalEvent,
  capabilityOperationDigest,
  capabilityWalEventDigest,
  foldCapabilityWal,
  readCapabilityWal,
} from "../storage/operation-store.js";
import { capabilityOperationPaths } from "../storage/paths.js";
import type { CapabilityScopeLockV1 } from "../storage/scope-lock.js";
import type { CapabilityStorageV1 } from "../storage/store.js";
import {
  type AdapterReceiptV1,
  CAPABILITY_ADAPTER_RECEIPT_ACTIVE_STATES,
  CAPABILITY_ADAPTER_RECEIPT_STATE,
  CAPABILITY_ADAPTER_RECEIPT_UNOBSERVED_STATES,
  CAPABILITY_OPERATION_RECOVERY_PHASE,
  CAPABILITY_WAL_PAYLOAD_KIND,
  type CapabilityAdapterReceiptActiveStateV1,
  type CapabilityAdapterReceiptEvidenceStateV1,
  type CapabilityOperationRecoveryPhaseV1,
  type CapabilityOperationV1,
  type CapabilityWalEventV1,
  type CapabilityWalPayloadV1,
  isCapabilityAdapterReceiptStateIn,
} from "../wire/operation.js";
import { CAPABILITY_RUNTIME_ERROR_CODE, CapabilityRuntimeError } from "./errors.js";
import { capabilityOperationPlanClosure } from "./operation-closure.js";
import {
  type CapabilityRefusalAppendInputV1,
  appendCapabilityRefusal,
} from "./operation-refusal-journal.js";
import { createReceipt, receiptEvidenceRecord } from "./receipts.js";
import type {
  CapabilityExecutionAuthorizationV1,
  CapabilityOperationObserverV1,
  CapabilityRuntimeAuthorityReaderV1,
} from "./types.js";

export interface CapabilityOperationJournalOptionsV1 {
  storage: CapabilityStorageV1;
  authority: CapabilityRuntimeAuthorityReaderV1;
  now: () => string;
  emit?: CapabilityOperationObserverV1;
  fault?: (point: import("./types.js").CapabilityRuntimeFaultPointV1) => void;
}

export class CapabilityOperationJournalV1 {
  constructor(readonly options: CapabilityOperationJournalOptionsV1) {}

  createHeader(
    operationId: string,
    graph: CapabilityDurablePlanningGraphV1,
    authorization: CapabilityExecutionAuthorizationV1,
  ): CapabilityOperationV1 {
    const closure = capabilityOperationPlanClosure(graph);
    const draft = {
      schema_version: "1.0" as const,
      operation_id: operationId,
      proposal_id: authorization.proposal_id,
      proposal_digest: authorization.proposal_digest,
      approval_id: authorization.approval_id,
      approval_digest: authorization.approval_digest,
      ...closure,
      created_at: authorization.created_at ?? closure.created_at,
      conversation_correlation: authorization.conversation_correlation ?? null,
      header_digest: "",
    };
    return { ...draft, header_digest: capabilityOperationDigest(draft) };
  }

  append(
    operationId: string,
    payload: CapabilityWalPayloadV1,
    held: CapabilityScopeLockV1,
    recordedAt = this.options.now(),
  ): CapabilityWalEventV1 {
    const eventsPath = capabilityOperationPaths(this.options.storage.paths, operationId).events;
    const prior = existsSync(eventsPath)
      ? readCapabilityWal(this.options.storage.paths, operationId)
      : [];
    const draft = {
      schema_version: "1.0" as const,
      operation_id: operationId,
      sequence: prior.length,
      previous_event_digest: prior.at(-1)?.event_digest ?? null,
      payload,
      recorded_at: recordedAt,
      event_digest: "",
    };
    const event = { ...draft, event_digest: capabilityWalEventDigest(draft) };
    appendCapabilityWalEvent(this.options.storage.paths, event, held);
    this.options.emit?.(event);
    return event;
  }

  appendReceipt(input: {
    operationId: string;
    plan: CapabilityFabricPlanV1;
    planId: string;
    stepId: string;
    state: AdapterReceiptV1["state"];
    evidence: string | null;
    error: string | null;
    observedAt?: string;
    held: CapabilityScopeLockV1;
  }): void {
    const { operationId, plan, planId, stepId, state, evidence, error, held } = input;
    const adapterPlan = plan.adapter_plans.find((item) => item.plan_id === planId);
    const step = adapterPlan?.steps.find((item) => item.step_id === stepId);
    if (!adapterPlan || !step)
      throw new CapabilityRuntimeError(
        "receipt references unknown plan step",
        CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
      );
    this.append(
      operationId,
      {
        kind: CAPABILITY_WAL_PAYLOAD_KIND.ADAPTER_STEP,
        receipt: createReceipt({
          operation_id: operationId,
          plan: adapterPlan,
          step,
          state,
          prepared_at: plan.created_at,
          observed_at: isCapabilityAdapterReceiptStateIn(
            CAPABILITY_ADAPTER_RECEIPT_UNOBSERVED_STATES,
            state,
          )
            ? null
            : (input.observedAt ?? this.options.now()),
          evidence_digest: evidence,
          error_code: error,
        }),
      },
      held,
    );
  }

  receiptEvidence(input: {
    operationId: string;
    plan: CapabilityFabricPlanV1;
    planId: string;
    stepId: string;
    descriptor: CapabilityEffectDescriptorV1;
    state: CapabilityAdapterReceiptEvidenceStateV1;
    error: string | null;
    observedAt: string;
    held: CapabilityScopeLockV1;
  }): string {
    const adapterPlan = input.plan.adapter_plans.find((item) => item.plan_id === input.planId);
    const step = adapterPlan?.steps.find((item) => item.step_id === input.stepId);
    if (!adapterPlan || !step)
      throw new CapabilityRuntimeError(
        "receipt evidence references unknown plan step",
        CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
      );
    const evidence = receiptEvidenceRecord({
      fabricPlan: input.plan,
      adapterPlan,
      step,
      descriptor: input.descriptor,
      operationId: input.operationId,
      state: input.state,
      observedAt: input.observedAt,
      errorCode: input.error,
    });
    this.options.storage.putObject(
      evidence.evidence_digest,
      evidence,
      { domain: "VF-ADAPTER-BOUNDED-EVIDENCE\0v1\0", omit_keys: ["evidence_digest"] },
      input.held,
    );
    return evidence.evidence_digest;
  }

  appendRefusal(input: CapabilityRefusalAppendInputV1): void {
    appendCapabilityRefusal(this.options, this.append.bind(this), input);
  }

  terminal(
    operationId: string,
    state: ActionOperationDomainTerminalState,
    reason: string | null,
    held: CapabilityScopeLockV1,
  ): void {
    const current = foldCapabilityWal(
      readCapabilityWal(this.options.storage.paths, operationId),
    ).state;
    if (
      current === ACTION_OPERATION_STATE.NEEDS_RECOVERY &&
      state === ACTION_OPERATION_STATE.NEEDS_RECOVERY
    )
      return;
    const from =
      current === ACTION_OPERATION_STATE.NEEDS_RECOVERY
        ? ACTION_OPERATION_STATE.NEEDS_RECOVERY
        : ACTION_OPERATION_STATE.COMMITTING;
    this.append(
      operationId,
      {
        kind: CAPABILITY_WAL_PAYLOAD_KIND.OPERATION_TRANSITION,
        from,
        to: state,
        reason_code: reason,
      },
      held,
    );
  }

  operationState(operationId: string): ReturnType<typeof foldCapabilityWal>["state"] {
    return foldCapabilityWal(readCapabilityWal(this.options.storage.paths, operationId)).state;
  }

  descriptorFor(
    plan: CapabilityFabricPlanV1,
    planId: string,
    stepId: string,
    kind: "intent" | "rollback",
  ): CapabilityEffectDescriptorV1 {
    const adapterPlan = plan.adapter_plans.find((item) => item.plan_id === planId);
    const step = adapterPlan?.steps.find((item) => item.step_id === stepId);
    const digest =
      kind === "intent" ? step?.intent.descriptor_digest : step?.rollback.descriptor_digest;
    const descriptor = plan.runtime_closure.descriptors.find(
      (item) => item.descriptor_digest === digest && item.descriptor_kind === kind,
    );
    if (!descriptor)
      throw new CapabilityRuntimeError(
        "operation descriptor closure is missing",
        CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
      );
    return descriptor;
  }

  latestReceipt(operationId: string, planId: string, stepId: string): AdapterReceiptV1 | null {
    return (
      readCapabilityWal(this.options.storage.paths, operationId)
        .filter(
          (event) =>
            event.payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.ADAPTER_STEP &&
            event.payload.receipt.plan_id === planId &&
            event.payload.receipt.step_id === stepId,
        )
        .map((event) =>
          event.payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.ADAPTER_STEP
            ? event.payload.receipt
            : null,
        )
        .filter((receipt): receipt is AdapterReceiptV1 => receipt !== null)
        .at(-1) ?? null
    );
  }

  unresolvedReceipt(operationId: string):
    | (AdapterReceiptV1 & {
        state: CapabilityAdapterReceiptActiveStateV1;
        recovery_phase: CapabilityOperationRecoveryPhaseV1;
      })
    | null {
    const latest = new Map<
      string,
      { receipt: AdapterReceiptV1; predecessor: AdapterReceiptV1["state"] | null }
    >();
    for (const event of readCapabilityWal(this.options.storage.paths, operationId))
      if (event.payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.ADAPTER_STEP) {
        const receipt = event.payload.receipt;
        const key = `${receipt.plan_id}\0${receipt.step_id}`;
        latest.set(key, { receipt, predecessor: latest.get(key)?.receipt.state ?? null });
      }
    const unresolved = [...latest.values()].find(({ receipt }) =>
      isCapabilityAdapterReceiptStateIn(CAPABILITY_ADAPTER_RECEIPT_ACTIVE_STATES, receipt.state),
    );
    if (!unresolved) return null;
    const { receipt, predecessor } = unresolved;
    const state = receipt.state;
    if (!isCapabilityAdapterReceiptStateIn(CAPABILITY_ADAPTER_RECEIPT_ACTIVE_STATES, state))
      return null;
    return {
      ...receipt,
      state,
      recovery_phase:
        state === CAPABILITY_ADAPTER_RECEIPT_STATE.REVERSE_IN_PROGRESS ||
        (state === CAPABILITY_ADAPTER_RECEIPT_STATE.UNCERTAIN &&
          predecessor === CAPABILITY_ADAPTER_RECEIPT_STATE.REVERSE_IN_PROGRESS)
          ? CAPABILITY_OPERATION_RECOVERY_PHASE.ROLLBACK
          : CAPABILITY_OPERATION_RECOVERY_PHASE.FORWARD,
    };
  }
}
