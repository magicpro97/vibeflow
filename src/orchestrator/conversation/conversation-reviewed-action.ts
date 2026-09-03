import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import {
  ACTION_OPERATION_STATE,
  type DurableActionAuthorityReaderV1,
  assertDurableActionAuthorityReaderV1,
} from "../../actions/index.js";
import { ACTION_DECISION, ACTION_DOMAIN } from "../../actions/public-action-contract.js";
import { canonicalJsonBytes, digestV1, privateFileBytes } from "../../durability/index.js";
import type { InternalTraceStoreRecord } from "../trace/types.js";
import type { ConversationArtifactEntry } from "./artifact-store.js";
import {
  type ConversationActionAuthorityBindingV1,
  ConversationActionReceiptStore,
  type ConversationReceiptProposalPlanV1,
} from "./conversation-action-receipt-store.js";
import { validatePublicCompactionArtifact } from "./conversation-active-compaction.js";
import {
  CONVERSATION_ARTIFACT_TYPE,
  CONVERSATION_TRACE_EVENT_KIND,
} from "./conversation-public-wire-contract.js";
import { sameCanonical } from "./lineage-action-authority.js";

const PROPOSAL = /^vf-proposal-[0-9a-f]{64}$/;
const OPERATION = /^vf-operation-[0-9a-f]{64}$/;

export interface ConversationReviewedActionAuthorityV1 {
  readonly reader: DurableActionAuthorityReaderV1;
  readPlan(proposalId: string): ReturnType<ConversationActionReceiptStore["readPlan"]>;
  readReceipt(proposalId: string): ReturnType<ConversationActionReceiptStore["read"]>;
  readBinding(bindingDigest: string): ConversationActionAuthorityBindingV1 | null;
}

const aggregateMinted = new WeakSet<object>();

class ConversationReviewedActionAuthority implements ConversationReviewedActionAuthorityV1 {
  readonly reader: DurableActionAuthorityReaderV1;

  constructor(
    reader: DurableActionAuthorityReaderV1,
    private readonly receipts: ConversationActionReceiptStore,
  ) {
    assertDurableActionAuthorityReaderV1(reader);
    if (
      Object.getPrototypeOf(receipts) !== ConversationActionReceiptStore.prototype ||
      receipts.actionRootPath !== reader.action_root_path
    )
      throw new Error("reviewed conversation action stores do not share one concrete root");
    this.reader = reader;
    aggregateMinted.add(this);
    Object.freeze(this);
  }

  readPlan(proposalId: string) {
    return this.receipts.readPlan(proposalId);
  }

  readReceipt(proposalId: string) {
    return this.receipts.read(proposalId);
  }

  readBinding(bindingDigest: string) {
    return this.receipts.readBinding(bindingDigest);
  }
}

export function createConversationReviewedActionAuthorityV1(
  reader: DurableActionAuthorityReaderV1,
  receipts: ConversationActionReceiptStore,
): ConversationReviewedActionAuthorityV1 {
  return new ConversationReviewedActionAuthority(reader, receipts);
}

export function assertConversationReviewedActionAuthorityV1(
  value: unknown,
): asserts value is ConversationReviewedActionAuthorityV1 {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== ConversationReviewedActionAuthority.prototype ||
    !aggregateMinted.has(value)
  )
    throw new Error("untrusted conversation reviewed action authority");
}

export interface ReviewedActionEventAuthorityV1 {
  has(eventId: string): boolean;
}

const minted = new WeakSet<object>();

class ReviewedActionEventAuthority implements ReviewedActionEventAuthorityV1 {
  constructor(private readonly eventIds: ReadonlySet<string>) {
    minted.add(this);
    Object.freeze(this);
  }

  has(eventId: string): boolean {
    return this.eventIds.has(eventId);
  }
}

export function assertReviewedActionEventAuthorityV1(
  value: unknown,
): asserts value is ReviewedActionEventAuthorityV1 {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== ReviewedActionEventAuthority.prototype ||
    !minted.has(value)
  )
    throw new Error("untrusted reviewed action event authority");
}

function proposalId(record: InternalTraceStoreRecord): string | null {
  const stored = record.stored_event;
  const compaction = stored.idempotency_key.match(
    /^action-context-compaction:(vf-proposal-[0-9a-f]{64})$/,
  );
  if (
    compaction &&
    stored.event.type === CONVERSATION_TRACE_EVENT_KIND.ARTIFACT_CREATED &&
    stored.event.payload.artifact_type === CONVERSATION_ARTIFACT_TYPE.COMPACTION
  )
    return compaction[1] ?? null;
  const literal = stored.idempotency_key.match(
    /^action-public-literal:(vf-proposal-[0-9a-f]{64})$/,
  );
  return literal && stored.event.type === CONVERSATION_TRACE_EVENT_KIND.USER_MESSAGE
    ? (literal[1] ?? null)
    : null;
}

function eventMatchesPlan(
  artifactRoot: string,
  artifacts: readonly ConversationArtifactEntry[],
  record: InternalTraceStoreRecord,
  plan: ConversationReceiptProposalPlanV1,
): boolean {
  const event = record.stored_event.event;
  const binding = plan.native_plan.effect_binding as Record<string, unknown>;
  if (event.type === CONVERSATION_TRACE_EVENT_KIND.ARTIFACT_CREATED) {
    const expectedId = `vf-compaction-${String(binding.proposed_compaction_artifact_digest).slice(7)}`;
    const entry = artifacts.find((candidate) => candidate.ref === event.payload.ref);
    if (
      event.payload.artifact_id !== expectedId ||
      event.payload.artifact_type !== CONVERSATION_ARTIFACT_TYPE.COMPACTION ||
      !/^vf-artifact-[0-9a-f]{64}$/.test(event.payload.ref) ||
      !entry ||
      entry.artifact_id !== expectedId ||
      entry.artifact_type !== CONVERSATION_ARTIFACT_TYPE.COMPACTION ||
      entry.previous_ref !== null ||
      entry.idempotency_key !== `compaction-artifact-${plan.proposal_id.slice(-32)}`
    )
      return false;
    const bytes = privateFileBytes(
      join(artifactRoot, "content", `${event.payload.ref.slice("vf-artifact-".length)}.bin`),
      1024 * 1024,
    );
    if (!bytes) return false;
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== entry.content_hash) return false;
    const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!canonicalJsonBytes(decoded).equals(bytes)) return false;
    return (
      validatePublicCompactionArtifact(decoded).content_digest ===
      binding.proposed_compaction_artifact_digest
    );
  }
  return (
    event.type === CONVERSATION_TRACE_EVENT_KIND.USER_MESSAGE &&
    digestV1("VF-PUBLIC-LITERAL-EVENT-CONTENT\0v1\0", event.payload) ===
      binding.projected_public_event_content_digest
  );
}

/** Returns only post-terminal events bound to exact durable proposal and dispatch bytes. */
export function reviewedActionEventIds(
  artifactRoot: string,
  authority: ConversationReviewedActionAuthorityV1 | undefined,
  artifacts: readonly ConversationArtifactEntry[],
  records: readonly InternalTraceStoreRecord[],
): ReviewedActionEventAuthorityV1 {
  const reviewed = new Set<string>();
  if (!authority) return new ReviewedActionEventAuthority(reviewed);
  assertConversationReviewedActionAuthorityV1(authority);
  if (authority.reader.action_root_path !== realpathSync(artifactRoot))
    throw new Error("reviewed action root authority mismatch");
  for (const record of records) {
    const id = proposalId(record);
    const operationId = record.stored_event.operation_id;
    if (!id || !PROPOSAL.test(id) || !OPERATION.test(operationId)) continue;
    try {
      const snapshot = authority.reader.get(id);
      const dispatch = authority.reader.getDispatch(operationId);
      const plan = authority.readPlan(id);
      const expectedType =
        record.stored_event.event.type === CONVERSATION_TRACE_EVENT_KIND.USER_MESSAGE
          ? HOST_ACTION_KIND.CONVERSATION_PUBLISH_SUSPECTED_LITERAL
          : HOST_ACTION_KIND.CONTEXT_COMPACT;
      if (
        !snapshot ||
        !dispatch ||
        !plan ||
        !snapshot.approval ||
        snapshot.approval.decision !== ACTION_DECISION.APPROVED ||
        (snapshot.state !== ACTION_OPERATION_STATE.COMMITTING &&
          snapshot.state !== ACTION_OPERATION_STATE.SUCCEEDED) ||
        snapshot.operation_id !== operationId ||
        snapshot.proposal.proposal_id !== id ||
        snapshot.proposal.proposal_digest !== plan.proposal_digest ||
        !sameCanonical(snapshot.proposal, plan.proposal) ||
        plan.native_plan.action_type !== expectedType ||
        plan.native_plan.root_session_id !== snapshot.proposal.base.root_session_id ||
        dispatch.operation_id !== operationId ||
        dispatch.proposal_id !== id ||
        dispatch.proposal_digest !== snapshot.proposal.proposal_digest ||
        dispatch.approval_id !== snapshot.approval.approval_id ||
        dispatch.approval_digest !== snapshot.approval.approval_digest ||
        dispatch.action_type !== expectedType ||
        dispatch.domain !== ACTION_DOMAIN.CONVERSATION ||
        dispatch.plan_digest !== snapshot.proposal.plan_digest ||
        dispatch.domain_header_digest !== null ||
        dispatch.created_at !== snapshot.approval.decided_at ||
        snapshot.dispatch_record_digest !== dispatch.dispatch_record_digest ||
        snapshot.proposal.action.type !== expectedType ||
        !eventMatchesPlan(artifactRoot, artifacts, record, plan)
      )
        continue;
      const receipt = authority.readReceipt(id);
      if (snapshot.state === ACTION_OPERATION_STATE.SUCCEEDED) {
        if (
          !receipt ||
          receipt.outcome !== ACTION_OPERATION_STATE.SUCCEEDED ||
          receipt.operation_id !== operationId ||
          receipt.proposal_id !== id ||
          receipt.approval_id !== snapshot.approval.approval_id ||
          receipt.action_type !== expectedType ||
          receipt.plan_digest !== snapshot.proposal.plan_digest ||
          receipt.reason_code !== null ||
          receipt.receipt_digest !== snapshot.domain_terminal_digest ||
          receipt.recorded_at !== record.stored_event.ts ||
          !authority.readBinding(receipt.expected_authority_binding_digest) ||
          !authority.readBinding(receipt.observed_authority_binding_digest)
        )
          continue;
      } else if (receipt || snapshot.domain_terminal_digest !== null) continue;
      reviewed.add(record.stored_event.event_id);
    } catch {
      // A malformed or missing authority record never upgrades the trace event.
    }
  }
  return new ReviewedActionEventAuthority(reviewed);
}
