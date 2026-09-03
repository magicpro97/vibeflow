import * as ts from "typescript";
import { UI_HOOK_ROUTE } from "../../src/core/ui-cli-contract.js";
import { type SourceFixture, parseUiFixture, staticStringValues } from "./ui-lan-authority-ast.js";

export interface LanRouteAudit {
  readonly file: string;
  readonly route: string;
  readonly authority: "event-source" | "hook-fetch" | "loopback-hook";
  readonly guarded: boolean;
}

interface FunctionRecord {
  readonly body: ts.ConciseBody;
  readonly parameters: readonly (string | null)[];
}

interface GuardSpec {
  readonly name: string;
  readonly arguments: readonly string[];
}

const EVENT_SOURCE_GUARD = Object.freeze({
  name: "eventSourceGuarded",
  arguments: Object.freeze(["req", "url"]),
});
const HOOK_FETCH_GUARD = Object.freeze({
  name: "guarded",
  arguments: Object.freeze(["req"]),
});
const LOOPBACK_HOOK_GUARD = Object.freeze({
  name: "requestHasLoopbackAuthority",
  arguments: Object.freeze(["request"]),
});

function namedFunctions(fixtures: readonly SourceFixture[]): Map<string, FunctionRecord[]> {
  const functions = new Map<string, FunctionRecord[]>();
  const add = (
    name: string,
    body: ts.ConciseBody,
    parameters: ts.NodeArray<ts.ParameterDeclaration>,
  ): void => {
    functions.set(name, [
      ...(functions.get(name) ?? []),
      {
        body,
        parameters: parameters.map(({ name: parameter }) =>
          ts.isIdentifier(parameter) ? parameter.text : null,
        ),
      },
    ]);
  };
  for (const fixture of fixtures) {
    const parsed = parseUiFixture(fixture);
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name && node.body)
        add(node.name.text, node.body, node.parameters);
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      )
        add(node.name.text, node.initializer.body, node.initializer.parameters);
      ts.forEachChild(node, visit);
    };
    visit(parsed);
  }
  return functions;
}

function containsSse(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (ts.isStringLiteralLike(child) && /^text\/event-stream(?:;|$)/u.test(child.text))
      found = true;
    if (!found) ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function calledNames(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child) && ts.isIdentifier(child.expression))
      names.add(child.expression.text);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return names;
}

function summarizedSseFunctions(
  functions: ReadonlyMap<string, readonly FunctionRecord[]>,
): Set<string> {
  const summary = new Set<string>();
  for (const [name, records] of functions)
    if (records.some(({ body }) => containsSse(body))) summary.add(name);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, records] of functions)
      if (
        !summary.has(name) &&
        records.some(({ body }) => [...calledNames(body)].some((call) => summary.has(call)))
      ) {
        summary.add(name);
        changed = true;
      }
  }
  return summary;
}

function responseStatus403(expression: ts.Expression): boolean {
  const argumentsList =
    ts.isCallExpression(expression) || ts.isNewExpression(expression)
      ? expression.arguments
      : undefined;
  if (!argumentsList) return false;
  const isResponse =
    (ts.isCallExpression(expression) &&
      ts.isPropertyAccessExpression(expression.expression) &&
      ts.isIdentifier(expression.expression.expression) &&
      expression.expression.expression.text === "Response" &&
      expression.expression.name.text === "json") ||
    (ts.isNewExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === "Response");
  const options = argumentsList[1];
  if (!isResponse || !options || !ts.isObjectLiteralExpression(options)) return false;
  return options.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      property.name.getText().replaceAll(/["']/gu, "") === "status" &&
      property.initializer.getText() === "403",
  );
}

function firstStatement(node: ts.Statement | ts.ConciseBody): ts.Statement | null {
  if (ts.isBlock(node)) return node.statements[0] ?? null;
  return ts.isStatement(node) ? node : null;
}

function returnedExpression(node: ts.Statement | ts.ConciseBody): ts.Expression | null {
  const first = firstStatement(node);
  return first && ts.isReturnStatement(first) ? (first.expression ?? null) : null;
}

function forbiddenFunctions(
  functions: ReadonlyMap<string, readonly FunctionRecord[]>,
): Set<string> {
  const summary = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, records] of functions) {
      if (summary.has(name)) continue;
      const forbidden = records.some(({ body }) => {
        const expression = returnedExpression(body);
        return (
          expression !== null &&
          (responseStatus403(expression) ||
            (ts.isCallExpression(expression) &&
              ts.isIdentifier(expression.expression) &&
              summary.has(expression.expression.text)))
        );
      });
      if (forbidden) {
        summary.add(name);
        changed = true;
      }
    }
  }
  return summary;
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  )
    current = current.expression;
  return current;
}

function rebindGuard(
  call: ts.CallExpression,
  record: FunctionRecord,
  guard: GuardSpec,
): GuardSpec | null {
  const rebound: string[] = [];
  for (const expected of guard.arguments) {
    const index = call.arguments.findIndex((argument) => {
      const actual = unwrap(argument);
      return ts.isIdentifier(actual) && actual.text === expected;
    });
    const parameter = index < 0 ? null : (record.parameters[index] ?? null);
    if (!parameter) return null;
    rebound.push(parameter);
  }
  return Object.freeze({ name: guard.name, arguments: Object.freeze(rebound) });
}

function exactNegativeGuard(node: ts.Expression, guard: GuardSpec): boolean {
  const expression = unwrap(node);
  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isCallExpression(expression.operand) &&
    ts.isIdentifier(expression.operand.expression) &&
    expression.operand.expression.text === guard.name &&
    expression.operand.arguments.length === guard.arguments.length
  )
    return expression.operand.arguments.every(
      (argument, index) => ts.isIdentifier(argument) && argument.text === guard.arguments[index],
    );
  if (!ts.isBinaryExpression(expression)) return false;
  const conjunction = expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken;
  const disjunction = expression.operatorToken.kind === ts.SyntaxKind.BarBarToken;
  if (!conjunction && !disjunction) return false;
  const leftGuard = exactNegativeGuard(expression.left, guard);
  const rightGuard = exactNegativeGuard(expression.right, guard);
  if (disjunction) return leftGuard || rightGuard;
  const isLanQualifier = (candidate: ts.Expression): boolean => {
    const value = unwrap(candidate);
    return ts.isIdentifier(value) && value.text === "lanExposed";
  };
  return (
    (leftGuard && isLanQualifier(expression.right)) ||
    (rightGuard && isLanQualifier(expression.left))
  );
}

function returnsForbidden(statement: ts.Statement, functions: ReadonlySet<string>): boolean {
  const returned = ts.isBlock(statement) ? statement.statements[0] : statement;
  if (!returned || !ts.isReturnStatement(returned) || !returned.expression) return false;
  return (
    responseStatus403(returned.expression) ||
    (ts.isCallExpression(returned.expression) &&
      ts.isIdentifier(returned.expression.expression) &&
      functions.has(returned.expression.expression.text))
  );
}

function startsWithGuard(
  node: ts.Statement | ts.ConciseBody,
  guard: GuardSpec,
  functions: ReadonlyMap<string, readonly FunctionRecord[]>,
  forbidden: ReadonlySet<string>,
  seen = new Set<string>(),
): boolean {
  const first = firstStatement(node);
  if (!first) return false;
  if (ts.isIfStatement(first))
    return (
      exactNegativeGuard(first.expression, guard) &&
      returnsForbidden(first.thenStatement, forbidden)
    );
  const expression = returnedExpression(first);
  if (!expression || !ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression))
    return false;
  const name = expression.expression.text;
  if (seen.has(name)) return false;
  const next = new Set([...seen, name]);
  return (functions.get(name) ?? []).some((record) => {
    const rebound = rebindGuard(expression, record, guard);
    return rebound !== null && startsWithGuard(record.body, rebound, functions, forbidden, next);
  });
}

function enclosingFunctionBody(node: ts.Node): ts.ConciseBody | null {
  for (let parent = node.parent; parent; parent = parent.parent)
    if (ts.isFunctionLike(parent) && "body" in parent && parent.body) return parent.body;
  return null;
}

function routeValues(node: ts.Node, evaluate: (node: ts.Node) => ReadonlySet<string>): string[] {
  const routes = new Set<string>();
  const visit = (child: ts.Node): void => {
    for (const value of evaluate(child)) if (value.startsWith("/")) routes.add(value);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return [...routes];
}

export function discoverLanRouteAudits(fixtures: readonly SourceFixture[]): LanRouteAudit[] {
  const functions = namedFunctions(fixtures);
  const sseFunctions = summarizedSseFunctions(functions);
  const forbidden = forbiddenFunctions(functions);
  const known = new Map([
    ["UI_HOOK_ROUTE.PENDING", UI_HOOK_ROUTE.PENDING],
    ["UI_HOOK_ROUTE.APPROVE", UI_HOOK_ROUTE.APPROVE],
    ["UI_HOOK_ROUTE.RESPONSE_PREFIX", UI_HOOK_ROUTE.RESPONSE_PREFIX],
  ]);
  const audits = new Map<string, LanRouteAudit>();
  const audit = (
    fixture: SourceFixture,
    anchor: ts.Node,
    routes: readonly string[],
    body: ts.Statement,
  ): void => {
    const sse = containsSse(body) || [...calledNames(body)].some((name) => sseFunctions.has(name));
    for (const route of routes) {
      let authority: LanRouteAudit["authority"] | null =
        route === UI_HOOK_ROUTE.RESPONSE_PREFIX ? "hook-fetch" : sse ? "event-source" : null;
      if (!authority) continue;
      let guarded = startsWithGuard(
        body,
        authority === "event-source" ? EVENT_SOURCE_GUARD : HOOK_FETCH_GUARD,
        functions,
        forbidden,
      );
      const enclosing = enclosingFunctionBody(anchor);
      if (
        authority === "hook-fetch" &&
        enclosing &&
        startsWithGuard(enclosing, LOOPBACK_HOOK_GUARD, functions, forbidden)
      ) {
        authority = "loopback-hook";
        guarded = true;
      }
      audits.set(`${fixture.path}:${route}:${authority}`, {
        file: fixture.path,
        route,
        authority,
        guarded,
      });
    }
  };
  for (const fixture of fixtures) {
    const parsed = parseUiFixture(fixture);
    const evaluate = staticStringValues(parsed, known);
    const visit = (node: ts.Node): void => {
      if (ts.isIfStatement(node))
        audit(fixture, node, routeValues(node.expression, evaluate), node.thenStatement);
      if (ts.isSwitchStatement(node))
        for (const clause of node.caseBlock.clauses)
          if (ts.isCaseClause(clause))
            audit(
              fixture,
              clause,
              routeValues(clause.expression, evaluate),
              ts.factory.createBlock([...clause.statements], true),
            );
      ts.forEachChild(node, visit);
    };
    visit(parsed);
  }
  return [...audits.values()].sort((a, b) =>
    `${a.file}:${a.route}:${a.authority}`.localeCompare(`${b.file}:${b.route}:${b.authority}`),
  );
}
