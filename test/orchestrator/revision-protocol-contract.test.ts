import { expect, test } from "bun:test";
import {
  type ACTION_OPERATION_STATE,
  PUBLIC_OPERATION_PARTICIPANT_START_PHASE,
  PUBLIC_OPERATION_REVISION_PHASE,
} from "../../src/actions/protocol-contract.js";
import { digestV1 } from "../../src/durability/index.js";
import {
  REVISION_OPERATION_EVENT_FIELDS,
  REVISION_OPERATION_EVENT_FIELD_CONTRACTS_EXACT,
  REVISION_OPERATION_EVENT_PAYLOAD_FIELDS,
  REVISION_OPERATION_EVENT_PAYLOAD_KIND,
  REVISION_OPERATION_EVENT_PAYLOAD_KINDS,
  REVISION_OPERATION_EVENT_SCHEMA_VERSION,
  REVISION_OPERATION_EVENT_STORAGE,
  REVISION_OPERATION_INITIAL_PHASE,
  type RevisionActionTerminalBindingV1,
  type RevisionOperationEventV1,
  type RevisionOperationPayloadV1,
  type RevisionOperationStateV1,
  assertRevisionOperationEventV1,
  isRevisionOperationEventPayloadKind,
} from "../../src/orchestrator/conversation/revision-operation-event-contract.js";
import {
  PARTICIPANT_CANCEL_MODES,
  PARTICIPANT_START_RECEIPT_FIELDS,
  PARTICIPANT_START_RECEIPT_FIELD_CONTRACT_EXACT,
  PARTICIPANT_START_RECONCILIATION_MODE,
  PARTICIPANT_START_RECONCILIATION_MODES,
  type ParticipantStartReceiptV1,
  advanceParticipantReceipt,
  isParticipantCancelModeV1,
  isParticipantStartReconciliationModeV1,
  materializeParticipantStartReceipt,
  participantCancelAttemptKey,
  participantStartAttemptKey,
} from "../../src/orchestrator/conversation/revision-participant-receipt.js";

type SameKeys<Shape, Fields extends readonly PropertyKey[]> = Exclude<
  keyof Shape,
  Fields[number]
> extends never
  ? Exclude<Fields[number], keyof Shape> extends never
    ? true
    : false
  : false;

type SameUnion<Left, Right> = Exclude<Left, Right> extends never
  ? Exclude<Right, Left> extends never
    ? true
    : false
  : false;

const receiptFieldParity = true satisfies SameKeys<
  ParticipantStartReceiptV1,
  typeof PARTICIPANT_START_RECEIPT_FIELDS
>;
const eventFieldParity = true satisfies SameKeys<
  RevisionOperationEventV1,
  typeof REVISION_OPERATION_EVENT_FIELDS
>;
const payloadFieldParity = {
  [REVISION_OPERATION_EVENT_PAYLOAD_KIND.STATE_TRANSITION]: true satisfies SameKeys<
    Extract<RevisionOperationPayloadV1, { kind: "state-transition" }>,
    (typeof REVISION_OPERATION_EVENT_PAYLOAD_FIELDS)["state-transition"]
  >,
  [REVISION_OPERATION_EVENT_PAYLOAD_KIND.PARTICIPANT_START]: true satisfies SameKeys<
    Extract<RevisionOperationPayloadV1, { kind: "participant-start" }>,
    (typeof REVISION_OPERATION_EVENT_PAYLOAD_FIELDS)["participant-start"]
  >,
  [REVISION_OPERATION_EVENT_PAYLOAD_KIND.RECONCILIATION_RESULT]: true satisfies SameKeys<
    Extract<RevisionOperationPayloadV1, { kind: "reconciliation-result" }>,
    (typeof REVISION_OPERATION_EVENT_PAYLOAD_FIELDS)["reconciliation-result"]
  >,
  [REVISION_OPERATION_EVENT_PAYLOAD_KIND.HEAD_COMMIT]: true satisfies SameKeys<
    Extract<RevisionOperationPayloadV1, { kind: "head-commit" }>,
    (typeof REVISION_OPERATION_EVENT_PAYLOAD_FIELDS)["head-commit"]
  >,
};
const revisionStateAuthorityParity = true satisfies SameUnion<
  RevisionOperationStateV1,
  (typeof PUBLIC_OPERATION_REVISION_PHASE)[keyof typeof PUBLIC_OPERATION_REVISION_PHASE]
>;
const revisionTerminalAuthorityParity = true satisfies SameUnion<
  RevisionActionTerminalBindingV1["outcome"],
  | typeof ACTION_OPERATION_STATE.SUCCEEDED
  | typeof ACTION_OPERATION_STATE.FAILED
  | typeof ACTION_OPERATION_STATE.NEEDS_RECOVERY
>;

const REVISION_PROTOCOL_CONSUMERS = Object.freeze([
  {
    path: "../../src/orchestrator/conversation/revision-control-evidence.ts",
    authorities: ["PUBLIC_OPERATION_REVISION_PHASE", "REVISION_OPERATION_EVENT_PAYLOAD_KIND"],
  },
  {
    path: "../../src/orchestrator/conversation/revision-control-retry.ts",
    authorities: [
      "ACTION_OPERATION_STATE",
      "PUBLIC_OPERATION_REVISION_PHASE",
      "REVISION_OPERATION_EVENT_PAYLOAD_KIND",
    ],
  },
  {
    path: "../../src/orchestrator/conversation/revision-fold-validation.ts",
    authorities: [
      "ACTION_OPERATION_STATE",
      "PUBLIC_OPERATION_REVISION_PHASE",
      "REVISION_OPERATION_EVENT_PAYLOAD_KIND",
      "REVISION_OPERATION_INITIAL_PHASE",
    ],
  },
  {
    path: "../../src/orchestrator/conversation/revision-fold.ts",
    authorities: [
      "PUBLIC_OPERATION_REVISION_PHASE",
      "REVISION_OPERATION_EVENT_PAYLOAD_KIND",
      "REVISION_OPERATION_INITIAL_PHASE",
    ],
  },
  {
    path: "../../src/orchestrator/conversation/revision-initial-lane-authority.ts",
    authorities: ["PUBLIC_OPERATION_REVISION_PHASE", "REVISION_OPERATION_EVENT_PAYLOAD_KIND"],
  },
  {
    path: "../../src/orchestrator/conversation/revision-operation-executor.ts",
    authorities: [
      "ACTION_OPERATION_STATE",
      "PUBLIC_OPERATION_REVISION_PHASE",
      "REVISION_OPERATION_EVENT_PAYLOAD_KIND",
      "REVISION_OPERATION_INITIAL_PHASE",
    ],
  },
  {
    path: "../../src/orchestrator/conversation/revision-owned-start-runtime.ts",
    authorities: ["PUBLIC_OPERATION_REVISION_PHASE"],
  },
  {
    path: "../../src/orchestrator/conversation/revision-start-finalizer.ts",
    authorities: [
      "ACTION_OPERATION_STATE",
      "PUBLIC_OPERATION_REVISION_PHASE",
      "REVISION_OPERATION_EVENT_PAYLOAD_KIND",
    ],
  },
  {
    path: "../../src/orchestrator/conversation/conversation-revision-control-authority.ts",
    authorities: [
      "ACTION_OPERATION_STATE",
      "PUBLIC_OPERATION_REVISION_PHASE",
      "REVISION_OPERATION_EVENT_PAYLOAD_KIND",
      "REVISION_OPERATION_INITIAL_PHASE",
    ],
  },
  {
    path: "../../src/orchestrator/conversation/conversation-control-effect-planner.ts",
    authorities: [
      "CONVERSATION_CONTROL_OPERATION_TERMINAL_STATES",
      "REVISION_OPERATION_EVENT_PAYLOAD_KIND",
    ],
  },
  {
    path: "../../src/orchestrator/conversation/conversation-lineage-mutation-reservation.ts",
    authorities: ["ACTION_AUTHORITY_EVENT_KIND", "ACTION_OPERATION_STATE"],
  },
  {
    path: "../../src/orchestrator/conversation/revision-lane-observation.ts",
    authorities: ["REVISION_OPERATION_EVENT_PAYLOAD_KIND"],
  },
] as const);

const RAW_REVISION_PROTOCOL_LITERALS = Object.freeze([
  "state-transition",
  "participant-start",
  "reconciliation-result",
  "head-commit",
  "created",
  "preparing",
  "prepared",
  "published",
  "starting",
  "started",
  "abandoned",
  "start_failed",
  "needs_recovery",
  "succeeded",
] as const);

const operationId = `vf-operation-${"a".repeat(64)}`;

function eventWith(payload: RevisionOperationPayloadV1): RevisionOperationEventV1 {
  const preimage = {
    schema_version: REVISION_OPERATION_EVENT_SCHEMA_VERSION,
    operation_id: operationId,
    sequence: 0,
    previous_event_digest: null,
    payload,
    recorded_at: "2026-08-25T00:00:00.000Z",
  } as const;
  return {
    ...preimage,
    event_digest: digestV1(REVISION_OPERATION_EVENT_STORAGE.DIGEST_DOMAIN, preimage),
  };
}

function redigest(event: Record<string, unknown>): Record<string, unknown> {
  const { event_digest: _ignored, ...preimage } = event;
  return {
    ...preimage,
    event_digest: digestV1(REVISION_OPERATION_EVENT_STORAGE.DIGEST_DOMAIN, preimage),
  };
}

test("revision receipt modes and exact field contracts are frozen and prototype-safe", () => {
  expect(receiptFieldParity).toBe(true);
  expect(PARTICIPANT_START_RECEIPT_FIELD_CONTRACT_EXACT).toBe(true);
  expect(Object.isFrozen(PARTICIPANT_START_RECEIPT_FIELDS)).toBe(true);
  expect(Object.isFrozen(PARTICIPANT_START_RECONCILIATION_MODES)).toBe(true);
  expect(Object.isFrozen(PARTICIPANT_CANCEL_MODES)).toBe(true);
  for (const mode of PARTICIPANT_START_RECONCILIATION_MODES)
    expect(isParticipantStartReconciliationModeV1(mode)).toBe(true);
  for (const mode of PARTICIPANT_CANCEL_MODES) expect(isParticipantCancelModeV1(mode)).toBe(true);
  for (const unknown of ["unknown", "toString", "__proto__", null]) {
    expect(isParticipantStartReconciliationModeV1(unknown)).toBe(false);
    expect(isParticipantCancelModeV1(unknown)).toBe(false);
  }
});

test("revision WAL event vocabulary has exact frozen fields for every payload variant", () => {
  expect(eventFieldParity).toBe(true);
  expect(Object.values(payloadFieldParity).every(Boolean)).toBe(true);
  expect(revisionStateAuthorityParity).toBe(true);
  expect(revisionTerminalAuthorityParity).toBe(true);
  expect(REVISION_OPERATION_EVENT_FIELD_CONTRACTS_EXACT).toBe(true);
  expect(Object.isFrozen(REVISION_OPERATION_EVENT_PAYLOAD_KIND)).toBe(true);
  expect(Object.isFrozen(REVISION_OPERATION_EVENT_PAYLOAD_KINDS)).toBe(true);
  expect(Object.isFrozen(REVISION_OPERATION_EVENT_FIELDS)).toBe(true);
  for (const kind of REVISION_OPERATION_EVENT_PAYLOAD_KINDS) {
    expect(isRevisionOperationEventPayloadKind(kind)).toBe(true);
    expect(Object.isFrozen(REVISION_OPERATION_EVENT_PAYLOAD_FIELDS[kind])).toBe(true);
  }
  for (const unknown of ["unknown", "toString", "__proto__", null])
    expect(isRevisionOperationEventPayloadKind(unknown)).toBe(false);
});

test("revision persisted consumers use the shared runtime protocol authorities", async () => {
  for (const consumer of REVISION_PROTOCOL_CONSUMERS) {
    const source = await Bun.file(new URL(consumer.path, import.meta.url)).text();
    for (const authority of consumer.authorities) expect(source).toContain(authority);
    for (const literal of RAW_REVISION_PROTOCOL_LITERALS)
      expect(source).not.toContain(`"${literal}"`);
    expect(source).not.toMatch(
      /\boutcome\s*:\s*"(?:succeeded|failed|needs_recovery)"|\.outcome\s*(?:===|!==)\s*"(?:succeeded|failed|needs_recovery)"/u,
    );
    expect(source).not.toMatch(
      /\ballowed_(?:states|outcomes)\s*:\s*\[[^\]]*"(?:succeeded|failed|canceled|needs_recovery)"/su,
    );
    expect(source).not.toMatch(
      /\bterminal\([^)]*,\s*"(?:succeeded|failed|needs_recovery)"|\[[^\]]*"(?:failed|canceled)"[^\]]*\]\.includes\([^)]*\.state\)/su,
    );
    expect(source).not.toMatch(
      /\bstate\s*:\s*"(?:prepared|failed|canceled)"|\.state\s*(?:===|!==)\s*"(?:prepared|failed|canceled)"/u,
    );
  }
});

test("revision WAL rejects re-digested event and payload extensions plus custom prototypes", () => {
  const event = eventWith({
    kind: REVISION_OPERATION_EVENT_PAYLOAD_KIND.STATE_TRANSITION,
    from: REVISION_OPERATION_INITIAL_PHASE.CREATED,
    to: PUBLIC_OPERATION_REVISION_PHASE.PREPARING,
    authorized_by_action_operation_id: operationId,
    effect_action_operation_id: operationId,
    action_terminals: [],
    reason_code: null,
  });
  expect(() => assertRevisionOperationEventV1(event)).not.toThrow();

  const extendedEvent = redigest({ ...event, extension: "re-digested" });
  expect(() => assertRevisionOperationEventV1(extendedEvent)).toThrow(
    "invalid revision operation event",
  );
  const extendedPayload = redigest({
    ...event,
    payload: { ...event.payload, extension: "re-digested" },
  });
  expect(() => assertRevisionOperationEventV1(extendedPayload)).toThrow(
    "invalid revision operation event payload",
  );

  const customPayload = Object.assign(Object.create({ inherited: true }), event.payload);
  expect(() => assertRevisionOperationEventV1({ ...event, payload: customPayload })).toThrow(
    "invalid revision operation event payload",
  );
  const customEvent = Object.assign(Object.create({ inherited: true }), event);
  expect(() => assertRevisionOperationEventV1(customEvent)).toThrow(
    "invalid revision operation event",
  );
});

test("participant receipts bind one immutable evidence channel to reconciliation mode", () => {
  const evidence = (label: string) =>
    digestV1("VF-REVISION-RECEIPT-EVIDENCE-TEST\0v1\0", { label });
  const receipt = (
    state: ParticipantStartReceiptV1["state"],
    options: {
      mode?: ParticipantStartReceiptV1["reconciliation_mode"];
      native?: string | null;
      process?: string | null;
      observedAt?: string | null;
      cancellationMode?: ParticipantStartReceiptV1["cancellation_mode"];
    } = {},
  ) => {
    const identity = {
      operation_id: operationId,
      participant_id: "participant-a",
      start_generation: 0,
    };
    const cancellationMode = options.cancellationMode ?? null;
    const input = {
      ...identity,
      attempt_key: participantStartAttemptKey(identity),
      state,
      engine: "codex" as const,
      model: "gpt-5.4",
      adapter_fingerprint: "adapter-a",
      reconciliation_mode:
        options.mode ?? PARTICIPANT_START_RECONCILIATION_MODE.PROVIDER_IDEMPOTENCY,
      cancel_attempt_key: null as string | null,
      cancellation_mode: cancellationMode,
      shared_prompt_digest: evidence("prompt"),
      wrapper_digest: evidence("wrapper"),
      private_native_session_ref: options.native ?? null,
      private_native_session_producer_receipt_digest: options.native
        ? evidence(`${options.native}-producer`)
        : null,
      private_process_lease_ref: options.process ?? null,
      private_process_lease_producer_receipt_digest: options.process
        ? evidence(`${options.process}-producer`)
        : null,
      prepared_at: "2026-08-25T00:00:00.000Z",
      observed_at: options.observedAt ?? null,
    };
    if (cancellationMode) input.cancel_attempt_key = participantCancelAttemptKey(input);
    return materializeParticipantStartReceipt(input);
  };

  const processObserved = receipt(PUBLIC_OPERATION_PARTICIPANT_START_PHASE.OBSERVED, {
    mode: PARTICIPANT_START_RECONCILIATION_MODE.VF_PROCESS_LEASE,
    process: evidence("lease-a"),
    observedAt: "2026-08-25T00:00:01.000Z",
  });
  expect(processObserved.private_native_session_ref).toBeNull();
  expect(() =>
    receipt(PUBLIC_OPERATION_PARTICIPANT_START_PHASE.OBSERVED, {
      mode: PARTICIPANT_START_RECONCILIATION_MODE.VF_PROCESS_LEASE,
      native: evidence("native-competing"),
      process: evidence("lease-competing"),
      observedAt: "2026-08-25T00:00:01.000Z",
    }),
  ).toThrow("does not match reconciliation mode");
  expect(() =>
    receipt(PUBLIC_OPERATION_PARTICIPANT_START_PHASE.ACCEPTED, {
      observedAt: "2026-08-25T00:00:01.000Z",
    }),
  ).toThrow("does not match reconciliation mode");

  const observed = receipt(PUBLIC_OPERATION_PARTICIPANT_START_PHASE.OBSERVED, {
    native: evidence("native-a"),
    observedAt: "2026-08-25T00:00:01.000Z",
  });
  const changedEvidence = receipt(PUBLIC_OPERATION_PARTICIPANT_START_PHASE.ACCEPTED, {
    native: evidence("native-b"),
    observedAt: "2026-08-25T00:00:01.000Z",
  });
  expect(() => advanceParticipantReceipt(observed, changedEvidence)).toThrow(
    "immutable evidence binding changed",
  );
  const changedObservation = receipt(PUBLIC_OPERATION_PARTICIPANT_START_PHASE.ACCEPTED, {
    native: evidence("native-a"),
    observedAt: "2026-08-25T00:00:02.000Z",
  });
  expect(() => advanceParticipantReceipt(observed, changedObservation)).toThrow(
    "immutable evidence binding changed",
  );

  const accepted = receipt(PUBLIC_OPERATION_PARTICIPANT_START_PHASE.ACCEPTED, {
    native: evidence("native-a"),
    observedAt: "2026-08-25T00:00:01.000Z",
  });
  const canceling = receipt(PUBLIC_OPERATION_PARTICIPANT_START_PHASE.CANCEL_IN_PROGRESS, {
    native: evidence("native-a"),
    observedAt: "2026-08-25T00:00:01.000Z",
    cancellationMode: "idempotent-cancel",
  });
  expect(() => advanceParticipantReceipt(accepted, canceling)).not.toThrow();
  const changedCancellation = receipt(PUBLIC_OPERATION_PARTICIPANT_START_PHASE.CANCELED, {
    native: evidence("native-a"),
    observedAt: "2026-08-25T00:00:01.000Z",
    cancellationMode: "inspect-cancel",
  });
  expect(() => advanceParticipantReceipt(canceling, changedCancellation)).toThrow(
    "immutable evidence binding changed",
  );
});
