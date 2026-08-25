import { parseStrictJson } from "../../actions/strict-json.js";
import { canonicalJson, canonicalJsonBytes, privateFileBytes } from "../../durability/index.js";
import type { CapabilityFabricPlanV1 } from "../planning/types.js";
import { validateCapabilityLock } from "../storage/lock-validation.js";
import { capabilityHistoryPath } from "../storage/paths.js";
import type { CapabilityStorageV1 } from "../storage/store.js";
import type { CapabilityWalEventV1 } from "../wire/operation.js";
import { bytewise } from "../wire/primitives.js";
import { CapabilityRuntimeError } from "./errors.js";
import { resolveHealthObservationBatches } from "./health-evidence.js";
import { readCapabilityHealthBinding, readCapabilityHealthInventory } from "./health-inventory.js";

function invalid(message: string): never {
  throw new CapabilityRuntimeError(message, "integrity-failure");
}

export function assertCapabilityPublicationEvidence(input: {
  storage: CapabilityStorageV1;
  plan: CapabilityFabricPlanV1;
  events: readonly CapabilityWalEventV1[];
}): void {
  const preparedEvents = input.events.filter(
    (event) => event.payload.kind === "health-inventory-prepared",
  );
  if (preparedEvents.length === 0) return;
  if (preparedEvents.length !== 1)
    invalid("capability operation has duplicate inventory preparation");
  const preparedEvent = preparedEvents[0];
  if (preparedEvent?.payload.kind !== "health-inventory-prepared")
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
    (input.plan.base_lock_digest !== null &&
      preparedEvent.payload.expected_health_pointer_digest === null)
  )
    invalid("prepared capability history escaped the approved publication closure");
  const inventory = readCapabilityHealthInventory(
    input.storage,
    preparedEvent.payload.health_inventory_digest,
    proposed,
  );
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
