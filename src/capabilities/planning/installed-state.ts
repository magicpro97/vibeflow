import { parseStrictJson } from "../../actions/strict-json.js";
import { canonicalJson, privateFileBytes } from "../../durability/index.js";
import { CapabilityRuntimeError } from "../operations/errors.js";
import type { FilesystemCapabilityPackageCacheV1 } from "../source/package-cache-reader.js";
import { validateCapabilityLock } from "../storage/lock-validation.js";
import { capabilityHistoryPath } from "../storage/paths.js";
import type { CapabilityStorageV1 } from "../storage/store.js";
import type { CapabilityLockV1 } from "../wire/lock.js";
import { bytewise } from "../wire/primitives.js";
import {
  type CapabilityPrivateInputAuthorityV1,
  materializeCurrentPackageInputs,
} from "./input-materializer.js";
import type { ResolvedCapabilityPackageV1 } from "./types.js";

function invalid(message: string): never {
  throw new CapabilityRuntimeError(message, "invalid-plan");
}

export interface CapabilityInstalledStateOptionsV1 {
  storage: CapabilityStorageV1;
  packages: FilesystemCapabilityPackageCacheV1;
  privateInputs: CapabilityPrivateInputAuthorityV1;
}

export function loadInstalledPackages(
  options: CapabilityInstalledStateOptionsV1,
  lock: CapabilityLockV1 | null,
): ResolvedCapabilityPackageV1[] {
  return (lock?.packages ?? []).map((entry) => {
    const pkg = options.packages.readByPin(entry.pin.pin_digest);
    if (
      !pkg ||
      pkg.manifest_digest !== entry.manifest_digest ||
      canonicalJson(pkg.authenticity_binding) !== canonicalJson(entry.authenticity_binding)
    )
      throw new CapabilityRuntimeError(
        "installed package cache closure is unavailable",
        "scope-needs-recovery",
      );
    return materializeCurrentPackageInputs({
      pkg: { ...pkg, dependencies: structuredClone(entry.dependencies) },
      publicInputs: entry.public_inputs,
      secretInputIds: entry.secret_input_ids,
      scope: lock?.scope as "project" | "user",
      scopeIdentityDigest: options.storage.scopeIdentityDigest,
      privateInputs: options.privateInputs,
    });
  });
}

export function readCapabilityHistory(
  storage: CapabilityStorageV1,
  generationId: string,
): CapabilityLockV1 {
  const bytes = privateFileBytes(
    capabilityHistoryPath(storage.paths, generationId),
    8 * 1024 * 1024,
  );
  if (!bytes) invalid("requested capability generation is unavailable");
  return validateCapabilityLock(
    parseStrictJson(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown as CapabilityLockV1,
    { expected_scope: storage.paths.scope },
  );
}

export function requiredInstalledPackage(
  packages: ResolvedCapabilityPackageV1[],
  packageId: string,
): ResolvedCapabilityPackageV1 {
  return (
    packages.find((row) => row.pin.id === packageId) ??
    invalid(`capability package ${packageId} is not installed`)
  );
}

export function sortedUniquePackages(
  packages: ResolvedCapabilityPackageV1[],
): ResolvedCapabilityPackageV1[] {
  const sorted = [...packages].sort((a, b) => bytewise(a.pin.id, b.pin.id));
  if (new Set(sorted.map((pkg) => pkg.pin.id)).size !== sorted.length)
    invalid("capability package graph contains duplicate package identities");
  return sorted;
}

export function mergeReplacingPackages(
  current: ResolvedCapabilityPackageV1[],
  replacements: ResolvedCapabilityPackageV1[],
): ResolvedCapabilityPackageV1[] {
  const ids = new Set(replacements.map((pkg) => pkg.pin.id));
  return sortedUniquePackages([...current.filter((pkg) => !ids.has(pkg.pin.id)), ...replacements]);
}

export function capabilityRemovalClosure(
  current: ResolvedCapabilityPackageV1[],
  packageId: string,
  cascade: boolean,
): ResolvedCapabilityPackageV1[] {
  requiredInstalledPackage(current, packageId);
  const removed = new Set([packageId]);
  while (true) {
    const dependent = current.find(
      (pkg) =>
        !removed.has(pkg.pin.id) && pkg.dependencies.some((dep) => removed.has(dep.package_id)),
    );
    if (!dependent) break;
    if (!cascade)
      invalid(`package ${dependent.pin.id} depends on ${packageId}; cascade is required`);
    removed.add(dependent.pin.id);
  }
  return current.filter((pkg) => removed.has(pkg.pin.id));
}
