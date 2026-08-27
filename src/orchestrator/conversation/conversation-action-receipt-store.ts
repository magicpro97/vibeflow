import { dirname, join, resolve } from "node:path";
import type { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import type {
  ActionOperationDomainTerminalState,
  ActionProposalV1,
  CanonicalActionRequestV1,
  HostActionKind,
  HostActionV1,
} from "../../actions/index.js";
import {
  type JsonValue,
  type ProcessLock,
  acquireProcessLock,
  appendVffrFrame,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestV1,
  ensurePrivateDirectory,
  privateFileBytes,
  readVffrFile,
} from "../../durability/index.js";
import {
  assertConversationActionBinding,
  assertConversationActionReceipt,
  assertConversationReceiptPlan,
} from "./conversation-action-receipt-validation.js";
import type { LineageActionPlanBindingV1 } from "./lineage-action-authority.js";

const MAX_RECORD = 2 * 1024 * 1024;
const MAX_RECEIPTS = 4 * 1024 * 1024;
const PROPOSAL = /^vf-proposal-[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export type ConversationReceiptActionKindV1 = Extract<
  HostActionKind,
  | typeof HOST_ACTION_KIND.CONVERSATION_SELECT_LINEAGE_HEAD
  | typeof HOST_ACTION_KIND.CONVERSATION_ASSOCIATE_LINEAGES
  | typeof HOST_ACTION_KIND.CONVERSATION_PUBLISH_SUSPECTED_LITERAL
  | typeof HOST_ACTION_KIND.CONVERSATION_STOP_OPERATION
  | typeof HOST_ACTION_KIND.CONTEXT_COMPACT
>;

export type ConversationControlActionKindV1 = Extract<
  HostActionKind,
  | typeof HOST_ACTION_KIND.CONVERSATION_ABANDON_REVISION_OPERATION
  | typeof HOST_ACTION_KIND.CONVERSATION_RETRY_REVISION_OPERATION
  | typeof HOST_ACTION_KIND.CONVERSATION_RECONCILE_REVISION_OPERATION
>;

export type ConversationNativeActionKindV1 =
  | ConversationReceiptActionKindV1
  | ConversationControlActionKindV1;

export interface ConversationReceiptNativePlanV1 {
  schema_version: "1.0";
  action_type: ConversationNativeActionKindV1;
  root_session_id: string;
  expected: {
    conversation_id: string;
    revision_id: string;
    last_seq: number;
    conversation_lock_digest: string;
    lineage_head_digest: string;
    lineage_head_epoch: number;
  };
  action: HostActionV1;
  effect_binding: JsonValue;
  created_at: string;
  expires_at: string;
  plan_digest: string;
}

export interface ConversationReceiptProposalPlanV1 {
  schema_version: "1.0";
  proposal_id: string;
  proposal_digest: string;
  proposal: ActionProposalV1;
  canonical_request: CanonicalActionRequestV1;
  action_plan: LineageActionPlanBindingV1;
  native_plan: ConversationReceiptNativePlanV1;
  record_digest: string;
}

export interface ConversationActionAuthorityBindingV1 {
  schema_version: "1.0";
  action_type: ConversationReceiptActionKindV1;
  plan_digest: string;
  phase: "expected" | "observed";
  facts: Array<{
    kind:
      | "conversation-lock"
      | "conversation-operation"
      | "public-trace-head"
      | "lineage-head"
      | "lineage-association"
      | "content-object"
      | "literal-staging";
    identity: string;
    content_digest: string;
  }>;
  binding_digest: string;
}

export interface ConversationActionReceiptV1 {
  schema_version: "1.0";
  operation_id: string;
  sequence: number;
  previous_receipt_digest: string | null;
  proposal_id: string;
  approval_id: string;
  action_type: ConversationReceiptActionKindV1;
  plan_digest: string;
  expected_authority_binding_digest: string;
  observed_authority_binding_digest: string;
  outcome: ActionOperationDomainTerminalState;
  reason_code: string | null;
  recorded_at: string;
  receipt_digest: string;
}

function decode<T>(bytes: Buffer, validate: (value: T) => void): T {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
  validate(value);
  if (!canonicalJsonBytes(value, { maxBytes: MAX_RECORD }).equals(bytes))
    throw new Error("non-canonical conversation receipt authority");
  return structuredClone(value);
}

export function materializeConversationActionBinding(
  input: Omit<ConversationActionAuthorityBindingV1, "schema_version" | "binding_digest">,
): ConversationActionAuthorityBindingV1 {
  const preimage = { schema_version: "1.0" as const, ...structuredClone(input) };
  const binding = {
    ...preimage,
    binding_digest: digestV1("VF-CONVERSATION-ACTION-AUTHORITY-BINDING\0v1\0", preimage),
  };
  assertConversationActionBinding(binding);
  return binding;
}

export function materializeConversationActionReceipt(
  input: Omit<
    ConversationActionReceiptV1,
    "schema_version" | "sequence" | "previous_receipt_digest" | "receipt_digest"
  >,
): ConversationActionReceiptV1 {
  const preimage = {
    schema_version: "1.0" as const,
    operation_id: input.operation_id,
    sequence: 0,
    previous_receipt_digest: null,
    proposal_id: input.proposal_id,
    approval_id: input.approval_id,
    action_type: input.action_type,
    plan_digest: input.plan_digest,
    expected_authority_binding_digest: input.expected_authority_binding_digest,
    observed_authority_binding_digest: input.observed_authority_binding_digest,
    outcome: input.outcome,
    reason_code: input.reason_code,
    recorded_at: input.recorded_at,
  };
  return {
    ...preimage,
    receipt_digest: digestV1("VF-CONVERSATION-ACTION-RECEIPT\0v1\0", preimage),
  };
}

function receiptCodec(
  proposalId: string,
  validate: (receipt: ConversationActionReceiptV1) => void,
) {
  return {
    domain: "conversation-action-receipt" as const,
    maxFrames: 1,
    maxPayloadBytes: MAX_RECORD,
    maxAggregateBytes: MAX_RECEIPTS,
    validatePayload: (payload: Record<string, unknown>) =>
      validate(payload as unknown as ConversationActionReceiptV1),
    computePayloadDigest: (payload: Record<string, unknown>) =>
      (payload as unknown as ConversationActionReceiptV1).receipt_digest,
    validateJournalIdentity: (payload: Record<string, unknown>) =>
      payload.proposal_id === proposalId,
  };
}

export class ConversationActionReceiptStore {
  readonly actionRootPath: string;
  private readonly plans: string;
  private readonly bindings: string;
  private readonly receipts: string;
  private readonly lock: string;

  constructor(artifactRoot: string) {
    const root = ensurePrivateDirectory(join(resolve(artifactRoot), "actions", "v1"));
    this.actionRootPath = dirname(dirname(root));
    this.plans = ensurePrivateDirectory(join(root, "domain-plans"));
    this.bindings = ensurePrivateDirectory(join(root, "domain-bindings"));
    this.receipts = ensurePrivateDirectory(join(root, "domain-receipts"));
    this.lock = join(root, "conversation-receipt.writer.lock");
  }

  private path(root: string, proposalId: string, extension: string): string {
    if (!PROPOSAL.test(proposalId)) throw new Error("invalid receipt proposal id");
    return join(root, `${proposalId}.${extension}`);
  }

  private withLock<T>(operation: string, run: (lock: ProcessLock) => T): T {
    const lock = acquireProcessLock(this.lock, { operation });
    try {
      return run(lock);
    } finally {
      lock.release();
    }
  }

  writePlan(plan: ConversationReceiptProposalPlanV1): void {
    assertConversationReceiptPlan(plan);
    this.withLock(`receipt-plan:${plan.proposal_id}`, (lock) =>
      createOrVerifyPrivateFile(
        this.path(this.plans, plan.proposal_id, "json"),
        canonicalJsonBytes(plan),
        { lock, maxBytes: MAX_RECORD },
      ),
    );
  }

  readPlan(proposalId: string): ConversationReceiptProposalPlanV1 | null {
    const bytes = privateFileBytes(this.path(this.plans, proposalId, "json"), MAX_RECORD);
    return bytes === null ? null : decode(bytes, assertConversationReceiptPlan);
  }

  writeBinding(binding: ConversationActionAuthorityBindingV1): void {
    assertConversationActionBinding(binding);
    if (!DIGEST.test(binding.binding_digest)) throw new Error("invalid binding digest path");
    this.withLock(`receipt-binding:${binding.binding_digest}`, (lock) =>
      createOrVerifyPrivateFile(
        join(this.bindings, `${binding.binding_digest.slice(7)}.json`),
        canonicalJsonBytes(binding),
        { lock, maxBytes: MAX_RECORD },
      ),
    );
  }

  readBinding(bindingDigest: string): ConversationActionAuthorityBindingV1 | null {
    if (!DIGEST.test(bindingDigest)) throw new Error("invalid binding digest path");
    const bytes = privateFileBytes(
      join(this.bindings, `${bindingDigest.slice(7)}.json`),
      MAX_RECORD,
    );
    return bytes === null ? null : decode(bytes, assertConversationActionBinding);
  }

  append(receipt: ConversationActionReceiptV1): void {
    const validate = this.receiptValidator(receipt.proposal_id);
    validate(receipt);
    this.withLock(`receipt:${receipt.proposal_id}`, (lock) => {
      const current = this.read(receipt.proposal_id);
      if (current) {
        if (!canonicalJsonBytes(current).equals(canonicalJsonBytes(receipt)))
          throw new Error("conversation action receipt conflict");
        return;
      }
      appendVffrFrame(
        this.path(this.receipts, receipt.proposal_id, "frames"),
        "conversation-action-receipt",
        receipt as unknown as JsonValue,
        { ...receiptCodec(receipt.proposal_id, validate), lock },
      );
    });
  }

  read(proposalId: string): ConversationActionReceiptV1 | null {
    const path = this.path(this.receipts, proposalId, "frames");
    if (privateFileBytes(path, MAX_RECEIPTS) === null) return null;
    const frames = readVffrFile(path, receiptCodec(proposalId, this.receiptValidator(proposalId)));
    if (frames.length !== 1) throw new Error("conversation action receipt chain is incomplete");
    return structuredClone(frames[0]?.payload as unknown as ConversationActionReceiptV1);
  }

  private receiptValidator(proposalId: string): (receipt: ConversationActionReceiptV1) => void {
    const plan = this.readPlan(proposalId);
    if (!plan) throw new Error("conversation action receipt plan is absent");
    return (receipt) => {
      if (receipt.proposal_id !== proposalId)
        throw new Error("conversation action receipt proposal mismatch");
      const expected = this.readBinding(receipt.expected_authority_binding_digest);
      const observed = this.readBinding(receipt.observed_authority_binding_digest);
      if (!expected || !observed)
        throw new Error("conversation action receipt authority binding is absent");
      assertConversationActionReceipt(receipt, plan, expected, observed);
    };
  }
}
