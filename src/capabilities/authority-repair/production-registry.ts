import { createHash } from "node:crypto";
import {
  ACTION_AUTHORITY_REPAIR_DOMAINS,
  ACTION_AUTHORITY_REPAIR_DOMAIN as D,
} from "../../actions/internal-action-vocabulary-contract.js";
import type { AuthorityRepairDomainV1 } from "../../actions/internal-action-vocabulary-contract.js";
import { ACTION_SCOPE, type ActionScope } from "../../actions/public-action-vocabulary-contract.js";
import { assertDigest, assertOpaqueId, assertTimestamp } from "../../actions/record-primitives.js";
import type { ActionProposalBaseV1 } from "../../actions/types.js";
import {
  AuthorityRepairAdapterRegistryV1,
  type AuthorityRepairAdapterSetV1,
  type AuthorityRepairCandidateIdentityV1,
} from "./adapter-registry.js";
import type { AuthorityRepairPreparedArtifactResolverV1 } from "./bootstrap-store.js";
import {
  AUTHORITY_REPAIR_CONTROL_STATE,
  AUTHORITY_REPAIR_LIMIT,
  AUTHORITY_REPAIR_STRATEGY,
} from "./contract.js";
import {
  AuthorityRepairExecutionAdapterRegistryV1,
  type AuthorityRepairExecutionAdapterSetV1,
  type AuthorityRepairExecutionAdapterV1,
  type AuthorityRepairExecutionContextV1,
  type AuthorityRepairExecutionObservationV1,
} from "./executor.js";
import type { AuthorityRepairPlanningCandidateV1 } from "./planner.js";
import type { AuthorityRepairReconciliationRowV1 } from "./reconciliation.js";
import { AuthorityRepairArtifactStoreV1 } from "./repair-artifact-store.js";
import type {
  AuthorityEpochRepairBaseV1,
  AuthorityRepairActionObjectClosureV1,
  AuthorityRepairActionObjectsV1,
  AuthorityRepairOperationV1,
  AuthorityRepairStepsV1,
  RepairAuthorizationBindingV1,
} from "./types.js";

export type AuthorityRepairProposalBaseDraftV1 = Omit<
  ActionProposalBaseV1,
  | "authority_binding_mode"
  | "authority_epoch"
  | "authority_head_digest"
  | "repair_authorization_binding_digest"
>;

export interface AuthorityRepairPreparedCandidateV1 {
  candidate_id: string;
  conversation_id: string | null;
  checkpoint_digest: string;
  control_state: AuthorityRepairPlanningCandidateV1["control_state"];
  authorization: Omit<RepairAuthorizationBindingV1, "binding_digest" | "mode">;
  steps: Omit<AuthorityRepairStepsV1, "steps_digest">;
  proposal_base: AuthorityRepairProposalBaseDraftV1;
  policy_digest: string;
  grant_digest: string;
  restore_bytes: Uint8Array;
  epoch_base: AuthorityEpochRepairBaseV1 | null;
  created_at: string;
  expires_at: string;
}

export interface AuthorityRepairDomainBackendV1 {
  readonly domain: AuthorityRepairDomainV1;
  /** Returns only checksum-valid checkpoint candidates owned by this domain. */
  inspect(): readonly AuthorityRepairPreparedCandidateV1[];
  /** Resolves one fixed affected private root from the validated scope identity; never enumerates. */
  ownerRoot(input: {
    domain: AuthorityRepairDomainV1;
    authority_scope: ActionScope;
    scope_id: string;
  }): string;
  /** Revalidates the exact current authority bound into an ordinary repair closure. */
  assertCurrent(closure: AuthorityRepairActionObjectClosureV1): void;
  withLocks<T>(operation: AuthorityRepairOperationV1, callback: () => T): T;
  observe(context: AuthorityRepairExecutionContextV1): AuthorityRepairExecutionObservationV1;
  advance(
    context: AuthorityRepairExecutionContextV1,
    row: AuthorityRepairReconciliationRowV1,
  ): AuthorityRepairExecutionObservationV1;
  /** Validates target ancestry while replaying the dedicated authority-repaired epoch event. */
  assertCommittedTransition?(input: {
    operation: AuthorityRepairOperationV1;
    closure: AuthorityRepairActionObjectClosureV1;
  }): void;
}

export type AuthorityRepairDomainBackendSetV1 = {
  readonly [Domain in AuthorityRepairDomainV1]: AuthorityRepairDomainBackendV1 & {
    readonly domain: Domain;
  };
};

function identity(
  candidate: AuthorityRepairPreparedCandidateV1,
): AuthorityRepairCandidateIdentityV1 {
  return Object.freeze({
    candidate_id: candidate.candidate_id,
    domain: candidate.steps.domain,
    authority_scope: candidate.steps.authority_scope,
    scope_id: candidate.steps.scope_id,
    checkpoint_digest: candidate.checkpoint_digest,
  });
}

function rawSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validatePreparedCandidate(
  domain: AuthorityRepairDomainV1,
  value: AuthorityRepairPreparedCandidateV1,
): void {
  assertOpaqueId(value.candidate_id, "$.authority_repair_candidate.candidate_id");
  if (value.conversation_id !== null)
    assertOpaqueId(value.conversation_id, "$.authority_repair_candidate.conversation_id");
  assertDigest(value.checkpoint_digest, "$.authority_repair_candidate.checkpoint_digest");
  assertDigest(value.policy_digest, "$.authority_repair_candidate.policy_digest");
  assertDigest(value.grant_digest, "$.authority_repair_candidate.grant_digest");
  const createdAt = assertTimestamp(value.created_at, "$.authority_repair_candidate.created_at");
  const expiresAt = assertTimestamp(value.expires_at, "$.authority_repair_candidate.expires_at");
  if (
    expiresAt <= createdAt ||
    expiresAt - createdAt > AUTHORITY_REPAIR_LIMIT.PLAN_TTL_MS ||
    value.restore_bytes.byteLength > AUTHORITY_REPAIR_LIMIT.RESTORE_BYTES
  )
    throw new Error("authority repair prepared candidate has invalid lifetime or byte bounds");
  if (
    value.steps.domain !== domain ||
    value.authorization.target_domain !== domain ||
    value.steps.authority_scope !== value.authorization.target_authority_scope ||
    value.steps.scope_id !== value.authorization.target_scope_id ||
    value.checkpoint_digest !== value.steps.last_valid_record_digest ||
    rawSha256(value.restore_bytes) !== value.steps.restore_bytes_sha256
  )
    throw new Error("authority repair prepared candidate closure is inconsistent");
  if (
    (value.steps.authority_scope === ACTION_SCOPE.CONVERSATION) !==
    (value.conversation_id !== null)
  )
    throw new Error("authority repair candidate conversation selector is inconsistent");
  const checkpoint = value.authorization.authority_head_checkpoint_digest;
  if (
    (value.control_state === AUTHORITY_REPAIR_CONTROL_STATE.CURRENT_VALID && checkpoint !== null) ||
    (value.control_state === AUTHORITY_REPAIR_CONTROL_STATE.RECOVERY_CHECKPOINT_ONLY &&
      checkpoint === null)
  )
    throw new Error("authority repair candidate control state and checkpoint disagree");
  const compound =
    value.steps.strategy === AUTHORITY_REPAIR_STRATEGY.REPLACE_AUTHORITY_EPOCH_COMPOUND;
  if (compound !== (value.epoch_base !== null))
    throw new Error("authority repair candidate epoch-base nullability mismatch");
  if (
    value.proposal_base.capability_scope !==
    (value.steps.authority_scope === ACTION_SCOPE.CONVERSATION ? null : value.steps.authority_scope)
  )
    throw new Error("authority repair candidate proposal base has the wrong target scope");
}

function candidateAdapter<Domain extends AuthorityRepairDomainV1>(
  backend: AuthorityRepairDomainBackendV1 & { readonly domain: Domain },
  candidates: readonly AuthorityRepairPreparedCandidateV1[],
) {
  return Object.freeze({
    domain: backend.domain,
    inspect: () =>
      candidates.map((candidate) =>
        Object.freeze({ ...identity(candidate), domain: backend.domain }),
      ),
  });
}

function executionAdapter<Domain extends AuthorityRepairDomainV1>(
  backend: AuthorityRepairDomainBackendV1 & { readonly domain: Domain },
): AuthorityRepairExecutionAdapterV1 & { readonly domain: Domain } {
  return Object.freeze({
    domain: backend.domain,
    withLocks: <T>(operation: AuthorityRepairOperationV1, callback: () => T) =>
      backend.withLocks(operation, callback),
    observe: (context: AuthorityRepairExecutionContextV1) => backend.observe(context),
    advance: (
      context: AuthorityRepairExecutionContextV1,
      row: AuthorityRepairReconciliationRowV1,
    ) => backend.advance(context, row),
  });
}

export interface AuthorityRepairCandidateSnapshotV1 {
  identities: readonly AuthorityRepairCandidateIdentityV1[];
  prepared(candidateId: string): AuthorityRepairPreparedCandidateV1;
}

/** Production composition is exhaustive at compile time and at construction time. */
export class AuthorityRepairProductionRegistryV1
  implements AuthorityRepairPreparedArtifactResolverV1
{
  readonly execution: AuthorityRepairExecutionAdapterRegistryV1;

  constructor(readonly backends: AuthorityRepairDomainBackendSetV1) {
    for (const domain of ACTION_AUTHORITY_REPAIR_DOMAINS)
      if (backends[domain].domain !== domain)
        throw new Error(`authority repair production backend misregistered for ${domain}`);
    const adapters = {
      [D.CONVERSATION_MANIFEST]: executionAdapter(backends[D.CONVERSATION_MANIFEST]),
      [D.CONVERSATION_JOURNAL]: executionAdapter(backends[D.CONVERSATION_JOURNAL]),
      [D.CONVERSATION_CONTENT]: executionAdapter(backends[D.CONVERSATION_CONTENT]),
      [D.LINEAGE_HEAD]: executionAdapter(backends[D.LINEAGE_HEAD]),
      [D.LINEAGE_RESERVATION]: executionAdapter(backends[D.LINEAGE_RESERVATION]),
      [D.LINEAGE_ASSOCIATION]: executionAdapter(backends[D.LINEAGE_ASSOCIATION]),
      [D.REVISION_OPERATION]: executionAdapter(backends[D.REVISION_OPERATION]),
      [D.ACTION_AUTHORITY]: executionAdapter(backends[D.ACTION_AUTHORITY]),
      [D.CAPABILITY_LOCK]: executionAdapter(backends[D.CAPABILITY_LOCK]),
      [D.CAPABILITY_OPERATION]: executionAdapter(backends[D.CAPABILITY_OPERATION]),
      [D.CAPABILITY_OUTBOX]: executionAdapter(backends[D.CAPABILITY_OUTBOX]),
      [D.SCOPE_IDENTITY]: executionAdapter(backends[D.SCOPE_IDENTITY]),
      [D.AUTHORITY_EPOCH]: executionAdapter(backends[D.AUTHORITY_EPOCH]),
      [D.GRANT_AUTHORITY]: executionAdapter(backends[D.GRANT_AUTHORITY]),
      [D.POLICY_AUTHORITY]: executionAdapter(backends[D.POLICY_AUTHORITY]),
      [D.REGISTRY_TRUST]: executionAdapter(backends[D.REGISTRY_TRUST]),
      [D.SECRET_REVOCATION]: executionAdapter(backends[D.SECRET_REVOCATION]),
      [D.AUTHORITY_REPAIR]: executionAdapter(backends[D.AUTHORITY_REPAIR]),
    } as const satisfies AuthorityRepairExecutionAdapterSetV1;
    this.execution = new AuthorityRepairExecutionAdapterRegistryV1(adapters);
    Object.freeze(backends);
  }

  snapshot(maxCandidates = 1_000): AuthorityRepairCandidateSnapshotV1 {
    const rows = new Map<AuthorityRepairDomainV1, readonly AuthorityRepairPreparedCandidateV1[]>();
    for (const domain of ACTION_AUTHORITY_REPAIR_DOMAINS) {
      const candidates = this.backends[domain]
        .inspect()
        .map((candidate) => structuredClone(candidate));
      for (const candidate of candidates) validatePreparedCandidate(domain, candidate);
      rows.set(domain, Object.freeze(candidates));
    }
    const adapters = {
      [D.CONVERSATION_MANIFEST]: candidateAdapter(
        this.backends[D.CONVERSATION_MANIFEST],
        rows.get(D.CONVERSATION_MANIFEST) ?? [],
      ),
      [D.CONVERSATION_JOURNAL]: candidateAdapter(
        this.backends[D.CONVERSATION_JOURNAL],
        rows.get(D.CONVERSATION_JOURNAL) ?? [],
      ),
      [D.CONVERSATION_CONTENT]: candidateAdapter(
        this.backends[D.CONVERSATION_CONTENT],
        rows.get(D.CONVERSATION_CONTENT) ?? [],
      ),
      [D.LINEAGE_HEAD]: candidateAdapter(
        this.backends[D.LINEAGE_HEAD],
        rows.get(D.LINEAGE_HEAD) ?? [],
      ),
      [D.LINEAGE_RESERVATION]: candidateAdapter(
        this.backends[D.LINEAGE_RESERVATION],
        rows.get(D.LINEAGE_RESERVATION) ?? [],
      ),
      [D.LINEAGE_ASSOCIATION]: candidateAdapter(
        this.backends[D.LINEAGE_ASSOCIATION],
        rows.get(D.LINEAGE_ASSOCIATION) ?? [],
      ),
      [D.REVISION_OPERATION]: candidateAdapter(
        this.backends[D.REVISION_OPERATION],
        rows.get(D.REVISION_OPERATION) ?? [],
      ),
      [D.ACTION_AUTHORITY]: candidateAdapter(
        this.backends[D.ACTION_AUTHORITY],
        rows.get(D.ACTION_AUTHORITY) ?? [],
      ),
      [D.CAPABILITY_LOCK]: candidateAdapter(
        this.backends[D.CAPABILITY_LOCK],
        rows.get(D.CAPABILITY_LOCK) ?? [],
      ),
      [D.CAPABILITY_OPERATION]: candidateAdapter(
        this.backends[D.CAPABILITY_OPERATION],
        rows.get(D.CAPABILITY_OPERATION) ?? [],
      ),
      [D.CAPABILITY_OUTBOX]: candidateAdapter(
        this.backends[D.CAPABILITY_OUTBOX],
        rows.get(D.CAPABILITY_OUTBOX) ?? [],
      ),
      [D.SCOPE_IDENTITY]: candidateAdapter(
        this.backends[D.SCOPE_IDENTITY],
        rows.get(D.SCOPE_IDENTITY) ?? [],
      ),
      [D.AUTHORITY_EPOCH]: candidateAdapter(
        this.backends[D.AUTHORITY_EPOCH],
        rows.get(D.AUTHORITY_EPOCH) ?? [],
      ),
      [D.GRANT_AUTHORITY]: candidateAdapter(
        this.backends[D.GRANT_AUTHORITY],
        rows.get(D.GRANT_AUTHORITY) ?? [],
      ),
      [D.POLICY_AUTHORITY]: candidateAdapter(
        this.backends[D.POLICY_AUTHORITY],
        rows.get(D.POLICY_AUTHORITY) ?? [],
      ),
      [D.REGISTRY_TRUST]: candidateAdapter(
        this.backends[D.REGISTRY_TRUST],
        rows.get(D.REGISTRY_TRUST) ?? [],
      ),
      [D.SECRET_REVOCATION]: candidateAdapter(
        this.backends[D.SECRET_REVOCATION],
        rows.get(D.SECRET_REVOCATION) ?? [],
      ),
      [D.AUTHORITY_REPAIR]: candidateAdapter(
        this.backends[D.AUTHORITY_REPAIR],
        rows.get(D.AUTHORITY_REPAIR) ?? [],
      ),
    } as const satisfies AuthorityRepairAdapterSetV1;
    const identities = new AuthorityRepairAdapterRegistryV1(adapters).candidates(maxCandidates);
    const prepared = new Map<string, AuthorityRepairPreparedCandidateV1>();
    for (const candidates of rows.values())
      for (const candidate of candidates)
        prepared.set(candidate.candidate_id, structuredClone(candidate));
    return Object.freeze({
      identities,
      prepared(candidateId: string) {
        const candidate = prepared.get(candidateId);
        if (!candidate)
          throw new Error("selected authority repair candidate is not in the snapshot");
        return structuredClone(candidate);
      },
    });
  }

  ownerRoot(input: {
    domain: AuthorityRepairDomainV1;
    authority_scope: ActionScope;
    scope_id: string;
  }): string {
    return this.backends[input.domain].ownerRoot(input);
  }

  resolve(objects: AuthorityRepairActionObjectsV1): AuthorityRepairActionObjectClosureV1 {
    const root = this.ownerRoot(objects.plan);
    return new AuthorityRepairArtifactStoreV1(root).resolvePreparedClosure(objects);
  }

  assertCurrent(closure: AuthorityRepairActionObjectClosureV1): void {
    this.backends[closure.plan.domain].assertCurrent(closure);
  }

  assertCommittedTransition(input: {
    operation: AuthorityRepairOperationV1;
    closure: AuthorityRepairActionObjectClosureV1;
  }): void {
    const backend = this.backends[input.operation.domain];
    if (!backend.assertCommittedTransition)
      throw new Error(`authority repair transition verifier is unavailable for ${backend.domain}`);
    backend.assertCommittedTransition(input);
  }
}
