import {
  type ActionProposalRequestV1,
  type ActionRequestAuthorityV1,
  type BrowserHostActionRequestV1,
  type JsonValue,
  type SuspectedLiteralPublicationBindingV1,
  deriveOperationId,
} from "../../actions/index.js";
import { canonicalJsonBytes, digestV1 } from "../../durability/index.js";
import type { TraceStore } from "../trace/store.js";
import type { StoredTraceEvent, TraceCorrelation } from "../trace/types.js";
import { conversationLockDigest } from "./catalog-lock.js";
import {
  type ConversationActionAuthorityBindingV1,
  materializeConversationActionBinding,
  materializeConversationActionReceipt,
} from "./conversation-action-receipt-store.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import { assertReceiptSource } from "./conversation-receipt-native-plans.js";
import { materializeConversationReceiptProposal } from "./conversation-receipt-planner.js";
import type { ConversationLineageService } from "./lineage-service.js";

function same(left: unknown, right: unknown): boolean {
  return canonicalJsonBytes(left).equals(canonicalJsonBytes(right));
}

function isLiteralCandidate(
  candidate: BrowserHostActionRequestV1,
): candidate is Extract<
  BrowserHostActionRequestV1,
  { type: "conversation.publish_suspected_literal" }
> {
  return candidate.type === "conversation.publish_suspected_literal";
}

function eventDigest(event: StoredTraceEvent): string {
  return digestV1("VF-PUBLIC-LITERAL-PUBLICATION-EVENT\0v1\0", event);
}

function sortedFacts(facts: ConversationActionAuthorityBindingV1["facts"]) {
  return facts.sort((left, right) =>
    Buffer.compare(
      Buffer.from(`${left.kind}\0${left.identity}`),
      Buffer.from(`${right.kind}\0${right.identity}`),
    ),
  );
}

export class ConversationLiteralActionAuthority {
  constructor(
    private readonly options: {
      lineages: ConversationLineageService;
      home: ConversationHomeAuthorities;
      traceStore: TraceStore;
    },
  ) {}

  async propose(input: {
    conversation_id: string;
    request: ActionProposalRequestV1;
    authority: ActionRequestAuthorityV1;
  }) {
    const candidate = input.request.candidate;
    if (!isLiteralCandidate(candidate)) throw new Error("not a public literal request");
    const resolved = this.options.lineages.resolve(input.conversation_id);
    assertReceiptSource(resolved, input.request);
    const record = this.options.home.literalStaging.readRecord(candidate.private_staging_id);
    if (!record) throw new Error("literal staging record is absent");
    const binding = this.options.home.literalStaging.binding(record);
    if (
      record.root_session_id !== resolved.lineage.root_session_id ||
      record.conversation_id !== resolved.requested.node.conversation_id ||
      record.revision_id !== resolved.requested.node.revision_id ||
      binding.staging_record_digest !== candidate.staging_record_digest ||
      binding.staged_content_digest !== candidate.staged_content_digest ||
      binding.findings_digest !== candidate.findings_digest
    )
      throw new Error("literal staging request binding changed");
    const content = this.options.home.literalStaging.content(binding);
    const createdAt = this.options.home.now();
    if (Date.parse(createdAt) >= Date.parse(binding.expires_at))
      throw new Error("literal staging record expired");
    const projected = {
      content,
      target_participants: "all" as const,
    };
    const planPreimage = {
      schema_version: "1.0" as const,
      root_session_id: resolved.lineage.root_session_id,
      conversation_id: resolved.requested.node.conversation_id,
      revision_id: resolved.requested.node.revision_id,
      expected_last_seq: resolved.requested.source.journal_head.last_seq,
      expected_conversation_lock_digest: input.request.expected.conversation_lock_digest,
      binding,
      projected_public_event_content_digest: digestV1(
        "VF-PUBLIC-LITERAL-EVENT-CONTENT\0v1\0",
        projected,
      ),
      created_at: createdAt,
      expires_at: binding.expires_at,
    };
    const plan = {
      ...planPreimage,
      plan_digest: digestV1("VF-PUBLIC-LITERAL-PUBLICATION-PLAN\0v1\0", planPreimage),
    };
    const lock = conversationLockDigest(
      resolved.lineage.root_session_id,
      resolved.requested.source,
      resolved.revision_claim_epoch,
    );
    const planned = materializeConversationReceiptProposal({
      source: {
        root_session_id: resolved.lineage.root_session_id,
        conversation_id: resolved.requested.node.conversation_id,
        revision_id: resolved.requested.node.revision_id,
        last_seq: resolved.requested.source.journal_head.last_seq,
        conversation_lock_digest: lock,
        head: resolved.head,
      },
      request: input.request,
      action: { type: candidate.type, binding },
      authority: input.authority,
      effect_binding: plan as unknown as JsonValue,
      native_step: { kind: "public-literal-publication", digest: plan.plan_digest },
      created_at: createdAt,
    });
    this.options.home.actionReceipts.writePlan(planned.proposal_plan);
    this.options.home.literalStaging.reserve(binding, planned.proposal.proposal_id, createdAt);
    const created = this.options.home.actions.create(planned.proposal_plan, input.authority);
    return { created: created.created, proposal_id: created.proposal.proposal_id };
  }

  private correlation(
    proposalId: string,
    operationId: string,
    manifest: {
      workflow_id: string;
      conversation_id: string;
      revision_id: string;
      run_id: string;
    },
  ): TraceCorrelation {
    const suffix = proposalId.slice("vf-proposal-".length, "vf-proposal-".length + 32);
    return {
      workflow_id: manifest.workflow_id,
      conversation_id: manifest.conversation_id,
      revision_id: manifest.revision_id,
      run_id: manifest.run_id,
      turn_id: `action-turn-${suffix}`,
      operation_id: operationId,
      attempt_id: `action-attempt-${suffix}`,
    };
  }

  private async published(
    conversationId: string,
    proposalId: string,
  ): Promise<StoredTraceEvent | null> {
    return (
      (await this.options.traceStore.readConversation(conversationId)).find(
        ({ stored_event: event }) =>
          event.idempotency_key === `action-public-literal:${proposalId}`,
      )?.stored_event ?? null
    );
  }

  async commit(proposalId: string): Promise<void> {
    const snapshot = this.options.home.actions.get(proposalId);
    const stored = this.options.home.actionReceipts.readPlan(proposalId);
    const binding =
      snapshot?.proposal.action.type === "conversation.publish_suspected_literal"
        ? snapshot.proposal.action.binding
        : null;
    if (!snapshot?.approval || !stored || !binding)
      throw new Error("public literal approval is absent");
    const operationId =
      snapshot.operation_id ?? deriveOperationId(snapshot.proposal, snapshot.approval.approval_id);
    const receipt = this.options.home.actionReceipts.read(proposalId);
    if (receipt) {
      this.options.home.actions.terminal(proposalId, operationId, {
        outcome: receipt.outcome,
        digest: receipt.receipt_digest,
        recorded_at: receipt.recorded_at,
      });
      return;
    }
    const plan = stored.native_plan.effect_binding as unknown as {
      expected_last_seq: number;
      expected_conversation_lock_digest: string;
      projected_public_event_content_digest: string;
      binding: SuspectedLiteralPublicationBindingV1;
    };
    if (!same(plan.binding, binding)) throw new Error("public literal plan binding changed");
    const content = this.options.home.literalStaging.content(binding);
    const projected = { content, target_participants: "all" as const };
    if (
      digestV1("VF-PUBLIC-LITERAL-EVENT-CONTENT\0v1\0", projected) !==
      plan.projected_public_event_content_digest
    )
      throw new Error("public literal projection changed");
    const resolved = this.options.lineages.resolve(stored.native_plan.expected.conversation_id);
    const source = resolved.requested.source;
    const already = await this.published(source.manifest.conversation_id, proposalId);
    if (
      !already &&
      (source.journal_head.last_seq !== plan.expected_last_seq ||
        conversationLockDigest(
          resolved.lineage.root_session_id,
          source,
          resolved.revision_claim_epoch,
        ) !== plan.expected_conversation_lock_digest)
    )
      throw new Error("public literal source head changed");
    const dispatch = this.options.home.actions.dispatch(proposalId, snapshot.approval.approval_id, {
      digest: stored.record_digest,
      recorded_at: snapshot.approval.decided_at,
    });
    const event =
      already ??
      (await this.options.traceStore.append(
        this.correlation(proposalId, dispatch.operation_id, source.manifest),
        {
          idempotency_key: `action-public-literal:${proposalId}`,
          event: { type: "user_message", payload: projected },
        },
        null,
        plan.expected_last_seq,
      ));
    const publicationDigest = eventDigest(event);
    this.options.home.literalStaging.consume(
      binding,
      proposalId,
      dispatch.operation_id,
      publicationDigest,
      event.ts,
    );
    const consumed = this.options.home.literalStaging.readFrames(binding.private_staging_id).at(-1);
    if (!consumed) throw new Error("public literal consumption is absent");
    const expected = materializeConversationActionBinding({
      action_type: "conversation.publish_suspected_literal",
      plan_digest: snapshot.proposal.plan_digest,
      phase: "expected",
      facts: sortedFacts([
        {
          kind: "conversation-lock",
          identity: `conversation:${source.manifest.conversation_id}`,
          content_digest: plan.expected_conversation_lock_digest,
        },
        {
          kind: "public-trace-head",
          identity: `trace:${source.manifest.revision_id}`,
          content_digest: source.journal_head.record_digest,
        },
        {
          kind: "literal-staging",
          identity: `literal:${binding.private_staging_id}`,
          content_digest: binding.staging_record_digest,
        },
      ]),
    });
    const observed = materializeConversationActionBinding({
      action_type: "conversation.publish_suspected_literal",
      plan_digest: snapshot.proposal.plan_digest,
      phase: "observed",
      facts: sortedFacts([
        {
          kind: "conversation-lock",
          identity: `conversation:${source.manifest.conversation_id}`,
          content_digest: plan.expected_conversation_lock_digest,
        },
        {
          kind: "public-trace-head",
          identity: `trace:${source.manifest.revision_id}`,
          content_digest: publicationDigest,
        },
        {
          kind: "literal-staging",
          identity: `literal:${binding.private_staging_id}`,
          content_digest: consumed.frame_digest,
        },
      ]),
    });
    const terminal = materializeConversationActionReceipt({
      operation_id: dispatch.operation_id,
      proposal_id: proposalId,
      approval_id: snapshot.approval.approval_id,
      action_type: "conversation.publish_suspected_literal",
      plan_digest: snapshot.proposal.plan_digest,
      expected_authority_binding_digest: expected.binding_digest,
      observed_authority_binding_digest: observed.binding_digest,
      outcome: "succeeded",
      reason_code: null,
      recorded_at: event.ts,
    });
    this.options.home.actionReceipts.writeBinding(expected);
    this.options.home.actionReceipts.writeBinding(observed);
    this.options.home.actionReceipts.append(terminal);
    this.options.home.actions.terminal(proposalId, dispatch.operation_id, {
      outcome: "succeeded",
      digest: terminal.receipt_digest,
      recorded_at: terminal.recorded_at,
    });
  }
}
