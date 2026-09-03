import { parseStrictJson } from "../../actions/strict-json.js";
import type { CapabilityScope } from "../../core/capability-contract.js";
import {
  canonicalJson,
  canonicalJsonBytes,
  digestV1,
  privateFileBytes,
} from "../../durability/index.js";
import type { CapabilityFabricPlanV1 } from "../planning/types.js";
import { validateCapabilityLock } from "../storage/lock-validation.js";
import { capabilityHistoryPath } from "../storage/paths.js";
import type { CapabilityStorageV1 } from "../storage/store.js";
import type { CapabilityHealthCurrentV1 } from "../storage/types.js";
import { CAPABILITY_WAL_PAYLOAD_KIND, type CapabilityWalEventV1 } from "../wire/operation.js";
import { bytewise } from "../wire/primitives.js";
import { CAPABILITY_RUNTIME_ERROR_CODE, CapabilityRuntimeError } from "./errors.js";
import { resolveHealthObservationBatches } from "./health-evidence.js";
import { readCapabilityHealthBinding, readCapabilityHealthInventory } from "./health-inventory.js";

function invalid(message: string): never {
  throw new CapabilityRuntimeError(message, CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE);
}

export function materializeCapabilityPublicationHealthPointer(input: {
  scope: CapabilityScope;
  scopeIdentityDigest: string;
  inventoryEpoch: number;
  inventoryDigest: string;
}): CapabilityHealthCurrentV1 {
  const draft = {
    schema_version: "1.0" as const,
    scope: input.scope,
    scope_identity_digest: input.scopeIdentityDigest,
    inventory_epoch: input.inventoryEpoch,
    inventory_digest: input.inventoryDigest,
  };
  return {
    ...draft,
    pointer_digest: digestV1("VF-CAPABILITY-HEALTH-CURRENT\0v1\0", draft),
  };
}

export function assertCapabilityPublicationEvidence(input: {
  storage: CapabilityStorageV1;
  plan: CapabilityFabricPlanV1;
  events: readonly CapabilityWalEventV1[];
}): void {
  const preparedEvents = input.events.filter(
    (event) => event.payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.HEALTH_INVENTORY_PREPARED,
  );
  if (preparedEvents.length === 0) return;
  if (preparedEvents.length !== 1)
    invalid("capability operation has duplicate inventory preparation");
  const preparedEvent = preparedEvents[0];
  if (preparedEvent?.payload.kind !== CAPABILITY_WAL_PAYLOAD_KIND.HEALTH_INVENTORY_PREPARED)
    invalid("capability inventory preparation narrowing failed");
  const bytes = privateFileBytes(
    capabilityHistoryPath(input.storage.paths, preparedEvent.payload.generation_id),
    8 * 1024 * 1024,
  );
  if (!bytes) invalid("prepared capability history snapshot is missing");
  const proposed = validateCapabilityLock(
    parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as never,
    { expected_scope: input.storage.paths.scope },
  );
  if (
    !Buffer.from(bytes).equals(canonicalJsonBytes(proposed, { maxBytes: 8 * 1024 * 1024 })) ||
    proposed.generation_id !== preparedEvent.payload.generation_id ||
    proposed.content_digest !== preparedEvent.payload.lock_digest ||
    proposed.policy_digest !== input.plan.runtime_closure.authority.policy_digest ||
    proposed.permission_digest !== input.plan.permission_digest ||
    (input.plan.base_lock_digest === null
      ? proposed.parent_generation_digests.length !== 0
      : !proposed.parent_generation_digests.includes(input.plan.base_lock_digest)) ||
    (input.plan.base_lock_digest === null) !==
      (preparedEvent.payload.expected_health_pointer_digest === null)
  )
    invalid("prepared capability history escaped the approved publication closure");
  const inventory = readCapabilityHealthInventory(
    input.storage,
    preparedEvent.payload.health_inventory_digest,
    proposed,
  );
  const expectedEpoch = preparedEvent.payload.expected_health_pointer_epoch;
  const nextEpoch = preparedEvent.payload.next_health_pointer_epoch;
  const nextDigest = preparedEvent.payload.next_health_pointer_digest;
  const hasAnyPointerExtension =
    expectedEpoch !== undefined || nextEpoch !== undefined || nextDigest !== undefined;
  const hasCompletePointerExtension =
    expectedEpoch !== undefined && nextEpoch !== undefined && nextDigest !== undefined;
  if (hasAnyPointerExtension && !hasCompletePointerExtension)
    invalid("prepared health pointer publication identity is incomplete");
  if (hasCompletePointerExtension) {
    if (
      (expectedEpoch === null) !==
        (preparedEvent.payload.expected_health_pointer_digest === null) ||
      (input.plan.base_lock_digest === null) !== (expectedEpoch === null) ||
      nextEpoch !== (expectedEpoch ?? -1) + 1 ||
      materializeCapabilityPublicationHealthPointer({
        scope: proposed.scope,
        scopeIdentityDigest: input.storage.scopeIdentityDigest,
        inventoryEpoch: nextEpoch,
        inventoryDigest: inventory.inventory_digest,
      }).pointer_digest !== nextDigest
    )
      invalid("prepared health pointer escaped the approved publication closure");
  }
  const targetPackage = new Map(
    proposed.packages.flatMap((pkg) =>
      pkg.targets.map((target) => [target.target_id, pkg.package_id] as const),
    ),
  );
  const batches = resolveHealthObservationBatches(input.storage, input.events);
  const expected = new Map<string, string>();
  for (const batch of batches) {
    if (!batch.complete) invalid("inventory preparation follows an incomplete health observation");
    const owners = new Set(
      batch.observation.results
        .map((result) => targetPackage.get(result.target_id) ?? null)
        .filter((owner): owner is string => owner !== null),
    );
    if (owners.size > 1) invalid("one health observation crosses committed package ownership");
    const owner = [...owners][0];
    if (owner) expected.set(batch.observation.observation_digest, owner);
  }
  const claimed = new Map<string, string>();
  for (const row of inventory.packages) {
    const binding = readCapabilityHealthBinding(input.storage, row.health_digest);
    for (const observationDigest of binding.observation_digests) {
      if (claimed.has(observationDigest))
        invalid("one health observation is claimed by more than one inventory binding");
      claimed.set(observationDigest, binding.package_id);
    }
  }
  const rows = (map: Map<string, string>) =>
    [...map].sort(([left], [right]) => bytewise(left, right));
  if (canonicalJson(rows(expected)) !== canonicalJson(rows(claimed)))
    invalid("health inventory observation ownership differs from the operation WAL");
}
