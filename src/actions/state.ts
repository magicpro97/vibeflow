import { digestV1 } from "../durability/index.js";
import {
  ACTION_AUTHORITY_EVENT_KIND,
  ACTION_OPERATION_STATE,
  type ActionOperationState,
  isActionOperationTerminalResolutionState,
  isActionOperationTransition,
} from "./protocol-contract.js";
import { ACTION_DECISION } from "./public-action-contract.js";
import { assertApproval, assertProposal, deriveOperationId } from "./records.js";
import type { ActionAuthorityEventV1, ActionAuthoritySnapshotV1 } from "./types.js";

export class ActionStateError extends Error {
  constructor(message: string) {
    super(`invalid action authority chain: ${message}`);
    this.name = "ActionStateError";
  }
}

function fail(message: string): never {
  throw new ActionStateError(message);
}

function assertEventDigest(event: ActionAuthorityEventV1): void {
  const { event_digest: observed, ...preimage } = event;
  const expected = digestV1("VF-ACTION-AUTHORITY-EVENT\0v1\0", preimage);
  if (observed !== expected) fail("event digest mismatch");
}

export function foldActionAuthority(
  events: readonly ActionAuthorityEventV1[],
): ActionAuthoritySnapshotV1 {
  if (events.length === 0) fail("sequence zero is missing");
  const first = events[0];
  if (!first || first.sequence !== 0 || first.previous_event_digest !== null)
    fail("sequence zero is malformed");
  if (first.payload.kind !== ACTION_AUTHORITY_EVENT_KIND.PROPOSAL_CREATED)
    fail("sequence zero is not proposal-created");
  assertEventDigest(first);
  const proposal = first.payload.proposal;
  assertProposal(proposal);
  if (first.proposal_id !== proposal.proposal_id) fail("proposal identity mismatch");
  if (first.recorded_at !== proposal.created_at)
    fail("proposal-created timestamp does not match immutable proposal");

  let state: ActionOperationState = ACTION_OPERATION_STATE.PENDING_REVIEW;
  let approval: ActionAuthoritySnapshotV1["approval"] = null;
  let operationId: string | null = null;
  let dispatchDigest: string | null = null;
  let terminalDigest: string | null = null;
  let previous = first;
  let previousTime = Date.parse(first.recorded_at);
  if (!Number.isFinite(previousTime)) fail("invalid recorded timestamp");

  for (let index = 1; index < events.length; index += 1) {
    const event = events[index];
    if (!event || event.sequence !== index) fail("event sequence is not dense");
    if (event.proposal_id !== proposal.proposal_id) fail("cross-proposal event");
    if (event.previous_event_digest !== previous.event_digest)
      fail("previous event digest mismatch");
    assertEventDigest(event);
    const eventTime = Date.parse(event.recorded_at);
    if (!Number.isFinite(eventTime) || eventTime < previousTime)
      fail("recorded timestamp regressed");
    previousTime = eventTime;
    previous = event;

    if (event.payload.kind === ACTION_AUTHORITY_EVENT_KIND.PROPOSAL_CREATED)
      fail("duplicate proposal-created event");
    if (event.payload.kind === ACTION_AUTHORITY_EVENT_KIND.APPROVAL_DECISION) {
      if (
        state !== ACTION_OPERATION_STATE.PENDING_REVIEW ||
        event.payload.from !== ACTION_OPERATION_STATE.PENDING_REVIEW
      )
        fail("approval decision does not start at pending_review");
      assertApproval(proposal, event.payload.approval);
      const expected: ActionOperationState =
        event.payload.approval.decision === ACTION_DECISION.APPROVED
          ? ACTION_OPERATION_STATE.APPROVED
          : ACTION_OPERATION_STATE.DENIED;
      if (event.payload.to !== expected) fail("approval decision and transition disagree");
      if (event.recorded_at !== event.payload.approval.decided_at)
        fail("approval decision timestamp mismatch");
      approval = event.payload.approval;
      state = expected;
      continue;
    }

    const transition = event.payload;
    if (transition.from !== state || !isActionOperationTransition(state, transition.to))
      fail(`illegal transition ${state} to ${transition.to}`);
    if (
      transition.to === ACTION_OPERATION_STATE.APPROVED ||
      transition.to === ACTION_OPERATION_STATE.DENIED
    )
      fail("approval states require an approval-decision payload");
    if (
      transition.from === ACTION_OPERATION_STATE.APPROVED &&
      transition.to === ACTION_OPERATION_STATE.COMMITTING
    ) {
      if (!approval || approval.decision !== ACTION_DECISION.APPROVED)
        fail("dispatch lacks approved decision");
      if (
        !transition.operation_id ||
        !transition.dispatch_record_digest ||
        transition.domain_terminal_digest !== null
      )
        fail("dispatch transition lacks write-before-authority record");
      if (transition.operation_id !== deriveOperationId(proposal, approval.approval_id))
        fail("dispatch operation identity mismatch");
      assertDigest(transition.dispatch_record_digest, "dispatch record");
      if (transition.reason_code !== null) fail("dispatch transition carries a reason code");
      operationId = transition.operation_id;
      dispatchDigest = transition.dispatch_record_digest;
    } else if (isActionOperationTerminalResolutionState(transition.from)) {
      if (
        !operationId ||
        transition.operation_id !== operationId ||
        transition.dispatch_record_digest !== dispatchDigest ||
        !transition.domain_terminal_digest
      )
        fail("domain terminal does not repeat dispatch authority");
      assertDigest(transition.domain_terminal_digest, "domain terminal");
      if (transition.reason_code !== null) fail("domain terminal carries a reason code");
      terminalDigest = transition.domain_terminal_digest;
    } else if (
      transition.operation_id !== null ||
      transition.dispatch_record_digest !== null ||
      transition.domain_terminal_digest !== null
    ) {
      fail("proposal-only terminal contains dispatch authority");
    } else if (
      typeof transition.reason_code !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(transition.reason_code)
    ) {
      fail("proposal-only terminal reason code is invalid");
    }
    state = transition.to;
  }

  return {
    proposal,
    approval,
    state,
    operation_id: operationId,
    dispatch_record_digest: dispatchDigest,
    domain_terminal_digest: terminalDigest,
    events: [...events],
  };
}

function assertDigest(value: string, label: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) fail(`${label} digest is invalid`);
}
