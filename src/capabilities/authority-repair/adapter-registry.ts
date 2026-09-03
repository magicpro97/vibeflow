import {
  ACTION_AUTHORITY_REPAIR_DOMAIN,
  ACTION_AUTHORITY_REPAIR_DOMAINS,
  isAuthorityRepairDomain,
  isAuthorityRepairScopeAllowed,
} from "../../actions/internal-action-vocabulary-contract.js";
import type { AuthorityRepairDomainV1 } from "../../actions/internal-action-vocabulary-contract.js";
import type { ActionScope } from "../../actions/public-action-vocabulary-contract.js";
import { assertDigest, assertOpaqueId } from "../../actions/record-primitives.js";
import {
  AUTHORITY_REPAIR_CONTENT_TARGET_KIND as C,
  AUTHORITY_REPAIR_JSON_HEAD_TARGET_KIND as J,
  AUTHORITY_REPAIR_STRATEGY as S,
} from "./contract.js";
import type { AuthorityRepairNonCompoundTargetLocatorV1, AuthorityRepairStepsV1 } from "./types.js";
import { assertNonCompoundLocator } from "./validation.js";

export type AuthorityRepairLocatorClassV1 =
  | `json:${(typeof J)[keyof typeof J]}`
  | "journal"
  | `content:${(typeof C)[keyof typeof C]}`
  | "compound";

const classes = (...values: AuthorityRepairLocatorClassV1[]) => Object.freeze(values);

/** Compile-time exhaustive domain→locator admission table. Missing domains do not fall through. */
export const AUTHORITY_REPAIR_DOMAIN_LOCATOR_MATRIX = Object.freeze({
  [ACTION_AUTHORITY_REPAIR_DOMAIN.CONVERSATION_MANIFEST]: classes(
    `json:${J.CONVERSATION_MANIFEST}`,
  ),
  [ACTION_AUTHORITY_REPAIR_DOMAIN.CONVERSATION_JOURNAL]: classes("journal"),
  [ACTION_AUTHORITY_REPAIR_DOMAIN.CONVERSATION_CONTENT]: classes(
    `content:${C.CONVERSATION_OBJECT}`,
  ),
  [ACTION_AUTHORITY_REPAIR_DOMAIN.LINEAGE_HEAD]: classes(`json:${J.LINEAGE_HEAD}`),
  [ACTION_AUTHORITY_REPAIR_DOMAIN.LINEAGE_RESERVATION]: classes(`json:${J.LINEAGE_RESERVATION}`),
  [ACTION_AUTHORITY_REPAIR_DOMAIN.LINEAGE_ASSOCIATION]: classes(`content:${C.LINEAGE_ASSOCIATION}`),
  [ACTION_AUTHORITY_REPAIR_DOMAIN.REVISION_OPERATION]: classes(
    "journal",
    `content:${C.REVISION_OPERATION_HEADER}`,
  ),
  [ACTION_AUTHORITY_REPAIR_DOMAIN.ACTION_AUTHORITY]: classes(
    "journal",
    `content:${C.ACTION_RECORD}`,
    `content:${C.ACTION_BLOB}`,
  ),
  [ACTION_AUTHORITY_REPAIR_DOMAIN.CAPABILITY_LOCK]: classes(
    `json:${J.CAPABILITY_LOCK}`,
    `content:${C.CAPABILITY_GENERATION}`,
  ),
  [ACTION_AUTHORITY_REPAIR_DOMAIN.CAPABILITY_OPERATION]: classes(
    "journal",
    `content:${C.CAPABILITY_OPERATION_HEADER}`,
    `content:${C.CAPABILITY_OBJECT}`,
    `content:${C.CAPABILITY_RUNTIME_EVIDENCE_BLOB}`,
    `content:${C.CAPABILITY_RUNTIME_EVIDENCE_BINDING}`,
  ),
  [ACTION_AUTHORITY_REPAIR_DOMAIN.CAPABILITY_OUTBOX]: classes(
    `content:${C.CAPABILITY_OUTBOX_PAYLOAD}`,
  ),
  [ACTION_AUTHORITY_REPAIR_DOMAIN.SCOPE_IDENTITY]: classes(`json:${J.SCOPE_IDENTITY}`),
  [ACTION_AUTHORITY_REPAIR_DOMAIN.AUTHORITY_EPOCH]: classes(
    `json:${J.AUTHORITY_EPOCH_ZERO_HEAD}`,
    "compound",
  ),
  [ACTION_AUTHORITY_REPAIR_DOMAIN.GRANT_AUTHORITY]: classes("journal"),
  [ACTION_AUTHORITY_REPAIR_DOMAIN.POLICY_AUTHORITY]: classes("journal"),
  [ACTION_AUTHORITY_REPAIR_DOMAIN.REGISTRY_TRUST]: classes("journal"),
  [ACTION_AUTHORITY_REPAIR_DOMAIN.SECRET_REVOCATION]: classes("journal"),
  [ACTION_AUTHORITY_REPAIR_DOMAIN.AUTHORITY_REPAIR]: classes(
    "journal",
    `content:${C.AUTHORITY_REPAIR_HEADER}`,
    `content:${C.AUTHORITY_REPAIR_OBJECT}`,
  ),
} as const satisfies Readonly<
  Record<AuthorityRepairDomainV1, readonly AuthorityRepairLocatorClassV1[]>
>);

export function authorityRepairLocatorClass(
  steps: AuthorityRepairStepsV1,
): AuthorityRepairLocatorClassV1 {
  if (steps.strategy === S.REPLACE_AUTHORITY_EPOCH_COMPOUND) {
    if (steps.target_locator !== null)
      throw new Error("compound repair unexpectedly has a locator");
    return "compound";
  }
  assertNonCompoundLocator(steps.target_locator);
  const locator = steps.target_locator as AuthorityRepairNonCompoundTargetLocatorV1;
  if (locator.strategy === S.NEW_JOURNAL_GENERATION) return "journal";
  if (locator.strategy === S.REPLACE_JSON_HEAD) return `json:${locator.target.kind}`;
  return `content:${locator.target.kind}`;
}

export function assertAuthorityRepairDomainLocator(
  domain: AuthorityRepairDomainV1,
  steps: AuthorityRepairStepsV1,
): void {
  if (domain !== steps.domain) throw new Error("repair adapter domain differs from repair steps");
  const locatorClass = authorityRepairLocatorClass(steps);
  if (
    !AUTHORITY_REPAIR_DOMAIN_LOCATOR_MATRIX[domain].some((candidate) => candidate === locatorClass)
  )
    throw new Error(`repair domain ${domain} does not admit locator ${locatorClass}`);
}

export interface AuthorityRepairCandidateIdentityV1 {
  candidate_id: string;
  domain: AuthorityRepairDomainV1;
  authority_scope: ActionScope;
  scope_id: string;
  checkpoint_digest: string;
}

export interface AuthorityRepairCandidateAdapterV1<
  Candidate extends AuthorityRepairCandidateIdentityV1 = AuthorityRepairCandidateIdentityV1,
> {
  readonly domain: Candidate["domain"];
  inspect(): readonly Candidate[];
}

export type AuthorityRepairAdapterSetV1 = {
  readonly [Domain in AuthorityRepairDomainV1]: AuthorityRepairCandidateAdapterV1<
    AuthorityRepairCandidateIdentityV1 & { domain: Domain }
  >;
};

export class AuthorityRepairAdapterRegistryV1 {
  constructor(readonly adapters: AuthorityRepairAdapterSetV1) {
    for (const domain of ACTION_AUTHORITY_REPAIR_DOMAINS) {
      if (adapters[domain].domain !== domain)
        throw new Error(`authority repair adapter misregistered for ${domain}`);
    }
    Object.freeze(adapters);
  }

  adapter<Domain extends AuthorityRepairDomainV1>(
    domain: Domain,
  ): AuthorityRepairAdapterSetV1[Domain] {
    return this.adapters[domain];
  }

  candidates(maxCandidates = 1_000): readonly AuthorityRepairCandidateIdentityV1[] {
    const all: AuthorityRepairCandidateIdentityV1[] = [];
    for (const domain of ACTION_AUTHORITY_REPAIR_DOMAINS)
      all.push(
        ...(this.adapters[domain].inspect() as readonly AuthorityRepairCandidateIdentityV1[]),
      );
    if (all.length > maxCandidates) throw new Error("authority repair candidate bound exceeded");
    const ids = new Set<string>();
    for (const candidate of all) {
      if (
        !isAuthorityRepairDomain(candidate.domain) ||
        !isAuthorityRepairScopeAllowed(candidate.domain, candidate.authority_scope)
      )
        throw new Error("authority repair candidate domain/scope is invalid");
      assertOpaqueId(candidate.candidate_id, "$.authority_repair_candidate.candidate_id");
      assertOpaqueId(candidate.scope_id, "$.authority_repair_candidate.scope_id");
      assertDigest(candidate.checkpoint_digest, "$.authority_repair_candidate.checkpoint_digest");
      if (
        candidate.domain !== this.adapters[candidate.domain].domain ||
        ids.has(candidate.candidate_id)
      )
        throw new Error("authority repair candidate registry is ambiguous");
      ids.add(candidate.candidate_id);
    }
    return Object.freeze(
      all
        .map((row) => Object.freeze(structuredClone(row)))
        .sort((a, b) => Buffer.from(a.candidate_id).compare(Buffer.from(b.candidate_id))),
    );
  }
}
