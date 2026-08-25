import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import type { RevisionOperationV1 } from "./lineage-revision-operation.js";
import type { ConversationLineageService } from "./lineage-service.js";
import { foldRevisionOperation } from "./revision-fold.js";
import type { ParticipantStartReceiptV1 } from "./revision-participant-receipt.js";
import type { RevisionOperationEventV1, RevisionOperationStateV1 } from "./revision-planner.js";

export type RevisionRecoveryInspectionV1 =
  | {
      kind: "proved";
      state: Exclude<RevisionOperationStateV1, "abandoned" | "needs_recovery">;
      evidence_digest: string;
    }
  | { kind: "inconclusive"; reason_code: string };

function participantReceipts(events: readonly RevisionOperationEventV1[]) {
  const latest = new Map<string, ParticipantStartReceiptV1>();
  for (const event of events)
    if (event.payload.kind === "participant-start")
      latest.set(event.payload.receipt.participant_id, event.payload.receipt);
  return latest;
}

function publishedHead(
  home: ConversationHomeAuthorities,
  lineages: ConversationLineageService,
  operation: RevisionOperationV1,
  events: readonly RevisionOperationEventV1[],
): "prior" | "child" | "unknown" {
  let resolved: ReturnType<ConversationLineageService["resolve"]>;
  try {
    resolved = lineages.resolve(operation.root_session_id);
  } catch {
    resolved = lineages.resolveRevisionRecovery(
      operation.parent.conversation_id,
      operation.root_session_id,
      operation.operation_id,
    );
  }
  const head = resolved.head;
  if (head.content_digest === operation.expected_head_digest) return "prior";
  const commit = [...events].reverse().find((event) => event.payload.kind === "head-commit");
  const published = home
    .publishedRevisionTransitions()
    .find(
      ({ authority }) =>
        (authority as { operation?: { operation_id?: string } }).operation?.operation_id ===
        operation.operation_id,
    );
  if (
    commit?.payload.kind === "head-commit" &&
    commit.payload.committed_head_digest === head.content_digest &&
    (published?.committed_head as { content_digest?: string } | undefined)?.content_digest ===
      head.content_digest &&
    head.updated_by_operation_id === operation.operation_id &&
    head.active?.conversation_id === operation.child.conversation_id &&
    head.active.revision_id === operation.child.revision_id
  )
    return "child";
  return "unknown";
}

function exactLaneSet(
  home: ConversationHomeAuthorities,
  operation: RevisionOperationV1,
  receipts: ReadonlyMap<string, ParticipantStartReceiptV1>,
): ParticipantStartReceiptV1[] | null {
  const plan = home.revisions.readPlan(operation.operation_id);
  if (!plan || plan.participant_starts.length === 0) return null;
  const ids = plan.participant_starts.map(({ participant_id }) => participant_id);
  if (
    receipts.size !== ids.length ||
    ids.some((id) => !receipts.has(id)) ||
    [...receipts.keys()].some((id) => !ids.includes(id))
  )
    return null;
  return ids.map((id) => receipts.get(id) as ParticipantStartReceiptV1);
}

function lanesAreProved(
  home: ConversationHomeAuthorities,
  operation: RevisionOperationV1,
  lanes: readonly ParticipantStartReceiptV1[],
): boolean {
  const plan = home.revisions.readPlan(operation.operation_id);
  return Boolean(
    plan &&
      lanes.length === plan.participant_starts.length &&
      plan.participant_starts.every((participant, index) => {
        const receipt = lanes[index];
        return Boolean(
          receipt && home.revisionLanes.receiptIsProved(operation, participant, receipt),
        );
      }),
  );
}

export function inspectRevisionRecovery(input: {
  home: ConversationHomeAuthorities;
  lineages: ConversationLineageService;
  operation: RevisionOperationV1;
  events: readonly RevisionOperationEventV1[];
  quiescent: boolean;
}): RevisionRecoveryInspectionV1 {
  const folded = foldRevisionOperation(input.operation, input.events);
  if (folded.state !== "needs_recovery")
    return { kind: "inconclusive", reason_code: "state-no-longer-needs-recovery" };
  const head = publishedHead(input.home, input.lineages, input.operation, input.events);
  const receipts = participantReceipts(input.events);
  if (head === "prior" && receipts.size === 0 && input.quiescent) {
    const prepared = input.home.revisions.readPreparedTransition(input.operation.operation_id);
    return {
      kind: "proved",
      state: prepared ? "prepared" : "preparing",
      evidence_digest: folded.state_digest,
    };
  }
  if (head !== "child") return { kind: "inconclusive", reason_code: "revision-head-is-not-proved" };
  const lanes = exactLaneSet(input.home, input.operation, receipts);
  if (!lanes) {
    const recovery = [...input.events]
      .reverse()
      .find(
        (event) =>
          event.payload.kind === "state-transition" && event.payload.to === "needs_recovery",
      );
    if (
      input.quiescent &&
      receipts.size === 0 &&
      recovery?.payload.kind === "state-transition" &&
      recovery.payload.from === "published"
    )
      return { kind: "proved", state: "published", evidence_digest: folded.state_digest };
    return { kind: "inconclusive", reason_code: "participant-evidence-is-incomplete" };
  }
  if (
    lanes.every(({ state }) => state === "accepted") &&
    lanesAreProved(input.home, input.operation, lanes)
  )
    return { kind: "proved", state: "started", evidence_digest: folded.state_digest };
  if (
    input.quiescent &&
    lanes.some(({ state }) => state === "failed") &&
    lanes.every(({ state }) => state === "failed" || state === "canceled") &&
    lanesAreProved(input.home, input.operation, lanes)
  )
    return { kind: "proved", state: "start_failed", evidence_digest: folded.state_digest };
  return { kind: "inconclusive", reason_code: "participant-effect-is-not-quiescent" };
}

export function revisionAbandonIsProved(input: {
  home: ConversationHomeAuthorities;
  lineages: ConversationLineageService;
  operation: RevisionOperationV1;
  events: readonly RevisionOperationEventV1[];
  quiescent: boolean;
}): boolean {
  const folded = foldRevisionOperation(input.operation, input.events);
  if (!["preparing", "prepared", "needs_recovery"].includes(folded.state)) return false;
  const recovery = [...input.events]
    .reverse()
    .find(
      (event) => event.payload.kind === "state-transition" && event.payload.to === "needs_recovery",
    );
  if (
    folded.state === "needs_recovery" &&
    (recovery?.payload.kind !== "state-transition" ||
      !["preparing", "prepared"].includes(recovery.payload.from))
  )
    return false;
  return (
    input.quiescent &&
    participantReceipts(input.events).size === 0 &&
    publishedHead(input.home, input.lineages, input.operation, input.events) === "prior" &&
    !input.home
      .publishedRevisionTransitions()
      .some(
        ({ authority }) =>
          (authority as { operation?: { operation_id?: string } }).operation?.operation_id ===
          input.operation.operation_id,
      )
  );
}

export function revisionRetryIsProved(input: {
  home: ConversationHomeAuthorities;
  lineages: ConversationLineageService;
  operation: RevisionOperationV1;
  events: readonly RevisionOperationEventV1[];
  quiescent: boolean;
}): boolean {
  if (foldRevisionOperation(input.operation, input.events).state !== "start_failed") return false;
  const lanes = exactLaneSet(input.home, input.operation, participantReceipts(input.events));
  return Boolean(
    input.quiescent &&
      publishedHead(input.home, input.lineages, input.operation, input.events) === "child" &&
      lanes?.some(({ state }) => state === "failed") &&
      lanes.every(({ state }) => state === "failed" || state === "canceled") &&
      lanesAreProved(input.home, input.operation, lanes),
  );
}
