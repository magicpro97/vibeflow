import { ACTION_OPERATION_STATE } from "../../actions/protocol-contract.js";
import { CAPABILITY_RUNTIME_ERROR_CODE } from "../../core/capability-contract.js";
import { digestV1 } from "../../durability/index.js";
import type { CapabilityDurablePlanningGraphV1 } from "../planning/types.js";
import type { CapabilityScopeLockV1 } from "../storage/scope-lock.js";
import {
  CAPABILITY_ADAPTER_RECEIPT_ERROR_CODE,
  CAPABILITY_ADAPTER_RECEIPT_PUBLICATION_TERMINAL_STATES,
  CAPABILITY_ADAPTER_RECEIPT_STATE,
  CAPABILITY_PRE_EFFECT_OBSERVED_STATE,
  CAPABILITY_PRE_EFFECT_REFUSAL_REASON,
  type CapabilityOperationV1,
  isCapabilityAdapterReceiptStateIn,
} from "../wire/operation.js";
import { requireCapabilityActionAuthority } from "./action-authority.js";
import { capabilityAuthorityFrontier } from "./authority-frontier.js";
import { CapabilityRuntimeError } from "./errors.js";
import { foldCapabilityOperation } from "./fold.js";
import type { CapabilityOperationJournalV1 } from "./operation-journal.js";
import type {
  CapabilityOperationExecutorOptionsV1,
  CapabilityOperationResultV1,
  CapabilityRuntimeFaultPointV1,
} from "./types.js";

export type CapabilityStepExecutionOutcomeV1 =
  | { kind: "continue" }
  | { kind: "rollback"; reason: string }
  | { kind: "result"; result: CapabilityOperationResultV1 };

type CapabilityStepFrontierOutcomeV1 =
  | {
      kind: "preimage-stale";
      descriptor: ReturnType<CapabilityOperationJournalV1["descriptorFor"]>;
      observed: string | null;
    }
  | {
      kind:
        | typeof CAPABILITY_ADAPTER_RECEIPT_STATE.APPLIED
        | typeof CAPABILITY_ADAPTER_RECEIPT_STATE.FAILED
        | typeof CAPABILITY_ADAPTER_RECEIPT_STATE.UNCERTAIN;
    };

function preimageDigest(ownershipKey: string, contentSha256: string | null): string {
  return digestV1("VF-CAPABILITY-PRE-EFFECT-OWNED-RESOURCE\0v1\0", {
    schema_version: "1.0",
    ownership_key: ownershipKey,
    content_sha256: contentSha256,
  });
}

export function executeCapabilitySteps(input: {
  graph: CapabilityDurablePlanningGraphV1;
  header: CapabilityOperationV1;
  held: CapabilityScopeLockV1;
  options: CapabilityOperationExecutorOptionsV1;
  journal: CapabilityOperationJournalV1;
  fault: ((point: CapabilityRuntimeFaultPointV1) => void) | null;
}): CapabilityStepExecutionOutcomeV1 {
  const { graph, header, held, options, journal } = input;
  const plan = graph.plan;
  for (const adapterPlan of plan.adapter_plans) {
    for (const step of adapterPlan.steps) {
      const selected = journal.latestReceipt(
        header.operation_id,
        adapterPlan.plan_id,
        step.step_id,
      );
      if (
        selected &&
        isCapabilityAdapterReceiptStateIn(
          CAPABILITY_ADAPTER_RECEIPT_PUBLICATION_TERMINAL_STATES,
          selected.state,
        )
      )
        continue;
      const frontier = capabilityAuthorityFrontier<CapabilityStepFrontierOutcomeV1>({
        graph,
        options,
        operation: `capability-effect:${header.operation_id}:${step.step_id}`,
        onRefusal: (authorityCheck) =>
          journal.appendRefusal({
            operationId: header.operation_id,
            plan,
            reason: authorityCheck.reason,
            planId: adapterPlan.plan_id,
            stepId: step.step_id,
            targetIds: step.target_ids,
            held,
            authorityCheck,
          }),
        effect: () => {
          const descriptor = journal.descriptorFor(
            plan,
            adapterPlan.plan_id,
            step.step_id,
            "intent",
          );
          const privatePayload = options.broker.resolvePrivatePayload(
            descriptor.private_payload_binding,
          );
          const observed = options.broker.inspect(
            descriptor.resource,
            privatePayload,
          ).content_sha256;
          if (observed !== descriptor.resource.expected_preimage_sha256)
            return { kind: "preimage-stale" as const, descriptor, observed };
          if (selected?.state !== CAPABILITY_ADAPTER_RECEIPT_STATE.PREPARED) {
            journal.appendReceipt({
              operationId: header.operation_id,
              plan,
              planId: adapterPlan.plan_id,
              stepId: step.step_id,
              state: CAPABILITY_ADAPTER_RECEIPT_STATE.PREPARED,
              evidence: null,
              error: null,
              held,
            });
            input.fault?.("after-prepared");
          }
          journal.appendReceipt({
            operationId: header.operation_id,
            plan,
            planId: adapterPlan.plan_id,
            stepId: step.step_id,
            state: CAPABILITY_ADAPTER_RECEIPT_STATE.EFFECT_IN_PROGRESS,
            evidence: null,
            error: null,
            held,
          });
          input.fault?.("after-effect-in-progress");
          try {
            const result = options.broker.apply(descriptor, privatePayload);
            input.fault?.("after-effect-before-receipt");
            if (result.content_sha256 !== descriptor.resource.expected_postimage_sha256)
              throw new Error("adapter did not produce its exact postimage");
            const observedAt = options.now();
            journal.appendReceipt({
              operationId: header.operation_id,
              plan,
              planId: adapterPlan.plan_id,
              stepId: step.step_id,
              state: CAPABILITY_ADAPTER_RECEIPT_STATE.APPLIED,
              evidence: journal.receiptEvidence({
                operationId: header.operation_id,
                plan,
                planId: adapterPlan.plan_id,
                stepId: step.step_id,
                descriptor,
                state: CAPABILITY_ADAPTER_RECEIPT_STATE.APPLIED,
                error: null,
                observedAt,
                held,
              }),
              error: null,
              observedAt,
              held,
            });
            input.fault?.("after-applied");
            return { kind: CAPABILITY_ADAPTER_RECEIPT_STATE.APPLIED };
          } catch (error) {
            if (
              error instanceof CapabilityRuntimeError &&
              error.runtime_code === CAPABILITY_RUNTIME_ERROR_CODE.FAULT
            )
              throw error;
            const live = options.broker.inspect(descriptor.resource, privatePayload).content_sha256;
            const state =
              live === descriptor.resource.expected_preimage_sha256
                ? CAPABILITY_ADAPTER_RECEIPT_STATE.FAILED
                : CAPABILITY_ADAPTER_RECEIPT_STATE.UNCERTAIN;
            const receiptError =
              state === CAPABILITY_ADAPTER_RECEIPT_STATE.FAILED
                ? CAPABILITY_ADAPTER_RECEIPT_ERROR_CODE.APPLY_FAILED
                : CAPABILITY_ADAPTER_RECEIPT_ERROR_CODE.THIRD_STATE;
            const observedAt = options.now();
            journal.appendReceipt({
              operationId: header.operation_id,
              plan,
              planId: adapterPlan.plan_id,
              stepId: step.step_id,
              state,
              evidence: journal.receiptEvidence({
                operationId: header.operation_id,
                plan,
                planId: adapterPlan.plan_id,
                stepId: step.step_id,
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
            return { kind: state };
          }
        },
      });
      if (!frontier.authorized) {
        return { kind: "rollback", reason: frontier.reason };
      }
      const outcome = frontier.value;
      if (outcome.kind === "preimage-stale") {
        const descriptor = outcome.descriptor;
        journal.appendRefusal({
          operationId: header.operation_id,
          plan,
          reason: CAPABILITY_PRE_EFFECT_REFUSAL_REASON.OWNED_PREIMAGE_STALE,
          planId: adapterPlan.plan_id,
          stepId: step.step_id,
          targetIds: step.target_ids,
          bindingKey: `ownership:${descriptor.resource.ownership_key}`,
          expectedDigest: preimageDigest(
            descriptor.resource.ownership_key,
            descriptor.resource.expected_preimage_sha256,
          ),
          observedDigest: preimageDigest(descriptor.resource.ownership_key, outcome.observed),
          observedState:
            outcome.observed === null
              ? CAPABILITY_PRE_EFFECT_OBSERVED_STATE.ABSENT
              : CAPABILITY_PRE_EFFECT_OBSERVED_STATE.CHANGED,
          held,
        });
        return {
          kind: "rollback",
          reason: CAPABILITY_PRE_EFFECT_REFUSAL_REASON.OWNED_PREIMAGE_STALE,
        };
      }
      if (outcome.kind === CAPABILITY_ADAPTER_RECEIPT_STATE.UNCERTAIN) {
        journal.terminal(
          header.operation_id,
          ACTION_OPERATION_STATE.NEEDS_RECOVERY,
          CAPABILITY_RUNTIME_ERROR_CODE.SCOPE_NEEDS_RECOVERY,
          held,
        );
        return {
          kind: "result",
          result: foldCapabilityOperation(
            options.storage,
            header.operation_id,
            requireCapabilityActionAuthority(options),
          ),
        };
      }
      if (outcome.kind === CAPABILITY_ADAPTER_RECEIPT_STATE.FAILED && step.required)
        return { kind: "rollback", reason: CAPABILITY_RUNTIME_ERROR_CODE.APPLY_FAILED };
    }
  }
  return { kind: "continue" };
}
