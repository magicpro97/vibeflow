import { existsSync } from "node:fs";
import { ACTION_OPERATION_STATE } from "../../actions/protocol-contract.js";
import {
  CAPABILITY_PLAN_STATUS,
  CAPABILITY_RUNTIME_ERROR_CODE,
} from "../../core/capability-contract.js";
import type {
  CapabilityDurablePlanningGraphV1,
  CapabilityFabricPlanV1,
} from "../planning/types.js";
import { readCapabilityWal } from "../storage/operation-store.js";
import { capabilityOperationPaths } from "../storage/paths.js";
import type { CapabilityScopeLockV1 } from "../storage/scope-lock.js";
import type { CapabilityStorageV1 } from "../storage/store.js";
import {
  CAPABILITY_OPERATION_STATUS,
  CAPABILITY_PRE_EFFECT_FRONTIER,
  CAPABILITY_PRE_EFFECT_REFUSAL_REASON,
  CAPABILITY_WAL_OPERATION_TRANSITION_ORIGIN,
  CAPABILITY_WAL_PAYLOAD_KIND,
} from "../wire/operation.js";
import { requireCapabilityActionAuthority } from "./action-authority.js";
import { capabilityAuthorityFrontier } from "./authority-frontier.js";
import { CapabilityRuntimeError } from "./errors.js";
import { foldCapabilityOperation } from "./fold.js";
import type { CapabilityOperationJournalV1 } from "./operation-journal.js";
import type {
  CapabilityOperationExecutorOptionsV1,
  CapabilityOperationResultV1,
  CapabilityRuntimeAuthorityReaderV1,
  CapabilityRuntimeSourceAuthorityReaderV1,
} from "./types.js";
import type { CapabilityOperationActionAuthorityV1 } from "./types.js";
import { capabilityHostTargetIds } from "./validation.js";

export function runCapabilityOperationPreflight(input: {
  plan: CapabilityFabricPlanV1;
  graph: CapabilityDurablePlanningGraphV1;
  operationId: string;
  held: CapabilityScopeLockV1;
  storage: CapabilityStorageV1;
  authority: CapabilityRuntimeAuthorityReaderV1;
  sourceAuthority?: CapabilityRuntimeSourceAuthorityReaderV1;
  journal: CapabilityOperationJournalV1;
  actionAuthority: CapabilityOperationActionAuthorityV1;
}): CapabilityOperationResultV1 | null {
  const events = readCapabilityWal(input.storage.paths, input.operationId);
  if (events.length !== 1) return null;
  const current = input.storage.readStatus();
  if (current.state === "corrupt") {
    input.journal.terminal(
      input.operationId,
      ACTION_OPERATION_STATE.NEEDS_RECOVERY,
      CAPABILITY_RUNTIME_ERROR_CODE.SCOPE_NEEDS_RECOVERY,
      input.held,
    );
    return foldCapabilityOperation(input.storage, input.operationId, input.actionAuthority);
  }
  const currentDigest = current.lock?.content_digest ?? null;
  if (currentDigest !== input.plan.base_lock_digest) {
    const reason = CAPABILITY_PRE_EFFECT_REFUSAL_REASON.SCOPE_BASE_STALE;
    input.journal.appendRefusal({
      operationId: input.operationId,
      plan: input.plan,
      reason,
      planId: null,
      stepId: null,
      targetIds: capabilityHostTargetIds(input.plan),
      held: input.held,
      frontier: CAPABILITY_PRE_EFFECT_FRONTIER.OPERATION,
    });
    input.journal.terminal(input.operationId, ACTION_OPERATION_STATE.FAILED, reason, input.held);
    return foldCapabilityOperation(input.storage, input.operationId, input.actionAuthority);
  }
  const authority = capabilityAuthorityFrontier({
    graph: input.graph,
    options: {
      authority: input.authority,
      sourceAuthority: input.sourceAuthority,
      now: input.journal.options.now,
    },
    operation: `capability-operation-preflight:${input.operationId}`,
    onRefusal: (authorityCheck) =>
      input.journal.appendRefusal({
        operationId: input.operationId,
        plan: input.plan,
        reason: authorityCheck.reason,
        planId: null,
        stepId: null,
        targetIds: capabilityHostTargetIds(input.plan),
        held: input.held,
        frontier: CAPABILITY_PRE_EFFECT_FRONTIER.OPERATION,
        authorityCheck,
      }),
    effect: () => null,
  });
  if (authority.authorized) return null;
  input.journal.terminal(
    input.operationId,
    ACTION_OPERATION_STATE.FAILED,
    authority.reason,
    input.held,
  );
  return foldCapabilityOperation(input.storage, input.operationId, input.actionAuthority);
}

export function beginCapabilityOperationRecovery(input: {
  plan: CapabilityFabricPlanV1;
  graph: CapabilityDurablePlanningGraphV1;
  operationId: string;
  header: import("../wire/operation.js").CapabilityOperationV1;
  held: CapabilityScopeLockV1;
  options: CapabilityOperationExecutorOptionsV1;
  journal: CapabilityOperationJournalV1;
}): CapabilityOperationResultV1 | null {
  const actionAuthority = requireCapabilityActionAuthority(input.options);
  actionAuthority.verifyDispatched(input.header, input.plan);
  const eventsPath = capabilityOperationPaths(
    input.options.storage.paths,
    input.operationId,
  ).events;
  if (!existsSync(eventsPath)) {
    input.journal.append(
      input.operationId,
      {
        kind: CAPABILITY_WAL_PAYLOAD_KIND.OPERATION_TRANSITION,
        from: CAPABILITY_WAL_OPERATION_TRANSITION_ORIGIN.CREATED,
        to: ACTION_OPERATION_STATE.COMMITTING,
        reason_code: null,
      },
      input.held,
    );
  }
  const events = readCapabilityWal(input.options.storage.paths, input.operationId);
  const current = foldCapabilityOperation(
    input.options.storage,
    input.operationId,
    actionAuthority,
    { deferPreparedPublicationEvidence: true },
  );
  if (
    current.status === CAPABILITY_OPERATION_STATUS.COMMITTING &&
    events.some(
      (event) => event.payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.HEALTH_INVENTORY_PREPARED,
    )
  )
    return null;
  if (
    current.status !== CAPABILITY_OPERATION_STATUS.COMMITTING &&
    current.status !== CAPABILITY_OPERATION_STATUS.NEEDS_RECOVERY
  )
    return current;
  if (current.status === CAPABILITY_OPERATION_STATUS.NEEDS_RECOVERY) return null;
  return runCapabilityOperationPreflight({
    plan: input.plan,
    graph: input.graph,
    operationId: input.operationId,
    held: input.held,
    storage: input.options.storage,
    authority: input.options.authority,
    sourceAuthority: input.options.sourceAuthority,
    journal: input.journal,
    actionAuthority,
  });
}

export function assertNoOpInspectionOnly(plan: CapabilityFabricPlanV1): void {
  if (plan.status === CAPABILITY_PLAN_STATUS.NO_OP)
    throw new CapabilityRuntimeError(
      "proved no-op plans are inspection-only and cannot be dispatched",
      CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH,
    );
}
