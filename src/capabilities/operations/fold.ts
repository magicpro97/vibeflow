import { ACTION_OPERATION_STATE } from "../../actions/protocol-contract.js";
import { PUBLIC_TARGET_RESULT_OUTCOME } from "../../actions/public-operation-contract.js";
import { parseStrictJson } from "../../actions/strict-json.js";
import {
  CAPABILITY_PLAN_STATUS,
  CAPABILITY_RUNTIME_ERROR_CODE,
} from "../../core/capability-contract.js";
import { privateFileBytes } from "../../durability/index.js";
import { validateCapabilityPlanningGraph } from "../planning/execution-graph-validation.js";
import type {
  CapabilityDurablePlanningGraphV1,
  CapabilityFabricPlanV1,
} from "../planning/types.js";
import { validateCapabilityLock } from "../storage/lock-validation.js";
import { readCapabilityWal, validateCapabilityOperation } from "../storage/operation-store.js";
import { capabilityOperationPaths } from "../storage/paths.js";
import { capabilityHistoryPath } from "../storage/paths.js";
import type { CapabilityStorageV1 } from "../storage/store.js";
import type { CapabilityLockV1 } from "../wire/lock.js";
import {
  CAPABILITY_OPERATION_DEFAULT_RECOVERY_ACTIONS_BY_STATUS,
  CAPABILITY_OPERATION_STATUS,
  CAPABILITY_OPERATION_STATUS_BY_ACTION_STATE,
  CAPABILITY_WAL_PAYLOAD_KIND,
  type CapabilityOperationV1,
  isCapabilityOperationChangedTargetOutcome,
} from "../wire/operation.js";
import { CapabilityRuntimeError } from "./errors.js";
import { assertCapabilityOperationHeaderClosure } from "./operation-closure.js";
import { foldCapabilityTarget } from "./target-fold.js";
import type {
  CapabilityOperationActionAuthorityV1,
  CapabilityOperationReadRequestV1,
  CapabilityOperationReadV1,
  CapabilityOperationResultV1,
} from "./types.js";
import {
  type CapabilityWalReferentialClosureOptionsV1,
  assertCapabilityWalReferentialClosure,
} from "./wal-referential.js";

export function readOperationHeader(
  storage: CapabilityStorageV1,
  operationId: string,
): CapabilityOperationV1 {
  const bytes = privateFileBytes(
    capabilityOperationPaths(storage.paths, operationId).header,
    2 * 1024 * 1024,
  );
  if (!bytes)
    throw new CapabilityRuntimeError(
      "capability operation was not found",
      CAPABILITY_RUNTIME_ERROR_CODE.OPERATION_NOT_FOUND,
    );
  const value = parseStrictJson(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ) as unknown as CapabilityOperationV1;
  validateCapabilityOperation(value);
  if (value.operation_id !== operationId)
    throw new CapabilityRuntimeError(
      "operation header path identity mismatch",
      CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
    );
  return value;
}

export function readOperationGraph(
  actionAuthority: CapabilityOperationActionAuthorityV1,
  header: CapabilityOperationV1,
): CapabilityDurablePlanningGraphV1 {
  const graph = validateCapabilityPlanningGraph(actionAuthority.resolvePlanningGraph(header));
  assertCapabilityOperationHeaderClosure(header, graph);
  return graph;
}

export function foldCapabilityOperation(
  storage: CapabilityStorageV1,
  operationId: string,
  actionAuthority: CapabilityOperationActionAuthorityV1,
  options: CapabilityWalReferentialClosureOptionsV1 = {},
): CapabilityOperationResultV1 {
  const header = readOperationHeader(storage, operationId);
  const graph = readOperationGraph(actionAuthority, header);
  const { plan } = graph;
  const events = readCapabilityWal(storage.paths, operationId);
  const baseLock = readOperationBaseLock(storage, plan);
  assertCapabilityWalReferentialClosure(storage, header, plan, events, baseLock, options);
  const transition = events
    .flatMap((event) =>
      event.payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.OPERATION_TRANSITION
        ? [event.payload]
        : [],
    )
    .at(-1);
  const state = transition?.to ?? ACTION_OPERATION_STATE.COMMITTING;
  const status = CAPABILITY_OPERATION_STATUS_BY_ACTION_STATE[state];
  const targets = plan.targets.map((target) =>
    foldCapabilityTarget({ plan, events, targetId: target.target_id, terminal: state, baseLock }),
  );
  const effectiveStatus =
    status === CAPABILITY_OPERATION_STATUS.SUCCEEDED &&
    targets.some((target) => target.outcome === PUBLIC_TARGET_RESULT_OUTCOME.DEGRADED)
      ? CAPABILITY_OPERATION_STATUS.DEGRADED
      : status;
  const lockCommit = events
    .filter((event) => event.payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.LOCK_COMMIT)
    .map((event) =>
      event.payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.LOCK_COMMIT ? event.payload : null,
    )
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .at(-1);
  const changed =
    plan.status === CAPABILITY_PLAN_STATUS.NO_OP
      ? false
      : Boolean(
          lockCommit ||
            targets.some((target) => isCapabilityOperationChangedTargetOutcome(target.outcome)),
        );
  return {
    schema_version: "1.0",
    operation_id: operationId,
    proposal_id: header.proposal_id,
    plan_digest: header.plan_digest,
    status: effectiveStatus,
    changed,
    generation_id:
      plan.status === CAPABILITY_PLAN_STATUS.NO_OP
        ? plan.base_generation_id
        : (lockCommit?.generation_id ?? null),
    targets,
    reason_code: transition?.reason_code ?? null,
    recovery_actions: [...CAPABILITY_OPERATION_DEFAULT_RECOVERY_ACTIONS_BY_STATUS[effectiveStatus]],
    latest_sequence: events.at(-1)?.sequence ?? -1,
  };
}

export function readOperationBaseLock(
  storage: CapabilityStorageV1,
  plan: CapabilityFabricPlanV1,
): CapabilityLockV1 | null {
  if (plan.base_generation_id === null || plan.base_lock_digest === null) return null;
  const bytes = privateFileBytes(
    capabilityHistoryPath(storage.paths, plan.base_generation_id),
    8 * 1024 * 1024,
  );
  if (!bytes)
    throw new CapabilityRuntimeError(
      "operation base history is missing",
      CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
    );
  const lock = validateCapabilityLock(
    parseStrictJson(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown as CapabilityLockV1,
    { expected_scope: storage.paths.scope },
  );
  if (
    lock.generation_id !== plan.base_generation_id ||
    lock.content_digest !== plan.base_lock_digest
  )
    throw new CapabilityRuntimeError(
      "operation base history identity mismatch",
      CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
    );
  return lock;
}

export function readCapabilityOperationView(
  storage: CapabilityStorageV1,
  request: CapabilityOperationReadRequestV1,
  actionAuthority: CapabilityOperationActionAuthorityV1,
): CapabilityOperationReadV1 {
  const result = foldCapabilityOperation(storage, request.operation_id, actionAuthority);
  const after = request.after_sequence ?? -1;
  const limit = Math.max(1, Math.min(request.limit ?? 256, 1_000));
  const all = readCapabilityWal(storage.paths, request.operation_id).filter(
    (event) => event.sequence > after,
  );
  const events = all.slice(0, limit);
  return {
    ...result,
    events,
    next_cursor: all.length > events.length ? String(events.at(-1)?.sequence ?? after) : null,
  };
}
