import { digestV1 } from "../../durability/index.js";
import { ownedProjectionRecord } from "../planning/resource-planner.js";
import type {
  CapabilityDurablePlanningGraphV1,
  CapabilityFabricPlanV1,
} from "../planning/types.js";
import type { CapabilityScopeLockV1 } from "../storage/scope-lock.js";
import type {
  CapabilityOperationV1,
  CapabilityPreEffectRefusalReasonV1,
} from "../wire/operation.js";
import { requireCapabilityActionAuthority } from "./action-authority.js";
import { capabilityAuthorityFrontier } from "./authority-frontier.js";
import { rollbackAppliedCapabilityEffects, runCapabilityHealth } from "./effect-runtime.js";
import { CapabilityRuntimeError } from "./errors.js";
import { foldCapabilityOperation } from "./fold.js";
import {
  buildCapabilityHealthInventory,
  readCapabilityHealthCurrent,
  readCapabilityHealthInventory,
} from "./health-inventory.js";
import { buildCapabilityLockFromResults } from "./lock-builder.js";
import { ensureCapabilityLockCheckpoint } from "./lock-checkpoint.js";
import type { CapabilityOperationJournalV1 } from "./operation-journal.js";
import { executeCapabilitySteps } from "./step-runtime.js";
import type {
  CapabilityOperationExecutorOptionsV1,
  CapabilityOperationResultV1,
  CapabilityRuntimeFaultPointV1,
} from "./types.js";
import { capabilityHostTargetIds } from "./validation.js";

interface CapabilityCommitRuntimeV1 {
  graph: CapabilityDurablePlanningGraphV1;
  options: CapabilityOperationExecutorOptionsV1;
  journal: CapabilityOperationJournalV1;
  fault: ((point: CapabilityRuntimeFaultPointV1) => void) | null;
}

export function finishCapabilityOperationAfterRollback(
  input: CapabilityCommitRuntimeV1 & {
    plan: CapabilityFabricPlanV1;
    operationId: string;
    held: CapabilityScopeLockV1;
    reason: string;
  },
): CapabilityOperationResultV1 {
  const rollbackOk = rollbackAppliedCapabilityEffects({
    plan: input.plan,
    graph: input.graph,
    operationId: input.operationId,
    held: input.held,
    journal: input.journal,
    options: input.options,
  });
  input.journal.terminal(
    input.operationId,
    rollbackOk ? "failed" : "needs_recovery",
    rollbackOk ? input.reason : "rollback-failed",
    input.held,
  );
  return foldCapabilityOperation(
    input.options.storage,
    input.operationId,
    requireCapabilityActionAuthority(input.options),
  );
}

function fail(
  input: CapabilityCommitRuntimeV1 & {
    plan: CapabilityFabricPlanV1;
    header: CapabilityOperationV1;
    held: CapabilityScopeLockV1;
  },
  reason: string,
): CapabilityOperationResultV1 {
  return finishCapabilityOperationAfterRollback({
    ...input,
    operationId: input.header.operation_id,
    reason,
  });
}

export function continueCapabilityOperation(
  input: CapabilityCommitRuntimeV1 & {
    plan: CapabilityFabricPlanV1;
    header: CapabilityOperationV1;
    held: CapabilityScopeLockV1;
  },
): CapabilityOperationResultV1 {
  const { plan, header, held, journal, options } = input;
  const stepOutcome = executeCapabilitySteps(input);
  if (stepOutcome.kind === "result") return stepOutcome.result;
  if (stepOutcome.kind === "rollback") return fail(input, stepOutcome.reason);
  const healthFailure = runCapabilityHealth({
    plan,
    graph: input.graph,
    operationId: header.operation_id,
    held,
    journal,
    options,
    fault: input.fault,
  });
  if (healthFailure) return fail(input, healthFailure);
  const publicationAdmission = capabilityAuthorityFrontier({
    graph: input.graph,
    options,
    operation: `capability-publication-admission:${header.operation_id}`,
    onRefusal: (authorityCheck) =>
      journal.appendRefusal({
        operationId: header.operation_id,
        plan,
        reason: authorityCheck.reason,
        planId: null,
        stepId: null,
        targetIds: capabilityHostTargetIds(plan),
        held,
        frontier: "lock-publication",
        authorityCheck,
      }),
    effect: () => null,
  });
  if (!publicationAdmission.authorized) return fail(input, publicationAdmission.reason);
  const currentStatus = options.storage.readStatus();
  if (currentStatus.state === "corrupt" || currentStatus.state === "unsupported")
    throw new CapabilityRuntimeError(
      "capability current lock cannot be validated for publication",
      "integrity-failure",
    );
  const current = currentStatus.lock;
  const interim = foldCapabilityOperation(
    options.storage,
    header.operation_id,
    requireCapabilityActionAuthority(options),
  );
  const proposed = buildCapabilityLockFromResults({
    plan,
    results: interim.targets,
    base: current,
  });
  if (plan.runtime_closure.packages.length > 0 && proposed.packages.length === 0)
    return fail(input, "no-surviving-package-targets");
  for (const descriptor of plan.runtime_closure.descriptors.filter(
    (item) => item.descriptor_kind === "intent",
  )) {
    const projection = ownedProjectionRecord(descriptor.resource, descriptor.target_id);
    if (projection.projection_digest !== descriptor.projection_digest)
      throw new CapabilityRuntimeError(
        "projection record escaped the approved closure",
        "integrity-failure",
      );
    options.storage.putObject(
      projection.projection_digest,
      projection,
      { domain: "VF-OWNED-PROJECTION\0v1\0", omit_keys: ["projection_digest"] },
      held,
    );
  }
  if (
    (current === null) !== (plan.base_lock_digest === null) ||
    (current !== null &&
      (current.generation_id !== plan.base_generation_id ||
        current.content_digest !== plan.base_lock_digest))
  )
    throw new CapabilityRuntimeError(
      "capability checkpoint base differs from the locked operation base",
      "integrity-failure",
    );
  const priorPointer = readCapabilityHealthCurrent(options.storage);
  if (current !== null && priorPointer === null)
    throw new CapabilityRuntimeError(
      "capability base lock has no selected health inventory",
      "integrity-failure",
    );
  if (priorPointer)
    readCapabilityHealthInventory(options.storage, priorPointer.inventory_digest, current);
  if (
    ensureCapabilityLockCheckpoint({
      storage: options.storage,
      operationId: header.operation_id,
      base: current,
      held,
      journal,
    })
  )
    input.fault?.("after-lock-checkpoint");
  options.storage.putHistory(proposed, held);
  const inventory = buildCapabilityHealthInventory({
    storage: options.storage,
    operationId: header.operation_id,
    plan,
    lock: proposed,
    held,
  });
  options.storage.putHealthInventory(inventory, held);
  journal.append(
    header.operation_id,
    {
      kind: "health-inventory-prepared",
      generation_id: proposed.generation_id,
      lock_digest: proposed.content_digest,
      health_inventory_digest: inventory.inventory_digest,
      expected_health_pointer_digest: priorPointer?.pointer_digest ?? null,
    },
    held,
  );
  input.fault?.("after-health-inventory-prepared");
  const publication = capabilityAuthorityFrontier({
    graph: input.graph,
    options,
    operation: `capability-publication:${header.operation_id}`,
    onRefusal: (authorityCheck) =>
      journal.appendRefusal({
        operationId: header.operation_id,
        plan,
        reason: authorityCheck.reason,
        planId: null,
        stepId: null,
        targetIds: capabilityHostTargetIds(plan),
        held,
        frontier: "lock-publication",
        authorityCheck,
      }),
    effect: () => {
      options.storage.publishLock(current, proposed, held);
      input.fault?.("after-lock-publish");
      journal.append(
        header.operation_id,
        {
          kind: "lock-commit",
          generation_id: proposed.generation_id,
          lock_digest: proposed.content_digest,
          health_inventory_digest: inventory.inventory_digest,
          expected_health_pointer_digest: priorPointer?.pointer_digest ?? null,
          directory_fsync_completed: true,
        },
        held,
      );
      input.fault?.("after-lock-commit");
      const pointerDraft = {
        schema_version: "1.0" as const,
        scope: proposed.scope,
        scope_identity_digest: plan.scope_identity_digest,
        inventory_epoch: (priorPointer?.inventory_epoch ?? -1) + 1,
        inventory_digest: inventory.inventory_digest,
        pointer_digest: "",
      };
      const { pointer_digest: _, ...pointerPreimage } = pointerDraft;
      options.storage.publishHealthCurrent(
        priorPointer,
        {
          ...pointerDraft,
          pointer_digest: digestV1("VF-CAPABILITY-HEALTH-CURRENT\0v1\0", pointerPreimage),
        },
        held,
      );
      journal.terminal(header.operation_id, "succeeded", null, held);
    },
  });
  if (!publication.authorized) {
    return fail(input, publication.reason);
  }
  return foldCapabilityOperation(
    options.storage,
    header.operation_id,
    requireCapabilityActionAuthority(options),
  );
}
