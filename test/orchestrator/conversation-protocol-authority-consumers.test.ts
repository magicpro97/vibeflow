import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import * as ts from "typescript";
import { HOST_ACTION_KIND } from "../../src/actions/host-action-contract.js";
import {
  ACTION_AUTHORITY_BINDING_MODE,
  ACTION_CHALLENGE_CLASS,
  ACTION_DECISION,
  ACTION_DOMAIN,
  ACTION_EFFECT_CLASS,
  ACTION_EXPECTED_SOURCE_MODE,
  ACTION_PLANNING_MODE,
  ACTION_PLANNING_NETWORK_READ_VALUE,
  ACTION_REVERSIBILITY_VALUE,
  ACTION_RISK,
  ACTOR_KIND,
  CREDENTIAL_CLASS,
} from "../../src/actions/public-action-contract.js";
import {
  PUBLIC_OPERATION_PARTICIPANT_START_PHASE,
  PUBLIC_OPERATION_REVISION_PHASE,
} from "../../src/actions/public-operation-contract.js";
import {
  AGENT_ACTION_CANDIDATE_ACTOR_KIND,
  AGENT_ACTION_CANDIDATE_CREDENTIAL_CLASS,
  AGENT_ACTION_CANDIDATE_EVENT_TYPE,
  AGENT_ACTION_CANDIDATE_EXPECTED_SOURCE_MODE,
  AGENT_ACTION_CANDIDATE_NETWORK_READ_POLICY,
  AGENT_ACTION_CANDIDATE_PLANNING_MODE,
  AGENT_ACTION_CANDIDATE_REQUEST_ORIGIN,
  AGENT_ACTION_CANDIDATE_ROLE,
  AGENT_ACTION_CANDIDATE_SOURCE_LIFECYCLE,
} from "../../src/orchestrator/conversation/conversation-agent-action-candidate-contract.js";
import {
  CONVERSATION_BASELINE_REASON,
  CONVERSATION_BASELINE_REASONS,
} from "../../src/orchestrator/conversation/conversation-baseline-contract.js";
import {
  CONVERSATION_BRAINSTORM_ERROR_KIND,
  CONVERSATION_BRAINSTORM_ERROR_KINDS,
} from "../../src/orchestrator/conversation/conversation-brainstorm-contract.js";
import {
  CONVERSATION_CATALOG_HEALTH,
  CONVERSATION_CATALOG_HEALTH_VALUES,
  CONVERSATION_CURSOR_ERROR_CODE,
  CONVERSATION_CURSOR_SORT,
  CONVERSATION_CURSOR_VALIDATION_STATUS,
  CONVERSATION_HEAD_STATUSES,
  CONVERSATION_LINEAGE_STATUSES,
  CONVERSATION_SOURCE_INVENTORY_STATE,
} from "../../src/orchestrator/conversation/conversation-catalog-contract.js";
import {
  CONVERSATION_COMMAND_RESULT_STATUSES,
  CONVERSATION_LEGACY_RESULT_LIFECYCLE,
} from "../../src/orchestrator/conversation/conversation-command-result-contract.js";
import {
  CONVERSATION_DURABLE_OPERATION_MEMBERSHIP,
  CONVERSATION_DURABLE_OPERATION_MEMBERSHIPS,
  CONVERSATION_DURABLE_TRACE_EVENT_AUTHORITIES,
  CONVERSATION_DURABLE_TRACE_EVENT_AUTHORITY,
} from "../../src/orchestrator/conversation/conversation-durable-authority-contract.js";
import {
  CONVERSATION_HUMAN_REACTION_REQUEST_MODES,
  CONVERSATION_INTERACTION_ACTOR_KINDS,
  CONVERSATION_INTERACTION_ENTRY_KIND,
  CONVERSATION_INTERACTION_STATES,
  CONVERSATION_REACTION_OPERATIONS,
  REACTION_EMOJIS,
} from "../../src/orchestrator/conversation/conversation-interaction-contract.js";
import {
  CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID,
  CONVERSATION_MESSAGE_QUEUE_EVENT_KIND,
  CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND,
  CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE,
} from "../../src/orchestrator/conversation/conversation-message-queue-contract.js";
import {
  CONVERSATION_ARTIFACT_TYPE,
  CONVERSATION_ARTIFACT_TYPES,
  CONVERSATION_ASSESSMENT_STAGES,
  CONVERSATION_BASELINE_STATUSES,
  CONVERSATION_CONVERGENCE_NOT_APPLICABLE,
  CONVERSATION_DECISION_OUTCOME,
  CONVERSATION_DECISION_OUTCOMES,
  CONVERSATION_HEALTH,
  CONVERSATION_HEALTH_VALUES,
  CONVERSATION_INVALID_ASSESSMENT_REASON,
  CONVERSATION_LIFECYCLE,
  CONVERSATION_LIFECYCLES,
  CONVERSATION_OPERATION_STATES,
  CONVERSATION_ROUND_PHASES,
  CONVERSATION_SANDBOX,
  CONVERSATION_TOOL_INTENT,
  CONVERSATION_TRACE_EVENT_KIND,
  CONVERSATION_TRACE_EVENT_KINDS,
} from "../../src/orchestrator/conversation/conversation-public-wire-contract.js";
import {
  CONVERSATION_CLIENT_STREAM_STATES,
  CONVERSATION_SSE_EVENT,
} from "../../src/orchestrator/conversation/conversation-sse-contract.js";
import {
  REVISION_OPERATION_EVENT_PAYLOAD_KINDS,
  REVISION_OPERATION_EVENT_STORAGE,
} from "../../src/orchestrator/conversation/revision-operation-event-contract.js";
import {
  CONVERSATION_TURN_DELIVERY_MODE,
  CONVERSATION_TURN_DELIVERY_MODES,
  CONVERSATION_TURN_INSTRUCTION_KIND,
  CONVERSATION_TURN_PRIVATE_CONTEXT_KIND,
  CONVERSATION_TURN_PRIVATE_CONTEXT_KINDS,
  CONVERSATION_TURN_PROJECTION_PROFILE,
} from "../../src/orchestrator/conversation/turn-delivery-contract.js";

const source = (path: string): string => readFileSync(resolve(path), "utf8");

const duplicateLiterals = (
  paths: readonly string[],
  contracts: readonly Readonly<Record<string, string>>[],
): string[] =>
  paths.flatMap((path) => {
    const content = source(path);
    return contracts.flatMap((contract) =>
      Object.values(contract)
        .filter((literal) => content.includes(JSON.stringify(literal)))
        .map((literal) => `${path} -> ${literal}`),
    );
  });

const conversationPath = (name: string): string => `src/orchestrator/conversation/${name}`;

const AUTHORITY_DEFINITION_ALLOWLIST = Object.freeze([
  conversationPath("catalog-cursor-contract.ts"),
  conversationPath("conversation-baseline-contract.ts"),
  conversationPath("conversation-brainstorm-contract.ts"),
  conversationPath("conversation-catalog-contract.ts"),
  conversationPath("conversation-command-result-contract.ts"),
  conversationPath("conversation-durable-authority-contract.ts"),
  conversationPath("conversation-interaction-contract.ts"),
  conversationPath("conversation-sse-contract.ts"),
  conversationPath("turn-delivery-contract.ts"),
]);

const NEGATIVE_PROTOCOL_FIXTURE_ALLOWLIST = Object.freeze([] as string[]);

const discoverSourceFiles = (directory: string): string[] =>
  readdirSync(resolve(directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return discoverSourceFiles(path);
    return /\.(?:ts|vue)$/.test(entry.name) ? [path] : [];
  });

const DISCOVERED_PROTOCOL_CONSUMERS = Object.freeze([
  ...discoverSourceFiles("src/orchestrator/conversation"),
  ...discoverSourceFiles("src/ui/src").filter((path) => {
    const name = basename(path);
    return (
      name.startsWith("conversation-") ||
      name === "useConversationStream.ts" ||
      name === "useSSE.ts" ||
      name === "WorkflowDashboard.vue"
    );
  }),
  "src/server/ask-route.ts",
  "src/server/conversation-ask-compatibility-route.ts",
  "src/server/conversation-sse.ts",
  "src/server.ts",
  "src/commands/ask.ts",
  "src/commands/conversation-args.ts",
  "e2e/conversation-home.spec.ts",
]).filter(
  (path) =>
    !AUTHORITY_DEFINITION_ALLOWLIST.includes(path) &&
    !NEGATIVE_PROTOCOL_FIXTURE_ALLOWLIST.includes(path),
);

const rawAstLiterals = (paths: readonly string[], forbiddenValues: readonly string[]): string[] => {
  const forbidden = new Set(forbiddenValues);
  return paths.flatMap((path) => {
    const absolute = resolve(path);
    const parsed = ts.createSourceFile(
      absolute,
      source(path),
      ts.ScriptTarget.Latest,
      true,
      path.endsWith(".vue") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const offenders: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) && forbidden.has(node.text)) {
        const location = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
        offenders.push(`${relative(process.cwd(), absolute)}:${location.line + 1}:${node.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    return offenders;
  });
};

const protocolField = (node: ts.Node | undefined): string | null => {
  if (!node) return null;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    ts.isStringLiteral(node.argumentExpression)
  )
    return node.argumentExpression.text;
  return null;
};

const literalProtocolField = (literal: ts.StringLiteral): string | null => {
  const parent = literal.parent;
  if (ts.isPropertyAssignment(parent) && parent.initializer === literal)
    return ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name)
      ? parent.name.text
      : null;
  if (ts.isBinaryExpression(parent))
    return protocolField(parent.left === literal ? parent.right : parent.left);
  if (ts.isCaseClause(parent)) {
    const caseBlock = parent.parent;
    return ts.isCaseBlock(caseBlock) ? protocolField(caseBlock.parent.expression) : null;
  }
  let current: ts.Node | undefined = parent;
  while (current && (ts.isLiteralTypeNode(current) || ts.isUnionTypeNode(current)))
    current = current.parent;
  if (current && ts.isPropertySignature(current))
    return ts.isIdentifier(current.name) || ts.isStringLiteral(current.name)
      ? current.name.text
      : null;
  return null;
};

const rawProtocolFields = (
  paths: readonly string[],
  fields: Readonly<Record<string, readonly string[]>>,
): string[] => {
  const known = new Map(Object.entries(fields).map(([field, values]) => [field, new Set(values)]));
  return paths.flatMap((path) => {
    const absolute = resolve(path);
    const parsed = ts.createSourceFile(
      absolute,
      source(path),
      ts.ScriptTarget.Latest,
      true,
      path.endsWith(".vue") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const offenders: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node)) {
        const field = literalProtocolField(node);
        if (field && known.get(field)?.has(node.text)) {
          const location = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
          offenders.push(
            `${relative(process.cwd(), absolute)}:${location.line + 1}:${field}=${node.text}`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    return offenders;
  });
};

const traceConsumers = Object.freeze(
  [
    "artifact-authority.ts",
    "attempt-history-reconciliation.ts",
    "attempt-runtime.ts",
    "baseline.ts",
    "brainstorm-output.ts",
    "control-runtime.ts",
    "conversation-active-compaction.ts",
    "conversation-artifact-ancestry.ts",
    "conversation-command-compatibility.ts",
    "conversation-command-create-compatibility.ts",
    "conversation-command-exit.ts",
    "conversation-compaction-authority.ts",
    "conversation-literal-action-authority.ts",
    "conversation-message-authority.ts",
    "conversation-message-queue-dispatcher.ts",
    "conversation-message-queue-trace-authority.ts",
    "conversation-operation-fold.ts",
    "conversation-receipt-effect-executor.ts",
    "conversation-reviewed-action.ts",
    "conversation-user-message-authority.ts",
    "debate-artifact-publication.ts",
    "debate-policy.ts",
    "debate-projection.ts",
    "debate-response-publication.ts",
    "direct-policy.ts",
    "emission-authority.ts",
    "fold-terminal.ts",
    "fold-validation.ts",
    "fold.ts",
    "policy-registry.ts",
    "private-file-range-commit-authority.ts",
    "restart-authority.ts",
    "restart-runtime.ts",
    "revision-handoff-context.ts",
    "runtime-private-file-message.ts",
    "runtime-turn-delivery.ts",
    "services.ts",
    "source-inventory-fold.ts",
    "source-inventory.ts",
    "turn-delivery-source.ts",
    "types.ts",
  ].map(conversationPath),
);

describe("conversation protocol authority consumers", () => {
  test("candidate subsets are derived from the shared action and conversation authorities", () => {
    expect(AGENT_ACTION_CANDIDATE_EVENT_TYPE.AGENT_RESPONSE_DELTA).toBe(
      CONVERSATION_TRACE_EVENT_KIND.AGENT_RESPONSE_DELTA,
    );
    expect(AGENT_ACTION_CANDIDATE_SOURCE_LIFECYCLE.COMPLETED).toBe(
      CONVERSATION_LIFECYCLE.COMPLETED,
    );
    expect(AGENT_ACTION_CANDIDATE_REQUEST_ORIGIN.CONVERSATION).toBe(ACTION_DOMAIN.CONVERSATION);
    expect(AGENT_ACTION_CANDIDATE_ACTOR_KIND.AGENT).toBe(ACTOR_KIND.AGENT);
    expect(AGENT_ACTION_CANDIDATE_CREDENTIAL_CLASS.LOOPBACK_SESSION).toBe(
      CREDENTIAL_CLASS.LOOPBACK_SESSION,
    );
    expect(AGENT_ACTION_CANDIDATE_PLANNING_MODE.DURABLE).toBe(ACTION_PLANNING_MODE.DURABLE);
    expect(AGENT_ACTION_CANDIDATE_NETWORK_READ_POLICY.ORDINARY_HOST_POLICY).toBe(
      ACTION_PLANNING_NETWORK_READ_VALUE.ORDINARY_HOST_POLICY,
    );
    expect(AGENT_ACTION_CANDIDATE_EXPECTED_SOURCE_MODE.WRITABLE_REVISION).toBe(
      ACTION_EXPECTED_SOURCE_MODE.WRITABLE_REVISION,
    );
  });

  test("trace and fold types contain no competing conversation vocabulary", () => {
    const duplicates = duplicateLiterals(
      ["src/orchestrator/trace/types.ts", conversationPath("fold-validation.ts")],
      [
        CONVERSATION_TRACE_EVENT_KIND,
        CONVERSATION_ARTIFACT_TYPE,
        CONVERSATION_DECISION_OUTCOME,
        CONVERSATION_HEALTH,
        CONVERSATION_LIFECYCLE,
        CONVERSATION_SANDBOX,
        CONVERSATION_TOOL_INTENT,
      ],
    );
    expect(duplicates).toEqual([]);
  });

  test("candidate and role consumers contain no duplicated parent-authority literals", () => {
    const candidateDuplicates = duplicateLiterals(
      [conversationPath("conversation-agent-action-candidate-contract.ts")],
      [
        CONVERSATION_TRACE_EVENT_KIND,
        CONVERSATION_LIFECYCLE,
        ACTION_DOMAIN,
        ACTOR_KIND,
        CREDENTIAL_CLASS,
        ACTION_PLANNING_MODE,
        ACTION_PLANNING_NETWORK_READ_VALUE,
        ACTION_EXPECTED_SOURCE_MODE,
      ],
    );
    const roleDuplicates = duplicateLiterals(
      [
        conversationPath("attempt-runtime.ts"),
        conversationPath("bootstrap-request-resolution.ts"),
        conversationPath("conversation-host-tool-policy.ts"),
      ],
      [AGENT_ACTION_CANDIDATE_ROLE],
    );
    expect([...candidateDuplicates, ...roleDuplicates]).toEqual([]);
  });

  test("backend action consumers use the shared host and action contracts", () => {
    const consumers = [
      "conversation-action-authority-resolver.ts",
      "conversation-action-planner.ts",
      "conversation-action-service.ts",
      "conversation-action-receipt-store.ts",
      "conversation-action-receipt-validation.ts",
      "conversation-action-service-projection.ts",
      "conversation-reviewed-action.ts",
      "lineage-association.ts",
      "lineage-action-authority.ts",
      "revision-action-authority.ts",
      "revision-deferred-validation.ts",
    ].map(conversationPath);
    expect(
      duplicateLiterals(consumers, [
        HOST_ACTION_KIND,
        ACTION_AUTHORITY_BINDING_MODE,
        ACTION_CHALLENGE_CLASS,
        ACTION_DECISION,
        ACTION_DOMAIN,
        ACTION_EFFECT_CLASS,
        ACTION_EXPECTED_SOURCE_MODE,
        ACTION_PLANNING_MODE,
        ACTION_PLANNING_NETWORK_READ_VALUE,
        ACTION_REVERSIBILITY_VALUE,
        ACTION_RISK,
        ACTOR_KIND,
        CREDENTIAL_CLASS,
      ]),
    ).toEqual([]);
  });

  test("backend queue and handoff consumers use the shared message contracts", () => {
    const consumers = [
      "conversation-action-planner.ts",
      "conversation-command-compatibility.ts",
      "conversation-literal-action-authority.ts",
      "revision-action-manifest.ts",
      "revision-action-service.ts",
      "revision-active-resume.ts",
      "types.ts",
      "revision-handoff-context.ts",
      "revision-handoff-reaction-projection.ts",
    ].map(conversationPath);
    expect(
      duplicateLiterals(consumers, [
        CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID,
        CONVERSATION_MESSAGE_QUEUE_EVENT_KIND,
        CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND,
        CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE,
      ]),
    ).toEqual([]);
  });

  test("trace producers and folds contain no raw event discriminants", () => {
    const consumers = [
      ...traceConsumers,
      "src/orchestrator/trace/lifecycle-cas.ts",
      "src/orchestrator/trace/fold.ts",
      "src/orchestrator/trace/public-sanitize.ts",
      "src/orchestrator/trace/types.ts",
      "src/commands/conversation-args.ts",
      "src/ui/src/conversation-home-projection.ts",
    ];
    expect(
      rawAstLiterals(
        consumers,
        CONVERSATION_TRACE_EVENT_KINDS.filter(
          (kind) => kind !== CONVERSATION_TRACE_EVENT_KIND.ERROR,
        ),
      ),
    ).toEqual([]);
    expect(rawProtocolFields(consumers, { type: CONVERSATION_TRACE_EVENT_KINDS })).toEqual([]);
  });

  test("lifecycle, artifact, assessment, and operation fields use runtime authorities", () => {
    const lifecycleConsumers = [
      ...traceConsumers,
      "src/orchestrator/trace/lifecycle-cas.ts",
      conversationPath("catalog-types.ts"),
      conversationPath("conversation-command-compatibility.ts"),
      conversationPath("lifecycle-gate.ts"),
      conversationPath("lifecycle-terminal-gate.ts"),
      conversationPath("operation-registry-types.ts"),
      conversationPath("restart-runtime.ts"),
      conversationPath("revision-runtime-terminal.ts"),
      conversationPath("revision-source.ts"),
      conversationPath("runtime.ts"),
      conversationPath("service-execution-runtime.ts"),
      conversationPath("service-start-authority.ts"),
      conversationPath("service.ts"),
      "src/server/conversation-list-route.ts",
    ];
    expect(rawAstLiterals(lifecycleConsumers, CONVERSATION_LIFECYCLES)).toEqual([]);
    expect(
      rawProtocolFields(lifecycleConsumers, {
        lifecycle: CONVERSATION_LIFECYCLES,
        health: CONVERSATION_HEALTH_VALUES,
      }),
    ).toEqual([]);

    const artifactConsumers = [
      conversationPath("artifact-validation.ts"),
      conversationPath("artifact-authority.ts"),
      conversationPath("bootstrap-plan-locator.ts"),
      conversationPath("conversation-active-compaction.ts"),
      conversationPath("conversation-artifact-ancestry.ts"),
      conversationPath("conversation-compaction-artifacts.ts"),
      conversationPath("conversation-compaction-authority.ts"),
      conversationPath("conversation-compaction-source-authority.ts"),
      conversationPath("debate-policy.ts"),
      conversationPath("review-service.ts"),
      conversationPath("services.ts"),
      conversationPath("verify-policy.ts"),
    ];
    expect(
      rawProtocolFields(artifactConsumers, { artifact_type: CONVERSATION_ARTIFACT_TYPES }),
    ).toEqual([]);

    const decisionConsumers = [
      "src/orchestrator/consensus.ts",
      "src/orchestrator/debate.ts",
      conversationPath("baseline.ts"),
      conversationPath("brainstorm-output.ts"),
      conversationPath("debate-policy.ts"),
      conversationPath("debate-projection.ts"),
      conversationPath("fold.ts"),
    ];
    expect(
      rawProtocolFields(decisionConsumers, {
        stage: CONVERSATION_ASSESSMENT_STAGES,
        phase: CONVERSATION_ROUND_PHASES,
        outcome: CONVERSATION_DECISION_OUTCOMES,
        reason: [CONVERSATION_INVALID_ASSESSMENT_REASON],
        status: CONVERSATION_BASELINE_STATUSES,
        value: [CONVERSATION_CONVERGENCE_NOT_APPLICABLE],
      }),
    ).toEqual([]);
    expect(
      rawProtocolFields([conversationPath("conversation-operation-fold.ts")], {
        state: CONVERSATION_OPERATION_STATES,
      }),
    ).toEqual([]);
  });

  test("revision progress and journal domains have one authority", () => {
    const revisionConsumers = [
      conversationPath("revision-control-retry.ts"),
      conversationPath("revision-deferred-authority.ts"),
      conversationPath("revision-lane-barrier.ts"),
      conversationPath("revision-lane-proof.ts"),
      conversationPath("revision-lane-retry-runtime.ts"),
      conversationPath("revision-lane-retry-validation.ts"),
    ];
    expect(
      rawProtocolFields(revisionConsumers, {
        state: Object.values(PUBLIC_OPERATION_PARTICIPANT_START_PHASE),
      }),
    ).toEqual([]);
    expect(
      rawAstLiterals(
        [conversationPath("revision-deferred-authority.ts")],
        [...Object.values(PUBLIC_OPERATION_REVISION_PHASE)],
      ),
    ).toEqual([]);
    expect(rawAstLiterals(revisionConsumers, REVISION_OPERATION_EVENT_PAYLOAD_KINDS)).toEqual([]);
    expect(
      rawAstLiterals(
        [
          conversationPath("lineage-action-authority.ts"),
          conversationPath("lineage-head-authority.ts"),
          conversationPath("revision-store.ts"),
        ],
        [REVISION_OPERATION_EVENT_STORAGE.DOMAIN],
      ),
    ).toEqual([]);
  });

  test("discovers backend, browser, route, and positive E2E protocol consumers", () => {
    expect(DISCOVERED_PROTOCOL_CONSUMERS).toContain(conversationPath("catalog-service.ts"));
    expect(DISCOVERED_PROTOCOL_CONSUMERS).toContain("src/ui/src/conversation-home-types.ts");
    expect(DISCOVERED_PROTOCOL_CONSUMERS).toContain("src/server/conversation-sse.ts");
    expect(DISCOVERED_PROTOCOL_CONSUMERS).toContain("e2e/conversation-home.spec.ts");
    expect(
      DISCOVERED_PROTOCOL_CONSUMERS.some((path) => AUTHORITY_DEFINITION_ALLOWLIST.includes(path)),
    ).toBeFalse();
  });

  test("catalog, lineage, and timeline consumers contain no competing wire vocabulary", () => {
    const catalogConsumers = DISCOVERED_PROTOCOL_CONSUMERS.filter((path) => {
      const name = basename(path);
      return (
        /^(?:catalog|lineage|timeline)-/.test(name) || path === "e2e/conversation-home.spec.ts"
      );
    });
    expect(
      rawProtocolFields(catalogConsumers, {
        catalog_health: CONVERSATION_CATALOG_HEALTH_VALUES,
        head_status: CONVERSATION_HEAD_STATUSES,
        lineage_status: CONVERSATION_LINEAGE_STATUSES,
        sort: Object.values(CONVERSATION_CURSOR_SORT),
        code: Object.values(CONVERSATION_CURSOR_ERROR_CODE),
      }),
    ).toEqual([]);

    const cursorConsumers = catalogConsumers.filter((path) => {
      const name = basename(path);
      return (
        name.includes("cursor") ||
        name === "catalog-projector.ts" ||
        name === "catalog-service.ts" ||
        name === "lineage-service.ts" ||
        path === "e2e/conversation-home.spec.ts"
      );
    });
    expect(
      rawProtocolFields(cursorConsumers, {
        status: Object.values(CONVERSATION_CURSOR_VALIDATION_STATUS),
      }),
    ).toEqual([]);

    const inventoryConsumers = catalogConsumers.filter((path) => basename(path).includes("source"));
    expect(
      rawProtocolFields(inventoryConsumers, {
        state: Object.values(CONVERSATION_SOURCE_INVENTORY_STATE),
      }),
    ).toEqual([]);
  });

  test("result, delivery, interaction, and stream consumers use their frozen authorities", () => {
    const resultConsumers = DISCOVERED_PROTOCOL_CONSUMERS.filter((path) => {
      const content = source(path);
      return (
        content.includes("ConversationCommandResult") ||
        content.includes("CONVERSATION_COMMAND_RESULT") ||
        content.includes("CONVERSATION_REVISION_START_SUCCESS")
      );
    });
    expect(
      rawProtocolFields(resultConsumers, {
        status: CONVERSATION_COMMAND_RESULT_STATUSES,
      }),
    ).toEqual([]);
    expect(
      rawAstLiterals(resultConsumers, Object.values(CONVERSATION_LEGACY_RESULT_LIFECYCLE)),
    ).toEqual([]);

    const deliveryConsumers = DISCOVERED_PROTOCOL_CONSUMERS.filter(
      (path) =>
        basename(path).includes("turn-delivery") ||
        basename(path).includes("private-file-range-turn-context") ||
        path === "e2e/conversation-home.spec.ts",
    );
    expect(
      rawProtocolFields(deliveryConsumers, {
        instruction_kind: Object.values(CONVERSATION_TURN_INSTRUCTION_KIND),
        context_kind: Object.values(CONVERSATION_TURN_PRIVATE_CONTEXT_KIND),
        delivery_mode: CONVERSATION_TURN_DELIVERY_MODES,
        projection_profile: Object.values(CONVERSATION_TURN_PROJECTION_PROFILE),
        interaction_state: CONVERSATION_INTERACTION_STATES,
        author_public_id: Object.values(CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID),
        target_participants: Object.values(CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE),
      }),
    ).toEqual([]);

    const interactionConsumers = DISCOVERED_PROTOCOL_CONSUMERS.filter((path) => {
      const name = basename(path);
      return /(?:interaction|reaction|social|authoring)/.test(name);
    });
    expect(
      rawProtocolFields(interactionConsumers, {
        actor_kind: CONVERSATION_INTERACTION_ACTOR_KINDS,
        operation: CONVERSATION_REACTION_OPERATIONS,
        request_mode: CONVERSATION_HUMAN_REACTION_REQUEST_MODES,
        kind: Object.values(CONVERSATION_INTERACTION_ENTRY_KIND),
        interaction_state: CONVERSATION_INTERACTION_STATES,
      }),
    ).toEqual([]);

    const streamConsumers = DISCOVERED_PROTOCOL_CONSUMERS.filter((path) => {
      const name = basename(path);
      return /(?:stream|loading)/i.test(name) || name === "conversation-store.ts";
    });
    expect(
      rawProtocolFields(streamConsumers, { streamStatus: CONVERSATION_CLIENT_STREAM_STATES }),
    ).toEqual([]);

    expect(
      rawProtocolFields([conversationPath("brainstorm-output.ts")], {
        error_kind: CONVERSATION_BRAINSTORM_ERROR_KINDS,
      }),
    ).toEqual([]);
    expect(
      rawProtocolFields(
        [
          conversationPath("baseline.ts"),
          "src/orchestrator/trace/types.ts",
          "src/ui/src/conversation-decision-projection.ts",
          "src/ui/src/conversation-types.ts",
        ],
        { skip_reason: CONVERSATION_BASELINE_REASONS },
      ),
    ).toEqual([]);

    const durableConsumers = [
      conversationPath("private-file-range-commit-authority.ts"),
      conversationPath("runtime-private-file-message.ts"),
      conversationPath("restart-runtime.ts"),
    ];
    expect(
      rawAstLiterals(durableConsumers, [
        ...CONVERSATION_DURABLE_TRACE_EVENT_AUTHORITIES,
        ...CONVERSATION_DURABLE_OPERATION_MEMBERSHIPS,
      ]),
    ).toEqual([]);
    expect(source(conversationPath("brainstorm-output.ts"))).not.toContain("new Set");
  });

  test("protocol authority maps and derived collections are frozen", () => {
    for (const authority of [
      CONVERSATION_CATALOG_HEALTH,
      CONVERSATION_BASELINE_REASON,
      CONVERSATION_BRAINSTORM_ERROR_KIND,
      CONVERSATION_CURSOR_ERROR_CODE,
      CONVERSATION_CURSOR_SORT,
      CONVERSATION_CURSOR_VALIDATION_STATUS,
      CONVERSATION_INTERACTION_ENTRY_KIND,
      CONVERSATION_DURABLE_OPERATION_MEMBERSHIP,
      CONVERSATION_DURABLE_TRACE_EVENT_AUTHORITY,
      CONVERSATION_SSE_EVENT,
      CONVERSATION_TURN_DELIVERY_MODE,
      REACTION_EMOJIS,
      CONVERSATION_COMMAND_RESULT_STATUSES,
      CONVERSATION_CLIENT_STREAM_STATES,
      CONVERSATION_BASELINE_REASONS,
      CONVERSATION_BRAINSTORM_ERROR_KINDS,
      CONVERSATION_DURABLE_OPERATION_MEMBERSHIPS,
      CONVERSATION_DURABLE_TRACE_EVENT_AUTHORITIES,
      CONVERSATION_TURN_PRIVATE_CONTEXT_KINDS,
    ])
      expect(Object.isFrozen(authority)).toBeTrue();
  });
});
