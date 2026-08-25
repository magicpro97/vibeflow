import { EMPTY_PERMISSION_DIGEST, EMPTY_SOURCE_AUTHORITY_SET_DIGEST } from "../actions/index.js";
import { canonicalJsonBytes, privateFileBytes } from "../durability/index.js";
import { validateAuthorityHead, validateAuthorityIdentity } from "./authority/index.js";
import type { AuthorityScopeIdentityRecordV1 } from "./authority/types.js";
import { CapabilityRuntimeError } from "./operations/errors.js";
import type { CapabilityRuntimeAuthorityReaderV1 } from "./operations/types.js";
import { permissionBindingDigest } from "./permissions/index.js";
import type {
  CapabilityDurablePlanningGraphV1,
  CapabilityRuntimeAuthorityV1,
} from "./planning/types.js";
import {
  activationHeadPath,
  parseCanonicalActivation,
  readActivationIdentity,
} from "./source/authority-activation-records.js";
import type { DurableAuthorityTransitionResolverV1 } from "./source/durable-authority-transition-resolver.js";
import { readDurableRegistryTrustSnapshot } from "./source/durable-registry-authority.js";
import type { CapabilityStorePathsV1 } from "./storage/paths.js";
import { acquireCapabilityAuthorityLock } from "./storage/scope-lock.js";

function unavailable(message: string): never {
  throw new CapabilityRuntimeError(message, "service-unavailable");
}

/** Read-only activation identity loader used before any runtime object is composed. */
export function readActivatedCapabilityIdentityV1(
  paths: CapabilityStorePathsV1,
): AuthorityScopeIdentityRecordV1 {
  const identityBytes = readActivationIdentity(paths);
  if (!identityBytes) unavailable("capability authority is not activated");
  const identity = parseCanonicalActivation<AuthorityScopeIdentityRecordV1>(
    identityBytes,
    "capability authority identity",
  );
  if (!identity) unavailable("capability authority identity is absent");
  validateAuthorityIdentity(identity);
  if (
    identity.scope !== paths.scope ||
    !Buffer.from(identityBytes).equals(canonicalJsonBytes(identity))
  )
    throw new CapabilityRuntimeError(
      "capability authority identity closure is corrupt",
      "integrity-failure",
    );
  return identity;
}

/** Zero-write, fully replay-validated reader for an explicitly activated Fabric authority. */
export class FilesystemCapabilityRuntimeAuthorityReaderV1
  implements CapabilityRuntimeAuthorityReaderV1
{
  constructor(
    readonly paths: CapabilityStorePathsV1,
    readonly transitionResolver: DurableAuthorityTransitionResolverV1,
  ) {}

  read(scope: "project" | "user"): CapabilityRuntimeAuthorityV1 {
    if (scope !== this.paths.scope) unavailable("capability authority reader scope mismatch");
    const identity = readActivatedCapabilityIdentityV1(this.paths);

    // This replays every retained epoch and verifies its durable shared-action authority.
    const trust = readDurableRegistryTrustSnapshot({
      private_root: this.paths.privateRoot,
      identity_path: this.paths.identity,
      scope,
      scope_identity_digest: identity.content_digest,
      authority_transition_resolver: this.transitionResolver,
    });
    const headBytes = privateFileBytes(activationHeadPath(this.paths), 1024 * 1024);
    if (!headBytes) unavailable("capability authority head is absent");
    const head = parseCanonicalActivation<import("./authority/types.js").AuthorityEpochHeadV1>(
      headBytes,
      "capability authority head",
    );
    if (!head) unavailable("capability authority head is absent");
    validateAuthorityHead(head);
    if (
      !Buffer.from(headBytes).equals(canonicalJsonBytes(head)) ||
      head.scope !== scope ||
      head.scope_identity_digest !== identity.content_digest ||
      trust.authority_epoch !== head.authority_epoch ||
      trust.authority_head_digest !== head.content_digest
    )
      throw new CapabilityRuntimeError(
        "capability authority identity/head closure is corrupt",
        "integrity-failure",
      );
    return {
      schema_version: "1.0",
      scope,
      scope_identity_digest: identity.content_digest,
      authority_epoch: head.authority_epoch,
      authority_head_digest: head.content_digest,
      policy_digest: head.policy_digest,
      grant_digest: head.grant_digest,
      permission_digest: EMPTY_PERMISSION_DIGEST,
      source_authority_set_digest: EMPTY_SOURCE_AUTHORITY_SET_DIGEST,
    };
  }

  readPermissionAuthority(graph: CapabilityDurablePlanningGraphV1, checkedAt: string): string {
    const checked = Date.parse(checkedAt);
    if (!Number.isFinite(checked) || new Date(checked).toISOString() !== checkedAt)
      throw new CapabilityRuntimeError(
        "permission authority frontier time is invalid",
        "permission-stale",
      );
    const { plan } = graph;
    if (
      plan.scope !== this.paths.scope ||
      plan.permission_digest !== permissionBindingDigest(plan.permission_binding) ||
      plan.runtime_closure.authority.permission_digest !== plan.permission_digest ||
      plan.adapter_plans.some(
        (adapterPlan) => adapterPlan.authority.permission_digest !== plan.permission_digest,
      )
    )
      throw new CapabilityRuntimeError(
        "typed permission authority differs from the approved execution graph",
        "permission-stale",
      );
    return plan.permission_digest;
  }

  criticalSection<T>(
    scope: "project" | "user",
    operation: string,
    now: () => string,
    callback: (authority: CapabilityRuntimeAuthorityV1, checkedAt: string) => T,
  ): T {
    if (scope !== this.paths.scope) unavailable("capability authority reader scope mismatch");
    const held = acquireCapabilityAuthorityLock(this.paths, operation);
    try {
      held.assertHeld();
      const checkedAt = now();
      return callback(this.read(scope), checkedAt);
    } finally {
      held.release();
    }
  }
}
