import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import * as ts from "typescript";
import {
  CAPABILITY_CLI_AUTHORITY_MUTATION_COMMANDS,
  CAPABILITY_CLI_CAPABILITY_MUTATION_COMMANDS,
  CAPABILITY_CLI_COMMAND,
  CAPABILITY_CLI_COMMANDS,
  CAPABILITY_CLI_EXPLICIT_SCOPE_AUTHORITY_COMMANDS,
  CAPABILITY_CLI_TRUST_MUTATION_COMMANDS,
  isCapabilityCliCapabilityMutationCommand,
  isCapabilityCliCommand,
  isCapabilityCliExplicitScopeAuthorityCommand,
  isCapabilityCliTrustMutationCommand,
} from "../../src/actions/capability-cli-contract.js";
import {
  CAPABILITY_AUTHORITY_CHANGE,
  CAPABILITY_AUTHORITY_CHANGES,
  CAPABILITY_GRANT_TRANSITION,
  CAPABILITY_GRANT_TRANSITIONS,
  CAPABILITY_PACKAGE_PIN_POLICY_BY_SOURCE,
  CAPABILITY_PACKAGE_PIN_TRUST,
  CAPABILITY_PACKAGE_PIN_TRUST_VALUES,
  CAPABILITY_REGISTRY_ENVELOPE_STATUS,
  CAPABILITY_REGISTRY_ENVELOPE_STATUSES,
  CAPABILITY_REGISTRY_TRUST_KEY_STATE,
  CAPABILITY_REGISTRY_TRUST_KEY_STATES,
  CAPABILITY_SIGNATURE_ALGORITHM,
  CAPABILITY_SIGNATURE_ALGORITHMS,
  CAPABILITY_SOURCE_KIND,
  CAPABILITY_SOURCE_KINDS,
  CAPABILITY_TRUST_KEY_STATE_BY_TRANSITION,
  CAPABILITY_TRUST_TRANSITION,
  CAPABILITY_TRUST_TRANSITIONS,
  isCapabilityAuthorityChange,
  isCapabilityGrantTransition,
  isCapabilityPackagePinTrust,
  isCapabilityRegistryEnvelopeStatus,
  isCapabilityRegistryTrustKeyState,
  isCapabilitySignatureAlgorithm,
  isCapabilitySourceKind,
  isCapabilityTrustTransition,
} from "../../src/actions/capability-security-contract.js";
import {
  ACTION_PACKAGE_PIN_SOURCE_KIND,
  ACTION_PACKAGE_PIN_TRUST_VALUE,
} from "../../src/actions/public-action-vocabulary-contract.js";

const productionSources = (roots: readonly string[]): string[] => {
  const output: string[] = [];
  const visit = (path: string): void => {
    if (path.endsWith(".ts")) return void output.push(path);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name.endsWith(".ts")) output.push(child);
    }
  };
  for (const root of roots) visit(resolve(root));
  return output.sort();
};

const securityRoots = productionSources([
  "src/actions",
  "src/capabilities",
  "src/commands/capability",
  "src/commands/capability.ts",
]);
const allProductionSources = productionSources(["src"]).filter(
  (path) => !relative(process.cwd(), path).split("/").includes("test"),
);

const CLI_COMMAND_LITERAL_AUTHORITY_FILES = Object.freeze({
  "src/actions/capability-cli-contract.ts": "canonical CLI authority",
  "src/actions/host-action-contract.ts": "canonical shared host-action authority",
} as const);

describe("browser-safe capability security authority", () => {
  test("freezes one exhaustive security vocabulary and source policy matrix", () => {
    expect(CAPABILITY_SOURCE_KIND).toBe(ACTION_PACKAGE_PIN_SOURCE_KIND);
    expect(CAPABILITY_PACKAGE_PIN_TRUST).toBe(ACTION_PACKAGE_PIN_TRUST_VALUE);
    expect(Object.keys(CAPABILITY_PACKAGE_PIN_POLICY_BY_SOURCE).sort()).toEqual(
      [...CAPABILITY_SOURCE_KINDS].sort(),
    );
    expect(CAPABILITY_PACKAGE_PIN_POLICY_BY_SOURCE).toEqual({
      registry: { trust: "verified", nonportable: false },
      git: { trust: "source-pinned", nonportable: false },
      "local-dev": { trust: "dev-unverified", nonportable: true },
      "legacy-adopt": { trust: "legacy-verified", nonportable: false },
    });
    expect(CAPABILITY_TRUST_KEY_STATE_BY_TRANSITION).toEqual({
      added: "active",
      rescoped: "active",
      deprecated: "deprecated",
      revoked: "revoked",
    });
    for (const authority of [
      CAPABILITY_SOURCE_KIND,
      CAPABILITY_SOURCE_KINDS,
      CAPABILITY_PACKAGE_PIN_TRUST,
      CAPABILITY_PACKAGE_PIN_TRUST_VALUES,
      CAPABILITY_PACKAGE_PIN_POLICY_BY_SOURCE,
      CAPABILITY_REGISTRY_TRUST_KEY_STATE,
      CAPABILITY_REGISTRY_TRUST_KEY_STATES,
      CAPABILITY_REGISTRY_ENVELOPE_STATUS,
      CAPABILITY_REGISTRY_ENVELOPE_STATUSES,
      CAPABILITY_SIGNATURE_ALGORITHM,
      CAPABILITY_SIGNATURE_ALGORITHMS,
      CAPABILITY_AUTHORITY_CHANGE,
      CAPABILITY_AUTHORITY_CHANGES,
      CAPABILITY_GRANT_TRANSITION,
      CAPABILITY_GRANT_TRANSITIONS,
      CAPABILITY_TRUST_TRANSITION,
      CAPABILITY_TRUST_TRANSITIONS,
      CAPABILITY_TRUST_KEY_STATE_BY_TRANSITION,
    ])
      expect(Object.isFrozen(authority)).toBe(true);
    for (const policy of Object.values(CAPABILITY_PACKAGE_PIN_POLICY_BY_SOURCE))
      expect(Object.isFrozen(policy)).toBe(true);
  });

  test("keeps public CLI command subsets derived from one frozen authority", () => {
    expect(CAPABILITY_CLI_COMMANDS).toEqual(Object.values(CAPABILITY_CLI_COMMAND));
    const mutations = new Set<string>([
      ...CAPABILITY_CLI_CAPABILITY_MUTATION_COMMANDS,
      ...CAPABILITY_CLI_AUTHORITY_MUTATION_COMMANDS,
    ]);
    const nonMutations = new Set<string>([
      CAPABILITY_CLI_COMMAND.SEARCH,
      CAPABILITY_CLI_COMMAND.LIST,
      CAPABILITY_CLI_COMMAND.STATUS,
      CAPABILITY_CLI_COMMAND.ADOPT_INSPECT,
      CAPABILITY_CLI_COMMAND.PRIVATE_INPUT_BIND,
    ]);
    expect(mutations).toEqual(
      new Set<string>(CAPABILITY_CLI_COMMANDS.filter((command) => !nonMutations.has(command))),
    );
    for (const authority of [
      CAPABILITY_CLI_COMMAND,
      CAPABILITY_CLI_COMMANDS,
      CAPABILITY_CLI_CAPABILITY_MUTATION_COMMANDS,
      CAPABILITY_CLI_AUTHORITY_MUTATION_COMMANDS,
      CAPABILITY_CLI_TRUST_MUTATION_COMMANDS,
      CAPABILITY_CLI_EXPLICIT_SCOPE_AUTHORITY_COMMANDS,
    ])
      expect(Object.isFrozen(authority)).toBe(true);
    expect(
      isCapabilityCliCommand(Object.create({ toString: () => CAPABILITY_CLI_COMMAND.SEARCH })),
    ).toBe(false);
    expect(isCapabilityCliCommand("capability.future")).toBe(false);
  });

  test("guards every CLI mutation subset and security vocabulary fail closed", () => {
    expect(isCapabilityCliCapabilityMutationCommand(CAPABILITY_CLI_COMMAND.INSTALL)).toBe(true);
    expect(isCapabilityCliCapabilityMutationCommand(CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR)).toBe(
      false,
    );
    expect(isCapabilityCliTrustMutationCommand(CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_ADD)).toBe(
      true,
    );
    expect(isCapabilityCliTrustMutationCommand(CAPABILITY_CLI_COMMAND.UPDATE)).toBe(false);
    expect(
      isCapabilityCliExplicitScopeAuthorityCommand(CAPABILITY_CLI_COMMAND.AUTHORITY_TRUST_REVOKE),
    ).toBe(true);
    expect(
      isCapabilityCliExplicitScopeAuthorityCommand(CAPABILITY_CLI_COMMAND.AUTHORITY_REPAIR),
    ).toBe(false);

    expect(isCapabilitySourceKind(CAPABILITY_SOURCE_KIND.GIT)).toBe(true);
    expect(isCapabilitySourceKind("registry ")).toBe(false);
    expect(isCapabilityPackagePinTrust(CAPABILITY_PACKAGE_PIN_TRUST.LEGACY_VERIFIED)).toBe(true);
    expect(isCapabilityPackagePinTrust("verified ")).toBe(false);
    expect(isCapabilityRegistryTrustKeyState(CAPABILITY_REGISTRY_TRUST_KEY_STATE.ACTIVE)).toBe(
      true,
    );
    expect(isCapabilityRegistryTrustKeyState("ACTIVE")).toBe(false);
    expect(isCapabilityRegistryEnvelopeStatus(CAPABILITY_REGISTRY_ENVELOPE_STATUS.BLOCKED)).toBe(
      true,
    );
    expect(isCapabilityRegistryEnvelopeStatus("blocked ")).toBe(false);
    expect(isCapabilitySignatureAlgorithm(CAPABILITY_SIGNATURE_ALGORITHM.ED25519)).toBe(true);
    expect(isCapabilitySignatureAlgorithm("ed25519")).toBe(false);
    expect(isCapabilityAuthorityChange(CAPABILITY_AUTHORITY_CHANGE.REGISTRY_TRUST_CHANGED)).toBe(
      true,
    );
    expect(isCapabilityAuthorityChange("registry-trust-change")).toBe(false);
    expect(isCapabilityGrantTransition(CAPABILITY_GRANT_TRANSITION.RENEWED)).toBe(true);
    expect(isCapabilityGrantTransition("renew")).toBe(false);
    expect(isCapabilityTrustTransition(CAPABILITY_TRUST_TRANSITION.RESCOPED)).toBe(true);
    expect(isCapabilityTrustTransition("rescope")).toBe(false);
  });

  test("AST-scans every action/capability production source for security redeclarations", () => {
    const forbidden = new Set<string>([
      ...CAPABILITY_SOURCE_KINDS,
      ...CAPABILITY_PACKAGE_PIN_TRUST_VALUES,
      ...CAPABILITY_REGISTRY_TRUST_KEY_STATES,
      ...CAPABILITY_REGISTRY_ENVELOPE_STATUSES,
      ...CAPABILITY_SIGNATURE_ALGORITHMS,
      ...CAPABILITY_AUTHORITY_CHANGES,
      ...CAPABILITY_GRANT_TRANSITIONS,
      ...CAPABILITY_TRUST_TRANSITIONS,
    ]);
    const canonical = new Set([
      "src/actions/capability-security-contract.ts",
      "src/actions/public-action-vocabulary-contract.ts",
    ]);
    const unrelated = new Set([
      "src/actions/protocol-contract.ts:stale",
      "src/actions/public-operation-contract.ts:blocked",
      "src/actions/public-operation-contract.ts:stale",
      "src/actions/public-operation-contract.ts:verified",
      "src/capabilities/action-domain/conversation-dispatch-runtime.ts:active",
      "src/capabilities/source/authority-activation-records.ts:stale",
      "src/capabilities/source/authority-activation.ts:stale",
      "src/capabilities/wire/operation-state-contract.ts:revoked",
    ]);
    const offenders: string[] = [];
    for (const path of securityRoots) {
      const display = relative(process.cwd(), path);
      if (canonical.has(display)) continue;
      const source = ts.createSourceFile(
        path,
        readFileSync(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteral(node) && forbidden.has(node.text)) {
          const key = `${display}:${node.text}`;
          if (!unrelated.has(key)) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
            offenders.push(`${display}:${line + 1}:${node.text}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(offenders).toEqual([]);
  });

  test("rejects handwritten public CLI command values across all production sources", () => {
    const commandValues = new Set<string>(CAPABILITY_CLI_COMMANDS);
    const offenders: string[] = [];
    for (const path of allProductionSources) {
      const display = relative(process.cwd(), path);
      if (Object.hasOwn(CLI_COMMAND_LITERAL_AUTHORITY_FILES, display)) continue;
      const source = ts.createSourceFile(
        path,
        readFileSync(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteral(node) && commandValues.has(node.text)) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          offenders.push(`${display}:${line + 1}:${node.text}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(Object.isFrozen(CLI_COMMAND_LITERAL_AUTHORITY_FILES)).toBe(true);
    expect(offenders).toEqual([]);
  });
});
