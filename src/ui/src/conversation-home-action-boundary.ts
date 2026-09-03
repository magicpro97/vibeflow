import {
  ACTION_OPERATION_STATE,
  isActionOperationApprovalProhibitedState,
  isActionOperationApprovalRequiredState,
} from "../../actions/protocol-contract.js";
import {
  isPublicOperationPhaseOwned,
  isPublicOperationPhaseStateValid,
} from "../../actions/public-operation-semantics.js";
import type {
  ActionApprovalChallengeResponseV1,
  ActionApprovalResponseV1,
  ActionMutationResponseV1,
} from "../../actions/public-types.js";
import { isSha256WireDigest, sameWireValue } from "../../actions/public-wire-primitives.js";
import { isBoundedWireText, isExactWireTimestamp } from "../../actions/public-wire-primitives.js";
import {
  ACTION_APPROVAL_CHALLENGE_RESPONSE_FIELDS,
  ACTION_APPROVAL_RESPONSE_FIELDS,
  ACTION_MUTATION_RESPONSE_FIELDS,
  ACTION_PROPOSAL_RESPONSE_FIELDS,
  PENDING_ACTION_RESPONSE_FIELDS,
} from "./conversation-home-action-boundary-fields.js";
import {
  assert,
  ACTION_APPROVAL_CHALLENGE_CLASSES,
  ACTION_APPROVAL_CHALLENGE_DISPLAY_PREFIX,
  ACTION_APPROVAL_CHALLENGE_DISPLAY_SUFFIX_PATTERN,
  ACTION_APPROVAL_CHALLENGE_ID_PATTERN,
  ACTION_DECISION,
  PUBLIC_ACTION_SCHEMA_VERSION,
  assertExactRecord,
  assertPattern,
  memberOf,
  nullableCursor,
} from "./conversation-home-action-boundary-shared.js";
import { parseActionOperation } from "./conversation-home-action-operation-boundary.js";
import {
  parseActionApproval,
  parseActionProposal,
} from "./conversation-home-action-proposal-boundary.js";
export { parseHomeTimelineResponse } from "./conversation-home-action-timeline-boundary.js";
import type {
  HomeActionApproval,
  HomeActionOperation,
  HomeActionProposal,
  HomeActionView,
  HomePendingActionsResponse,
} from "./conversation-home-types.js";

function assertApprovalOperationBinding(
  approval: HomeActionApproval,
  operation: HomeActionOperation,
): void {
  assert(
    operation.proposal_id === approval.proposal_id &&
      operation.proposal_digest === approval.proposal_digest &&
      operation.approval_id === approval.approval_id &&
      operation.approval_digest === approval.approval_digest,
    "action approval and operation binding mismatch",
  );
  assert(
    Date.parse(operation.updated_at) >= Date.parse(approval.decided_at),
    "action operation predates its approval",
  );
  if (operation.progress[0])
    assert(
      Date.parse(operation.progress[0].at) >= Date.parse(approval.decided_at),
      "action progress predates its approval",
    );
}

function assertActionViewBinding(
  proposal: HomeActionProposal,
  approval: HomeActionApproval | null,
  operation: HomeActionOperation,
): void {
  const proposalCreatedAt = Date.parse(proposal.created_at);
  assert(
    operation.proposal_id === proposal.proposal_id &&
      operation.proposal_digest === proposal.proposal_digest &&
      operation.domain === proposal.domain &&
      operation.created_at === proposal.created_at,
    "action proposal and operation binding mismatch",
  );
  const operationHasApproval = operation.approval_id !== null;
  assert(
    (approval !== null) === operationHasApproval,
    "action approval presence and operation binding mismatch",
  );
  if (approval) {
    assertApprovalOperationBinding(approval, operation);
    assert(
      Date.parse(approval.decided_at) >= Date.parse(proposal.created_at) &&
        Date.parse(approval.expires_at) <= Date.parse(proposal.expires_at),
      "action approval escaped the proposal time window",
    );
  }
  if (isActionOperationApprovalRequiredState(operation.state))
    assert(approval !== null, "action operation state requires an approval record");
  if (isActionOperationApprovalProhibitedState(operation.state))
    assert(approval === null, "action operation state prohibits an approval record");
  if (approval?.decision === ACTION_DECISION.DENIED)
    assert(
      operation.state === ACTION_OPERATION_STATE.DENIED,
      "denied approval must terminalize as denied",
    );
  if (approval?.decision === ACTION_DECISION.APPROVED)
    assert(
      operation.state !== ACTION_OPERATION_STATE.DENIED,
      "approved action cannot terminalize as denied",
    );
  const targets = new Map(proposal.targets.map((target) => [target.target_id, target]));
  for (const progress of operation.progress) {
    assert(Date.parse(progress.at) >= proposalCreatedAt, "action progress predates its proposal");
    assert(
      isPublicOperationPhaseOwned({
        actionType: proposal.action_type,
        phase: progress.phase,
        phaseSequence: progress.sequence,
      }),
      "action progress phase escaped its action ownership",
    );
  }
  const latestProgress = operation.progress.at(-1);
  if (latestProgress)
    assert(
      isPublicOperationPhaseStateValid({
        actionType: proposal.action_type,
        phase: latestProgress.phase,
        phaseSequence: latestProgress.sequence,
        state: operation.state,
      }),
      "action operation state escaped its latest progress semantics",
    );
  for (const target of operation.targets) {
    const proposed = targets.get(target.target_id);
    assert(
      proposed !== undefined &&
        sameWireValue(
          { target: target.target, subject: target.subject },
          { target: proposed.target, subject: proposed.subject },
        ),
      "action operation target escaped its immutable proposal binding",
    );
  }
}

export function parseHomeActionChallengeResponse(
  value: unknown,
  expectedClass: ActionApprovalChallengeResponseV1["challenge_class"],
): ActionApprovalChallengeResponseV1 {
  const row = assertExactRecord(
    value,
    ACTION_APPROVAL_CHALLENGE_RESPONSE_FIELDS,
    "invalid action approval challenge response",
  );
  assert(
    row.schema_version === PUBLIC_ACTION_SCHEMA_VERSION,
    "invalid action approval challenge schema version",
  );
  assertPattern(
    row.challenge_id,
    ACTION_APPROVAL_CHALLENGE_ID_PATTERN,
    "invalid action approval challenge id",
  );
  assert(
    memberOf(ACTION_APPROVAL_CHALLENGE_CLASSES, row.challenge_class) &&
      row.challenge_class === expectedClass,
    "invalid action approval challenge class",
  );
  assert(
    isBoundedWireText(row.display_phrase, { maxBytes: 64 }),
    "invalid action approval challenge display phrase",
  );
  const prefix = `${ACTION_APPROVAL_CHALLENGE_DISPLAY_PREFIX[row.challenge_class]} `;
  assert(
    row.display_phrase.startsWith(prefix) &&
      ACTION_APPROVAL_CHALLENGE_DISPLAY_SUFFIX_PATTERN.test(
        row.display_phrase.slice(prefix.length),
      ),
    "invalid action approval challenge display phrase",
  );
  assert(isExactWireTimestamp(row.expires_at), "invalid action approval challenge expires_at");
  return {
    schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
    challenge_id: row.challenge_id,
    challenge_class: row.challenge_class,
    display_phrase: row.display_phrase,
    expires_at: row.expires_at,
  };
}

export function parseHomeActionViewResponse(value: unknown): HomeActionView {
  const row = assertExactRecord(
    value,
    ACTION_PROPOSAL_RESPONSE_FIELDS,
    "invalid action view response",
  );
  assert(row.schema_version === PUBLIC_ACTION_SCHEMA_VERSION, "invalid action view schema version");
  const proposal = parseActionProposal(row.proposal);
  const approval = row.approval === null ? null : parseActionApproval(row.approval);
  const operation = parseActionOperation(row.operation);
  assertActionViewBinding(proposal, approval, operation);
  return {
    schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
    proposal,
    approval,
    operation,
  };
}

export function parseHomePendingActionsResponse(value: unknown): HomePendingActionsResponse {
  const row = assertExactRecord(
    value,
    PENDING_ACTION_RESPONSE_FIELDS,
    "invalid pending action response",
  );
  assert(
    row.schema_version === PUBLIC_ACTION_SCHEMA_VERSION,
    "invalid pending action schema version",
  );
  assert(Array.isArray(row.items), "invalid pending action items");
  assert(nullableCursor(row.next_cursor), "invalid pending action cursor");
  assert(isSha256WireDigest(row.authority_watermark), "invalid pending authority watermark");
  return {
    schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
    items: row.items.map(parseHomeActionViewResponse),
    next_cursor: row.next_cursor,
    authority_watermark: row.authority_watermark,
  };
}

export function parseHomeActionApprovalResponse(
  value: unknown,
  expected?: {
    proposalId: string;
    proposalDigest: string;
    decision: HomeActionApproval["decision"];
  },
): ActionApprovalResponseV1 {
  const row = assertExactRecord(
    value,
    ACTION_APPROVAL_RESPONSE_FIELDS,
    "invalid action approval response",
  );
  assert(
    row.schema_version === PUBLIC_ACTION_SCHEMA_VERSION,
    "invalid action approval response schema version",
  );
  const approval = parseActionApproval(row.approval);
  const operation = parseActionOperation(row.operation);
  if (expected)
    assert(
      approval.proposal_id === expected.proposalId &&
        approval.proposal_digest === expected.proposalDigest &&
        approval.decision === expected.decision &&
        operation.proposal_id === expected.proposalId &&
        operation.proposal_digest === expected.proposalDigest,
      "action approval response escaped its request binding",
    );
  assertApprovalOperationBinding(approval, operation);
  return { schema_version: PUBLIC_ACTION_SCHEMA_VERSION, approval, operation };
}

export function parseHomeActionMutationResponse(
  value: unknown,
  expected?: { proposalId: string; proposalDigest: string; approvalId?: string },
): ActionMutationResponseV1 {
  const row = assertExactRecord(
    value,
    ACTION_MUTATION_RESPONSE_FIELDS,
    "invalid action mutation response",
  );
  assert(
    row.schema_version === PUBLIC_ACTION_SCHEMA_VERSION,
    "invalid action mutation response schema version",
  );
  const operation = parseActionOperation(row.operation);
  if (expected)
    assert(
      operation.proposal_id === expected.proposalId &&
        operation.proposal_digest === expected.proposalDigest &&
        (expected.approvalId === undefined || operation.approval_id === expected.approvalId),
      "action mutation response escaped its request binding",
    );
  return {
    schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
    operation,
  };
}

export function parseHomeActionCancelResponse(
  value: unknown,
  expected?: { proposalId: string; proposalDigest: string; approvalId?: string },
): ActionMutationResponseV1 {
  return parseHomeActionMutationResponse(value, expected);
}
