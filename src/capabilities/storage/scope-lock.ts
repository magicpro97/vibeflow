import { dirname, join } from "node:path";
import { CAPABILITY_SCOPE, type CapabilityScope } from "../../core/capability-contract.js";
import type { ProcessLock } from "../../durability/index.js";
import { acquireProcessLock, inspectProcessLockStatus } from "../../durability/index.js";
import { canonicalDurabilityPath } from "../../durability/native.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import type { CapabilityStorePathsV1 } from "./paths.js";

export interface CapabilityScopeLockV1 {
  readonly scope: CapabilityScope;
  readonly scopeIdentityDigest: string;
  readonly processLock: ProcessLock;
  assertHeld(): void;
  release(): void;
}

export interface CapabilityAuthorityActivationLockV1 {
  readonly scope: CapabilityScope;
  readonly processLock: ProcessLock;
  assertHeld(): void;
  release(): void;
}

export interface CapabilityPortableCasLockV1 {
  readonly scope: CapabilityScope;
  readonly scopeIdentityDigest: string;
  readonly processLock: ProcessLock;
  assertHeld(): void;
}

interface LockBindingV1 {
  scope: CapabilityScope;
  scopeIdentityDigest: string | null;
  privateRoot: string;
  portableTarget: string | null;
  targetClass: "capability-lock" | "project-identity" | null;
  processLock: ProcessLock;
}

const LOCK_BINDINGS = new WeakMap<object, LockBindingV1>();

function canonicalTarget(path: string): string {
  return join(canonicalDurabilityPath(dirname(path)), path.slice(dirname(path).length + 1));
}

function register<T extends object>(lock: T, binding: LockBindingV1): T {
  LOCK_BINDINGS.set(lock, binding);
  return Object.freeze(lock);
}

export function acquireCapabilityScopeLock(
  paths: CapabilityStorePathsV1,
  scopeIdentityDigest: string,
  operation: string,
  timeoutMs = 5_000,
): CapabilityScopeLockV1 {
  const processLock = acquireProcessLock(paths.writerLock, { operation, timeoutMs });
  return register(
    {
      scope: paths.scope,
      scopeIdentityDigest,
      processLock,
      assertHeld: () => processLock.assertHeld(),
      release: () => processLock.release(),
    },
    {
      scope: paths.scope,
      scopeIdentityDigest,
      privateRoot: canonicalDurabilityPath(paths.privateRoot),
      portableTarget: canonicalTarget(paths.currentLock),
      targetClass: "capability-lock",
      processLock,
    },
  );
}

export function acquireCapabilityAuthorityActivationLock(
  paths: CapabilityStorePathsV1,
  timeoutMs = 5_000,
): CapabilityAuthorityActivationLockV1 {
  const operation =
    paths.scope === CAPABILITY_SCOPE.PROJECT
      ? "project-authority-activation"
      : "user-authority-activation";
  return acquireCapabilityAuthorityLock(paths, operation, timeoutMs);
}

/** Serializes every authority mutation and every effect frontier on one fixed lock. */
export function acquireCapabilityAuthorityLock(
  paths: CapabilityStorePathsV1,
  operation: string,
  timeoutMs = 5_000,
): CapabilityAuthorityActivationLockV1 {
  const processLock = acquireProcessLock(paths.authorityWriterLock, {
    operation,
    timeoutMs,
    coverageRoot: paths.privateRoot,
  });
  return register(
    {
      scope: paths.scope,
      processLock,
      assertHeld: () => processLock.assertHeld(),
      release: () => processLock.release(),
    },
    {
      scope: paths.scope,
      scopeIdentityDigest: null,
      privateRoot: canonicalDurabilityPath(paths.privateRoot),
      portableTarget: null,
      targetClass: null,
      processLock,
    },
  );
}

export function bindProjectIdentityPortableCas(
  authorityLock: CapabilityAuthorityActivationLockV1,
  paths: CapabilityStorePathsV1,
  scopeIdentityDigest: string,
): CapabilityPortableCasLockV1 {
  const binding = LOCK_BINDINGS.get(authorityLock);
  if (
    !binding ||
    binding.scope !== CAPABILITY_SCOPE.PROJECT ||
    paths.scope !== CAPABILITY_SCOPE.PROJECT ||
    binding.privateRoot !== canonicalDurabilityPath(paths.privateRoot) ||
    binding.processLock !== authorityLock.processLock
  )
    throw new CapabilityValidationError(
      "project identity CAS requires the concrete authority activation lock",
      "authority_lock",
      "integrity_failure",
    );
  authorityLock.assertHeld();
  return register(
    {
      scope: CAPABILITY_SCOPE.PROJECT,
      scopeIdentityDigest,
      processLock: authorityLock.processLock,
      assertHeld: () => authorityLock.assertHeld(),
    },
    {
      ...binding,
      scopeIdentityDigest,
      portableTarget: canonicalTarget(paths.identity),
      targetClass: "project-identity",
    },
  );
}

export function assertCapabilityPortableCasLock(
  lock: CapabilityScopeLockV1 | CapabilityPortableCasLockV1,
  path: string,
): void {
  const binding = LOCK_BINDINGS.get(lock);
  if (
    !binding ||
    binding.scope !== lock.scope ||
    binding.scopeIdentityDigest !== lock.scopeIdentityDigest ||
    binding.processLock !== lock.processLock ||
    binding.portableTarget !== canonicalTarget(path) ||
    binding.targetClass === null
  )
    throw new CapabilityValidationError(
      "portable CAS requires a concrete target-bound scope lock",
      path,
      "integrity_failure",
    );
  lock.assertHeld();
}

export function inspectCapabilityScopeLock(paths: CapabilityStorePathsV1) {
  return inspectProcessLockStatus(paths.writerLock);
}
