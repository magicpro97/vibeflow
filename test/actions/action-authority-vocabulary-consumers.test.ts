import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import * as ts from "typescript";
import { HOST_ACTION_KIND_VALUES } from "../../src/actions/host-action-contract.js";
import {
  ACTION_AUTHORITY_BINDING_MODES,
  ACTION_CHALLENGE_CLASSES,
  ACTION_CONFIG_DIFF_MODE,
  ACTION_CONFIG_DIFF_MODES,
  ACTION_DECISIONS,
  ACTION_EFFECT_CLASSES,
  ACTION_EXPECTED_SOURCE_MODES,
  ACTION_HEALTH_PLAN_KINDS,
  ACTION_PACKAGE_PIN_SOURCE_KINDS,
  ACTION_PACKAGE_PIN_TRUST,
  ACTION_PERMISSION_CHANGES,
  ACTION_PERMISSION_ENFORCEMENT,
  ACTION_PLANNING_MODES,
  ACTION_PLANNING_NETWORK_READ,
  ACTION_RISKS,
  ACTION_SCOPES,
  ACTOR_KINDS,
  CREDENTIAL_CLASSES,
  PUBLIC_ACTION_SCHEMA_VERSION,
} from "../../src/actions/public-action-contract.js";
import {
  PUBLIC_ERROR_CODES,
  PUBLIC_RECOVERY_ACTIONS,
} from "../../src/actions/public-error-contract.js";
import {
  PUBLIC_ACTION_TARGET_APPLY_FAILURE,
  PUBLIC_ACTION_TARGET_HEALTH_FAILURE,
} from "../../src/actions/public-operation-contract.js";

const authorityConsumers = Object.freeze([
  "src/actions/authority-proofs.ts",
  "src/actions/store-read-validation.ts",
  "src/actions/store-rules.ts",
  "src/actions/store.ts",
  "src/capabilities/permissions/types.ts",
  "src/capabilities/cli/ports.ts",
  "src/commands/capability.ts",
  "src/commands/capability/mutation-port.ts",
  "src/actions/record-primitives.ts",
] as const);

const schemaConsumers = Object.freeze([
  "src/actions/authority-proofs.ts",
  "src/actions/challenge.ts",
  "src/actions/idempotency.ts",
  "src/actions/persistence-validation.ts",
  "src/actions/proposal-validation.ts",
  "src/actions/store-rules.ts",
  "src/actions/internal-candidate-validation.ts",
  "src/actions/permission-validation.ts",
  "src/actions/proposal-content-validation.ts",
  "src/actions/internal-repair-validation.ts",
  "src/actions/store-creation.ts",
  "src/actions/legacy-manifest-validation.ts",
] as const);

const publicErrorConsumers = Object.freeze([
  "src/actions/store-cancel.ts",
  "src/actions/store-dispatch.ts",
  "src/actions/store-transitions.ts",
  "src/actions/store-rules.ts",
  "src/actions/store.ts",
  "src/actions/proposal-request-validation.ts",
  "src/actions/validation.ts",
  "src/actions/wire-validation.ts",
  "src/server/conversation-action-route.ts",
  "src/server/conversation-artifact.ts",
  "src/server/conversation-legacy-adopt-route.ts",
  "src/actions/store-creation.ts",
  "src/actions/strict-json.ts",
  "src/orchestrator/conversation/catalog-timeline-cursor.ts",
  "src/orchestrator/conversation/timeline-service.ts",
  "src/orchestrator/conversation/capability-proposal-base.ts",
  "src/orchestrator/conversation/catalog-cursor.ts",
  "src/orchestrator/conversation/conversation-action-cursor.ts",
  "src/orchestrator/conversation/catalog-service-contract.ts",
  "src/orchestrator/conversation/lineage-service.ts",
  "src/orchestrator/conversation/conversation-user-message-authority.ts",
  "src/orchestrator/conversation/conversation-action-domain.ts",
  "src/orchestrator/conversation/revision-errors.ts",
  "src/orchestrator/conversation/handoff-selection.ts",
  "src/orchestrator/conversation/conversation-home-create-authority.ts",
  "src/server/conversation-head-route.ts",
  "src/server/conversation-reaction-route.ts",
  "src/server/conversation-browser-route.ts",
  "src/server/conversation-handoff-route.ts",
  "src/server/conversation-timeline-route.ts",
  "src/server/conversation-lineage-route.ts",
  "src/server/conversation-list-route.ts",
  "src/ui/src/conversation-home-pagination.ts",
  "src/ui/src/conversation-home-active-pagination.ts",
  "src/ui/src/conversation-home-capability-target-runtime.ts",
] as const);

const recoveryActionConsumers = Object.freeze([
  "src/capabilities/query/service.ts",
  "src/server/conversation-action-route.ts",
  "src/server/conversation-artifact.ts",
  "src/server/conversation-legacy-adopt-route.ts",
  "src/orchestrator/conversation/revision-errors.ts",
  "src/server/conversation-head-route.ts",
  "src/server/conversation-reaction-route.ts",
  "src/server/conversation-browser-route.ts",
  "src/server/conversation-handoff-route.ts",
  "src/server/conversation-timeline-route.ts",
  "src/server/conversation-lineage-route.ts",
  "src/server/conversation-list-route.ts",
] as const);

const hostActionConsumers = Object.freeze([
  "src/capabilities/source/durable-authority-transition-resolver.ts",
  "src/capabilities/wire/cli.ts",
  "src/commands/capability/mutation.ts",
  "src/actions/request-types.ts",
  "src/actions/validation.ts",
  "src/orchestrator/conversation/conversation-handoff-overflow.ts",
  "src/orchestrator/conversation/revision-publication-replay.ts",
  "src/orchestrator/conversation/conversation-receipt-native-plans.ts",
  "src/orchestrator/conversation/conversation-lineage-mutation-reservation-contract.ts",
  "src/ui/src/conversation-home-recovery.ts",
  "src/ui/src/conversation-home-command-runtime.ts",
] as const);

const planningConsumers = Object.freeze([
  "src/actions/proposal-validation.ts",
  "src/actions/idempotency.ts",
] as const);

const bindingModeConsumers = Object.freeze(["src/actions/authority-proofs.ts"] as const);

const packagePinConsumers = Object.freeze([
  "src/actions/internal-candidate-validation.ts",
  "src/actions/package-pin-validation.ts",
  "src/actions/proposal-content-validation.ts",
] as const);

const healthPlanConsumers = Object.freeze(["src/actions/legacy-component-validation.ts"] as const);

const permissionEnforcementConsumers = Object.freeze([
  "src/actions/permission-validation.ts",
  "src/actions/proposal-content-validation.ts",
] as const);

const expectedModeConsumers = Object.freeze([
  "src/actions/proposal-request-validation.ts",
] as const);

const proposalContentConsumers = Object.freeze([
  "src/actions/proposal-content-validation.ts",
] as const);

const repairConsumers = Object.freeze(["src/actions/internal-repair-validation.ts"] as const);

const targetFailureConsumers = Object.freeze([
  "src/actions/internal-candidate-validation.ts",
  "src/actions/proposal-content-validation.ts",
  "src/actions/legacy-manifest-validation.ts",
  "src/capabilities/legacy/inspection.ts",
  "src/capabilities/planning/component-target.ts",
  "src/capabilities/planning/orphan-planner.ts",
  "src/capabilities/operations/effect-runtime.ts",
] as const);

function rawLiterals(paths: readonly string[], forbiddenValues: readonly string[]): string[] {
  const forbidden = new Set(forbiddenValues);
  const offenders: string[] = [];
  for (const path of paths) {
    const absolute = resolve(path);
    const source = ts.createSourceFile(
      absolute,
      readFileSync(absolute, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        forbidden.has(node.text)
      ) {
        const location = source.getLineAndCharacterOfPosition(node.getStart(source));
        offenders.push(`${relative(process.cwd(), absolute)}:${location.line + 1}:${node.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return offenders;
}

function requireAuthority(paths: readonly string[], symbol: string): void {
  for (const path of paths)
    expect(readFileSync(resolve(path), "utf8"), `${path} consumes ${symbol}`).toContain(symbol);
}

describe("durable action authority vocabulary consumers", () => {
  test("actor, credential, challenge, and decision consumers do not redeclare wire values", () => {
    const authorityValues = [
      ...ACTOR_KINDS,
      ...CREDENTIAL_CLASSES,
      ...ACTION_CHALLENGE_CLASSES,
      ...ACTION_DECISIONS,
    ];
    expect(rawLiterals(authorityConsumers, authorityValues)).toEqual([]);
    requireAuthority(authorityConsumers.slice(0, 4), "ACTION_");
    requireAuthority(authorityConsumers.slice(5, 7), "ACTOR_KIND");
    expect(readFileSync(resolve(authorityConsumers[4]), "utf8")).toContain("CredentialClass");
    expect(readFileSync(resolve(authorityConsumers[7]), "utf8")).toContain("ACTION_DECISION");
    expect(readFileSync(resolve("src/actions/record-primitives.ts"), "utf8")).toContain(
      "ACTOR_KIND",
    );
    expect(readFileSync(resolve("src/actions/record-primitives.ts"), "utf8")).toContain(
      "CREDENTIAL_CLASS",
    );
  });

  test("action planning, pin, permission, and target policies stay on runtime authorities", () => {
    expect(
      rawLiterals(planningConsumers, [...ACTION_PLANNING_MODES, ...ACTION_PLANNING_NETWORK_READ]),
    ).toEqual([]);
    expect(rawLiterals(bindingModeConsumers, ACTION_AUTHORITY_BINDING_MODES)).toEqual([]);
    expect(
      rawLiterals(packagePinConsumers, [
        ...ACTION_PACKAGE_PIN_SOURCE_KINDS,
        ...ACTION_PACKAGE_PIN_TRUST,
      ]),
    ).toEqual([]);
    expect(rawLiterals(healthPlanConsumers, ACTION_HEALTH_PLAN_KINDS)).toEqual([]);
    expect(rawLiterals(permissionEnforcementConsumers, ACTION_PERMISSION_ENFORCEMENT)).toEqual([]);
    expect(rawLiterals(expectedModeConsumers, ACTION_EXPECTED_SOURCE_MODES)).toEqual([]);
    expect(
      rawLiterals(proposalContentConsumers, [
        ...ACTION_EFFECT_CLASSES,
        ...ACTION_RISKS,
        ...ACTION_PACKAGE_PIN_TRUST,
        ...ACTION_PERMISSION_CHANGES,
        ...ACTION_CONFIG_DIFF_MODES.filter((mode) => mode !== ACTION_CONFIG_DIFF_MODE.MANUAL),
      ]),
    ).toEqual([]);
    expect(rawLiterals(repairConsumers, [...ACTION_RISKS, ...ACTION_SCOPES])).toEqual([]);
    expect(
      rawLiterals(targetFailureConsumers, [
        ...Object.values(PUBLIC_ACTION_TARGET_APPLY_FAILURE),
        ...Object.values(PUBLIC_ACTION_TARGET_HEALTH_FAILURE),
      ]),
    ).toEqual([]);
    requireAuthority(planningConsumers, "ACTION_PLANNING_");
    requireAuthority(bindingModeConsumers, "ACTION_AUTHORITY_BINDING_MODE");
    requireAuthority(packagePinConsumers, "ACTION_PACKAGE_PIN_");
    requireAuthority(healthPlanConsumers, "LEGACY_SOURCE_HEALTH_PROBE_KIND");
    requireAuthority(permissionEnforcementConsumers, "ACTION_PERMISSION_ENFORCEMENT_VALUE");
    requireAuthority(expectedModeConsumers, "ACTION_EXPECTED_SOURCE_MODE");
    requireAuthority(repairConsumers, "ACTION_SCOPE");
    requireAuthority(targetFailureConsumers, "PUBLIC_ACTION_TARGET_");
    expect(readFileSync(resolve(proposalContentConsumers[0]), "utf8")).toContain(
      "ACTION_CONFIG_DIFF_MODE.MANUAL",
    );
  });

  test("durable action schema consumers use the public action version authority", () => {
    expect(rawLiterals(schemaConsumers, [PUBLIC_ACTION_SCHEMA_VERSION])).toEqual([]);
    requireAuthority(schemaConsumers, "PUBLIC_ACTION_SCHEMA_VERSION");
  });

  test("public error and recovery consumers use the shared runtime authorities", () => {
    expect(rawLiterals(publicErrorConsumers, PUBLIC_ERROR_CODES)).toEqual([]);
    expect(rawLiterals(recoveryActionConsumers, PUBLIC_RECOVERY_ACTIONS)).toEqual([]);
    requireAuthority(publicErrorConsumers, "PUBLIC_ERROR_CODE");
    requireAuthority(recoveryActionConsumers, "PUBLIC_RECOVERY_ACTION");
  });

  test("capability dispatch consumers do not redeclare host-action discriminants", () => {
    expect(rawLiterals(hostActionConsumers, HOST_ACTION_KIND_VALUES)).toEqual([]);
    requireAuthority(hostActionConsumers, "HOST_ACTION_KIND");
  });
});
