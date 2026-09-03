import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CAPABILITY_SCOPE, type CapabilityScope } from "../../core/capability-contract.js";
import { digestHex } from "../../durability/index.js";
import { CapabilityValidationError, DIGEST_PATTERN } from "../wire/primitives.js";

export interface CapabilityStorePathsV1 {
  scope: CapabilityScope;
  privateRoot: string;
  currentLock: string;
  identity: string;
  writerLock: string;
  authorityWriterLock: string;
}

export function projectCapabilityPaths(projectRoot: string): CapabilityStorePathsV1 {
  const root = resolve(projectRoot);
  const privateRoot = join(root, ".vibeflow", "private", "capabilities");
  return {
    scope: CAPABILITY_SCOPE.PROJECT,
    privateRoot,
    currentLock: join(root, ".vibeflow", "CAPABILITIES.lock.json"),
    identity: join(root, ".vibeflow", "PROJECT_ID.json"),
    writerLock: join(privateRoot, "writer.lock"),
    authorityWriterLock: join(privateRoot, "authority", "v1", "writer.lock"),
  };
}

export function userCapabilityPaths(
  userVibeflowRoot = join(homedir(), ".vibeflow"),
): CapabilityStorePathsV1 {
  const privateRoot = join(resolve(userVibeflowRoot), "capabilities");
  return {
    scope: CAPABILITY_SCOPE.USER,
    privateRoot,
    currentLock: join(privateRoot, "CAPABILITIES.lock.json"),
    identity: join(privateRoot, "authority", "USER_IDENTITY.json"),
    writerLock: join(privateRoot, "writer.lock"),
    authorityWriterLock: join(privateRoot, "authority", "v1", "writer.lock"),
  };
}

function safeId(value: string, kind: string): string {
  if (!new RegExp(`^vf-${kind}-[a-f0-9]{64}$`).test(value))
    throw new CapabilityValidationError(`invalid ${kind} ID`, kind);
  return value;
}

export function capabilityHistoryPath(paths: CapabilityStorePathsV1, generationId: string): string {
  return join(paths.privateRoot, "history", "v1", `${safeId(generationId, "generation")}.json`);
}

export function capabilityOperationPaths(
  paths: CapabilityStorePathsV1,
  operationId: string,
): { header: string; events: string } {
  const id = safeId(operationId, "operation");
  const root = join(paths.privateRoot, "operations", "v1", id);
  return { header: join(root, "header.json"), events: join(root, "events.frames") };
}

export function capabilityObjectPath(paths: CapabilityStorePathsV1, objectDigest: string): string {
  if (!DIGEST_PATTERN.test(objectDigest))
    throw new CapabilityValidationError("invalid object digest", "object_digest");
  return join(paths.privateRoot, "objects", "v1", `${digestHex(objectDigest)}.json`);
}

export function capabilityHealthInventoryPath(
  paths: CapabilityStorePathsV1,
  inventoryDigest: string,
): string {
  if (!DIGEST_PATTERN.test(inventoryDigest))
    throw new CapabilityValidationError("invalid inventory digest", "inventory_digest");
  return join(
    paths.privateRoot,
    "health",
    "v1",
    "inventories",
    `${digestHex(inventoryDigest)}.json`,
  );
}

export function capabilityHealthCurrentPath(paths: CapabilityStorePathsV1): string {
  return join(paths.privateRoot, "health", "v1", "current.json");
}
