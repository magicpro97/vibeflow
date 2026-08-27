import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import * as ts from "typescript";
import { toRoleSpec } from "../src/agents/role-loader.js";
import type {
  RoleModel as AgentRoleModel,
  RoleSandbox as AgentRoleSandbox,
  ToolIntent as AgentToolIntent,
  RoleSpec,
} from "../src/agents/role.js";
import {
  ROLE_FRONTMATTER_FIELD,
  ROLE_FRONTMATTER_FIELDS,
  ROLE_MODEL,
  ROLE_MODELS,
  ROLE_MUTATING_TOOL_INTENTS,
  ROLE_READ_ONLY_TOOL_INTENTS,
  ROLE_SANDBOX,
  ROLE_SANDBOXES,
  ROLE_TOOL_INTENT,
  ROLE_TOOL_INTENTS,
  ROLE_WORKFLOW_TOOL_INTENTS,
  type RoleModel,
  type RoleSandbox,
  type ToolIntent,
  isMutatingRoleToolIntent,
  isRoleFrontmatterField,
  isRoleFrontmatterRecord,
  isRoleModel,
  isRoleSandbox,
  isRoleToolIntent,
} from "../src/core/role-contract.js";
import {
  CONVERSATION_SANDBOX,
  CONVERSATION_SANDBOXES,
  CONVERSATION_TOOL_INTENT,
  CONVERSATION_TOOL_INTENTS,
  type ConversationSandboxV1,
  type ConversationToolIntentV1,
} from "../src/orchestrator/conversation/conversation-public-wire-contract.js";

type Same<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;

const typeParity = Object.freeze({
  AGENT_TOOL: true satisfies Same<AgentToolIntent, ToolIntent>,
  AGENT_MODEL: true satisfies Same<AgentRoleModel, RoleModel>,
  AGENT_SANDBOX: true satisfies Same<AgentRoleSandbox, RoleSandbox>,
  ROLE_SPEC_TOOL: true satisfies Same<RoleSpec["tools"][number], ToolIntent>,
  ROLE_SPEC_MODEL: true satisfies Same<RoleSpec["model"], RoleModel>,
  ROLE_SPEC_SANDBOX: true satisfies Same<NonNullable<RoleSpec["sandbox"]>, RoleSandbox>,
  CONVERSATION_TOOL: true satisfies Same<ConversationToolIntentV1, ToolIntent>,
  CONVERSATION_SANDBOX: true satisfies Same<ConversationSandboxV1, RoleSandbox>,
});

const AUTHORITY_PATH = resolve("src/core/role-contract.ts");
const productionSources = (): string[] => {
  const paths: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (
        /\.tsx?$/u.test(entry.name) &&
        !/[/\\]test[/\\]|\.test\.tsx?$/u.test(child) &&
        resolve(child) !== AUTHORITY_PATH
      )
        paths.push(child);
    }
  };
  visit(resolve("src"));
  return paths.sort();
};

const literal = (node: ts.Node | undefined): ts.StringLiteral | null => {
  if (!node) return null;
  if (ts.isStringLiteral(node)) return node;
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return node.literal;
  if (
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
  )
    return literal(node.expression);
  return null;
};

const fieldName = (node: ts.Node | undefined): string | null => {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return null;
};

const setEquals = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean =>
  left.size === right.size && [...left].every((value) => right.has(value));

const rawRoleProtocol = (path: string): string[] => {
  const text = readFileSync(path, "utf8");
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const offenders: string[] = [];
  const seen = new Set<number>();
  const toolValues = new Set<string>(ROLE_TOOL_INTENTS);
  const modelValues = new Set<string>(ROLE_MODELS);
  const sandboxValues = new Set<string>(ROLE_SANDBOXES);
  const closedSets = [
    toolValues,
    modelValues,
    sandboxValues,
    new Set<string>(ROLE_MUTATING_TOOL_INTENTS),
    new Set<string>(ROLE_FRONTMATTER_FIELDS),
  ];
  const record = (node: ts.StringLiteral, reason: string): void => {
    const start = node.getStart(file);
    if (seen.has(start)) return;
    seen.add(start);
    const position = file.getLineAndCharacterOfPosition(start);
    offenders.push(`${relative(process.cwd(), path)}:${position.line + 1}:${reason}=${node.text}`);
  };
  const strings = (node: ts.ArrayLiteralExpression): ts.StringLiteral[] | null => {
    const values = node.elements.map(literal);
    return values.every((value): value is ts.StringLiteral => value !== null) ? values : null;
  };
  const inspectArray = (node: ts.ArrayLiteralExpression): void => {
    const values = strings(node);
    if (!values || values.length === 0) return;
    const set = new Set(values.map((value) => value.text));
    if (closedSets.some((authority) => setEquals(set, authority)))
      for (const value of values) record(value, "handwritten role vocabulary");
  };
  const inspectType = (node: ts.TypeAliasDeclaration): void => {
    if (
      !/^(?:ToolIntent|RoleModel|RoleSandbox|ConversationToolIntentV1|ConversationSandboxV1)$/u.test(
        node.name.text,
      )
    )
      return;
    const visit = (child: ts.Node): void => {
      const value = literal(child);
      if (
        value &&
        (toolValues.has(value.text) || modelValues.has(value.text) || sandboxValues.has(value.text))
      )
        record(value, `handwritten ${node.name.text}`);
      ts.forEachChild(child, visit);
    };
    visit(node.type);
  };
  const inspectField = (name: string | null, node: ts.Node | undefined): void => {
    const value = literal(node);
    if (!name || !value) return;
    if (name === "model" && modelValues.has(value.text)) record(value, "raw role model");
    if (name === "sandbox" && sandboxValues.has(value.text)) record(value, "raw role sandbox");
    if (name === "tools" && node && ts.isArrayLiteralExpression(node)) {
      const values = strings(node);
      if (values?.length && values.every((candidate) => toolValues.has(candidate.text)))
        for (const candidate of values) record(candidate, "raw role tools");
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node)) inspectType(node);
    if (ts.isArrayLiteralExpression(node)) inspectArray(node);
    if (ts.isPropertyAssignment(node)) inspectField(fieldName(node.name), node.initializer);
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ].includes(node.operatorToken.kind)
    ) {
      inspectField(fieldName(node.left), node.right);
      inspectField(fieldName(node.right), node.left);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return offenders;
};

describe("core role protocol authority", () => {
  test("freezes exact values, mutating/read-only/workflow subsets, and inferred parity", () => {
    expect(ROLE_TOOL_INTENTS).toEqual(["read", "write", "edit", "bash", "grep", "glob", "web"]);
    expect(ROLE_MUTATING_TOOL_INTENTS).toEqual(["write", "edit", "bash"]);
    expect(ROLE_READ_ONLY_TOOL_INTENTS).toEqual(["read", "grep", "glob", "web"]);
    expect(ROLE_WORKFLOW_TOOL_INTENTS).toEqual(["read", "write", "edit", "bash", "grep", "glob"]);
    expect(ROLE_MODELS).toEqual([
      "haiku",
      "sonnet",
      "opus",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
      "gpt-5.4-codex",
    ]);
    expect(ROLE_SANDBOXES).toEqual(["read-only", "workspace-write", "danger-full-access"]);
    expect(ROLE_FRONTMATTER_FIELDS).toEqual([
      "name",
      "description",
      "tools",
      "model",
      "sandbox",
      "extends",
    ]);
    for (const value of [
      ROLE_TOOL_INTENT,
      ROLE_TOOL_INTENTS,
      ROLE_MUTATING_TOOL_INTENTS,
      ROLE_READ_ONLY_TOOL_INTENTS,
      ROLE_WORKFLOW_TOOL_INTENTS,
      ROLE_MODEL,
      ROLE_MODELS,
      ROLE_SANDBOX,
      ROLE_SANDBOXES,
      ROLE_FRONTMATTER_FIELD,
      ROLE_FRONTMATTER_FIELDS,
      typeParity,
    ])
      expect(Object.isFrozen(value)).toBe(true);
  });

  test("keeps guards fail-closed for prototype names, hostile records, and inherited role data", () => {
    expect(ROLE_TOOL_INTENTS.every(isRoleToolIntent)).toBe(true);
    expect(ROLE_MODELS.every(isRoleModel)).toBe(true);
    expect(ROLE_SANDBOXES.every(isRoleSandbox)).toBe(true);
    expect(ROLE_MUTATING_TOOL_INTENTS.every(isMutatingRoleToolIntent)).toBe(true);
    expect(ROLE_FRONTMATTER_FIELDS.every(isRoleFrontmatterField)).toBe(true);
    for (const value of ["__proto__", "constructor", "toString", "", null, 1]) {
      expect(isRoleToolIntent(value)).toBe(false);
      expect(isRoleModel(value)).toBe(false);
      expect(isRoleSandbox(value)).toBe(false);
      expect(isRoleFrontmatterField(value)).toBe(false);
    }
    const nullPrototype = Object.assign(Object.create(null), {
      name: "legacy-role",
      tools: [ROLE_TOOL_INTENT.READ],
      model: ROLE_MODEL.SONNET,
    });
    expect(isRoleFrontmatterRecord(nullPrototype)).toBe(true);
    expect(isRoleFrontmatterRecord(Object.create({ name: "inherited" }))).toBe(false);
    expect(isRoleFrontmatterRecord({ name: "valid", constructor: "polluted" })).toBe(false);
    expect(
      isRoleFrontmatterRecord(
        new Proxy(
          {},
          {
            getPrototypeOf: () => {
              throw new Error("trap");
            },
          },
        ),
      ),
    ).toBe(false);
    expect(toRoleSpec(Object.create({ ...nullPrototype }))).toBeNull();
  });

  test("aliases the public conversation wire to the exact core objects and values", () => {
    expect(CONVERSATION_TOOL_INTENT).toBe(ROLE_TOOL_INTENT);
    expect(CONVERSATION_TOOL_INTENTS).toBe(ROLE_TOOL_INTENTS);
    expect(CONVERSATION_SANDBOX).toBe(ROLE_SANDBOX);
    expect(CONVERSATION_SANDBOXES).toBe(ROLE_SANDBOXES);
    expect(Object.values(typeParity).every(Boolean)).toBe(true);
  });

  test("keeps the authority browser-safe and scans every production TypeScript consumer", () => {
    const authority = readFileSync(AUTHORITY_PATH, "utf8");
    expect(authority).not.toMatch(/^\s*(?:import|export\s+\*)\b/mu);
    expect(authority).not.toMatch(/\bnode:|\bBuffer\b|\bprocess(?:\.|\b)/u);
    expect(productionSources().flatMap(rawRoleProtocol)).toEqual([]);
  });
});
