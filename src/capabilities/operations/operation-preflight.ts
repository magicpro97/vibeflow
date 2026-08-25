import { existsSync } from "node:fs";
import type {
  CapabilityDurablePlanningGraphV1,
  CapabilityFabricPlanV1,
} from "../planning/types.js";
import { readCapabilityWal } from "../storage/operation-store.js";
import { capabilityOperationPaths } from "../storage/paths.js";
import type { CapabilityScopeLockV1 } from "../storage/scope-lock.js";
import type { CapabilityStorageV1 } from "../storage/store.js";
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
    input.journal.terminal(input.operationId, "needs_recovery", "scope-needs-recovery", input.held);
    return foldCapabilityOperation(input.storage, input.operationId, input.actionAuthority);
  }
  const currentDigest = current.lock?.content_digest ?? null;
  if (currentDigest !== input.plan.base_lock_digest) {
    const reason = "scope-base-stale" as const;
    input.journal.appendRefusal({
      operationId: input.operationId,
      plan: input.plan,
      reason,
      planId: null,
      stepId: null,
      targetIds: capabilityHostTargetIds(input.plan),
      held: input.held,
      frontier: "operation",
    });
    input.journal.terminal(input.operationId, "failed", reason, input.held);
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
        frontier: "operation",
        authorityCheck,
      }),
    effect: () => null,
  });
  if (authority.authorized) return null;
  input.journal.terminal(input.operationId, "failed", authority.reason, input.held);
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
        kind: "operation-transition",
        from: "created",
        to: "committing",
        reason_code: null,
      },
      input.held,
    );
  }
  const current = foldCapabilityOperation(
    input.options.storage,
    input.operationId,
    actionAuthority,
  );
  if (current.status !== "committing" && current.status !== "needs-recovery") return current;
  if (current.status === "needs-recovery") return null;
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
  if (plan.status === "no-op")
    throw new CapabilityRuntimeError(
      "proved no-op plans are inspection-only and cannot be dispatched",
      "authorization-mismatch",
    );
}
