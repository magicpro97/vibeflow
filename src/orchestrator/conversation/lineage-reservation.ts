import { digestV1 } from "../../durability/index.js";
import type { ConversationLineageReadV1 } from "./lineage-reader.js";
import {
  type LineageHeadRecordV1,
  type LineageNodeIdentityV1,
  assertLineageNodeIdentityV1,
  hasExactLineageKeys,
  isBoundedLineageReference,
  isLineageDigest,
  isMillisecondIsoDate,
  isPlainLineageRecord,
} from "./lineage-types.js";

const OPERATION_ID = /^vf-operation-[0-9a-f]{64}$/;
const PROPOSAL_ID = /^vf-proposal-[0-9a-f]{64}$/;

export interface RevisionReservationRecordV1 {
  schema_version: "1.0";
  root_session_id: string;
  reservation_epoch: number;
  previous_reservation_digest: string | null;
  status: "active" | "consumed" | "released";
  parent: LineageNodeIdentityV1;
  revision_claim_epoch: number;
  operation_id: string;
  proposal_id: string;
  plan_digest: string;
  child: LineageNodeIdentityV1;
  created_at: string;
  updated_at: string;
  content_digest: string;
}

const key = (node: LineageNodeIdentityV1): string =>
  `${node.conversation_id}\0${node.revision_id}\0${node.revision_ordinal}`;

export function revisionReservationDigest(
  value: Omit<RevisionReservationRecordV1, "content_digest">,
): string {
  return digestV1("VF-REVISION-RESERVATION\0v1\0", value);
}

export function assertRevisionReservationRecordV1(
  value: unknown,
): asserts value is RevisionReservationRecordV1 {
  if (
    !isPlainLineageRecord(value) ||
    !hasExactLineageKeys(value, [
      "child",
      "content_digest",
      "created_at",
      "operation_id",
      "parent",
      "plan_digest",
      "previous_reservation_digest",
      "proposal_id",
      "reservation_epoch",
      "revision_claim_epoch",
      "root_session_id",
      "schema_version",
      "status",
      "updated_at",
    ]) ||
    value.schema_version !== "1.0" ||
    !isBoundedLineageReference(value.root_session_id) ||
    !Number.isSafeInteger(value.reservation_epoch) ||
    (value.reservation_epoch as number) < 1 ||
    !["active", "consumed", "released"].includes(value.status as string) ||
    !Number.isSafeInteger(value.revision_claim_epoch) ||
    (value.revision_claim_epoch as number) < 1 ||
    typeof value.operation_id !== "string" ||
    !OPERATION_ID.test(value.operation_id) ||
    typeof value.proposal_id !== "string" ||
    !PROPOSAL_ID.test(value.proposal_id) ||
    !isLineageDigest(value.plan_digest) ||
    !isMillisecondIsoDate(value.created_at) ||
    !isMillisecondIsoDate(value.updated_at) ||
    value.updated_at < value.created_at ||
    !isLineageDigest(value.content_digest) ||
    (value.previous_reservation_digest !== null &&
      !isLineageDigest(value.previous_reservation_digest)) ||
    ((value.reservation_epoch as number) === 1) !== (value.previous_reservation_digest === null) ||
    (value.status === "active" && value.updated_at !== value.created_at)
  )
    throw new Error("invalid revision reservation");
  assertLineageNodeIdentityV1(value.parent);
  assertLineageNodeIdentityV1(value.child);
  if (
    value.child.revision_ordinal !== value.parent.revision_ordinal + 1 ||
    value.parent.conversation_id === value.child.conversation_id
  )
    throw new Error("invalid revision reservation pair");
  const { content_digest: _digest, ...preimage } = value;
  if (
    revisionReservationDigest(
      preimage as unknown as Omit<RevisionReservationRecordV1, "content_digest">,
    ) !== value.content_digest
  )
    throw new Error("invalid revision reservation digest");
}

function same(left: LineageNodeIdentityV1 | null, right: LineageNodeIdentityV1): boolean {
  return left !== null && key(left) === key(right);
}

export function deriveRevisionClaimEpoch(
  input: unknown | undefined,
  lineage: ConversationLineageReadV1,
  head: LineageHeadRecordV1,
  history: ReadonlyMap<string, unknown> = new Map(),
  requiredPublishedReservationDigest: string | null = null,
): number {
  if (input === undefined) return 0;
  assertRevisionReservationRecordV1(input);
  let current = input;
  const seen = new Set<string>();
  let publishedReservationObserved = requiredPublishedReservationDigest === null;
  while (current.previous_reservation_digest !== null) {
    if (current.content_digest === requiredPublishedReservationDigest)
      publishedReservationObserved = true;
    if (seen.has(current.content_digest)) throw new Error("revision reservation cycle");
    seen.add(current.content_digest);
    const priorInput = history.get(current.previous_reservation_digest);
    if (priorInput === undefined) throw new Error("revision reservation history is absent");
    assertRevisionReservationRecordV1(priorInput);
    const prior = priorInput;
    if (
      prior.content_digest !== current.previous_reservation_digest ||
      current.reservation_epoch !== prior.reservation_epoch + 1 ||
      current.root_session_id !== prior.root_session_id
    )
      throw new Error("revision reservation history is discontinuous");
    if (current.status === "active") {
      if (
        prior.status === "active" ||
        current.revision_claim_epoch !== prior.revision_claim_epoch + 1 ||
        key(current.parent) !== key(prior.status === "consumed" ? prior.child : prior.parent)
      )
        throw new Error("invalid active revision reservation edge");
    } else if (
      prior.status !== "active" ||
      current.revision_claim_epoch !== prior.revision_claim_epoch ||
      current.operation_id !== prior.operation_id ||
      current.proposal_id !== prior.proposal_id ||
      current.plan_digest !== prior.plan_digest ||
      current.created_at !== prior.created_at ||
      key(current.parent) !== key(prior.parent) ||
      key(current.child) !== key(prior.child)
    ) {
      throw new Error("invalid terminal revision reservation edge");
    }
    current = prior;
  }
  if (current.content_digest === requiredPublishedReservationDigest)
    publishedReservationObserved = true;
  if (
    current.reservation_epoch !== 1 ||
    current.status !== "active" ||
    current.revision_claim_epoch !== 1
  )
    throw new Error("invalid initial revision reservation");
  if (input.root_session_id !== lineage.root_session_id || head.head_status !== "committed")
    throw new Error("revision reservation root is not committed");
  const nodes = new Map(lineage.nodes.map((node) => [key(node.node), node]));
  const parent = nodes.get(key(input.parent));
  const child = nodes.get(key(input.child));
  if (!parent || !child || !child.parent || key(child.parent) !== key(parent.node))
    throw new Error("revision reservation pair is not durable lineage");
  if (
    (input.status === "released" && !same(head.active, input.parent)) ||
    (input.status === "consumed" && !same(head.active, input.child)) ||
    (input.status === "active" &&
      !same(head.active, input.parent) &&
      !same(head.active, input.child))
  )
    throw new Error("revision reservation state disagrees with head");
  if (same(head.active, input.child) && input.operation_id !== head.updated_by_operation_id)
    throw new Error("revision reservation operation disagrees with committed head");
  if (!publishedReservationObserved)
    throw new Error("current reservation history omits the published child claim");
  return input.revision_claim_epoch;
}
