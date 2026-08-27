import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import * as ts from "typescript";
import { AGENT_ROLE_SOURCE } from "../src/core/agent-contract.js";
import { SKILL_SOURCE } from "../src/core/skill-contract.js";
import {
  DISPATCH_MODE,
  DISPATCH_MODES,
  ENGINE_ATTEMPT_START_OUTCOME,
  ENGINE_ATTEMPT_START_OUTCOMES,
  ENGINE_EVIDENCE_STATUS,
  ENGINE_ISOLATION_KIND,
  ENGINE_ISOLATION_KINDS,
  ENGINE_NATIVE_SESSION_STATUS,
  ENGINE_NATIVE_SESSION_STATUSES,
  ENGINE_OUTPUT_STREAM,
  ENGINE_OUTPUT_STREAMS,
  ENGINE_PROMPT_MODE,
  ENGINE_PROMPT_MODES,
  ENGINE_ROLE_SOURCE,
  ENGINE_ROLE_SOURCES,
  ENGINE_SESSION_MODE,
  ENGINE_SESSION_MODES,
  ENGINE_SESSION_PROTOCOL,
  ENGINE_SESSION_PROTOCOLS,
  isDispatchMode,
  isEngineAttemptStartOutcome,
  isEngineIsolationKind,
  isEngineNativeSessionStatus,
  isEngineOutputStream,
  isEnginePromptMode,
  isEngineRoleSource,
  isEngineSessionMode,
  isEngineSessionProtocol,
} from "../src/dispatch/session-contract.js";
import {
  RUNTIME_PLATFORM,
  RUNTIME_PLATFORMS,
} from "../src/durability/process-identity-contract.js";

const AUTHORITY_PATHS = new Set(
  [
    "src/core/agent-contract.ts",
    "src/core/skill-contract.ts",
    "src/dispatch/session-contract.ts",
    "src/durability/process-identity-contract.ts",
  ].map((path) => resolve(path)),
);

const productionSources = (): string[] => {
  const paths: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name.endsWith(".ts") && !AUTHORITY_PATHS.has(child))
        paths.push(child);
    }
  };
  visit(resolve("src"));
  return paths.sort();
};

const protocolFields = new Map<string, ReadonlySet<string>>([
  ["mode", new Set(Object.values(DISPATCH_MODE))],
  ["resolveMode", new Set(Object.values(DISPATCH_MODE))],
  ["dispatchMode", new Set(Object.values(DISPATCH_MODE))],
  ["promptMode", new Set(Object.values(ENGINE_PROMPT_MODE))],
  ["protocol", new Set(Object.values(ENGINE_SESSION_PROTOCOL))],
  ["stream", new Set(Object.values(ENGINE_OUTPUT_STREAM))],
  ["sessionMode", new Set(Object.values(ENGINE_SESSION_MODE))],
  ["session_mode", new Set(Object.values(ENGINE_SESSION_MODE))],
  ["kind", new Set(Object.values(ENGINE_ISOLATION_KIND))],
  ["roleSource", new Set(Object.values(ENGINE_ROLE_SOURCE))],
  ["role_source", new Set(Object.values(ENGINE_ROLE_SOURCE))],
  ["nativeSessionStatus", new Set(Object.values(ENGINE_NATIVE_SESSION_STATUS))],
  ["native_session_status", new Set(Object.values(ENGINE_NATIVE_SESSION_STATUS))],
  ["evidenceStatus", new Set(Object.values(ENGINE_EVIDENCE_STATUS))],
  ["evidence_status", new Set(Object.values(ENGINE_EVIDENCE_STATUS))],
  ["platform", new Set(Object.values(RUNTIME_PLATFORM))],
]);

const protocolTypeNames = new Map<string, ReadonlySet<string>>([
  ["DispatchMode", new Set(Object.values(DISPATCH_MODE))],
  ["EnginePromptMode", new Set(Object.values(ENGINE_PROMPT_MODE))],
  ["EngineSessionProtocol", new Set(Object.values(ENGINE_SESSION_PROTOCOL))],
  ["EngineOutputStream", new Set(Object.values(ENGINE_OUTPUT_STREAM))],
  ["SessionMode", new Set(Object.values(ENGINE_SESSION_MODE))],
  ["EngineSessionMode", new Set(Object.values(ENGINE_SESSION_MODE))],
  ["EngineIsolationKind", new Set(Object.values(ENGINE_ISOLATION_KIND))],
  ["EngineRoleSource", new Set(Object.values(ENGINE_ROLE_SOURCE))],
  ["EngineNativeSessionStatus", new Set(Object.values(ENGINE_NATIVE_SESSION_STATUS))],
  ["EngineAttemptStartOutcome", new Set(Object.values(ENGINE_ATTEMPT_START_OUTCOME))],
  ["RuntimePlatform", new Set(Object.values(RUNTIME_PLATFORM))],
]);

const fieldName = (node: ts.Node | undefined): string | null => {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    ts.isStringLiteral(node.argumentExpression)
  )
    return node.argumentExpression.text;
  return null;
};

const literal = (node: ts.Node | undefined): ts.StringLiteral | null => {
  if (!node) return null;
  if (ts.isStringLiteral(node)) return node;
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return node.literal;
  if (
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    return literal(node.expression);
  return null;
};

const rawProtocolConsumers = (path: string): string[] => {
  const text = readFileSync(path, "utf8");
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const offenders: string[] = [];
  const positions = new Set<number>();
  const record = (node: ts.StringLiteral, reason: string): void => {
    const position = node.getStart(file);
    if (positions.has(position)) return;
    positions.add(position);
    const location = file.getLineAndCharacterOfPosition(position);
    offenders.push(`${relative(process.cwd(), path)}:${location.line + 1}:${reason}=${node.text}`);
  };
  const matchesField = (name: string | null, node: ts.Node | undefined): void => {
    const value = literal(node);
    if (name && value && protocolFields.get(name)?.has(value.text)) record(value, name);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) matchesField(fieldName(node.name), node.initializer);
    if (ts.isPropertySignature(node)) matchesField(fieldName(node.name), node.type);
    if (ts.isPropertyDeclaration(node)) matchesField(fieldName(node.name), node.initializer);
    if (ts.isParameter(node)) matchesField(fieldName(node.name), node.initializer);
    if (ts.isVariableDeclaration(node)) matchesField(fieldName(node.name), node.initializer);

    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ].includes(node.operatorToken.kind)
    ) {
      matchesField(fieldName(node.left), node.right);
      matchesField(fieldName(node.right), node.left);
      for (const [reference, value] of [
        [node.left, node.right],
        [node.right, node.left],
      ] as const) {
        const raw = literal(value);
        if (
          raw &&
          Object.values(RUNTIME_PLATFORM).includes(raw.text as never) &&
          reference.getText(file) === "process.platform"
        )
          record(raw, "process.platform");
      }
    }

    if (ts.isCaseClause(node)) {
      const statement = node.parent.parent;
      if (ts.isSwitchStatement(statement)) {
        matchesField(fieldName(statement.expression), node.expression);
        const value = literal(node.expression);
        if (
          value &&
          Object.values(RUNTIME_PLATFORM).includes(value.text as never) &&
          statement.expression.getText(file) === "process.platform"
        )
          record(value, "process.platform");
      }
    }

    if (ts.isTypeAliasDeclaration(node)) {
      const values = protocolTypeNames.get(node.name.text);
      if (values) {
        const inspect = (child: ts.Node): void => {
          const value = literal(child);
          if (value && values.has(value.text)) record(value, node.name.text);
          ts.forEachChild(child, inspect);
        };
        inspect(node.type);
      }
    }

    if (text.includes("AttemptStartAuthority") && ts.isStringLiteral(node)) {
      const parent = node.parent;
      if (
        ts.isBinaryExpression(parent) &&
        fieldName(parent.left === node ? parent.right : parent.left) === "outcome" &&
        new Set(Object.values(ENGINE_ATTEMPT_START_OUTCOME)).has(node.text as never)
      )
        record(node, "AttemptStartAuthority.outcome");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return offenders;
};

describe("dispatch and session protocol authority", () => {
  test("freezes canonical values and derives all runtime guards", () => {
    const authorities = [
      DISPATCH_MODE,
      DISPATCH_MODES,
      ENGINE_PROMPT_MODE,
      ENGINE_PROMPT_MODES,
      ENGINE_SESSION_PROTOCOL,
      ENGINE_SESSION_PROTOCOLS,
      ENGINE_OUTPUT_STREAM,
      ENGINE_OUTPUT_STREAMS,
      ENGINE_SESSION_MODE,
      ENGINE_SESSION_MODES,
      ENGINE_ISOLATION_KIND,
      ENGINE_ISOLATION_KINDS,
      ENGINE_ROLE_SOURCE,
      ENGINE_ROLE_SOURCES,
      ENGINE_NATIVE_SESSION_STATUS,
      ENGINE_NATIVE_SESSION_STATUSES,
      ENGINE_EVIDENCE_STATUS,
      ENGINE_ATTEMPT_START_OUTCOME,
      ENGINE_ATTEMPT_START_OUTCOMES,
      RUNTIME_PLATFORM,
      RUNTIME_PLATFORMS,
    ];
    for (const authority of authorities) expect(Object.isFrozen(authority)).toBe(true);
    expect(ENGINE_ROLE_SOURCE).toBe(AGENT_ROLE_SOURCE);
    expect(SKILL_SOURCE.REPO).toBe(ENGINE_ROLE_SOURCE.REPO);

    const guards = [
      [isDispatchMode, DISPATCH_MODES],
      [isEnginePromptMode, ENGINE_PROMPT_MODES],
      [isEngineSessionProtocol, ENGINE_SESSION_PROTOCOLS],
      [isEngineOutputStream, ENGINE_OUTPUT_STREAMS],
      [isEngineSessionMode, ENGINE_SESSION_MODES],
      [isEngineIsolationKind, ENGINE_ISOLATION_KINDS],
      [isEngineRoleSource, ENGINE_ROLE_SOURCES],
      [isEngineNativeSessionStatus, ENGINE_NATIVE_SESSION_STATUSES],
      [isEngineAttemptStartOutcome, ENGINE_ATTEMPT_START_OUTCOMES],
    ] as const;
    for (const [guard, values] of guards) {
      for (const value of values) expect(guard(value)).toBe(true);
      for (const value of ["", "invented", null, 1, {}, "toString"])
        expect(guard(value)).toBe(false);
    }
  });

  test("rejects handwritten protocol literals in every production consumer", () => {
    expect(productionSources().flatMap(rawProtocolConsumers)).toEqual([]);
  });
});
