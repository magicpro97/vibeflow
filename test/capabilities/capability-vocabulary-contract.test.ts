import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import * as ts from "typescript";
import { HOST_ACTION_KIND_VALUES } from "../../src/actions/host-action-contract.js";
import {
  ACTION_PRODUCER_REQUEST_BINDING_KINDS,
  ACTION_ROOT_LOCATOR_KINDS,
} from "../../src/actions/protocol-contract.js";
import type { CapabilityScope as ActionCapabilityScope } from "../../src/actions/types.js";
import {
  CAPABILITY_RUNTIME_ERROR_CODE,
  CAPABILITY_RUNTIME_ERROR_CODE_BY_REFUSAL_REASON,
  runtimeCodeForRefusal,
} from "../../src/capabilities/operations/errors.js";
import type { CapabilityLockV1 } from "../../src/capabilities/wire/lock.js";
import {
  CAPABILITY_PRE_EFFECT_REFUSAL_REASONS,
  type CapabilityOperationV1,
} from "../../src/capabilities/wire/operation.js";
import type {
  CapabilityQuerySourceV1,
  CapabilityStatusV1 as QueryCapabilityStatusV1,
} from "../../src/capabilities/wire/query.js";
import {
  CAPABILITY_PLAN_STATUS,
  CAPABILITY_PLAN_STATUSES,
  CAPABILITY_RUNTIME_ERROR_CODES,
  CAPABILITY_SCOPE,
  CAPABILITY_SCOPES,
  CAPABILITY_STATUS,
  CAPABILITY_STATUSES,
  type CapabilityRuntimeErrorCodeV1,
  type CapabilityScope,
  type CapabilityStatusV1,
  isCapabilityPlanStatus,
  isCapabilityRuntimeErrorCode,
  isCapabilityScope,
  isCapabilityStatus,
} from "../../src/core/capability-contract.js";

type Same<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;

const exactTypeParity = Object.freeze({
  ACTION_SCOPE: true satisfies Same<ActionCapabilityScope, CapabilityScope>,
  OPERATION_SCOPE: true satisfies Same<CapabilityOperationV1["scope"], CapabilityScope>,
  LOCK_SCOPE: true satisfies Same<CapabilityLockV1["scope"], CapabilityScope>,
  QUERY_SCOPE: true satisfies Same<CapabilityQuerySourceV1["scope"], CapabilityScope>,
  QUERY_STATUS: true satisfies Same<QueryCapabilityStatusV1, CapabilityStatusV1>,
});

const source = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");

const productionSources = (roots: readonly string[]): string[] => {
  const paths: string[] = [];
  const visit = (path: string): void => {
    if (path.endsWith(".ts")) {
      paths.push(path);
      return;
    }
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name.endsWith(".ts")) paths.push(child);
    }
  };
  for (const root of roots) visit(resolve(process.cwd(), root));
  return paths.sort();
};

const capabilityProductionSources = (): string[] =>
  productionSources([
    "src/capabilities",
    "src/commands/capability",
    "src/commands/capability.ts",
    "src/server/conversation-legacy-adopt-route.ts",
  ]);

const capabilityFabricSources = (): string[] => productionSources(["src/capabilities"]);

const capabilityCliBoundarySources = (): string[] =>
  productionSources(["src/commands/capability", "src/commands/capability.ts"]);

const rawCapabilityVocabularyConsumers = (path: string): string[] => {
  const text = readFileSync(path, "utf8");
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const knownValues = new Set<string>([
    ...CAPABILITY_RUNTIME_ERROR_CODES,
    ...CAPABILITY_PLAN_STATUSES,
  ]);
  const offenders: string[] = [];
  const record = (literal: ts.StringLiteral): void => {
    const location = file.getLineAndCharacterOfPosition(literal.getStart(file));
    offenders.push(`${relative(process.cwd(), path)}:${location.line + 1}:${literal.text}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) && knownValues.has(node.text)) record(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return offenders;
};

const rawActionRootDiscriminantConsumers = (path: string): string[] => {
  const text = readFileSync(path, "utf8");
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const knownValues = new Set<string>([
    ...ACTION_ROOT_LOCATOR_KINDS,
    ...ACTION_PRODUCER_REQUEST_BINDING_KINDS,
  ]);
  const offenders: string[] = [];
  const knownLiteral = (node: ts.Node | undefined): node is ts.StringLiteral =>
    node !== undefined && ts.isStringLiteral(node) && knownValues.has(node.text);
  const namedKind = (node: ts.Node): boolean =>
    (ts.isIdentifier(node) && node.text === "kind") ||
    (ts.isStringLiteral(node) && node.text === "kind");
  const kindReference = (node: ts.Node): boolean =>
    (ts.isPropertyAccessExpression(node) && node.name.text === "kind") ||
    (ts.isElementAccessExpression(node) &&
      node.argumentExpression !== undefined &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === "kind");
  const record = (literal: ts.StringLiteral): void => {
    const location = file.getLineAndCharacterOfPosition(literal.getStart(file));
    offenders.push(`${relative(process.cwd(), path)}:${location.line + 1}:${literal.text}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && namedKind(node.name) && knownLiteral(node.initializer))
      record(node.initializer);
    if (
      ts.isPropertySignature(node) &&
      namedKind(node.name) &&
      node.type !== undefined &&
      ts.isLiteralTypeNode(node.type) &&
      knownLiteral(node.type.literal)
    )
      record(node.type.literal);
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ].includes(node.operatorToken.kind)
    ) {
      if (kindReference(node.left) && knownLiteral(node.right)) record(node.right);
      if (kindReference(node.right) && knownLiteral(node.left)) record(node.left);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return offenders;
};

const rawCapabilityScopeConsumers = (path: string): string[] => {
  const text = readFileSync(path, "utf8");
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const knownValues = new Set<string>(CAPABILITY_SCOPES);
  const comparisonKinds = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ]);
  const offenders: string[] = [];
  const rawString = (node: ts.Node | undefined): string | null => {
    if (node === undefined) return null;
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return node.literal.text;
    if (
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isParenthesizedExpression(node)
    )
      return rawString(node.expression);
    return null;
  };
  const named = (node: ts.Node, name: string): boolean =>
    (ts.isIdentifier(node) && node.text === name) ||
    (ts.isStringLiteral(node) && node.text === name);
  const scopeReference = (node: ts.Node): boolean =>
    (ts.isIdentifier(node) && node.text === "scope") ||
    (ts.isPropertyAccessExpression(node) && node.name.text === "scope") ||
    (ts.isElementAccessExpression(node) &&
      node.argumentExpression !== undefined &&
      named(node.argumentExpression, "scope"));
  const record = (node: ts.Node, reason: string): void => {
    const location = file.getLineAndCharacterOfPosition(node.getStart(file));
    offenders.push(`${relative(process.cwd(), path)}:${location.line + 1}:${reason}`);
  };
  const completeScopeSet = (nodes: readonly ts.Node[]): boolean => {
    const values = nodes.map(rawString);
    return (
      values.length === CAPABILITY_SCOPES.length &&
      new Set(values).size === CAPABILITY_SCOPES.length &&
      values.every((value) => value !== null && knownValues.has(value))
    );
  };
  const visit = (node: ts.Node): void => {
    if (ts.isUnionTypeNode(node) && completeScopeSet(node.types))
      record(node, "handwritten-scope-union");
    if (ts.isArrayLiteralExpression(node) && completeScopeSet(node.elements))
      record(node, "handwritten-scope-list");
    if (ts.isBinaryExpression(node) && comparisonKinds.has(node.operatorToken.kind)) {
      if (knownValues.has(rawString(node.left) ?? "") && scopeReference(node.right))
        record(node.left, "raw-scope-comparison");
      if (knownValues.has(rawString(node.right) ?? "") && scopeReference(node.left))
        record(node.right, "raw-scope-comparison");
    }
    if (
      ts.isPropertyAssignment(node) &&
      named(node.name, "scope") &&
      knownValues.has(rawString(node.initializer) ?? "")
    )
      record(node.initializer, "raw-scope-assignment");
    if (
      ts.isParameter(node) &&
      named(node.name, "scope") &&
      knownValues.has(rawString(node.initializer) ?? "")
    )
      record(node.initializer as ts.Expression, "raw-scope-default");
    ts.forEachChild(node, visit);
  };
  visit(file);
  return offenders;
};

const rawCapabilityActionAuthorityConsumers = (path: string): string[] => {
  const text = readFileSync(path, "utf8");
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const rootKinds = new Set<string>(ACTION_ROOT_LOCATOR_KINDS);
  const producerKinds = new Set<string>(ACTION_PRODUCER_REQUEST_BINDING_KINDS);
  const rootShape = new Set([
    "root_session_id",
    "scope_identity_digest",
    "bootstrap_identity_digest",
  ]);
  const positions = new Set<number>();
  const offenders: string[] = [];
  const raw = (node: ts.Node | undefined): ts.StringLiteral | null => {
    if (node === undefined) return null;
    if (ts.isStringLiteral(node)) return node;
    if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return node.literal;
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) return raw(node.expression);
    return null;
  };
  const name = (node: ts.Node): string | null =>
    ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : null;
  const record = (literal: ts.StringLiteral): void => {
    if (positions.has(literal.getStart(file))) return;
    positions.add(literal.getStart(file));
    const location = file.getLineAndCharacterOfPosition(literal.getStart(file));
    offenders.push(`${relative(process.cwd(), path)}:${location.line + 1}:${literal.text}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node) || ts.isTypeLiteralNode(node)) {
      const members = ts.isObjectLiteralExpression(node) ? node.properties : node.members;
      const names = new Set(
        members.flatMap((member) => ("name" in member && member.name ? [name(member.name)] : [])),
      );
      for (const member of members) {
        if (!("name" in member) || !member.name || name(member.name) !== "kind") continue;
        const literal = ts.isPropertyAssignment(member)
          ? raw(member.initializer)
          : ts.isPropertySignature(member)
            ? raw(member.type)
            : null;
        if (
          literal &&
          (producerKinds.has(literal.text) ||
            (rootKinds.has(literal.text) && [...rootShape].some((field) => names.has(field))))
        )
          record(literal);
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ].includes(node.operatorToken.kind)
    ) {
      const candidates: Array<[ts.Expression, ts.Expression]> = [
        [node.left, node.right],
        [node.right, node.left],
      ];
      for (const [reference, value] of candidates) {
        const literal = raw(value);
        const receiver =
          ts.isPropertyAccessExpression(reference) && reference.name.text === "kind"
            ? reference.expression
            : ts.isElementAccessExpression(reference) &&
                name(reference.argumentExpression) === "kind"
              ? reference.expression
              : null;
        if (
          literal &&
          receiver &&
          ((rootKinds.has(literal.text) &&
            /(?:action[_A-Z]?root|locator)/u.test(receiver.getText(file))) ||
            producerKinds.has(literal.text))
        )
          record(literal);
      }
    }
    if (
      ts.isLiteralTypeNode(node) &&
      ts.isStringLiteral(node.literal) &&
      rootKinds.has(node.literal.text)
    ) {
      let ancestor: ts.Node | undefined = node.parent;
      for (let depth = 0; ancestor && depth < 6; depth++, ancestor = ancestor.parent) {
        if (
          ts.isTypeReferenceNode(ancestor) &&
          /PrivateActionRootLocatorV1/u.test(ancestor.getText(file))
        ) {
          record(node.literal);
          break;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return offenders;
};

const rawCapabilityHostActionConsumers = (path: string): string[] => {
  const text = readFileSync(path, "utf8");
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const knownKinds = new Set<string>(HOST_ACTION_KIND_VALUES);
  const comparisonKinds = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ]);
  const positions = new Set<number>();
  const offenders: string[] = [];
  const raw = (node: ts.Node | undefined): ts.StringLiteral | null => {
    if (node === undefined) return null;
    if (ts.isStringLiteral(node)) return node;
    if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return node.literal;
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) return raw(node.expression);
    return null;
  };
  const name = (node: ts.Node): string | null =>
    ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : null;
  const actionTypeReference = (node: ts.Node): boolean =>
    (ts.isIdentifier(node) && ["type", "actionType"].includes(node.text)) ||
    (ts.isPropertyAccessExpression(node) && node.name.text === "type") ||
    (ts.isElementAccessExpression(node) && name(node.argumentExpression) === "type");
  const record = (literal: ts.StringLiteral): void => {
    if (positions.has(literal.getStart(file))) return;
    positions.add(literal.getStart(file));
    const location = file.getLineAndCharacterOfPosition(literal.getStart(file));
    offenders.push(`${relative(process.cwd(), path)}:${location.line + 1}:${literal.text}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && name(node.name) === "type") {
      const literal = raw(node.initializer);
      if (literal && knownKinds.has(literal.text)) record(literal);
    }
    if (ts.isPropertySignature(node) && name(node.name) === "type") {
      const literal = raw(node.type);
      if (literal && knownKinds.has(literal.text)) record(literal);
    }
    if (ts.isCaseClause(node)) {
      const literal = raw(node.expression);
      const statement = node.parent.parent;
      if (
        literal &&
        knownKinds.has(literal.text) &&
        ts.isSwitchStatement(statement) &&
        actionTypeReference(statement.expression)
      )
        record(literal);
    }
    if (ts.isBinaryExpression(node) && comparisonKinds.has(node.operatorToken.kind)) {
      const pairs: Array<[ts.Expression, ts.Expression]> = [
        [node.left, node.right],
        [node.right, node.left],
      ];
      for (const [reference, value] of pairs) {
        const literal = raw(value);
        if (literal && knownKinds.has(literal.text) && actionTypeReference(reference))
          record(literal);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return offenders;
};

const moduleSpecifiers = (text: string): string[] =>
  [...text.matchAll(/(?:\bfrom\s+|^\s*import\s+|\bimport\s*\(\s*)"([^"]+)"/gmu)].map(
    (match) => match[1] ?? "",
  );

describe("capability vocabulary contract", () => {
  test("freezes scope and query-status runtime authorities with derived guards", () => {
    expect(CAPABILITY_SCOPES).toEqual(["project", "user"]);
    expect(CAPABILITY_STATUSES).toEqual([
      "absent",
      "ready",
      "degraded",
      "blocked",
      "failed",
      "unknown",
      "stale",
      "drifted",
      "orphaned",
      "unmanaged",
      "manual",
      "unsupported",
      "needs-recovery",
    ]);
    expect(Object.values(CAPABILITY_SCOPE)).toEqual([...CAPABILITY_SCOPES]);
    expect(Object.values(CAPABILITY_STATUS)).toEqual([...CAPABILITY_STATUSES]);
    for (const value of [
      CAPABILITY_SCOPE,
      CAPABILITY_SCOPES,
      CAPABILITY_STATUS,
      CAPABILITY_STATUSES,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    for (const value of CAPABILITY_SCOPES) expect(isCapabilityScope(value)).toBe(true);
    for (const value of CAPABILITY_STATUSES) expect(isCapabilityStatus(value)).toBe(true);
    expect(isCapabilityScope("workspace")).toBe(false);
    expect(isCapabilityStatus("installed")).toBe(false);
    expect(Object.values(exactTypeParity).every(Boolean)).toBe(true);
  });

  test("binds every refusal reason to the frozen runtime-error vocabulary", () => {
    expect(CAPABILITY_RUNTIME_ERROR_CODES).toEqual(Object.values(CAPABILITY_RUNTIME_ERROR_CODE));
    expect(Object.isFrozen(CAPABILITY_RUNTIME_ERROR_CODE)).toBe(true);
    expect(Object.isFrozen(CAPABILITY_RUNTIME_ERROR_CODES)).toBe(true);
    expect(Object.isFrozen(CAPABILITY_RUNTIME_ERROR_CODE_BY_REFUSAL_REASON)).toBe(true);
    expect(Object.keys(CAPABILITY_RUNTIME_ERROR_CODE_BY_REFUSAL_REASON).sort()).toEqual(
      [...CAPABILITY_PRE_EFFECT_REFUSAL_REASONS].sort(),
    );
    for (const reason of CAPABILITY_PRE_EFFECT_REFUSAL_REASONS) {
      const code: CapabilityRuntimeErrorCodeV1 = runtimeCodeForRefusal(reason);
      expect(code).toBe(reason);
      expect(isCapabilityRuntimeErrorCode(code)).toBe(true);
    }
    expect(isCapabilityRuntimeErrorCode("unknown-runtime-error")).toBe(false);
  });

  test("binds plan statuses to one frozen runtime authority", () => {
    expect(CAPABILITY_PLAN_STATUSES).toEqual(Object.values(CAPABILITY_PLAN_STATUS));
    expect(Object.isFrozen(CAPABILITY_PLAN_STATUS)).toBe(true);
    expect(Object.isFrozen(CAPABILITY_PLAN_STATUSES)).toBe(true);
    for (const value of CAPABILITY_PLAN_STATUSES) expect(isCapabilityPlanStatus(value)).toBe(true);
    expect(isCapabilityPlanStatus("prepared")).toBe(false);
  });

  test("keeps capability runtime-error and plan consumers on the shared authorities", () => {
    expect(capabilityProductionSources().flatMap(rawCapabilityVocabularyConsumers)).toEqual([]);
  });

  test("keeps every capability-fabric scope consumer on the shared runtime authority", () => {
    expect(capabilityFabricSources().flatMap(rawCapabilityScopeConsumers)).toEqual([]);
  });

  test("keeps capability action roots and producer bindings on shared authorities", () => {
    expect(capabilityFabricSources().flatMap(rawCapabilityActionAuthorityConsumers)).toEqual([]);
  });

  test("keeps capability host-action discriminants on the shared runtime authority", () => {
    expect(capabilityFabricSources().flatMap(rawCapabilityHostActionConsumers)).toEqual([]);
  });

  test("keeps CLI root locators and producer bindings on the action authorities", () => {
    expect(capabilityCliBoundarySources().flatMap(rawActionRootDiscriminantConsumers)).toEqual([]);
  });

  test("keeps the authority dependency-free and consumers free of competing declarations", () => {
    const contract = source("src/core/capability-contract.ts");
    expect(moduleSpecifiers(contract)).toEqual([]);

    const scopeConsumers = [
      "src/actions/types.ts",
      "src/actions/validation.ts",
      "src/actions/internal-candidate-validation.ts",
      "src/actions/proposal-content-validation.ts",
      "src/capabilities/wire/operation.ts",
      "src/capabilities/wire/lock.ts",
      "src/capabilities/storage/lock-validation.ts",
      "src/capabilities/operations/errors.ts",
      "src/capabilities/action-domain/preview.ts",
      "src/capabilities/wire/query.ts",
      "src/server/capability-route.ts",
    ];
    for (const path of scopeConsumers) expect(source(path)).toContain("capability-contract");

    expect(source("src/actions/types.ts")).not.toContain(
      'export type CapabilityScope = "project" | "user"',
    );
    expect(source("src/capabilities/wire/query.ts")).not.toMatch(
      /export type CapabilityStatusV1\s*=/u,
    );
    expect(source("src/capabilities/operations/errors.ts")).not.toMatch(
      /export type CapabilityRuntimeErrorCodeV1\s*=/u,
    );
    expect(source("src/capabilities/action-domain/preview.ts")).toContain(
      "PUBLIC_RECOVERY_ACTIONS",
    );
  });
});
