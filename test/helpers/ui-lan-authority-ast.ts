import * as ts from "typescript";
import {
  UI_HOOK_ROUTE,
  UI_LAN_BOOTSTRAP_QUERY,
  UI_LAN_EVENT_SOURCE_TOKEN_QUERY,
  UI_LAN_SESSION_COOKIE,
  UI_LAN_TOKEN_HEADER,
} from "../../src/core/ui-cli-contract.js";

export interface SourceFixture {
  readonly path: string;
  readonly source: string;
}
const QUERY_METHODS = Object.freeze(["append", "delete", "get", "getAll", "has", "set"] as const);
const MAX_STATIC_VALUES = 64;
export function parseUiFixture({ path, source }: SourceFixture): ts.SourceFile {
  const input = path.endsWith(".vue")
    ? [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gu)]
        .map((match) => match[1] ?? "")
        .join("\n")
    : source;
  const kind = path.endsWith(".js") || path.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createSourceFile(path, input, ts.ScriptTarget.Latest, true, kind);
}
function product(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  const values = new Set<string>();
  for (const a of left)
    for (const b of right) {
      values.add(a + b);
      if (values.size >= MAX_STATIC_VALUES) return values;
    }
  return values;
}
export function staticStringValues(
  parsed: ts.SourceFile,
  known = new Map<string, string>(),
): (node: ts.Node, seen?: ReadonlySet<string>) => ReadonlySet<string> {
  const bindings = new Map<string, ts.Expression>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      bindings.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(parsed);

  const evaluate = (node: ts.Node, seen: ReadonlySet<string> = new Set()): ReadonlySet<string> => {
    if (ts.isStringLiteralLike(node)) return new Set([node.text]);
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node)
    )
      return evaluate(node.expression, seen);
    if (ts.isConditionalExpression(node))
      return new Set([...evaluate(node.whenTrue, seen), ...evaluate(node.whenFalse, seen)]);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return product(evaluate(node.left, seen), evaluate(node.right, seen));
    if (ts.isTemplateExpression(node)) {
      let values: ReadonlySet<string> = new Set([node.head.text]);
      for (const span of node.templateSpans)
        values = product(
          product(values, evaluate(span.expression, seen)),
          new Set([span.literal.text]),
        );
      return values;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const value = known.get(node.getText(parsed));
      return value === undefined ? new Set() : new Set([value]);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (method === "join") {
        let array: ts.Expression = node.expression.expression;
        if (ts.isIdentifier(array)) {
          const initializer = bindings.get(array.text);
          if (initializer) array = initializer;
        }
        if (!ts.isArrayLiteralExpression(array)) return new Set();
        const separators = node.arguments[0] ? evaluate(node.arguments[0], seen) : new Set([","]);
        let values: ReadonlySet<string> = new Set([""]);
        array.elements.forEach((element, index) => {
          if (index > 0) values = product(values, separators);
          values = product(values, evaluate(element, seen));
        });
        return values;
      }
    }
    if (!ts.isIdentifier(node) || seen.has(node.text)) return new Set();
    const direct = known.get(node.text);
    if (direct !== undefined) return new Set([direct]);
    const initializer = bindings.get(node.text);
    if (!initializer) return new Set();
    return evaluate(initializer, new Set([...seen, node.text]));
  };
  return evaluate;
}
function propertyName(node: ts.PropertyName, parsed: ts.SourceFile): string | null {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  if (ts.isComputedPropertyName(node))
    return [...staticStringValues(parsed)(node.expression)][0] ?? null;
  return null;
}
function insideUrlSearchParams(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      ts.isNewExpression(parent) &&
      ts.isIdentifier(parent.expression) &&
      parent.expression.text === "URLSearchParams"
    )
      return true;
    if (ts.isStatement(parent) || ts.isFunctionLike(parent)) return false;
  }
  return false;
}
export function rawTransportLiterals(fixtures: readonly SourceFixture[]): string[] {
  return fixtures.flatMap((fixture) => {
    const parsed = parseUiFixture(fixture);
    const evaluate = staticStringValues(parsed);
    const offenders = new Set<string>();
    const report = (node: ts.Node, kind: string): void => {
      const { line } = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
      offenders.add(`${fixture.path}:${line + 1}:${kind}`);
    };
    const outermost = (node: ts.Node, value: string): boolean =>
      !node.parent || !evaluate(node.parent).has(value);
    const visit = (node: ts.Node): void => {
      const values = evaluate(node);
      if (values.has(UI_LAN_TOKEN_HEADER) && outermost(node, UI_LAN_TOKEN_HEADER))
        report(node, "header");
      for (const value of [
        UI_LAN_BOOTSTRAP_QUERY,
        UI_LAN_SESSION_COOKIE,
        UI_HOOK_ROUTE.PENDING,
        UI_HOOK_ROUTE.APPROVE,
        UI_HOOK_ROUTE.RESPONSE_PREFIX,
      ])
        if (values.has(value) && outermost(node, value)) report(node, "authority");
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const first = node.arguments[0];
        const method = node.expression.name.text;
        if (
          first &&
          QUERY_METHODS.some((candidate) => candidate === method) &&
          evaluate(first).has(UI_LAN_EVENT_SOURCE_TOKEN_QUERY)
        )
          report(first, "query");
      }
      if (insideUrlSearchParams(node)) {
        if (values.has(UI_LAN_EVENT_SOURCE_TOKEN_QUERY)) report(node, "query-constructor");
        if (
          ts.isPropertyAssignment(node) &&
          propertyName(node.name, parsed) === UI_LAN_EVENT_SOURCE_TOKEN_QUERY
        )
          report(node.name, "query-constructor");
      }
      if (
        [...values].some((value) =>
          new RegExp(`(?:^|[?&])${UI_LAN_EVENT_SOURCE_TOKEN_QUERY}=`, "u").test(value),
        ) &&
        (!node.parent ||
          ![...evaluate(node.parent)].some((value) =>
            new RegExp(`(?:^|[?&])${UI_LAN_EVENT_SOURCE_TOKEN_QUERY}=`, "u").test(value),
          ))
      )
        report(node, "query-url");
      if (
        ts.isTemplateLiteralToken(node) &&
        new RegExp(`(?:^|[?&])${UI_LAN_EVENT_SOURCE_TOKEN_QUERY}=`, "u").test(node.text)
      )
        report(node, "query-url");
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    return [...offenders].sort();
  });
}
