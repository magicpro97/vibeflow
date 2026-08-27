import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import * as ts from "typescript";
import {
  ACTION_AUTHORITY_REPAIR_CAPABILITY_DOMAINS,
  ACTION_AUTHORITY_REPAIR_CONVERSATION_DOMAINS,
  ACTION_AUTHORITY_REPAIR_DOMAIN,
  ACTION_AUTHORITY_REPAIR_DOMAINS,
  ACTION_AUTHORITY_REPAIR_SCOPE_POLICY,
  ACTION_AUTHORITY_REPAIR_SCOPE_POLICY_KIND,
  ACTION_AUTHORITY_REPAIR_TARGET_PREIMAGE_PRESENCE,
  ACTION_AUTHORITY_REPAIR_TARGET_PREIMAGE_PRESENCES,
  isAuthorityRepairOriginBoundDomain,
} from "../../src/actions/internal-action-vocabulary-contract.js";
import {
  ACTION_APPROVAL_CHALLENGE_LIMIT,
  ACTION_APPROVAL_CHALLENGE_STATE,
  ACTION_APPROVAL_CHALLENGE_STATES,
  ACTION_APPROVAL_CHALLENGE_TERMINAL_STATES,
  ACTION_IDEMPOTENCY_BINDING_STATE,
  ACTION_IDEMPOTENCY_BINDING_STATES,
  ACTION_IDEMPOTENCY_BINDING_TERMINAL_STATES,
  isActionIdempotencyBindingState,
} from "../../src/actions/persistence-contract.js";
import {
  ACTION_PLANNING_MODES,
  ACTION_PLANNING_NETWORK_READ,
} from "../../src/actions/public-action-vocabulary-contract.js";
import { CAPABILITY_EXECUTION_LEDGER_MODES } from "../../src/capabilities/planning/execution-ledger-contract.js";
import { CAPABILITY_OPERATION_STATUSES } from "../../src/capabilities/wire/operation.js";

const productionSources = (roots: readonly string[]): string[] => {
  const output: string[] = [];
  const visit = (path: string): void => {
    if (path.endsWith(".ts")) {
      output.push(path);
      return;
    }
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name.endsWith(".ts")) output.push(child);
    }
  };
  for (const root of roots) visit(resolve(root));
  return output.sort();
};

const rawLiterals = (
  paths: readonly string[],
  forbiddenValues: readonly string[],
  excludedPaths: ReadonlySet<string>,
  allowed: ReadonlyMap<string, string> = new Map(),
): string[] => {
  const forbidden = new Set(forbiddenValues);
  const offenders: string[] = [];
  for (const path of paths) {
    const displayPath = relative(process.cwd(), path);
    if (excludedPaths.has(displayPath)) continue;
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) && forbidden.has(node.text)) {
        const key = `${displayPath}:${node.text}`;
        if (!allowed.has(key)) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          offenders.push(`${displayPath}:${line + 1}:${node.text}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return offenders;
};

const roots = productionSources([
  "src/actions",
  "src/capabilities",
  "src/commands/capability",
  "src/commands/capability.ts",
]);
const allProduction = productionSources(["src"]);

describe("persisted action authority consumers", () => {
  test("freezes idempotency and approval-challenge states, subsets, and limits", () => {
    expect(ACTION_IDEMPOTENCY_BINDING_STATES).toEqual([
      ACTION_IDEMPOTENCY_BINDING_STATE.PREPARED,
      ACTION_IDEMPOTENCY_BINDING_STATE.VISIBLE,
    ]);
    expect(ACTION_IDEMPOTENCY_BINDING_TERMINAL_STATES).toEqual([
      ACTION_IDEMPOTENCY_BINDING_STATE.VISIBLE,
    ]);
    expect(ACTION_APPROVAL_CHALLENGE_STATES).toEqual(
      Object.values(ACTION_APPROVAL_CHALLENGE_STATE),
    );
    expect(ACTION_APPROVAL_CHALLENGE_TERMINAL_STATES).toEqual([
      ACTION_APPROVAL_CHALLENGE_STATE.CONSUMED,
      ACTION_APPROVAL_CHALLENGE_STATE.EXPIRED,
      ACTION_APPROVAL_CHALLENGE_STATE.LOCKED,
    ]);
    expect(ACTION_APPROVAL_CHALLENGE_LIMIT).toEqual({
      LIFETIME_MS: 120_000,
      MAX_FAILED_ATTEMPTS: 5,
      ENTROPY_BYTES: 32,
    });
    for (const authority of [
      ACTION_IDEMPOTENCY_BINDING_STATE,
      ACTION_IDEMPOTENCY_BINDING_STATES,
      ACTION_IDEMPOTENCY_BINDING_TERMINAL_STATES,
      ACTION_APPROVAL_CHALLENGE_STATE,
      ACTION_APPROVAL_CHALLENGE_STATES,
      ACTION_APPROVAL_CHALLENGE_TERMINAL_STATES,
      ACTION_APPROVAL_CHALLENGE_LIMIT,
    ])
      expect(Object.isFrozen(authority)).toBe(true);
    expect(isActionIdempotencyBindingState(ACTION_IDEMPOTENCY_BINDING_STATE.PREPARED)).toBe(true);
    expect(isActionIdempotencyBindingState("prepared ")).toBe(false);
  });

  test("freezes repair domains and preimage-presence authority", () => {
    expect(ACTION_AUTHORITY_REPAIR_DOMAINS).toEqual(Object.values(ACTION_AUTHORITY_REPAIR_DOMAIN));
    expect(ACTION_AUTHORITY_REPAIR_TARGET_PREIMAGE_PRESENCES).toEqual(
      Object.values(ACTION_AUTHORITY_REPAIR_TARGET_PREIMAGE_PRESENCE),
    );
    for (const authority of [
      ACTION_AUTHORITY_REPAIR_DOMAIN,
      ACTION_AUTHORITY_REPAIR_DOMAINS,
      ACTION_AUTHORITY_REPAIR_CONVERSATION_DOMAINS,
      ACTION_AUTHORITY_REPAIR_CAPABILITY_DOMAINS,
      ACTION_AUTHORITY_REPAIR_SCOPE_POLICY,
      ACTION_AUTHORITY_REPAIR_SCOPE_POLICY_KIND,
      ACTION_AUTHORITY_REPAIR_TARGET_PREIMAGE_PRESENCE,
      ACTION_AUTHORITY_REPAIR_TARGET_PREIMAGE_PRESENCES,
    ])
      expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.keys(ACTION_AUTHORITY_REPAIR_SCOPE_POLICY).sort()).toEqual(
      [...ACTION_AUTHORITY_REPAIR_DOMAINS].sort(),
    );
    for (const policy of Object.values(ACTION_AUTHORITY_REPAIR_SCOPE_POLICY)) {
      expect(Object.isFrozen(policy)).toBe(true);
      expect(Object.isFrozen(policy.allowed_scopes)).toBe(true);
    }
    expect(
      ACTION_AUTHORITY_REPAIR_SCOPE_POLICY[ACTION_AUTHORITY_REPAIR_DOMAIN.ACTION_AUTHORITY].kind,
    ).toBe(ACTION_AUTHORITY_REPAIR_SCOPE_POLICY_KIND.ORIGIN_BOUND);
    expect(
      ACTION_AUTHORITY_REPAIR_SCOPE_POLICY[ACTION_AUTHORITY_REPAIR_DOMAIN.AUTHORITY_REPAIR].kind,
    ).toBe(ACTION_AUTHORITY_REPAIR_SCOPE_POLICY_KIND.ORIGIN_BOUND);
    expect(
      isAuthorityRepairOriginBoundDomain(ACTION_AUTHORITY_REPAIR_DOMAIN.ACTION_AUTHORITY),
    ).toBe(true);
    expect(isAuthorityRepairOriginBoundDomain(ACTION_AUTHORITY_REPAIR_DOMAIN.CAPABILITY_LOCK)).toBe(
      false,
    );
  });

  test("dynamically scans production consumers for persisted action literals", () => {
    const canonical = new Set([
      "src/actions/persistence-contract.ts",
      "src/actions/protocol-contract.ts",
      "src/actions/public-action-vocabulary-contract.ts",
      "src/actions/public-operation-contract.ts",
    ]);
    const actionSources = roots.filter((path) => path.includes("/src/actions/"));
    expect(
      rawLiterals(
        actionSources,
        [...ACTION_IDEMPOTENCY_BINDING_STATES, ...ACTION_APPROVAL_CHALLENGE_STATES],
        canonical,
      ),
    ).toEqual([]);
  });

  test("dynamically scans planning, ledger, and operation-status consumers", () => {
    const canonical = new Set([
      "src/actions/public-action-vocabulary-contract.ts",
      "src/capabilities/planning/execution-ledger-contract.ts",
      "src/capabilities/wire/operation-state-contract.ts",
      "src/capabilities/wire/operation.ts",
    ]);
    expect(
      rawLiterals(
        roots,
        [
          ...ACTION_PLANNING_MODES,
          ...ACTION_PLANNING_NETWORK_READ,
          ...CAPABILITY_EXECUTION_LEDGER_MODES,
        ],
        canonical,
      ),
    ).toEqual([]);
    const operationConsumers = roots.filter((path) =>
      /CapabilityOperation(?:Status|Result)|operation(?:Result|_result|\.status)|CAPABILITY_OPERATION_STATUS/u.test(
        readFileSync(path, "utf8"),
      ),
    );
    expect(rawLiterals(operationConsumers, CAPABILITY_OPERATION_STATUSES, canonical)).toEqual([]);
  });

  test("dynamically rejects handwritten repair-domain and preimage-presence consumers", () => {
    const allowed = new Map([
      ["src/actions/persistence.ts:action-authority", "VFFR storage-domain discriminant"],
      ["src/actions/public-operation-contract.ts:authority-repair", "host-action authority"],
    ]);
    expect(
      rawLiterals(
        roots.filter((path) => path.includes("/src/actions/")),
        [...ACTION_AUTHORITY_REPAIR_DOMAINS, ...ACTION_AUTHORITY_REPAIR_TARGET_PREIMAGE_PRESENCES],
        new Set(["src/actions/internal-action-vocabulary-contract.ts"]),
        allowed,
      ),
    ).toEqual([]);
    const persistedDigestProducers = allProduction.filter((path) => {
      const source = readFileSync(path, "utf8");
      return source.includes("repair_domain") || source.includes("VF-JOURNAL-IDENTITY");
    });
    expect(
      rawLiterals(
        persistedDigestProducers,
        ACTION_AUTHORITY_REPAIR_DOMAINS,
        new Set(["src/actions/internal-action-vocabulary-contract.ts"]),
      ),
    ).toEqual([]);
  });
});
