import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { terminalStateForPhase } from "../../src/actions/operation-phase-rules.js";
import {
  ACTION_OPERATION_DISPATCH_BEGIN_STATES,
  ACTION_OPERATION_DISPATCH_REPLAY_STATES,
  ACTION_OPERATION_DISPATCH_RESERVATION_ASSERT_STATES,
  ACTION_OPERATION_DISPATCH_RESERVATION_READ_STATES,
  ACTION_OPERATION_DOMAIN_TERMINAL_STATES,
  ACTION_OPERATION_ERROR_FIELDS,
  ACTION_OPERATION_EVENT_FIELDS,
  ACTION_OPERATION_PROPOSAL_OPEN_STATES,
  ACTION_OPERATION_RESOLVED_DOMAIN_STATES,
  ACTION_OPERATION_REVIEW_DECISION_STATES,
  ACTION_OPERATION_REVIEW_INVALIDATION_STATES,
  ACTION_OPERATION_SSE_EVENT,
  ACTION_OPERATION_SSE_EVENTS,
  ACTION_OPERATION_STATE,
  ACTION_OPERATION_STATES,
  ACTION_OPERATION_TERMINAL_RESOLUTION_STATES,
  ACTION_OPERATION_TERMINAL_STATES,
  ACTION_OPERATION_TRANSITION_TARGETS,
  ACTION_PRODUCER_REQUEST_BINDING_KIND,
  ACTION_PRODUCER_REQUEST_BINDING_KINDS,
  ACTION_ROOT_LOCATOR_KIND,
  ACTION_ROOT_LOCATOR_KINDS,
  PUBLIC_OPERATION_PROGRESS_STATUS,
  PUBLIC_OPERATION_PROGRESS_STATUSES,
  isActionOperationDispatchBeginState,
  isActionOperationDispatchReplayState,
  isActionOperationDispatchReservationAssertState,
  isActionOperationDispatchReservationReadState,
  isActionOperationDomainTerminalState,
  isActionOperationProposalOpenState,
  isActionOperationResolvedDomainState,
  isActionOperationReviewInvalidationState,
  isActionOperationSseEventName,
  isActionOperationState,
  isActionOperationTerminalResolutionState,
  isActionOperationTerminalState,
  isActionOperationTransition,
  isActionProducerRequestBindingKind,
  isActionRootLocatorKind,
  isPublicOperationProgressStatus,
} from "../../src/actions/protocol-contract.js";
import type { ActionOperationEventV1 } from "../../src/actions/public-types.js";
import { isNonRecoveryActionRootLocatorV1 } from "../../src/actions/types.js";
import {
  CONVERSATION_SSE_EVENT,
  CONVERSATION_SSE_EVENTS,
  isConversationSseEventName,
} from "../../src/orchestrator/conversation/conversation-sse-contract.js";
import {
  LINEAGE_PLAN_KIND,
  LINEAGE_PLAN_KINDS,
  isLineagePlanKindV1,
} from "../../src/orchestrator/conversation/lineage-action-authority.js";
type SameKeys<RecordType, Fields extends readonly PropertyKey[]> = Exclude<
  keyof RecordType,
  Fields[number]
> extends never
  ? Exclude<Fields[number], keyof RecordType> extends never
    ? true
    : false
  : false;

const operationEventFieldParity = true satisfies SameKeys<
  ActionOperationEventV1,
  typeof ACTION_OPERATION_EVENT_FIELDS
>;

function productionTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...productionTypeScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

describe("shared action and SSE protocol contracts", () => {
  test("root locator and producer binding discriminants stay authoritative and narrow fail-closed", () => {
    expect(Object.isFrozen(ACTION_ROOT_LOCATOR_KIND)).toBe(true);
    expect(Object.isFrozen(ACTION_ROOT_LOCATOR_KINDS)).toBe(true);
    expect(Object.isFrozen(ACTION_PRODUCER_REQUEST_BINDING_KIND)).toBe(true);
    expect(Object.isFrozen(ACTION_PRODUCER_REQUEST_BINDING_KINDS)).toBe(true);
    expect(ACTION_ROOT_LOCATOR_KINDS).toEqual(Object.values(ACTION_ROOT_LOCATOR_KIND));
    expect(ACTION_PRODUCER_REQUEST_BINDING_KINDS).toEqual(
      Object.values(ACTION_PRODUCER_REQUEST_BINDING_KIND),
    );
    expect(ACTION_ROOT_LOCATOR_KINDS.every(isActionRootLocatorKind)).toBe(true);
    expect(ACTION_PRODUCER_REQUEST_BINDING_KINDS.every(isActionProducerRequestBindingKind)).toBe(
      true,
    );
    expect(isActionRootLocatorKind("recovery_bootstrap")).toBe(false);
    expect(isActionProducerRequestBindingKind("canonical_action_request")).toBe(false);
    expect(
      isNonRecoveryActionRootLocatorV1({
        kind: ACTION_ROOT_LOCATOR_KIND.CONVERSATION,
        root_session_id: "root",
      }),
    ).toBe(true);
    expect(
      isNonRecoveryActionRootLocatorV1({
        kind: ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP,
        bootstrap_identity_digest: "a".repeat(64),
      }),
    ).toBe(false);
    expect(isNonRecoveryActionRootLocatorV1({ kind: "future-root" })).toBe(false);
    expect(isNonRecoveryActionRootLocatorV1(null)).toBe(false);
  });

  test("lineage action plan kinds are frozen, derived, and narrowed fail-closed", () => {
    expect(Object.isFrozen(LINEAGE_PLAN_KIND)).toBe(true);
    expect(Object.isFrozen(LINEAGE_PLAN_KINDS)).toBe(true);
    expect(LINEAGE_PLAN_KINDS).toEqual(Object.values(LINEAGE_PLAN_KIND));
    expect(LINEAGE_PLAN_KINDS.every(isLineagePlanKindV1)).toBe(true);
    expect(isLineagePlanKindV1("revision_operation")).toBe(false);
  });

  test("root locator and producer binding consumers do not redeclare discriminants", () => {
    const consumers = new Map<string, readonly string[]>([
      [
        "src/orchestrator/conversation/conversation-revision-action-plan.ts",
        [
          "ACTION_ROOT_LOCATOR_KIND",
          "PUBLIC_ACTION_SCHEMA_VERSION",
          "ACTION_DOMAIN",
          "ACTION_PLANNING_MODE",
          "ACTION_PLANNING_NETWORK_READ_VALUE",
          "ACTION_EFFECT_CLASS",
          "ACTION_REVERSIBILITY_VALUE",
          "LINEAGE_PLAN_KIND.REVISION_OPERATION",
        ],
      ],
      [
        "src/orchestrator/conversation/conversation-action-planner.ts",
        ["ACTION_ROOT_LOCATOR_KIND", "ACTION_PRODUCER_REQUEST_BINDING_KIND"],
      ],
      [
        "src/orchestrator/conversation/conversation-receipt-planner.ts",
        ["ACTION_ROOT_LOCATOR_KIND", "ACTION_PRODUCER_REQUEST_BINDING_KIND"],
      ],
      [
        "src/orchestrator/conversation/conversation-action-receipt-validation.ts",
        ["ACTION_PRODUCER_REQUEST_BINDING_KIND"],
      ],
      [
        "src/capabilities/action-domain/conversation-dispatch-runtime.ts",
        ["ACTION_ROOT_LOCATOR_KIND"],
      ],
      [
        "src/capabilities/action-domain/domain-handler.ts",
        ["ACTION_ROOT_LOCATOR_KIND", "CAPABILITY_PLAN_STATUS", "CAPABILITY_RUNTIME_ERROR_CODE"],
      ],
      [
        "src/capabilities/source/durable-authority-transition-resolver.ts",
        ["ACTION_ROOT_LOCATOR_KIND", "NonRecoveryActionRootLocatorV1"],
      ],
      ["src/capabilities/adapters/types.ts", ["NonRecoveryActionRootLocatorV1"]],
    ]);
    const rawRootDiscriminant =
      /\bkind\s*(?::|===|!==|==|!=)\s*["'](?:conversation|capability|recovery-bootstrap)["']/;
    const rawProducerBindingDiscriminant =
      /\bkind\s*(?::|===|!==|==|!=)\s*["'](?:canonical-action-request|recovery-bootstrap-repair-plan)["']/;
    const rawNonRecoveryExclude =
      /Exclude\s*<\s*PrivateActionRootLocatorV1\s*,\s*\{\s*kind\s*:\s*["']recovery-bootstrap["']/s;

    for (const [path, symbols] of consumers) {
      const source = readFileSync(resolve(path), "utf8");
      for (const symbol of symbols) expect(source, `${path} imports ${symbol}`).toContain(symbol);
      expect(source, `${path} has no raw root discriminant`).not.toMatch(rawRootDiscriminant);
      expect(source, `${path} has no raw producer binding discriminant`).not.toMatch(
        rawProducerBindingDiscriminant,
      );
      expect(source, `${path} uses the shared non-recovery locator type`).not.toMatch(
        rawNonRecoveryExclude,
      );
    }
  });

  test("all production root-locator and producer-binding properties use shared authorities", () => {
    const rawRootComparison =
      /\b(?:action_root_locator|owner_root_locator)\.kind\s*(?:===|!==|==|!=)\s*["'](?:conversation|capability|recovery-bootstrap)["']/;
    const rawRootObject =
      /\b(?:action_root_locator|owner_root_locator)\s*:\s*\{[\s\S]{0,256}?\bkind\s*:\s*["'](?:conversation|capability|recovery-bootstrap)["']/;
    const rawProducerComparison =
      /\bproducer_request_binding\.kind\s*(?:===|!==|==|!=)\s*["'](?:canonical-action-request|recovery-bootstrap-repair-plan)["']/;
    const rawProducerObject =
      /\bproducer_request_binding\s*:\s*\{[\s\S]{0,256}?\bkind\s*:\s*["'](?:canonical-action-request|recovery-bootstrap-repair-plan)["']/;
    for (const path of productionTypeScriptFiles(resolve("src"))) {
      const source = readFileSync(path, "utf8");
      const label = relative(process.cwd(), path);
      expect(source, `${label} has no raw action-root comparison`).not.toMatch(rawRootComparison);
      expect(source, `${label} has no raw action-root object`).not.toMatch(rawRootObject);
      expect(source, `${label} has no raw producer-binding comparison`).not.toMatch(
        rawProducerComparison,
      );
      expect(source, `${label} has no raw producer-binding object`).not.toMatch(rawProducerObject);
    }
  });

  test("runtime vocabularies are frozen, inferred, and narrowed fail-closed", () => {
    const contracts = [
      ACTION_OPERATION_STATE,
      PUBLIC_OPERATION_PROGRESS_STATUS,
      ACTION_OPERATION_SSE_EVENT,
      CONVERSATION_SSE_EVENT,
      ACTION_OPERATION_TRANSITION_TARGETS,
    ];
    const lists = [
      ACTION_OPERATION_STATES,
      ACTION_OPERATION_TERMINAL_STATES,
      ACTION_OPERATION_DOMAIN_TERMINAL_STATES,
      ACTION_OPERATION_RESOLVED_DOMAIN_STATES,
      ACTION_OPERATION_DISPATCH_REPLAY_STATES,
      ACTION_OPERATION_DISPATCH_RESERVATION_READ_STATES,
      ACTION_OPERATION_DISPATCH_RESERVATION_ASSERT_STATES,
      ACTION_OPERATION_DISPATCH_BEGIN_STATES,
      ACTION_OPERATION_TERMINAL_RESOLUTION_STATES,
      ACTION_OPERATION_PROPOSAL_OPEN_STATES,
      ACTION_OPERATION_REVIEW_INVALIDATION_STATES,
      ACTION_OPERATION_REVIEW_DECISION_STATES,
      PUBLIC_OPERATION_PROGRESS_STATUSES,
      ACTION_OPERATION_SSE_EVENTS,
      ACTION_OPERATION_EVENT_FIELDS,
      ACTION_OPERATION_ERROR_FIELDS,
      CONVERSATION_SSE_EVENTS,
    ];
    expect(contracts.every(Object.isFrozen)).toBe(true);
    expect(lists.every(Object.isFrozen)).toBe(true);
    expect(Object.values(ACTION_OPERATION_TRANSITION_TARGETS).every(Object.isFrozen)).toBe(true);
    expect(ACTION_OPERATION_STATES).toEqual(Object.values(ACTION_OPERATION_STATE));
    expect(PUBLIC_OPERATION_PROGRESS_STATUSES).toEqual(
      Object.values(PUBLIC_OPERATION_PROGRESS_STATUS),
    );
    expect(CONVERSATION_SSE_EVENTS).toEqual(Object.values(CONVERSATION_SSE_EVENT));
    expect(ACTION_OPERATION_SSE_EVENTS).toEqual(Object.values(ACTION_OPERATION_SSE_EVENT));
    expect(ACTION_OPERATION_SSE_EVENT.HEARTBEAT).toBe("heartbeat");
    expect(operationEventFieldParity).toBe(true);
    expect(ACTION_OPERATION_STATES.every(isActionOperationState)).toBe(true);
    expect(ACTION_OPERATION_TERMINAL_STATES.every(isActionOperationTerminalState)).toBe(true);
    expect(
      ACTION_OPERATION_DOMAIN_TERMINAL_STATES.every(isActionOperationDomainTerminalState),
    ).toBe(true);
    expect(
      ACTION_OPERATION_RESOLVED_DOMAIN_STATES.every(isActionOperationResolvedDomainState),
    ).toBe(true);
    expect(
      ACTION_OPERATION_DISPATCH_REPLAY_STATES.every(isActionOperationDispatchReplayState),
    ).toBe(true);
    expect(
      ACTION_OPERATION_DISPATCH_RESERVATION_READ_STATES.every(
        isActionOperationDispatchReservationReadState,
      ),
    ).toBe(true);
    expect(
      ACTION_OPERATION_DISPATCH_RESERVATION_ASSERT_STATES.every(
        isActionOperationDispatchReservationAssertState,
      ),
    ).toBe(true);
    expect(ACTION_OPERATION_DISPATCH_BEGIN_STATES.every(isActionOperationDispatchBeginState)).toBe(
      true,
    );
    expect(
      ACTION_OPERATION_TERMINAL_RESOLUTION_STATES.every(isActionOperationTerminalResolutionState),
    ).toBe(true);
    expect(ACTION_OPERATION_PROPOSAL_OPEN_STATES.every(isActionOperationProposalOpenState)).toBe(
      true,
    );
    expect(
      ACTION_OPERATION_REVIEW_INVALIDATION_STATES.every(isActionOperationReviewInvalidationState),
    ).toBe(true);
    expect(PUBLIC_OPERATION_PROGRESS_STATUSES.every(isPublicOperationProgressStatus)).toBe(true);
    expect(ACTION_OPERATION_SSE_EVENTS.every(isActionOperationSseEventName)).toBe(true);
    expect(CONVERSATION_SSE_EVENTS.every(isConversationSseEventName)).toBe(true);
    expect([
      isActionOperationState("pending-review"),
      isActionOperationTerminalState("committing"),
      isActionOperationDomainTerminalState("denied"),
      isActionOperationResolvedDomainState("needs_recovery"),
      isActionOperationDispatchReplayState("approved"),
      isActionOperationDispatchReservationReadState("pending_review"),
      isActionOperationDispatchReservationAssertState("succeeded"),
      isActionOperationDispatchBeginState("needs_recovery"),
      isActionOperationTerminalResolutionState("approved"),
      isActionOperationProposalOpenState("committing"),
      isActionOperationReviewInvalidationState("canceled"),
      isPublicOperationProgressStatus("complete"),
      isActionOperationSseEventName("message"),
      isConversationSseEventName("operation"),
    ]).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  test("named state subsets preserve their exact lifecycle semantics", () => {
    expect(ACTION_OPERATION_RESOLVED_DOMAIN_STATES).toEqual([
      ACTION_OPERATION_STATE.SUCCEEDED,
      ACTION_OPERATION_STATE.FAILED,
    ]);
    expect(ACTION_OPERATION_DISPATCH_REPLAY_STATES).toEqual([
      ACTION_OPERATION_STATE.COMMITTING,
      ...ACTION_OPERATION_DOMAIN_TERMINAL_STATES,
    ]);
    expect(ACTION_OPERATION_DISPATCH_RESERVATION_READ_STATES).toEqual([
      ACTION_OPERATION_STATE.APPROVED,
      ...ACTION_OPERATION_DISPATCH_REPLAY_STATES,
    ]);
    expect(ACTION_OPERATION_DISPATCH_RESERVATION_ASSERT_STATES).toEqual([
      ACTION_OPERATION_STATE.APPROVED,
      ACTION_OPERATION_STATE.COMMITTING,
      ACTION_OPERATION_STATE.NEEDS_RECOVERY,
    ]);
    expect(ACTION_OPERATION_DISPATCH_BEGIN_STATES).toEqual([
      ACTION_OPERATION_STATE.APPROVED,
      ACTION_OPERATION_STATE.COMMITTING,
    ]);
    expect(ACTION_OPERATION_TERMINAL_RESOLUTION_STATES).toEqual([
      ACTION_OPERATION_STATE.COMMITTING,
      ACTION_OPERATION_STATE.NEEDS_RECOVERY,
    ]);
    expect(ACTION_OPERATION_PROPOSAL_OPEN_STATES).toEqual([
      ACTION_OPERATION_STATE.PENDING_REVIEW,
      ACTION_OPERATION_STATE.APPROVED,
    ]);
    expect(ACTION_OPERATION_REVIEW_INVALIDATION_STATES).toEqual([
      ACTION_OPERATION_STATE.EXPIRED,
      ACTION_OPERATION_STATE.STALE,
    ]);
    expect(ACTION_OPERATION_REVIEW_DECISION_STATES).toEqual([
      ACTION_OPERATION_STATE.APPROVED,
      ACTION_OPERATION_STATE.DENIED,
    ]);
    expect(ACTION_OPERATION_TRANSITION_TARGETS).toEqual({
      [ACTION_OPERATION_STATE.PENDING_REVIEW]: [
        ACTION_OPERATION_STATE.APPROVED,
        ACTION_OPERATION_STATE.DENIED,
        ACTION_OPERATION_STATE.CANCELED,
        ACTION_OPERATION_STATE.EXPIRED,
        ACTION_OPERATION_STATE.STALE,
      ],
      [ACTION_OPERATION_STATE.APPROVED]: [
        ACTION_OPERATION_STATE.COMMITTING,
        ACTION_OPERATION_STATE.CANCELED,
        ACTION_OPERATION_STATE.EXPIRED,
        ACTION_OPERATION_STATE.STALE,
      ],
      [ACTION_OPERATION_STATE.COMMITTING]: [...ACTION_OPERATION_DOMAIN_TERMINAL_STATES],
      [ACTION_OPERATION_STATE.NEEDS_RECOVERY]: [...ACTION_OPERATION_RESOLVED_DOMAIN_STATES],
      [ACTION_OPERATION_STATE.SUCCEEDED]: [],
      [ACTION_OPERATION_STATE.FAILED]: [],
      [ACTION_OPERATION_STATE.DENIED]: [],
      [ACTION_OPERATION_STATE.CANCELED]: [],
      [ACTION_OPERATION_STATE.EXPIRED]: [],
      [ACTION_OPERATION_STATE.STALE]: [],
    });
    expect(
      isActionOperationTransition(
        ACTION_OPERATION_STATE.APPROVED,
        ACTION_OPERATION_STATE.COMMITTING,
      ),
    ).toBe(true);
    expect(
      isActionOperationTransition(
        ACTION_OPERATION_STATE.PENDING_REVIEW,
        ACTION_OPERATION_STATE.SUCCEEDED,
      ),
    ).toBe(false);
    expect(terminalStateForPhase("operation-succeeded")).toBe(ACTION_OPERATION_STATE.SUCCEEDED);
    expect(terminalStateForPhase("operation-failed")).toBe(ACTION_OPERATION_STATE.FAILED);
    expect(terminalStateForPhase("operation-needs-recovery")).toBe(
      ACTION_OPERATION_STATE.NEEDS_RECOVERY,
    );
    expect(terminalStateForPhase("dispatch")).toBeNull();
  });

  test("internal operation consumers cannot redeclare closed state subsets", () => {
    const requiredImports = new Map<string, readonly string[]>([
      [
        "src/actions/store-dispatch.ts",
        [
          "ACTION_OPERATION_STATE",
          "isActionOperationDispatchReplayState",
          "isActionOperationDispatchReservationReadState",
          "isActionOperationDispatchReservationAssertState",
          "isActionOperationDispatchBeginState",
          "isActionOperationDomainTerminalState",
          "isActionOperationResolvedDomainState",
          "isActionOperationTerminalResolutionState",
        ],
      ],
      [
        "src/actions/operation-batch-validation.ts",
        [
          "ACTION_OPERATION_STATE",
          "isActionOperationDomainTerminalState",
          "isActionOperationResolvedDomainState",
        ],
      ],
      [
        "src/actions/operation-phase-rules.ts",
        ["isPublicOperationPhase", "expectedOperationStatus", "isPublicOperationPhaseOwned"],
      ],
      [
        "src/actions/public-operation-semantics.ts",
        [
          "ACTION_OPERATION_STATE",
          "ActionOperationDomainTerminalState",
          "PUBLIC_OPERATION_PROGRESS_STATUS",
        ],
      ],
      [
        "src/actions/state.ts",
        [
          "ACTION_OPERATION_STATE",
          "isActionOperationTerminalResolutionState",
          "isActionOperationTransition",
        ],
      ],
      ["src/actions/store.ts", ["ACTION_OPERATION_STATE"]],
      ["src/actions/store-rules.ts", ["ACTION_OPERATION_STATE"]],
      [
        "src/actions/store-cancel.ts",
        ["ACTION_OPERATION_STATE", "isActionOperationProposalOpenState"],
      ],
      [
        "src/actions/store-transitions.ts",
        [
          "ACTION_OPERATION_STATE",
          "ActionOperationReviewInvalidationState",
          "isActionOperationProposalOpenState",
        ],
      ],
      ["src/actions/projector.ts", ["ACTION_OPERATION_STATE"]],
      [
        "src/actions/challenge.ts",
        [
          "ACTION_OPERATION_STATE",
          "ActionApprovalChallengeClass",
          "ActionApprovalChallengeResponseV1",
          "ACTION_APPROVAL_CHALLENGE_DISPLAY_PREFIX",
          "PUBLIC_ACTION_SCHEMA_VERSION",
        ],
      ],
      [
        "src/capabilities/action-domain/operation-evidence.ts",
        ["isActionOperationDomainTerminalState", "CAPABILITY_WAL_PAYLOAD_KIND"],
      ],
      [
        "src/capabilities/controller.ts",
        [
          "ActionOperationDomainTerminalState",
          "ACTION_DECISION",
          "ACTION_DOMAIN",
          "ACTION_ROOT_LOCATOR_KIND",
          "isCapabilityHostActionKind",
        ],
      ],
      [
        "src/capabilities/service.ts",
        [
          "ACTION_PLANNING_MODE",
          "ACTION_ROOT_LOCATOR_KIND",
          "readCapabilityDomainAuthorityEvidence",
        ],
      ],
      [
        "src/actions/operation-projection.ts",
        ["ACTION_OPERATION_STATE", "isPublicTargetResultOutcome", "isPublicTargetResultHealth"],
      ],
      [
        "src/orchestrator/conversation/conversation-action-domain.ts",
        ["ACTION_OPERATION_STATE", "isActionOperationDomainTerminalState"],
      ],
      [
        "src/orchestrator/conversation/conversation-action-authority-resolver.ts",
        ["ActionOperationDomainTerminalState"],
      ],
      [
        "src/orchestrator/conversation/conversation-action-receipt-validation.ts",
        ["ACTION_OPERATION_STATE", "isActionOperationDomainTerminalState"],
      ],
      [
        "src/orchestrator/conversation/conversation-action-service-projection.ts",
        ["isActionOperationProposalOpenState"],
      ],
      [
        "src/orchestrator/conversation/conversation-action-projection.ts",
        ["ACTION_OPERATION_STATE", "PUBLIC_OPERATION_PROGRESS_STATUS"],
      ],
      [
        "src/orchestrator/conversation/conversation-action-receipt-store.ts",
        ["ActionOperationDomainTerminalState"],
      ],
      [
        "src/orchestrator/conversation/conversation-action-service.ts",
        ["ActionOperationDomainTerminalState"],
      ],
      ["src/ui/src/components/HomeActionCard.vue", ["ACTION_OPERATION_STATE"]],
      [
        "src/ui/src/conversation-home-action-runtime.ts",
        [
          "ACTION_CHALLENGE_CLASS",
          "ACTION_DECISION",
          "ACTION_SCOPE",
          "HOST_ACTION_KIND",
          "PUBLIC_ERROR_CODE",
        ],
      ],
    ]);
    const stateName =
      "pending_review|approved|committing|succeeded|failed|denied|canceled|expired|stale|needs_recovery";
    const rawStateSubset = new RegExp(
      `\\[(?:\\s*["'](?:${stateName})["']\\s*,?){2,}\\]\\s*\\.includes\\(`,
      "s",
    );
    const rawTypedStateSet = /new Set<\s*ActionOperationState\s*>\s*\(/;
    const unsafeStateNarrowing =
      /\b(?:state|from|to)\s+as\s+(?:never|["'](?:committing|needs_recovery)["']\s*\|)/;
    const rawSnapshotState = new RegExp(
      `(?:snapshot|value\\?)\\.state\\s*(?:===|!==|==|!=)\\s*["'](?:${stateName})["']`,
    );
    const rawAuthorityTransition = new RegExp(
      `(?:transition\\.(?:from|to)|event\\.payload\\.(?:from|to)|\\b(?:from|to):)\\s*(?:===|!==|==|!=)?\\s*["'](?:${stateName})["']`,
    );
    const manualStateUnion = new RegExp(
      `\\b(?:state|from|to):\\s*["'](?:${stateName})["']\\s*\\|\\s*["'](?:${stateName})["']`,
    );
    const rawOperationState = new RegExp(
      `(?:props\\.)?view\\.operation\\.state\\s*(?:===|!==|==|!=)\\s*["'](?:${stateName})["']`,
    );
    const rawDomainOutcome =
      /\\b(?:receipt|terminal|value)\\.outcome\\s*(?:===|!==|==|!=)\\s*["'](?:succeeded|failed|needs_recovery)["']/;
    const manualDomainOutcome =
      /\\boutcome:\\s*["'](?:succeeded|failed|needs_recovery)["']\\s*\\|\\s*["'](?:succeeded|failed|needs_recovery)["']/;

    for (const [path, symbols] of requiredImports) {
      const source = readFileSync(resolve(path), "utf8");
      for (const symbol of symbols) expect(source, `${path} imports ${symbol}`).toContain(symbol);
      expect(source, `${path} has no raw state subset`).not.toMatch(rawStateSubset);
      expect(source, `${path} has no typed state Set redeclaration`).not.toMatch(rawTypedStateSet);
      expect(source, `${path} has no unsafe state cast`).not.toMatch(unsafeStateNarrowing);
      expect(source, `${path} has no raw snapshot state comparison`).not.toMatch(rawSnapshotState);
      expect(source, `${path} has no raw authority transition`).not.toMatch(rawAuthorityTransition);
      expect(source, `${path} has no manual state union`).not.toMatch(manualStateUnion);
      expect(source, `${path} has no raw operation state comparison`).not.toMatch(
        rawOperationState,
      );
      expect(source, `${path} has no raw domain outcome comparison`).not.toMatch(rawDomainOutcome);
      expect(source, `${path} has no manual domain outcome union`).not.toMatch(manualDomainOutcome);
    }
  });
});
