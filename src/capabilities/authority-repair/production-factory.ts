import {
  type AuthorityRepairDomainV1,
  ACTION_AUTHORITY_REPAIR_DOMAIN as D,
} from "../../actions/internal-action-vocabulary-contract.js";
import { ACTION_SCOPE, type ActionScope } from "../../actions/public-action-vocabulary-contract.js";
import {
  type CapabilityLockAuthorityRepairBackendOptionsV1,
  CapabilityLockAuthorityRepairBackendV1,
} from "./capability-lock-backend.js";
import type {
  AuthorityRepairDomainBackendSetV1,
  AuthorityRepairDomainBackendV1,
} from "./production-registry.js";
import { AuthorityRepairProductionRegistryV1 } from "./production-registry.js";
import type { AuthorityRepairActionObjectClosureV1, AuthorityRepairOperationV1 } from "./types.js";

export type AuthorityRepairOwnerRootsV1 = Readonly<Record<ActionScope, string>>;

export interface AuthorityRepairProductionFactoryOptionsV1 {
  owner_roots: AuthorityRepairOwnerRootsV1;
  /** Exhaustive domain validators supplied by the owning persistence adapters. */
  backends?: AuthorityRepairDomainBackendSetV1;
  capability_lock?: CapabilityLockAuthorityRepairBackendOptionsV1;
}

function unavailable(domain: AuthorityRepairDomainV1): never {
  throw new Error(`authority repair domain validator is unavailable for ${domain}`);
}

function ownerRoot(roots: AuthorityRepairOwnerRootsV1, scope: ActionScope): string {
  if (scope === ACTION_SCOPE.CONVERSATION) return roots[ACTION_SCOPE.CONVERSATION];
  if (scope === ACTION_SCOPE.PROJECT) return roots[ACTION_SCOPE.PROJECT];
  return roots[ACTION_SCOPE.USER];
}

/**
 * Exhaustive fail-closed host used until an owning domain registers a checksum-valid validator.
 * It resolves canonical owner roots but can never invent a checkpoint or execute a write.
 */
function closedBackend<Domain extends AuthorityRepairDomainV1>(
  domain: Domain,
  roots: AuthorityRepairOwnerRootsV1,
): AuthorityRepairDomainBackendV1 & { readonly domain: Domain } {
  const backend: AuthorityRepairDomainBackendV1 & { readonly domain: Domain } = {
    domain,
    inspect: () => [],
    ownerRoot: (input) => {
      if (input.domain !== domain) unavailable(domain);
      return ownerRoot(roots, input.authority_scope);
    },
    assertCurrent: (_closure: AuthorityRepairActionObjectClosureV1) => unavailable(domain),
    withLocks: <T>(_operation: AuthorityRepairOperationV1, _callback: () => T) =>
      unavailable(domain),
    observe: () => unavailable(domain),
    advance: () => unavailable(domain),
  };
  return Object.freeze(backend);
}

export function createDefaultAuthorityRepairDomainBackendsV1(
  roots: AuthorityRepairOwnerRootsV1,
  capabilityLock?: CapabilityLockAuthorityRepairBackendOptionsV1,
): AuthorityRepairDomainBackendSetV1 {
  return Object.freeze({
    [D.CONVERSATION_MANIFEST]: closedBackend(D.CONVERSATION_MANIFEST, roots),
    [D.CONVERSATION_JOURNAL]: closedBackend(D.CONVERSATION_JOURNAL, roots),
    [D.CONVERSATION_CONTENT]: closedBackend(D.CONVERSATION_CONTENT, roots),
    [D.LINEAGE_HEAD]: closedBackend(D.LINEAGE_HEAD, roots),
    [D.LINEAGE_RESERVATION]: closedBackend(D.LINEAGE_RESERVATION, roots),
    [D.LINEAGE_ASSOCIATION]: closedBackend(D.LINEAGE_ASSOCIATION, roots),
    [D.REVISION_OPERATION]: closedBackend(D.REVISION_OPERATION, roots),
    [D.ACTION_AUTHORITY]: closedBackend(D.ACTION_AUTHORITY, roots),
    [D.CAPABILITY_LOCK]: capabilityLock
      ? new CapabilityLockAuthorityRepairBackendV1(capabilityLock)
      : closedBackend(D.CAPABILITY_LOCK, roots),
    [D.CAPABILITY_OPERATION]: closedBackend(D.CAPABILITY_OPERATION, roots),
    [D.CAPABILITY_OUTBOX]: closedBackend(D.CAPABILITY_OUTBOX, roots),
    [D.SCOPE_IDENTITY]: closedBackend(D.SCOPE_IDENTITY, roots),
    [D.AUTHORITY_EPOCH]: closedBackend(D.AUTHORITY_EPOCH, roots),
    [D.GRANT_AUTHORITY]: closedBackend(D.GRANT_AUTHORITY, roots),
    [D.POLICY_AUTHORITY]: closedBackend(D.POLICY_AUTHORITY, roots),
    [D.REGISTRY_TRUST]: closedBackend(D.REGISTRY_TRUST, roots),
    [D.SECRET_REVOCATION]: closedBackend(D.SECRET_REVOCATION, roots),
    [D.AUTHORITY_REPAIR]: closedBackend(D.AUTHORITY_REPAIR, roots),
  } as const satisfies AuthorityRepairDomainBackendSetV1);
}

export function createProductionAuthorityRepairRegistryV1(
  options: AuthorityRepairProductionFactoryOptionsV1,
): AuthorityRepairProductionRegistryV1 {
  return new AuthorityRepairProductionRegistryV1(
    options.backends ??
      createDefaultAuthorityRepairDomainBackendsV1(options.owner_roots, options.capability_lock),
  );
}
