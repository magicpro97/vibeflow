import { parseStrictJson } from "../../actions/strict-json.js";
import { digestV1, privateFileBytes } from "../../durability/index.js";
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
  const historyBytes = privateFileBytes(
    capabilityHistoryPath(storage.paths, generationId),
    8 * 1024 * 1024,
  );
  if (!historyBytes) return null;
  const proposed = validateCapabilityLock(
    parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(historyBytes)) as never,
    { expected_scope: storage.paths.scope },
  );
  let inventory: CapabilityHealthInventoryV1;
  try {
    inventory = readCapabilityHealthInventory(storage, inventoryDigest, proposed);
  } catch {
    return null;
  }
  if (
    proposed.generation_id !== generationId ||
    proposed.content_digest !== lockDigest ||
    inventory.inventory_digest !== inventoryDigest
  )
    return null;
  return { proposed, inventory };
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
  const prepared = events
    .filter((event) => event.payload.kind === "health-inventory-prepared")
    .map((event) => (event.payload.kind === "health-inventory-prepared" ? event.payload : null))
    .filter((value): value is NonNullable<typeof value> => value !== null)
    .at(-1);
  if (!prepared) return { kind: "none" };
  const retainedRefusal = events.find(
    (event) =>
      event.sequence >
        (events.find((candidate) => candidate.payload.kind === "health-inventory-prepared")
          ?.sequence ?? -1) &&
      event.payload.kind === "pre-effect-refusal" &&
      event.payload.refusal.frontier_kind === "lock-publication",
  );
  if (retainedRefusal?.payload.kind === "pre-effect-refusal")
    return {
      kind: "rollback-required",
      reason: retainedRefusal.payload.refusal.reason_code,
    };
  const objects = readPreparedObjects(
    input.storage,
    prepared.generation_id,
    prepared.lock_digest,
    prepared.health_inventory_digest,
  );
  if (!objects) {
    input.journal.terminal(
      input.operationId,
      "needs_recovery",
      "publication-objects-missing",
      input.held,
    );
    return {
      kind: "result",
      result: foldCapabilityOperation(input.storage, input.operationId, input.actionAuthority),
    };
  }
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
  const pointer = readCapabilityHealthCurrent(input.storage);
  const base = readOperationBaseLock(input.storage, input.plan);
  if ((pointer?.pointer_digest ?? null) === prepared.expected_health_pointer_digest) {
    if (pointer) readCapabilityHealthInventory(input.storage, pointer.inventory_digest, base);
    else if (base)
      throw new CapabilityRuntimeError(
        "retained base health pointer is missing during publication recovery",
        "integrity-failure",
      );
  }
  if (
    pointer?.inventory_digest !== objects.inventory.inventory_digest &&
    (pointer?.pointer_digest ?? null) !== prepared.expected_health_pointer_digest
  ) {
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
      if (pointer?.inventory_digest !== objects.inventory.inventory_digest) {
        const pointerDraft = {
          schema_version: "1.0" as const,
          scope: objects.proposed.scope,
          scope_identity_digest: input.plan.scope_identity_digest,
          inventory_epoch: (pointer?.inventory_epoch ?? -1) + 1,
          inventory_digest: objects.inventory.inventory_digest,
          pointer_digest: "",
        };
        const { pointer_digest: _, ...preimage } = pointerDraft;
        input.storage.publishHealthCurrent(
          pointer,
          {
            ...pointerDraft,
            pointer_digest: digestV1("VF-CAPABILITY-HEALTH-CURRENT\0v1\0", preimage),
          },
          input.held,
        );
      }
      input.journal.terminal(input.operationId, "succeeded", null, input.held);
    },
  });
  return {
    kind: "result",
    result: foldCapabilityOperation(input.storage, input.operationId, input.actionAuthority),
  };
}
