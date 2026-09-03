import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import * as ts from "typescript";
import {
  AUTHORIZABLE_ACTION_KINDS,
  CAPABILITY_AUTHORIZATION_ACTION_KIND,
  CAPABILITY_HOST_ACTION_KINDS,
  HOST_ACTION_KIND,
  HOST_ACTION_KIND_VALUES,
  type HostActionKind,
  isAuthorizableActionKind,
} from "../../src/actions/host-action-contract.js";
import type {
  HostActionV1,
  InternalStagedHostActionKind,
} from "../../src/actions/internal-action-types.js";
import { validateGrantInput } from "../../src/actions/permission-validation.js";
import {
  AUTHORITY_HOST_ACTION_KINDS,
  isAuthorityAction,
  isCapabilityAction,
} from "../../src/actions/proposal-content-validation.js";
import { HOST_ACTION_KINDS, type HostActionRequestV1 } from "../../src/actions/request-types.js";
import type { ConversationReceiptActionKindV1 } from "../../src/orchestrator/conversation/conversation-action-receipt-store.js";
import {
  AGENT_ACTION_CANDIDATE_CAPABILITY_INPUT_ACTION_TYPES,
  AGENT_ACTION_CANDIDATE_PRIVATE_OR_STAGED_ACTION_TYPES,
} from "../../src/orchestrator/conversation/conversation-agent-action-candidate-contract.js";
import { CONVERSATION_RECEIPT_ACTION_KINDS } from "../../src/orchestrator/conversation/conversation-receipt-action-authority.js";

type SameUnion<Left, Right> = Exclude<Left, Right> extends never
  ? Exclude<Right, Left> extends never
    ? true
    : false
  : false;

const requestKindParity = true satisfies SameUnion<HostActionRequestV1["type"], HostActionKind>;
const internalKindParity = true satisfies SameUnion<HostActionV1["type"], HostActionKind>;
const receiptKindParity = true satisfies SameUnion<
  (typeof CONVERSATION_RECEIPT_ACTION_KINDS)[number],
  ConversationReceiptActionKindV1
>;

const expectedStagedKinds = [
  HOST_ACTION_KIND.CONVERSATION_PUBLISH_SUSPECTED_LITERAL,
  HOST_ACTION_KIND.CONVERSATION_ABANDON_REVISION_OPERATION,
  HOST_ACTION_KIND.CONVERSATION_RETRY_REVISION_OPERATION,
  HOST_ACTION_KIND.CONVERSATION_RECONCILE_REVISION_OPERATION,
  HOST_ACTION_KIND.CONTEXT_COMPACT,
  HOST_ACTION_KIND.CAPABILITY_ADOPT,
  HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY,
  HOST_ACTION_KIND.SECRET_REVOKE,
  HOST_ACTION_KIND.AUTHORITY_REPAIR,
] as const satisfies readonly InternalStagedHostActionKind[];

const stagedKindParity = true satisfies SameUnion<
  (typeof expectedStagedKinds)[number],
  InternalStagedHostActionKind
>;

const CLI_HOST_ACTION_CONSUMERS = Object.freeze([
  "src/commands/capability/mutation.ts",
  "src/commands/capability/authority-mutation.ts",
] as const);

const rawHostActionDiscriminants = (path: string): string[] => {
  const absolutePath = resolve(process.cwd(), path);
  const file = ts.createSourceFile(
    absolutePath,
    readFileSync(absolutePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const knownKinds = new Set<string>(HOST_ACTION_KIND_VALUES);
  const offenders: string[] = [];
  const namedType = (node: ts.Node): boolean =>
    (ts.isIdentifier(node) && node.text === "type") ||
    (ts.isStringLiteral(node) && node.text === "type");
  const typeReference = (node: ts.Node): boolean =>
    (ts.isPropertyAccessExpression(node) && node.name.text === "type") ||
    (ts.isElementAccessExpression(node) &&
      node.argumentExpression !== undefined &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === "type");
  const record = (node: ts.Node, value: string): void => {
    const location = file.getLineAndCharacterOfPosition(node.getStart(file));
    offenders.push(`${relative(process.cwd(), absolutePath)}:${location.line + 1}:${value}`);
  };
  const recordKnownLiterals = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) && knownKinds.has(node.text)) record(node, node.text);
    if (ts.isTemplateLiteralTypeNode(node) && node.head.text.startsWith("capability."))
      record(node, node.getText(file));
    ts.forEachChild(node, recordKnownLiterals);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && namedType(node.name))
      recordKnownLiterals(node.initializer);
    if (ts.isPropertySignature(node) && namedType(node.name) && node.type !== undefined)
      recordKnownLiterals(node.type);
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ].includes(node.operatorToken.kind)
    ) {
      if (typeReference(node.left)) recordKnownLiterals(node.right);
      if (typeReference(node.right)) recordKnownLiterals(node.left);
    }
    if (ts.isSwitchStatement(node) && typeReference(node.expression))
      for (const clause of node.caseBlock.clauses)
        if (ts.isCaseClause(clause)) recordKnownLiterals(clause.expression);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "includes" &&
      node.arguments.some(typeReference)
    )
      recordKnownLiterals(node.expression.expression);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return offenders;
};

describe("host-action vocabulary consumers", () => {
  test("request and internal discriminants stay identical to the canonical host vocabulary", () => {
    expect(requestKindParity).toBe(true);
    expect(internalKindParity).toBe(true);
    expect(stagedKindParity).toBe(true);
    expect([...HOST_ACTION_KINDS]).toEqual([...HOST_ACTION_KIND_VALUES]);
    expect(HOST_ACTION_KINDS).toBe(HOST_ACTION_KIND_VALUES);
    expect(Object.isFrozen(HOST_ACTION_KINDS)).toBe(true);
    expect(() => (HOST_ACTION_KINDS as unknown as string[]).push("evil.action")).toThrow();
    expect(isAuthorizableActionKind("evil.action")).toBe(false);
    expect(() =>
      validateGrantInput(
        {
          scope: "project",
          principal_id: "principal-1",
          action_types: ["evil.action"],
          permissions: [],
          target_engines: [],
          expires_at: "2026-08-25T01:00:00.000Z",
        },
        "$.grant",
      ),
    ).toThrow(/unsupported grant action type/i);
    expect(AUTHORIZABLE_ACTION_KINDS).toEqual([
      ...HOST_ACTION_KIND_VALUES,
      CAPABILITY_AUTHORIZATION_ACTION_KIND.DISCOVER,
    ]);
  });

  test("capability and authority guards consume exact canonical subsets", () => {
    expect(Object.isFrozen(AUTHORITY_HOST_ACTION_KINDS)).toBe(true);
    for (const kind of HOST_ACTION_KIND_VALUES) {
      expect(isCapabilityAction(kind)).toBe(
        CAPABILITY_HOST_ACTION_KINDS.some((candidate) => candidate === kind),
      );
      expect(isAuthorityAction(kind)).toBe(
        AUTHORITY_HOST_ACTION_KINDS.some((candidate) => candidate === kind),
      );
    }
    expect(isCapabilityAction("capability.future")).toBe(false);
    expect(isAuthorityAction("grant.future")).toBe(false);
  });

  test("agent candidate and receipt subsets retain their intended canonical members", () => {
    expect(receiptKindParity).toBe(true);
    expect(Object.isFrozen(CONVERSATION_RECEIPT_ACTION_KINDS)).toBe(true);
    expect(CONVERSATION_RECEIPT_ACTION_KINDS).toEqual([
      HOST_ACTION_KIND.CONVERSATION_SELECT_LINEAGE_HEAD,
      HOST_ACTION_KIND.CONVERSATION_ASSOCIATE_LINEAGES,
      HOST_ACTION_KIND.CONVERSATION_PUBLISH_SUSPECTED_LITERAL,
      HOST_ACTION_KIND.CONVERSATION_STOP_OPERATION,
      HOST_ACTION_KIND.CONTEXT_COMPACT,
    ]);
    expect(AGENT_ACTION_CANDIDATE_PRIVATE_OR_STAGED_ACTION_TYPES).toEqual([
      HOST_ACTION_KIND.CONVERSATION_SELECT_LINEAGE_HEAD,
      HOST_ACTION_KIND.CONVERSATION_PUBLISH_SUSPECTED_LITERAL,
      HOST_ACTION_KIND.CONVERSATION_ABANDON_REVISION_OPERATION,
      HOST_ACTION_KIND.CONVERSATION_RETRY_REVISION_OPERATION,
      HOST_ACTION_KIND.CONVERSATION_RECONCILE_REVISION_OPERATION,
      HOST_ACTION_KIND.CONTEXT_COMPACT,
      HOST_ACTION_KIND.CAPABILITY_ADOPT,
      HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY,
      HOST_ACTION_KIND.SECRET_REVOKE,
    ]);
    expect(AGENT_ACTION_CANDIDATE_CAPABILITY_INPUT_ACTION_TYPES).toEqual([
      HOST_ACTION_KIND.CAPABILITY_INSTALL,
      HOST_ACTION_KIND.CAPABILITY_CONFIGURE,
      HOST_ACTION_KIND.CAPABILITY_UPDATE,
    ]);
  });

  test("CLI consumers keep host-action discriminants on shared frozen subsets", () => {
    expect(Object.isFrozen(CLI_HOST_ACTION_CONSUMERS)).toBe(true);
    expect(CLI_HOST_ACTION_CONSUMERS.flatMap((path) => rawHostActionDiscriminants(path))).toEqual(
      [],
    );
    const capabilitySource = readFileSync(resolve(CLI_HOST_ACTION_CONSUMERS[0]), "utf8");
    const authoritySource = readFileSync(resolve(CLI_HOST_ACTION_CONSUMERS[1]), "utf8");
    expect(capabilitySource).toContain("CAPABILITY_HOST_ACTION_KINDS");
    expect(authoritySource).toContain("AUTHORITY_HOST_ACTION_KINDS");
    for (const source of [capabilitySource, authoritySource])
      expect(source).toContain("HOST_ACTION_KIND");
  });
});
