import { parseStrictJson } from "../../actions/strict-json.js";
import { canonicalJsonBytes, privateFileBytes } from "../../durability/index.js";
import type {
  CapabilityDurablePlanningGraphV1,
  CapabilityFabricPlanV1,
} from "../planning/types.js";
import { validateCapabilityLock } from "../storage/lock-validation.js";
import { readCapabilityWal } from "../storage/operation-store.js";
import { capabilityHistoryPath } from "../storage/paths.js";
import type { CapabilityScopeLockV1 } from "../storage/scope-lock.js";
import type { CapabilityStorageV1 } from "../storage/store.js";
import type { CapabilityHealthInventoryV1 } from "../storage/types.js";
import type { CapabilityPreEffectRefusalReasonV1 } from "../wire/operation.js";
import { capabilityAuthorityFrontier, capabilityRecoveryFrontier } from "./authority-frontier.js";
import { CapabilityRuntimeError } from "./errors.js";
import { foldCapabilityOperation, readOperationBaseLock } from "./fold.js";
import { readCapabilityHealthCurrent, readCapabilityHealthInventory } from "./health-inventory.js";
import type { CapabilityOperationJournalV1 } from "./operation-journal.js";
import {
  assertCapabilityPublicationEvidence,
  materializeCapabilityPublicationHealthPointer,
} from "./publication-evidence.js";
import type {
  CapabilityOperationActionAuthorityV1,
  CapabilityOperationResultV1,
  CapabilityRuntimeAuthorityReaderV1,
  CapabilityRuntimeSourceAuthorityReaderV1,
} from "./types.js";
import { capabilityHostTargetIds } from "./validation.js";

export type CapabilityPublicationRecoveryOutcomeV1 =
  | { kind: "none" }
  | { kind: "rollback-required"; reason: CapabilityPreEffectRefusalReasonV1 }
  | { kind: "result"; result: CapabilityOperationResultV1 };

function readPreparedObjects(
  storage: CapabilityStorageV1,
  generationId: string,
  lockDigest: string,
  inventoryDigest: string,
): {
  proposed: NonNullable<ReturnType<CapabilityStorageV1["readStatus"]>["lock"]>;
  inventory: CapabilityHealthInventoryV1;
} | null {
  try {
    const historyBytes = privateFileBytes(
      capabilityHistoryPath(storage.paths, generationId),
      8 * 1024 * 1024,
    );
    if (!historyBytes) return null;
    const proposed = validateCapabilityLock(
      parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(historyBytes)) as never,
      { expected_scope: storage.paths.scope },
    );
    if (
      !Buffer.from(historyBytes).equals(canonicalJsonBytes(proposed, { maxBytes: 8 * 1024 * 1024 }))
    )
      return null;
    const inventory = readCapabilityHealthInventory(storage, inventoryDigest, proposed);
    if (
      proposed.generation_id !== generationId ||
      proposed.content_digest !== lockDigest ||
      inventory.inventory_digest !== inventoryDigest
    )
      return null;
    return { proposed, inventory };
  } catch {
    return null;
  }
}

function failAfterDurableRecoveryTerminal(
  input: {
    operationId: string;
    held: CapabilityScopeLockV1;
    journal: CapabilityOperationJournalV1;
  },
  reason: string,
  message: string,
): never {
  input.journal.terminal(input.operationId, "needs_recovery", reason, input.held);
  throw new CapabilityRuntimeError(message, "integrity-failure");
}

export function recoverCapabilityPublication(input: {
  plan: CapabilityFabricPlanV1;
  graph: CapabilityDurablePlanningGraphV1;
  operationId: string;
  held: CapabilityScopeLockV1;
  storage: CapabilityStorageV1;
  authority: CapabilityRuntimeAuthorityReaderV1;
  sourceAuthority?: CapabilityRuntimeSourceAuthorityReaderV1;
  now: () => string;
  journal: CapabilityOperationJournalV1;
  actionAuthority: CapabilityOperationActionAuthorityV1;
}): CapabilityPublicationRecoveryOutcomeV1 {
  const events = readCapabilityWal(input.storage.paths, input.operationId);
  const preparedEvent = events.find((event) => event.payload.kind === "health-inventory-prepared");
  if (preparedEvent?.payload.kind !== "health-inventory-prepared") return { kind: "none" };
  const prepared = preparedEvent.payload;
  const retainedTransition = events
    .filter((event) => event.payload.kind === "operation-transition")
    .at(-1)?.payload;
  if (
    retainedTransition?.kind === "operation-transition" &&
    retainedTransition.to === "needs_recovery"
  )
    return {
      kind: "result",
      result: foldCapabilityOperation(input.storage, input.operationId, input.actionAuthority),
    };
  const objects = readPreparedObjects(
    input.storage,
    prepared.generation_id,
    prepared.lock_digest,
    prepared.health_inventory_digest,
  );
  if (!objects)
    return failAfterDurableRecoveryTerminal(
      input,
      "publication-objects-missing",
      "prepared publication objects are missing or corrupt after durable recovery terminal",
    );

  try {
    assertCapabilityPublicationEvidence({
      storage: input.storage,
      plan: input.plan,
      events,
    });
  } catch {
    return failAfterDurableRecoveryTerminal(
      input,
      "publication-evidence-invalid",
      "prepared publication evidence is invalid after durable recovery terminal",
    );
  }
  const expectedEpoch = prepared.expected_health_pointer_epoch;
  const nextEpoch = prepared.next_health_pointer_epoch;
  const nextDigest = prepared.next_health_pointer_digest;
  if (expectedEpoch === undefined || nextEpoch === undefined || nextDigest === undefined)
    return failAfterDurableRecoveryTerminal(
      input,
      "publication-pointer-evidence-missing",
      "prepared publication lacks exact post-pointer evidence after durable recovery terminal",
    );
  const nextPointer = materializeCapabilityPublicationHealthPointer({
    scope: objects.proposed.scope,
    scopeIdentityDigest: input.storage.scopeIdentityDigest,
    inventoryEpoch: nextEpoch,
    inventoryDigest: objects.inventory.inventory_digest,
  });
  foldCapabilityOperation(input.storage, input.operationId, input.actionAuthority);
  const retainedRefusal = events.find(
    (event) =>
      event.sequence > preparedEvent.sequence &&
      event.payload.kind === "pre-effect-refusal" &&
      event.payload.refusal.frontier_kind === "lock-publication",
  );
  if (retainedRefusal?.payload.kind === "pre-effect-refusal")
    return {
      kind: "rollback-required",
      reason: retainedRefusal.payload.refusal.reason_code,
    };
  const committed = events.some(
    (event) =>
      event.payload.kind === "lock-commit" &&
      event.payload.generation_id === prepared.generation_id &&
      event.payload.lock_digest === prepared.lock_digest,
  );
  const current = input.storage.readStatus();
  const currentDigest = current.lock?.content_digest ?? null;
  if (!committed) {
    if (currentDigest === input.plan.base_lock_digest) {
      const frontier = capabilityAuthorityFrontier({
        graph: input.graph,
        options: input,
        operation: `capability-publication-recovery:${input.operationId}`,
        onRefusal: (authorityCheck) =>
          input.journal.appendRefusal({
            operationId: input.operationId,
            plan: input.plan,
            reason: authorityCheck.reason,
            planId: null,
            stepId: null,
            targetIds: capabilityHostTargetIds(input.plan),
            held: input.held,
            frontier: "lock-publication",
            authorityCheck,
          }),
        effect: () => {
          input.storage.publishLock(current.lock, objects.proposed, input.held);
          input.journal.append(
            input.operationId,
            {
              kind: "lock-commit",
              generation_id: objects.proposed.generation_id,
              lock_digest: objects.proposed.content_digest,
              health_inventory_digest: objects.inventory.inventory_digest,
              expected_health_pointer_digest: prepared.expected_health_pointer_digest,
              expected_health_pointer_epoch: expectedEpoch,
              next_health_pointer_epoch: nextPointer.inventory_epoch,
              next_health_pointer_digest: nextPointer.pointer_digest,
              directory_fsync_completed: true,
            },
            input.held,
          );
        },
      });
      if (!frontier.authorized) {
        return { kind: "rollback-required", reason: frontier.reason };
      }
    } else if (currentDigest !== objects.proposed.content_digest) {
      input.journal.terminal(
        input.operationId,
        "needs_recovery",
        "lock-publication-third-state",
        input.held,
      );
      return {
        kind: "result",
        result: foldCapabilityOperation(input.storage, input.operationId, input.actionAuthority),
      };
    }
    if (currentDigest === objects.proposed.content_digest)
      capabilityRecoveryFrontier({
        graph: input.graph,
        options: input,
        operation: `capability-lock-receipt-recovery:${input.operationId}`,
        recover: () =>
          input.journal.append(
            input.operationId,
            {
              kind: "lock-commit",
              generation_id: objects.proposed.generation_id,
              lock_digest: objects.proposed.content_digest,
              health_inventory_digest: objects.inventory.inventory_digest,
              expected_health_pointer_digest: prepared.expected_health_pointer_digest,
              expected_health_pointer_epoch: expectedEpoch,
              next_health_pointer_epoch: nextPointer.inventory_epoch,
              next_health_pointer_digest: nextPointer.pointer_digest,
              directory_fsync_completed: true,
            },
            input.held,
          ),
      });
  } else if (currentDigest !== objects.proposed.content_digest) {
    input.journal.terminal(
      input.operationId,
      "needs_recovery",
      "committed-lock-missing",
      input.held,
    );
    return {
      kind: "result",
      result: foldCapabilityOperation(input.storage, input.operationId, input.actionAuthority),
    };
  }
  let pointer: ReturnType<typeof readCapabilityHealthCurrent>;
  try {
    pointer = readCapabilityHealthCurrent(input.storage);
  } catch {
    return failAfterDurableRecoveryTerminal(
      input,
      "health-pointer-invalid",
      "health pointer is corrupt after durable recovery terminal",
    );
  }
  const pointerDigest = pointer?.pointer_digest ?? null;
  const pointerEpoch = pointer?.inventory_epoch ?? null;
  const matchesPriorPointer =
    pointerDigest === prepared.expected_health_pointer_digest && pointerEpoch === expectedEpoch;
  const matchesNextPointer =
    pointerDigest === nextPointer.pointer_digest && pointerEpoch === nextPointer.inventory_epoch;
  const base = readOperationBaseLock(input.storage, input.plan);
  if (pointer && matchesPriorPointer)
    try {
      readCapabilityHealthInventory(input.storage, pointer.inventory_digest, base);
    } catch {
      return failAfterDurableRecoveryTerminal(
        input,
        "retained-health-pointer-invalid",
        "retained base health pointer is invalid after durable recovery terminal",
      );
    }
  if (!matchesPriorPointer && !matchesNextPointer) {
    input.journal.terminal(
      input.operationId,
      "needs_recovery",
      "health-pointer-third-state",
      input.held,
    );
    return {
      kind: "result",
      result: foldCapabilityOperation(input.storage, input.operationId, input.actionAuthority),
    };
  }
  capabilityRecoveryFrontier({
    graph: input.graph,
    options: input,
    operation: `capability-pointer-recovery:${input.operationId}`,
    recover: () => {
      if (matchesPriorPointer) input.storage.publishHealthCurrent(pointer, nextPointer, input.held);
      input.journal.terminal(input.operationId, "succeeded", null, input.held);
    },
  });
  return {
    kind: "result",
    result: foldCapabilityOperation(input.storage, input.operationId, input.actionAuthority),
  };
}
