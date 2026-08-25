import { digestV1 } from "../../durability/index.js";
import {
  type RevisionHeadCommitEventV1,
  assertRevisionHeadCommitEventV1,
} from "./lineage-revision-operation.js";
import {
  LINEAGE_LIMITS,
  hasExactLineageKeys,
  isBoundedLineageReference,
  isLineageDigest,
  isMillisecondIsoDate,
  isPlainLineageRecord,
} from "./lineage-types.js";

const OPERATION_ID = /^vf-operation-[0-9a-f]{64}$/;
const PREPUBLICATION_EDGES = new Set(["created\0preparing", "preparing\0prepared"]);

interface RevisionStateTransitionEventV1 {
  schema_version: "1.0";
  operation_id: string;
  sequence: number;
  previous_event_digest: string | null;
  payload: {
    kind: "state-transition";
    from: "created" | "preparing";
    to: "preparing" | "prepared";
    authorized_by_action_operation_id: string;
    effect_action_operation_id: string;
    action_terminals: [];
    reason_code: null;
  };
  recorded_at: string;
  event_digest: string;
}

function assertStateTransitionEvent(
  value: unknown,
): asserts value is RevisionStateTransitionEventV1 {
  if (
    !isPlainLineageRecord(value) ||
    !hasExactLineageKeys(value, [
      "event_digest",
      "operation_id",
      "payload",
      "previous_event_digest",
      "recorded_at",
      "schema_version",
      "sequence",
    ]) ||
    value.schema_version !== "1.0" ||
    typeof value.operation_id !== "string" ||
    !OPERATION_ID.test(value.operation_id) ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 0 ||
    (value.previous_event_digest !== null && !isLineageDigest(value.previous_event_digest)) ||
    !isMillisecondIsoDate(value.recorded_at) ||
    !isLineageDigest(value.event_digest) ||
    !isPlainLineageRecord(value.payload) ||
    !hasExactLineageKeys(value.payload, [
      "action_terminals",
      "authorized_by_action_operation_id",
      "effect_action_operation_id",
      "from",
      "kind",
      "reason_code",
      "to",
    ]) ||
    value.payload.kind !== "state-transition" ||
    !isBoundedLineageReference(value.payload.from) ||
    !isBoundedLineageReference(value.payload.to) ||
    !PREPUBLICATION_EDGES.has(`${value.payload.from}\0${value.payload.to}`) ||
    typeof value.payload.authorized_by_action_operation_id !== "string" ||
    !OPERATION_ID.test(value.payload.authorized_by_action_operation_id) ||
    typeof value.payload.effect_action_operation_id !== "string" ||
    !OPERATION_ID.test(value.payload.effect_action_operation_id) ||
    !Array.isArray(value.payload.action_terminals) ||
    value.payload.action_terminals.length !== 0 ||
    value.payload.reason_code !== null
  )
    throw new Error("invalid prepublication revision event");
  const { event_digest: _digest, ...preimage } = value;
  if (digestV1("VF-REVISION-OPERATION-EVENT\0v1\0", preimage) !== value.event_digest)
    throw new Error("invalid prepublication revision event digest");
}

export function assertRevisionOperationEventChainV1(
  value: unknown,
  operationId: string,
): RevisionHeadCommitEventV1 {
  if (!Array.isArray(value) || value.length !== 3 || value.length > LINEAGE_LIMITS.maxNodes)
    throw new Error("invalid revision operation event chain");
  let previousDigest: string | null = null;
  let previousTimestamp: string | null = null;
  let state: "created" | "preparing" | "prepared" = "created";
  for (let index = 0; index < value.length - 1; index += 1) {
    const event = value[index];
    assertStateTransitionEvent(event);
    if (
      event.operation_id !== operationId ||
      event.sequence !== index ||
      event.previous_event_digest !== previousDigest ||
      event.payload.from !== state ||
      event.payload.authorized_by_action_operation_id !== operationId ||
      event.payload.effect_action_operation_id !== operationId ||
      (previousTimestamp !== null && event.recorded_at < previousTimestamp)
    )
      throw new Error("revision operation event chain is discontinuous");
    state = event.payload.to;
    previousDigest = event.event_digest;
    previousTimestamp = event.recorded_at;
  }
  const commit = value.at(-1);
  assertRevisionHeadCommitEventV1(commit);
  if (
    state !== "prepared" ||
    commit.operation_id !== operationId ||
    commit.sequence !== value.length - 1 ||
    commit.previous_event_digest !== previousDigest ||
    (previousTimestamp !== null && commit.recorded_at < previousTimestamp)
  )
    throw new Error("revision head commit does not close the dense event chain");
  return structuredClone(commit);
}
