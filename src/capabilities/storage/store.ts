import { timingSafeEqual } from "node:crypto";
import { parseStrictJson } from "../../actions/strict-json.js";
import {
  atomicCompareAndSwap,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  privateFileBytes,
} from "../../durability/index.js";
import { digestV1 } from "../../durability/index.js";
import type { DurableAuthorityTransitionResolverV1 } from "../source/durable-authority-transition-resolver.js";
import { validateRegistryLockAuthorityFromDurableState } from "../source/registry-lock-authority.js";
import type { CapabilityLockV1 } from "../wire/lock.js";
import {
  CapabilityValidationError,
  assertSortedUnique,
  bytewise,
  digest,
  exactKeys,
  text,
} from "../wire/primitives.js";
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
import type { CapabilityObjectDigestSpecV1 } from "./types.js";

function exact(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

const MAX_HISTORY_ANCESTORS = 4_096;

function validatedHistoryGraph(
  paths: CapabilityStorePathsV1,
  rootDigests: readonly string[],
): Map<string, CapabilityLockV1> {
  const complete = new Map<string, CapabilityLockV1>();
  const visiting = new Set<string>();
  let observed = 0;
  const load = (contentDigest: string): CapabilityLockV1 => {
    digest(contentDigest, "history.content_digest");
    const prior = complete.get(contentDigest);
    if (prior) return prior;
    if (visiting.has(contentDigest))
      throw new CapabilityValidationError(
        "capability history ancestry contains a cycle",
        "history.parents",
        "integrity_failure",
      );
    observed += 1;
    if (observed > MAX_HISTORY_ANCESTORS)
      throw new CapabilityValidationError(
        "capability history ancestry exceeds bounds",
        "history.parents",
        "bounds",
      );
    const generationId = `vf-generation-${contentDigest.slice(7)}`;
    const bytes = privateFileBytes(capabilityHistoryPath(paths, generationId), 8 * 1024 * 1024);
    if (!bytes)
      throw new CapabilityValidationError(
        "required ancestor history snapshot is absent",
        "history.parents",
        "integrity_failure",
      );
    let parsed: unknown;
    try {
      parsed = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new CapabilityValidationError(
        "ancestor history snapshot is not strict JSON",
        "history.parents",
        "integrity_failure",
      );
    }
    const identity = parsed as Partial<CapabilityLockV1>;
    if (
      identity.scope !== paths.scope ||
      identity.content_digest !== contentDigest ||
      identity.generation_id !== generationId
    )
      throw new CapabilityValidationError(
        "ancestor history scope or identity is inconsistent",
        "history.parents",
        "integrity_failure",
      );
    if (
      !Array.isArray(identity.parent_generation_digests) ||
      identity.parent_generation_digests.length > 32
    )
      throw new CapabilityValidationError(
        "ancestor history parent set exceeds bounds",
        "history.parents",
        "bounds",
      );
    visiting.add(contentDigest);
    let parents: CapabilityLockV1[];
    try {
      parents = identity.parent_generation_digests.map((parentDigest) => {
        digest(parentDigest, "history.parent_generation_digest");
        return load(parentDigest);
      });
    } finally {
      visiting.delete(contentDigest);
    }
    const value = validateCapabilityLock(parsed as CapabilityLockV1, {
      expected_scope: paths.scope,
      parents,
    });
    if (!exact(bytes, canonicalJsonBytes(value)))
      throw new CapabilityValidationError(
        "ancestor history bytes are not canonical",
        "history.parents",
        "integrity_failure",
      );
    complete.set(contentDigest, value);
    return value;
  };
  for (const contentDigest of rootDigests) load(contentDigest);
  return complete;
}

export class CapabilityStorageV1 {
  readonly #now: () => string;
  readonly #authorityTransitionResolver: DurableAuthorityTransitionResolverV1 | undefined;

  constructor(
    readonly paths: CapabilityStorePathsV1,
    readonly scopeIdentityDigest: string,
    options: {
      now?: () => string;
      authorityTransitionResolver?: DurableAuthorityTransitionResolverV1;
    } = {},
  ) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#authorityTransitionResolver = options.authorityTransitionResolver;
  }

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
      const shape = validateCapabilityLock(parsed as unknown as CapabilityLockV1, {
        expected_scope: this.paths.scope,
      });
      const history = validatedHistoryGraph(this.paths, shape.parent_generation_digests);
      const parents = shape.parent_generation_digests.map(
        (parentDigest) => history.get(parentDigest) as CapabilityLockV1,
      );
      const lock = validateCapabilityLock(parsed as unknown as CapabilityLockV1, {
        expected_scope: this.paths.scope,
        parents,
      });
      validateRegistryLockAuthorityFromDurableState([lock, ...history.values()], {
        private_root: this.paths.privateRoot,
        identity_path: this.paths.identity,
        scope: this.paths.scope,
        scope_identity_digest: this.scopeIdentityDigest,
        at: this.#now(),
        authority_transition_resolver: this.#authorityTransitionResolver,
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
    lock.assertHeld();
    const history = validatedHistoryGraph(this.paths, [
      ...proposed.parent_generation_digests,
      ...(expected ? [expected.content_digest] : []),
    ]);
    const parents = proposed.parent_generation_digests.map(
      (parentDigest) => history.get(parentDigest) as CapabilityLockV1,
    );
    const next = validateCapabilityLock(proposed, {
      expected_scope: this.paths.scope,
      parents,
    });
    validateRegistryLockAuthorityFromDurableState([next, ...history.values()], {
      private_root: this.paths.privateRoot,
      identity_path: this.paths.identity,
      scope: this.paths.scope,
      scope_identity_digest: this.scopeIdentityDigest,
      at: this.#now(),
      authority_transition_resolver: this.#authorityTransitionResolver,
    });
    if (
      (expected === null && next.parent_generation_digests.length !== 0) ||
      (expected !== null && !next.parent_generation_digests.includes(expected.content_digest))
    )
      throw new CapabilityValidationError(
        "proposed parent history does not contain the exact current generation",
        "history.parents",
        "integrity_failure",
      );
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
      ? (() => {
          const validated = validateCapabilityLock(expected, { expected_scope: this.paths.scope });
          const historical = history.get(validated.content_digest);
          if (!historical)
            throw new CapabilityValidationError(
              "expected current lock is absent from validated history",
              "history.current",
              "integrity_failure",
            );
          const bytes = canonicalJsonBytes(validated);
          if (!exact(bytes, canonicalJsonBytes(historical)))
            throw new CapabilityValidationError(
              "expected current lock differs from immutable history",
              "history.current",
              "integrity_failure",
            );
          return bytes;
        })()
      : null;
    compareAndSwapPortableBytes(this.paths.currentLock, expectedBytes, nextBytes, lock);
  }

  putObject(
    objectDigest: string,
    value: unknown,
    spec: CapabilityObjectDigestSpecV1,
    lock: CapabilityScopeLockV1,
  ): string {
    lock.assertHeld();
    exactKeys(spec, ["domain", "omit_keys"], [], "object.digest_spec");
    if (!/^VF-[A-Z0-9][A-Z0-9-]*\0v1\0$/.test(spec.domain))
      throw new CapabilityValidationError(
        "invalid capability object digest domain",
        "object.domain",
      );
    if (!Array.isArray(spec.omit_keys) || new Set(spec.omit_keys).size !== spec.omit_keys.length)
      throw new CapabilityValidationError("invalid object digest omission set", "object.omit_keys");
    spec.omit_keys.forEach((key, index) =>
      text(key, `object.omit_keys[${index}]`, { min: 1, max: 128, ascii: true }),
    );
    assertSortedUnique(spec.omit_keys, bytewise, "object.omit_keys");
    let preimage = value;
    if (spec.omit_keys.length > 0) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new CapabilityValidationError(
          "digest omissions require a top-level object",
          "object.value",
        );
      const copy = { ...(value as Record<string, unknown>) };
      for (const key of spec.omit_keys) {
        if (!Object.hasOwn(copy, key) || ["__proto__", "constructor", "prototype"].includes(key))
          throw new CapabilityValidationError("invalid omitted digest field", "object.omit_keys");
        delete copy[key];
      }
      preimage = copy;
    }
    if (digestV1(spec.domain, preimage) !== objectDigest)
      throw new CapabilityValidationError(
        "capability object digest mismatch",
        "object.digest",
        "integrity_failure",
      );
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
