import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import * as ts from "typescript";
import { HOST_ACTION_KIND_VALUES } from "../../src/actions/host-action-contract.js";

const CONVERSATION_HOST_ACTION_CONSUMERS = Object.freeze([
  "src/orchestrator/conversation/conversation-action-registry.ts",
  "src/orchestrator/conversation/conversation-literal-action-authority.ts",
  "src/orchestrator/conversation/conversation-receipt-planner.ts",
  "src/orchestrator/conversation/revision-action-service.ts",
  "src/orchestrator/conversation/conversation-compaction-authority.ts",
  "src/orchestrator/conversation/conversation-receipt-authority-facts.ts",
  "src/orchestrator/conversation/revision-active-resume.ts",
  "src/orchestrator/conversation/conversation-revision-control-authority.ts",
  "src/orchestrator/conversation/conversation-receipt-effect-executor.ts",
  "src/orchestrator/conversation/revision-deferred-authority.ts",
  "src/orchestrator/conversation/revision-control-proposal.ts",
] as const);

function rawHostActionKinds(path: string): string[] {
  const absolutePath = resolve(process.cwd(), path);
  const source = ts.createSourceFile(
    absolutePath,
    readFileSync(absolutePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const knownKinds = new Set<string>(HOST_ACTION_KIND_VALUES);
  const offenders: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) && knownKinds.has(node.text)) {
      const location = source.getLineAndCharacterOfPosition(node.getStart(source));
      offenders.push(`${relative(process.cwd(), absolutePath)}:${location.line + 1}:${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return offenders;
}

describe("conversation host-action vocabulary consumers", () => {
  test("bounded conversation authorities contain no raw durable host-action discriminants", () => {
    expect(Object.isFrozen(CONVERSATION_HOST_ACTION_CONSUMERS)).toBe(true);
    expect(CONVERSATION_HOST_ACTION_CONSUMERS.flatMap((path) => rawHostActionKinds(path))).toEqual(
      [],
    );
  });
});
