import type { ProcessLock } from "../../durability/index.js";
import { acquireProcessLock, inspectProcessLockStatus } from "../../durability/index.js";
import type { CapabilityStorePathsV1 } from "./paths.js";

export interface CapabilityScopeLockV1 {
  readonly scope: "project" | "user";
  readonly scopeIdentityDigest: string;
  readonly processLock: ProcessLock;
  assertHeld(): void;
  release(): void;
}

export function acquireCapabilityScopeLock(
  paths: CapabilityStorePathsV1,
  scopeIdentityDigest: string,
  operation: string,
  timeoutMs = 5_000,
): CapabilityScopeLockV1 {
  const processLock = acquireProcessLock(paths.writerLock, { operation, timeoutMs });
  return {
    scope: paths.scope,
    scopeIdentityDigest,
    processLock,
    assertHeld: () => processLock.assertHeld(),
    release: () => processLock.release(),
  };
}

export function inspectCapabilityScopeLock(paths: CapabilityStorePathsV1) {
  return inspectProcessLockStatus(paths.writerLock);
}
