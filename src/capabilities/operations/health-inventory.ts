import { parseStrictJson } from "../../actions/strict-json.js";
import {
  canonicalJson,
  canonicalJsonBytes,
  digestV1,
  privateFileBytes,
} from "../../durability/index.js";
import type { CapabilityFabricPlanV1 } from "../planning/types.js";
import { readCapabilityWal } from "../storage/operation-store.js";
import {
  capabilityHealthCurrentPath,
  capabilityHealthInventoryPath,
  capabilityObjectPath,
} from "../storage/paths.js";
import type { CapabilityScopeLockV1 } from "../storage/scope-lock.js";
import type { CapabilityStorageV1 } from "../storage/store.js";
import type { CapabilityHealthCurrentV1, CapabilityHealthInventoryV1 } from "../storage/types.js";
import type { CapabilityLockV1 } from "../wire/lock.js";
import { bytewise } from "../wire/primitives.js";
import { CAPABILITY_RUNTIME_ERROR_CODE, CapabilityRuntimeError } from "./errors.js";
import {
  type AdapterHealthObservationResultV1,
  type CapabilityHealthBindingV1,
  capabilityHealthBinding,
  readAdapterHealthObservation,
  resolveHealthObservationBatches,
} from "./health-evidence.js";

function invalid(message: string): never {
  throw new CapabilityRuntimeError(message, CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE);
}

function readObject(storage: CapabilityStorageV1, digest: string): unknown {
  const bytes = privateFileBytes(capabilityObjectPath(storage.paths, digest), 2 * 1024 * 1024);
  if (!bytes) invalid("capability health binding object is missing");
  const parsed = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!Buffer.from(bytes).equals(canonicalJsonBytes(parsed, { maxBytes: 2 * 1024 * 1024 })))
    invalid("capability health binding object is not canonical");
  return parsed;
}

export function readCapabilityHealthBinding(
  storage: CapabilityStorageV1,
  digest: string,
): CapabilityHealthBindingV1 {
  const value = readObject(storage, digest) as CapabilityHealthBindingV1;
  const expected = capabilityHealthBinding({
    scope: value.scope,
    scope_identity_digest: value.scope_identity_digest,
    generation_id: value.generation_id,
    capability_lock_digest: value.capability_lock_digest,
    package_id: value.package_id,
    lock_entry_digest: value.lock_entry_digest,
    observation_digests: value.observation_digests,
    results: value.results,
  });
  if (value.health_digest !== digest || canonicalJson(value) !== canonicalJson(expected))
    invalid("capability health binding identity mismatch");
  for (const observationDigest of value.observation_digests)
    readAdapterHealthObservation(storage, observationDigest);
  return value;
}

export function buildCapabilityHealthInventory(input: {
  storage: CapabilityStorageV1;
  operationId: string;
  plan: CapabilityFabricPlanV1;
  lock: CapabilityLockV1;
  held: CapabilityScopeLockV1;
}): CapabilityHealthInventoryV1 {
  const events = readCapabilityWal(input.storage.paths, input.operationId);
  const batches = resolveHealthObservationBatches(input.storage, events);
  if (batches.some((batch) => !batch.complete))
    invalid("health inventory cannot publish an incomplete observation batch");
  const packages = input.lock.packages.map((pkg) => {
    const targetIds = new Set(pkg.targets.map((target) => target.target_id));
    const packagePlanIds = new Set(
      input.plan.adapter_plans
        .filter((plan) => plan.package_pin.id === pkg.package_id)
        .map((plan) => plan.plan_id),
    );
    const selected = batches.filter(
      (batch) =>
        packagePlanIds.has(batch.observation.plan_id) &&
        batch.observation.results.some((result) => targetIds.has(result.target_id)),
    );
    const results = selected.flatMap((batch) =>
      batch.observation.results.filter((result) => targetIds.has(result.target_id)),
    );
    const keys = results.map((row) => `${row.target_id}\0${row.probe_id}`);
    if (new Set(keys).size !== keys.length)
      invalid("package health binding has conflicting probe results");
    const binding = capabilityHealthBinding({
      scope: input.lock.scope,
      scope_identity_digest: input.storage.scopeIdentityDigest,
      generation_id: input.lock.generation_id,
      capability_lock_digest: input.lock.content_digest,
      package_id: pkg.package_id,
      lock_entry_digest: pkg.lock_entry_digest,
      observation_digests: selected.map((batch) => batch.observation.observation_digest),
      results,
    });
    input.storage.putObject(
      binding.health_digest,
      binding,
      { domain: "VF-CAPABILITY-HEALTH-BINDING\0v1\0", omit_keys: ["health_digest"] },
      input.held,
    );
    return {
      package_id: pkg.package_id,
      lock_entry_digest: pkg.lock_entry_digest,
      health_digest: binding.health_digest,
    };
  });
  packages.sort((left, right) => bytewise(left.package_id, right.package_id));
  const draft = {
    schema_version: "1.0" as const,
    scope: input.lock.scope,
    scope_identity_digest: input.storage.scopeIdentityDigest,
    capability_generation_id: input.lock.generation_id,
    capability_lock_digest: input.lock.content_digest,
    packages,
  };
  return {
    ...draft,
    inventory_digest: digestV1("VF-CAPABILITY-HEALTH-INVENTORY\0v1\0", draft),
  };
}

export function readCapabilityHealthInventory(
  storage: CapabilityStorageV1,
  inventoryDigest: string,
  lock: CapabilityLockV1 | null,
): CapabilityHealthInventoryV1 {
  const bytes = privateFileBytes(
    capabilityHealthInventoryPath(storage.paths, inventoryDigest),
    8 * 1024 * 1024,
  );
  if (!bytes) invalid("capability health inventory is missing");
  const value = parseStrictJson(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ) as unknown as CapabilityHealthInventoryV1;
  const draft = {
    schema_version: "1.0" as const,
    scope: lock?.scope ?? storage.paths.scope,
    scope_identity_digest: storage.scopeIdentityDigest,
    capability_generation_id: lock?.generation_id ?? null,
    capability_lock_digest: lock?.content_digest ?? null,
    packages: value.packages,
  };
  if (
    !Buffer.from(bytes).equals(canonicalJsonBytes(value, { maxBytes: 8 * 1024 * 1024 })) ||
    value.inventory_digest !== inventoryDigest ||
    value.inventory_digest !== digestV1("VF-CAPABILITY-HEALTH-INVENTORY\0v1\0", draft) ||
    canonicalJson(value) !== canonicalJson({ ...draft, inventory_digest: inventoryDigest }) ||
    value.packages.length !== (lock?.packages.length ?? 0)
  )
    invalid("capability health inventory does not bind the selected lock");
  if (!lock) return value;
  const claimedObservations = new Set<string>();
  for (let index = 0; index < lock.packages.length; index += 1) {
    const pkg = lock.packages[index];
    const row = value.packages[index];
    if (
      !pkg ||
      !row ||
      pkg.package_id !== row.package_id ||
      pkg.lock_entry_digest !== row.lock_entry_digest
    )
      invalid("capability health inventory package set differs from its lock");
    const binding = readCapabilityHealthBinding(storage, row.health_digest);
    if (
      binding.scope !== lock.scope ||
      binding.scope_identity_digest !== storage.scopeIdentityDigest ||
      binding.generation_id !== lock.generation_id ||
      binding.capability_lock_digest !== lock.content_digest ||
      binding.package_id !== pkg.package_id ||
      binding.lock_entry_digest !== pkg.lock_entry_digest
    )
      invalid("capability health binding does not bind its lock entry");
    const targetIds = new Set(pkg.targets.map((target) => target.target_id));
    if (binding.results.some((result) => !targetIds.has(result.target_id)))
      invalid("capability health binding contains a foreign target");
    for (const observationDigest of binding.observation_digests) {
      if (claimedObservations.has(observationDigest))
        invalid("one retained health observation is claimed by multiple packages");
      claimedObservations.add(observationDigest);
    }
    assertBindingObservations(storage, binding);
  }
  return value;
}

function assertBindingObservations(
  storage: CapabilityStorageV1,
  binding: CapabilityHealthBindingV1,
): void {
  const retained = binding.observation_digests.flatMap(
    (digest) => readAdapterHealthObservation(storage, digest).results,
  );
  const sorted = (rows: AdapterHealthObservationResultV1[]) =>
    [...rows].sort((left, right) =>
      bytewise(`${left.target_id}\0${left.probe_id}`, `${right.target_id}\0${right.probe_id}`),
    );
  if (canonicalJson(sorted(retained)) !== canonicalJson(sorted(binding.results)))
    invalid("capability health binding result set differs from retained observations");
}

export function readCapabilityHealthCurrent(
  storage: CapabilityStorageV1,
): CapabilityHealthCurrentV1 | null {
  const bytes = privateFileBytes(capabilityHealthCurrentPath(storage.paths), 2 * 1024 * 1024);
  if (!bytes) return null;
  const value = parseStrictJson(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ) as unknown as CapabilityHealthCurrentV1;
  const draft = {
    schema_version: "1.0" as const,
    scope: storage.paths.scope,
    scope_identity_digest: storage.scopeIdentityDigest,
    inventory_epoch: value.inventory_epoch,
    inventory_digest: value.inventory_digest,
  };
  if (
    !Buffer.from(bytes).equals(canonicalJsonBytes(value, { maxBytes: 2 * 1024 * 1024 })) ||
    canonicalJson(value) !==
      canonicalJson({
        ...draft,
        pointer_digest: digestV1("VF-CAPABILITY-HEALTH-CURRENT\0v1\0", draft),
      })
  )
    invalid("capability health current pointer is inconsistent");
  return value;
}
