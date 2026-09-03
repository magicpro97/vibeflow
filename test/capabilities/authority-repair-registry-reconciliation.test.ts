import { describe, expect, test } from "bun:test";
import { ACTION_AUTHORITY_REPAIR_DOMAINS } from "../../src/actions/internal-action-vocabulary-contract.js";
import {
  AUTHORITY_REPAIR_DOMAIN_LOCATOR_MATRIX,
  AUTHORITY_REPAIR_RECONCILIATION_PREDICATE,
  AUTHORITY_REPAIR_RECONCILIATION_TABLE,
  AuthorityRepairAdapterRegistryV1,
  assertAuthorityRepairDomainLocator,
  dispatchAuthorityRepairReconciliation,
} from "../../src/capabilities/authority-repair/index.js";
import type {
  AuthorityRepairAdapterSetV1,
  AuthorityRepairReconciliationClaimsV1,
  AuthorityRepairStepsV1,
} from "../../src/capabilities/authority-repair/index.js";

function claims(...enabled: string[]): AuthorityRepairReconciliationClaimsV1 {
  return Object.fromEntries(
    Object.values(AUTHORITY_REPAIR_RECONCILIATION_PREDICATE).map((predicate) => [
      predicate,
      enabled.includes(predicate),
    ]),
  ) as unknown as AuthorityRepairReconciliationClaimsV1;
}

const dispatch = (value: AuthorityRepairReconciliationClaimsV1) =>
  dispatchAuthorityRepairReconciliation({
    claims: value,
    strategy: "json-content",
    preimage: "present",
    resume_anchor: "prepared",
    reconciling: false,
  });

describe("authority repair reconciliation table", () => {
  test("dispatches every closed row and preserves first-match priority", () => {
    const predicates = new Set<string>();
    for (const row of AUTHORITY_REPAIR_RECONCILIATION_TABLE) {
      expect(row.priority).toBe(predicates.size);
      expect(predicates.has(row.predicate)).toBe(false);
      predicates.add(row.predicate);
      expect(
        dispatchAuthorityRepairReconciliation({
          claims: claims(row.predicate),
          strategy:
            row.strategy_class === "journal"
              ? "journal"
              : row.strategy_class === "compound"
                ? "compound"
                : "json-content",
          preimage: row.strategy_class === "absent-json-content" ? "absent" : "present",
          resume_anchor:
            row.anchor === "any-later" || row.anchor === "needs_recovery"
              ? "preimage_fsynced"
              : row.anchor,
          reconciling: row.anchor === "needs_recovery",
        }),
      ).toEqual(row);
    }
    const [first, second] = AUTHORITY_REPAIR_RECONCILIATION_TABLE;
    if (!first || !second) throw new Error("reconciliation table lacks its priority rows");
    expect(dispatch(claims(first.predicate, second.predicate)).predicate).toBe(first.predicate);
    expect(() => dispatch(claims())).toThrow(/no exhaustive/);
    expect(() =>
      dispatch(claims(AUTHORITY_REPAIR_RECONCILIATION_PREDICATE.TARGET_EXACT_RESTORED)),
    ).toThrow(/outside its strategy or anchor/);
  });
});

describe("authority repair adapter and locator registry", () => {
  test("has one nonempty compile-time domain row for every repair domain", () => {
    expect(Object.keys(AUTHORITY_REPAIR_DOMAIN_LOCATOR_MATRIX).sort()).toEqual(
      [...ACTION_AUTHORITY_REPAIR_DOMAINS].sort(),
    );
    for (const domain of ACTION_AUTHORITY_REPAIR_DOMAINS)
      expect(AUTHORITY_REPAIR_DOMAIN_LOCATOR_MATRIX[domain].length).toBeGreaterThan(0);
  });

  test("rejects a locator admitted by another domain", () => {
    const steps = {
      domain: "conversation-manifest",
      strategy: "replace-json-head",
      target_locator: {
        strategy: "replace-json-head",
        target: { kind: "conversation-manifest", conversation_id: "conversation-1" },
      },
    } as AuthorityRepairStepsV1;
    expect(() => assertAuthorityRepairDomainLocator("conversation-manifest", steps)).not.toThrow();
    expect(() => assertAuthorityRepairDomainLocator("lineage-head", steps)).toThrow(
      /domain differs/,
    );
  });

  test("candidate registry is bounded, sorted, unique, and rejects adapter misregistration", () => {
    const adapters = Object.fromEntries(
      ACTION_AUTHORITY_REPAIR_DOMAINS.map((domain) => [
        domain,
        {
          domain,
          inspect: () =>
            domain === "conversation-manifest"
              ? [
                  {
                    candidate_id: "candidate-z",
                    domain,
                    authority_scope: "conversation" as const,
                    scope_id: "root-1",
                    checkpoint_digest: `sha256:${"1".repeat(64)}`,
                  },
                ]
              : [],
        },
      ]),
    ) as unknown as AuthorityRepairAdapterSetV1;
    const registry = new AuthorityRepairAdapterRegistryV1(adapters);
    expect(registry.candidates().map((candidate) => candidate.candidate_id)).toEqual([
      "candidate-z",
    ]);
    expect(() => registry.candidates(0)).toThrow(/bound/);

    const broken = {
      ...adapters,
      "conversation-manifest": { ...adapters["conversation-manifest"], domain: "lineage-head" },
    } as unknown as AuthorityRepairAdapterSetV1;
    expect(() => new AuthorityRepairAdapterRegistryV1(broken)).toThrow(/misregistered/);
  });
});
