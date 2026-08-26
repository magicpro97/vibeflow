import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type {
  ActionApprovalV1,
  ActionDispatchRecordV1,
  ActionProposalV1,
} from "../../actions/index.js";
import {
  canonicalJsonBytes,
  digestHex,
  digestV1,
  privateFileBytes,
} from "../../durability/index.js";
import { lineageStorageKey } from "./lineage-storage-key.js";
import {
  hasExactLineageKeys,
  isBoundedLineageReference,
  isLineageDigest,
  isMillisecondIsoDate,
  isPlainLineageRecord,
} from "./lineage-types.js";

const MAX_BLOCK_BYTES = 64 * 1024;
const PROPOSAL = /^vf-proposal-[0-9a-f]{64}$/;
const APPROVAL = /^vf-approval-[0-9a-f]{64}$/;
const OPERATION = /^vf-operation-[0-9a-f]{64}$/;

export interface ConversationCapabilityDispatchBlockV1 {
  schema_version: "1.0";
  root_session_id: string;
  proposal_id: string;
  proposal_digest: string;
  approval_id: string;
  approval_digest: string;
  operation_id: string;
  dispatch_record_digest: string;
  domain_header_digest: string;
  reason: "claim-missing" | "claim-released" | "claim-mismatch";
  blocked_at: string;
  content_digest: string;
}

export class ConversationCapabilityDispatchCorruptError extends Error {
  override readonly name = "ConversationCapabilityDispatchCorruptError";
}

export function capabilityDispatchBlockPath(artifactRoot: string, rootSessionId: string): string {
  return join(
    artifactRoot,
    "lineage",
    "v1",
    "capability-dispatch-blocks",
    `${digestHex(lineageStorageKey(rootSessionId))}.json`,
  );
}

function blockDigest(value: Omit<ConversationCapabilityDispatchBlockV1, "content_digest">) {
  return digestV1("VF-CONVERSATION-CAPABILITY-DISPATCH-BLOCK\0v1\0", value);
}

function assertBlock(value: unknown): asserts value is ConversationCapabilityDispatchBlockV1 {
  if (
    !isPlainLineageRecord(value) ||
    !hasExactLineageKeys(value, [
      "approval_digest",
      "approval_id",
      "blocked_at",
      "content_digest",
      "dispatch_record_digest",
      "domain_header_digest",
      "operation_id",
      "proposal_digest",
      "proposal_id",
      "reason",
      "root_session_id",
      "schema_version",
    ]) ||
    value.schema_version !== "1.0" ||
    !isBoundedLineageReference(value.root_session_id) ||
    typeof value.proposal_id !== "string" ||
    !PROPOSAL.test(value.proposal_id) ||
    typeof value.approval_id !== "string" ||
    !APPROVAL.test(value.approval_id) ||
    typeof value.operation_id !== "string" ||
    !OPERATION.test(value.operation_id) ||
    ![
      value.proposal_digest,
      value.approval_digest,
      value.dispatch_record_digest,
      value.domain_header_digest,
      value.content_digest,
    ].every(isLineageDigest) ||
    !["claim-missing", "claim-released", "claim-mismatch"].includes(value.reason as string) ||
    !isMillisecondIsoDate(value.blocked_at)
  )
    throw new ConversationCapabilityDispatchCorruptError("capability dispatch block is corrupt");
  const { content_digest: _digest, ...preimage } = value;
  if (
    blockDigest(
      preimage as unknown as Omit<ConversationCapabilityDispatchBlockV1, "content_digest">,
    ) !== value.content_digest
  )
    throw new ConversationCapabilityDispatchCorruptError(
      "capability dispatch block digest mismatch",
    );
}

export function readCapabilityDispatchBlock(
  artifactRoot: string,
  rootSessionId: string,
): ConversationCapabilityDispatchBlockV1 | null {
  const bytes = privateFileBytes(
    capabilityDispatchBlockPath(artifactRoot, rootSessionId),
    MAX_BLOCK_BYTES,
  );
  if (bytes === null) return null;
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  assertBlock(value);
  const canonical = canonicalJsonBytes(value);
  if (bytes.length !== canonical.length || !timingSafeEqual(bytes, canonical))
    throw new ConversationCapabilityDispatchCorruptError(
      "capability dispatch block is non-canonical",
    );
  if (value.root_session_id !== rootSessionId)
    throw new ConversationCapabilityDispatchCorruptError(
      "capability dispatch block storage key mismatch",
    );
  return structuredClone(value);
}

export function materializeCapabilityDispatchBlock(input: {
  proposal: ActionProposalV1;
  approval: ActionApprovalV1;
  dispatch: ActionDispatchRecordV1;
  reason: ConversationCapabilityDispatchBlockV1["reason"];
  now: string;
}): ConversationCapabilityDispatchBlockV1 {
  const root = input.proposal.base.root_session_id;
  if (!root || !input.dispatch.domain_header_digest)
    throw new ConversationCapabilityDispatchCorruptError(
      "capability dispatch block authority is incomplete",
    );
  const preimage = {
    schema_version: "1.0" as const,
    root_session_id: root,
    proposal_id: input.proposal.proposal_id,
    proposal_digest: input.proposal.proposal_digest,
    approval_id: input.approval.approval_id,
    approval_digest: input.approval.approval_digest,
    operation_id: input.dispatch.operation_id,
    dispatch_record_digest: input.dispatch.dispatch_record_digest,
    domain_header_digest: input.dispatch.domain_header_digest,
    reason: input.reason,
    blocked_at: input.now,
  };
  return { ...preimage, content_digest: blockDigest(preimage) };
}

export function sameCapabilityDispatchBlockAuthority(
  left: ConversationCapabilityDispatchBlockV1,
  right: ConversationCapabilityDispatchBlockV1,
): boolean {
  return (
    left.root_session_id === right.root_session_id &&
    left.proposal_id === right.proposal_id &&
    left.proposal_digest === right.proposal_digest &&
    left.approval_id === right.approval_id &&
    left.approval_digest === right.approval_digest &&
    left.operation_id === right.operation_id &&
    left.dispatch_record_digest === right.dispatch_record_digest &&
    left.domain_header_digest === right.domain_header_digest &&
    left.reason === right.reason
  );
}
