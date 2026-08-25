import { timingSafeEqual } from "node:crypto";
import { parseStrictJson } from "../../actions/strict-json.js";
import {
  atomicCompareAndSwap,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  privateFileBytes,
} from "../../durability/index.js";
import { digestV1 } from "../../durability/index.js";
import type { CapabilityLockV1 } from "../wire/lock.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import { validateCapabilityLock } from "./lock-validation.js";
import {
  type CapabilityStorePathsV1,
  capabilityHealthCurrentPath,
  capabilityHealthInventoryPath,
  capabilityHistoryPath,
  capabilityObjectPath,
} from "./paths.js";
import { compareAndSwapPortableBytes, readPortableBytes } from "./portable-cas.js";
import {
  type CapabilityScopeLockV1,
  acquireCapabilityScopeLock,
  inspectCapabilityScopeLock,
} from "./scope-lock.js";
import type {
  CapabilityHealthCurrentV1,
  CapabilityHealthInventoryV1,
  CapabilityReadStatusV1,
} from "./types.js";

function exact(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

export class CapabilityStorageV1 {
  constructor(
    readonly paths: CapabilityStorePathsV1,
    readonly scopeIdentityDigest: string,
  ) {}

  acquire(operation: string, timeoutMs?: number): CapabilityScopeLockV1 {
    return acquireCapabilityScopeLock(this.paths, this.scopeIdentityDigest, operation, timeoutMs);
  }

  readStatus(): CapabilityReadStatusV1 {
    const bytes = readPortableBytes(this.paths.currentLock);
    if (bytes === null)
      return { scope: this.paths.scope, state: "absent", lock: null, error: null };
    let parsed: unknown;
    try {
      parsed = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if ((parsed as { schema_version?: unknown }).schema_version !== "1.0")
        return {
          scope: this.paths.scope,
          state: "unsupported",
          lock: null,
          error: "unsupported_schema_version",
        };
      const lock = validateCapabilityLock(parsed as unknown as CapabilityLockV1, {
        expected_scope: this.paths.scope,
      });
      const lockState = inspectCapabilityScopeLock(this.paths);
      return {
        scope: this.paths.scope,
        state: lockState.status === "live" ? "locked" : "ready",
        lock,
        error: null,
      };
    } catch (error) {
      return {
        scope: this.paths.scope,
        state: "corrupt",
        lock: null,
        error: error instanceof Error ? error.message : "corrupt",
      };
    }
  }

  putHistory(lockValue: CapabilityLockV1, lock: CapabilityScopeLockV1): string {
    const value = validateCapabilityLock(lockValue, { expected_scope: this.paths.scope });
    const bytes = canonicalJsonBytes(value);
    const path = capabilityHistoryPath(this.paths, value.generation_id);
    createOrVerifyPrivateFile(path, bytes, { lock: lock.processLock, maxBytes: 8 * 1024 * 1024 });
    return path;
  }

  publishLock(
    expected: CapabilityLockV1 | null,
    proposed: CapabilityLockV1,
    lock: CapabilityScopeLockV1,
  ): void {
    const next = validateCapabilityLock(proposed, { expected_scope: this.paths.scope });
    const nextBytes = canonicalJsonBytes(next);
    const historyBytes = privateFileBytes(
      capabilityHistoryPath(this.paths, next.generation_id),
      8 * 1024 * 1024,
    );
    if (!historyBytes || !exact(historyBytes, nextBytes))
      throw new CapabilityValidationError(
        "proposed immutable history snapshot is absent or different",
        "history",
        "integrity_failure",
      );
    const expectedBytes = expected
      ? canonicalJsonBytes(validateCapabilityLock(expected, { expected_scope: this.paths.scope }))
      : null;
    compareAndSwapPortableBytes(this.paths.currentLock, expectedBytes, nextBytes, lock);
  }

  putObject(objectDigest: string, value: unknown, lock: CapabilityScopeLockV1): string {
    const bytes = canonicalJsonBytes(value, { maxBytes: 2 * 1024 * 1024 });
    const path = capabilityObjectPath(this.paths, objectDigest);
    createOrVerifyPrivateFile(path, bytes, { lock: lock.processLock, maxBytes: 2 * 1024 * 1024 });
    return path;
  }

  putHealthInventory(value: CapabilityHealthInventoryV1, lock: CapabilityScopeLockV1): string {
    const { inventory_digest: _, ...preimage } = value;
    if (
      value.scope !== this.paths.scope ||
      value.scope_identity_digest !== this.scopeIdentityDigest ||
      value.inventory_digest !== digestV1("VF-CAPABILITY-HEALTH-INVENTORY\0v1\0", preimage)
    )
      throw new CapabilityValidationError("health inventory owner/digest mismatch", "inventory");
    const path = capabilityHealthInventoryPath(this.paths, value.inventory_digest);
    createOrVerifyPrivateFile(path, canonicalJsonBytes(value), {
      lock: lock.processLock,
      maxBytes: 8 * 1024 * 1024,
    });
    return path;
  }

  publishHealthCurrent(
    expected: CapabilityHealthCurrentV1 | null,
    proposed: CapabilityHealthCurrentV1,
    lock: CapabilityScopeLockV1,
  ): void {
    const { pointer_digest: _, ...preimage } = proposed;
    if (
      proposed.scope !== this.paths.scope ||
      proposed.scope_identity_digest !== this.scopeIdentityDigest ||
      proposed.pointer_digest !== digestV1("VF-CAPABILITY-HEALTH-CURRENT\0v1\0", preimage)
    )
      throw new CapabilityValidationError("health pointer owner/digest mismatch", "health.current");
    const target = capabilityHealthCurrentPath(this.paths);
    const expectedBytes = expected ? canonicalJsonBytes(expected) : null;
    const nextBytes = canonicalJsonBytes(proposed);
    atomicCompareAndSwap(target, expectedBytes, nextBytes, { lock: lock.processLock });
  }
}
