import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import * as ts from "typescript";
import {
  HOOK_DECISION,
  HOOK_ENFORCEMENT_MODE,
  HOOK_EVENT,
  RISK_LEVEL,
} from "../src/core/hook-contract.js";
import { LOG_CHANNEL, LOG_LEVEL } from "../src/core/log-contract.js";
import {
  SKILL_DOMAIN_ROLE,
  SKILL_FILESYSTEM_REQUIREMENT,
  SKILL_FRESHNESS,
  SKILL_MCP_TRANSPORT,
  SKILL_SCOPE,
  SKILL_SOURCE,
  SKILL_STATUS,
  SKILL_TYPE,
} from "../src/core/skill-contract.js";
import {
  ACCEPTANCE_PRIORITY,
  GATE_STATE,
  KNOWLEDGE_HEAVY_SOURCE,
  SECURITY_CONSENT,
  SECURITY_VERDICT,
  WORKFLOW_DASHBOARD_STATUS,
  WORK_UNIT_GATE,
  WORK_UNIT_RISK_CLASS,
  WORK_UNIT_STATUS,
} from "../src/core/workflow-contract.js";

const AUTHORITY_PATHS = new Set(
  [
    "src/core/hook-contract.ts",
    "src/core/log-contract.ts",
    "src/core/skill-contract.ts",
    "src/core/workflow-contract.ts",
  ].map((path) => resolve(path)),
);

const WORKFLOW_AUTHORITIES = [
  GATE_STATE,
  WORK_UNIT_STATUS,
  WORK_UNIT_RISK_CLASS,
  KNOWLEDGE_HEAVY_SOURCE,
  ACCEPTANCE_PRIORITY,
  SECURITY_CONSENT,
  SECURITY_VERDICT,
  WORK_UNIT_GATE,
  WORKFLOW_DASHBOARD_STATUS,
] as const;
const HOOK_AUTHORITIES = [HOOK_EVENT, HOOK_DECISION, RISK_LEVEL, HOOK_ENFORCEMENT_MODE] as const;
const LOG_AUTHORITIES = [LOG_CHANNEL, LOG_LEVEL] as const;
const SKILL_AUTHORITIES = [
  SKILL_STATUS,
  SKILL_SOURCE,
  SKILL_SCOPE,
  SKILL_TYPE,
  SKILL_FILESYSTEM_REQUIREMENT,
  SKILL_MCP_TRANSPORT,
  SKILL_DOMAIN_ROLE,
  SKILL_FRESHNESS,
] as const;

const values = (authority: Record<string, string>): ReadonlySet<string> =>
  new Set(Object.values(authority));

const namedTypes = new Map<string, ReadonlySet<string>>([
  ["GateState", values(GATE_STATE)],
  ["WorkUnitStatus", values(WORK_UNIT_STATUS)],
  ["RiskClass", values(WORK_UNIT_RISK_CLASS)],
  ["WorkUnitRiskClass", values(WORK_UNIT_RISK_CLASS)],
  ["KnowledgeHeavySource", values(KNOWLEDGE_HEAVY_SOURCE)],
  ["AcceptancePriority", values(ACCEPTANCE_PRIORITY)],
  ["SecurityConsent", values(SECURITY_CONSENT)],
  ["SecurityVerdict", values(SECURITY_VERDICT)],
  ["HookEvent", values(HOOK_EVENT)],
  ["HookDecision", values(HOOK_DECISION)],
  ["RiskLevel", values(RISK_LEVEL)],
  ["HookEnforcementMode", values(HOOK_ENFORCEMENT_MODE)],
  ["Channel", values(LOG_CHANNEL)],
  ["LogChannel", values(LOG_CHANNEL)],
  ["LogLevel", values(LOG_LEVEL)],
  ["SkillScope", values(SKILL_SCOPE)],
  ["SkillStatus", values(SKILL_STATUS)],
  ["SkillSource", values(SKILL_SOURCE)],
  ["SkillType", values(SKILL_TYPE)],
  ["SkillFilesystemRequirement", values(SKILL_FILESYSTEM_REQUIREMENT)],
  ["SkillMcpTransport", values(SKILL_MCP_TRANSPORT)],
  ["SkillDomainRole", values(SKILL_DOMAIN_ROLE)],
  ["SkillFreshness", values(SKILL_FRESHNESS)],
]);

const productionSources = (vue = false): string[] => {
  const paths: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory() && !["node_modules", "test"].includes(entry.name)) visit(child);
      else if (
        (vue ? entry.name.endsWith(".vue") : /\.(?:tsx?|m?js)$/u.test(entry.name)) &&
        !/[/\\]test[/\\]|\.test\.(?:tsx?|m?js)$/u.test(child) &&
        // Vendored browser bundles are upstream artifacts, not editable production consumers.
        !/[/\\]assets[/\\]/u.test(child) &&
        !AUTHORITY_PATHS.has(child)
      )
        paths.push(child);
    }
  };
  visit(resolve("src"));
  return paths.sort();
};

const escapedAlternation = (values: readonly string[]): string =>
  values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|");

const rawVueTemplateConsumers = (path: string): string[] => {
  const text = readFileSync(path, "utf8");
  const relativePath = relative(process.cwd(), path).replaceAll("\\", "/");
  const patterns: RegExp[] = [];
  if (/\/(?:WorkUnit|Workflow)[^/]*\.vue$/u.test(relativePath)) {
    patterns.push(
      new RegExp(
        `\\.\\s*status\\s*(?:===|!==|==|!=|\\?\\?)\\s*(["'])(${escapedAlternation(Object.values(WORK_UNIT_STATUS))})\\1`,
        "gu",
      ),
      new RegExp(
        `(?:\\.\\s*(?:build|lint|test|review|security|goal_eval)|\\bgate)\\s*(?:===|!==|==|!=|\\?\\?)\\s*(["'])(${escapedAlternation(Object.values(GATE_STATE))})\\1`,
        "gu",
      ),
    );
  }
  if (/\/(?:Skill|Stage1Describe)[^/]*\.vue$/u.test(relativePath))
    patterns.push(
      new RegExp(
        `\\.\\s*status\\s*(?:===|!==|==|!=|\\?\\?)\\s*(["'])(${escapedAlternation(Object.values(SKILL_STATUS))})\\1`,
        "gu",
      ),
    );
  if (/\/Hook[^/]*\.vue$/u.test(relativePath))
    patterns.push(
      new RegExp(
        `\\.\\s*risk\\s*(?:===|!==|==|!=|\\?\\?)\\s*(["'])(${escapedAlternation(Object.values(RISK_LEVEL))})\\1`,
        "gu",
      ),
    );
  return patterns.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => {
      const line = text.slice(0, match.index).split("\n").length;
      return `${relative(process.cwd(), path)}:${line}:raw Vue protocol consumer=${match[2]}`;
    }),
  );
};

const literal = (node: ts.Node | undefined): ts.StringLiteral | null => {
  if (!node) return null;
  if (ts.isStringLiteral(node)) return node;
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return node.literal;
  if (
    ts.isAsExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    return literal(node.expression);
  return null;
};

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

const rawAuthorityDeclarations = (
  path: string,
  source = readFileSync(path, "utf8"),
  lineOffset = 0,
): string[] => {
  const text = source;
  const scriptKind = path.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : /\.m?js$/u.test(path)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind);
  const offenders: string[] = [];
  const activeVocabularies: Array<ReadonlySet<string>> = [];
  const activate = (authorities: readonly Record<string, string>[]): void => {
    for (const authority of authorities) activeVocabularies.push(values(authority));
  };
  const recorded = new Set<number>();
  const record = (node: ts.Node, value: string, reason: string): void => {
    const start = node.getStart(file);
    if (recorded.has(start)) return;
    recorded.add(start);
    const pos = file.getLineAndCharacterOfPosition(start);
    offenders.push(
      `${relative(process.cwd(), path)}:${pos.line + lineOffset + 1}:${reason}=${value}`,
    );
  };
  const inspectNamedType = (node: ts.TypeAliasDeclaration): void => {
    const values = namedTypes.get(node.name.text);
    if (!values) return;
    const visit = (child: ts.Node): void => {
      const value = literal(child);
      if (value && values.has(value.text)) record(value, value.text, node.name.text);
      ts.forEachChild(child, visit);
    };
    visit(node.type);
  };
  const inspectVocabularySubset = (node: ts.ArrayLiteralExpression): void => {
    const strings = node.elements
      .map(literal)
      .filter((value): value is ts.StringLiteral => value !== null);
    if (strings.length < 2 || strings.length !== node.elements.length) return;
    const found = new Set(strings.map((value) => value.text));
    for (const vocabulary of activeVocabularies) {
      if ([...found].every((value) => vocabulary.has(value))) {
        for (const value of strings) record(value, value.text, "handwritten vocabulary collection");
      }
    }
  };
  const inspectVocabularyMap = (node: ts.ObjectLiteralExpression): void => {
    const entries = node.properties.flatMap((property) => {
      if (!ts.isPropertyAssignment(property)) return [];
      const name = fieldName(property.name);
      return name ? [{ name, node: property.name }] : [];
    });
    if (entries.length < 2 || entries.length !== node.properties.length) return;
    const found = new Set(entries.map((entry) => entry.name));
    for (const vocabulary of activeVocabularies) {
      if ([...found].every((value) => vocabulary.has(value)))
        for (const entry of entries) record(entry.node, entry.name, "handwritten vocabulary map");
    }
  };
  const fields = new Map<string, ReadonlySet<string>>();
  const add = (names: readonly string[], authority: Record<string, string>): void => {
    for (const name of names)
      fields.set(name, new Set([...(fields.get(name) ?? []), ...Object.values(authority)]));
  };
  const relativePath = relative(process.cwd(), path).replaceAll("\\", "/");
  const workflowBearing =
    /src\/(?:ai-init|commands\/(?:dispatch|orchestrate|units)|ui\/src\/(?:components\/(?:WorkUnit|Workflow)|composables\/useWorkflow))/u.test(
      relativePath,
    ) ||
    /\b(?:AiInitUnit|DispatchMarker|UnitOutcome|WorkflowDashboardItem|WorkflowState|WorkUnit)\b/u.test(
      text,
    );
  if (text.includes("workflow-contract.js") || workflowBearing) {
    activate(WORKFLOW_AUTHORITIES);
    add(["riskClass"], WORK_UNIT_RISK_CLASS);
    add(["knowledge_heavy_source"], KNOWLEDGE_HEAVY_SOURCE);
    add(["priority"], ACCEPTANCE_PRIORITY);
    add(["consent"], SECURITY_CONSENT);
    add(["verdict"], SECURITY_VERDICT);
    add(["build", "lint", "test", "review", "security", "goal_eval"], GATE_STATE);
    if (workflowBearing) add(["status"], WORK_UNIT_STATUS);
  }
  const hookBearing =
    text.includes("hook-contract.js") ||
    /src\/(?:hooks|server\/pending-hooks|ui\/src\/components\/Hook|adapters\/engine-files)/u.test(
      relativePath,
    ) ||
    /\b(?:HookDecision|HookEvent|HookInput|HookResult|PendingHook|RiskLevel)\b/u.test(text);
  if (hookBearing) {
    activate(HOOK_AUTHORITIES);
    add(["event"], HOOK_EVENT);
    add(["decision", "enforcementLevel"], HOOK_DECISION);
    add(["risk", "maxRisk"], RISK_LEVEL);
    add(["preActionBlocking", "enforcementMode"], HOOK_ENFORCEMENT_MODE);
  }
  const logBearing =
    text.includes("log-contract.js") ||
    /src\/(?:logbus|commands\/init-ai|ui\/src\/(?:components\/(?:Log|WorkflowLog)|lib\/log-presentation))/u.test(
      relativePath,
    ) ||
    /\b(?:LogEvent|LogChannel|LogLevel)\b/u.test(text);
  if (logBearing) {
    activate(LOG_AUTHORITIES);
    add(["channel"], LOG_CHANNEL);
    add(["level"], LOG_LEVEL);
  }
  const skillBearing =
    text.includes("skill-contract.js") ||
    /src\/(?:skills|commands\/skills|ui\/src\/components\/(?:Skill|Stage1Describe))/u.test(
      relativePath,
    ) ||
    /\b(?:MarketplaceSkill|SafeSkill|SkillSource|SkillStatus)\b/u.test(text);
  if (skillBearing) {
    activate(SKILL_AUTHORITIES);
    add(["status"], SKILL_STATUS);
    add(["source"], SKILL_SOURCE);
    add(["scope"], SKILL_SCOPE);
    add(["type"], SKILL_TYPE);
    add(["filesystem"], SKILL_FILESYSTEM_REQUIREMENT);
    add(["transport"], SKILL_MCP_TRANSPORT);
    add(["role"], SKILL_DOMAIN_ROLE);
    add(["freshness"], SKILL_FRESHNESS);
  }
  const inspectField = (name: string | null, node: ts.Node | undefined): void => {
    if (!name || !node) return;
    const authority = fields.get(name);
    if (!authority) return;
    const inspect = (candidate: ts.Node): void => {
      const value = literal(candidate);
      if (value && authority.has(value.text)) record(value, value.text, `raw ${name} consumer`);
    };
    if (ts.isUnionTypeNode(node)) for (const candidate of node.types) inspect(candidate);
    else if (ts.isConditionalExpression(node)) {
      inspect(node.whenTrue);
      inspect(node.whenFalse);
    } else inspect(node);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node)) inspectNamedType(node);
    // Ordinary typed call arguments are values, not vocabulary declarations; their callee owns
    // validation. Template-literal adapter source is standalone generated code for the same reason.
    const ordinaryCallArgument =
      ts.isArrayLiteralExpression(node) &&
      ts.isCallExpression(node.parent) &&
      node.parent.expression.getText(file) !== "Object.freeze";
    if (ts.isArrayLiteralExpression(node) && !ordinaryCallArgument) inspectVocabularySubset(node);
    if (ts.isObjectLiteralExpression(node)) inspectVocabularyMap(node);
    if (ts.isNewExpression(node) && node.expression.getText(file) === "Set") {
      const first = node.arguments?.[0];
      if (first && ts.isArrayLiteralExpression(first)) inspectVocabularySubset(first);
    }
    if (ts.isPropertyAssignment(node)) inspectField(fieldName(node.name), node.initializer);
    if (ts.isPropertySignature(node)) inspectField(fieldName(node.name), node.type);
    if (ts.isParameter(node)) inspectField(fieldName(node.name), node.type);
    if (ts.isVariableDeclaration(node))
      inspectField(fieldName(node.name), node.initializer ?? node.type);
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.EqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ].includes(node.operatorToken.kind)
    ) {
      inspectField(fieldName(node.left), node.right);
      inspectField(fieldName(node.right), node.left);
    }
    if (ts.isCaseClause(node)) {
      const statement = node.parent.parent;
      if (ts.isSwitchStatement(statement))
        inspectField(fieldName(statement.expression), node.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return offenders;
};

const rawVueScriptConsumers = (path: string): string[] => {
  const text = readFileSync(path, "utf8");
  return [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gu)].flatMap((match) => {
    const source = match[1] ?? "";
    const lineOffset =
      text.slice(0, (match.index ?? 0) + match[0].indexOf(source)).split("\n").length - 1;
    return rawAuthorityDeclarations(path, source, lineOffset);
  });
};

describe("core protocol authority consumers", () => {
  test("scans every production root for redeclared closed vocabularies", () => {
    expect(productionSources().flatMap((path) => rawAuthorityDeclarations(path))).toEqual([]);
  });

  test("scans Vue templates and scripts for raw protocol consumers", () => {
    expect(
      productionSources(true).flatMap((path) => [
        ...rawVueTemplateConsumers(path),
        ...rawVueScriptConsumers(path),
      ]),
    ).toEqual([]);
  });
});
