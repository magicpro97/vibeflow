import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import { ACTION_ROOT_LOCATOR_KIND } from "../../actions/protocol-contract.js";
import { ACTION_DECISION } from "../../actions/public-action-contract.js";
import {
  appendVffrFrame,
  atomicCompareAndSwap,
  canonicalJson,
  digestV1,
  encodeVffrFrame,
  readVffrBytes,
} from "../../durability/index.js";
import type { ProcessLock, VffrReadOptions } from "../../durability/index.js";
import type { JsonValue } from "../../durability/index.js";
import {
  AUTHORITY_REPAIR_DIGEST_DOMAIN,
  AUTHORITY_REPAIR_LIMIT,
  AUTHORITY_REPAIR_TERMINAL_STATE,
  type AuthorityRepairTerminalStateV1,
  RECOVERY_BOOTSTRAP_APPROVAL_TRANSITION,
  RECOVERY_BOOTSTRAP_IDENTITY_KIND,
  RECOVERY_BOOTSTRAP_PAYLOAD_KIND,
} from "./contract.js";
import {
  assertAuthorityRepairOperation,
  assertRecoveryBootstrapApproval,
  assertRecoveryBootstrapEvent,
  assertRecoveryBootstrapIdentity,
  assertRecoveryBootstrapProposal,
  materializeAuthorityRepairOperation,
  materializeRecoveryBootstrapEvent,
} from "./records.js";
import type {
  AuthorityRepairOperationV1,
  RecoveryBootstrapEventV1,
  RecoveryBootstrapIdentityV1,
} from "./types.js";

interface BootstrapProposalFoldV1 {
  proposal: Extract<RecoveryBootstrapEventV1["payload"], { kind: "proposal-created" }>["proposal"];
  approval:
    | Extract<RecoveryBootstrapEventV1["payload"], { kind: "approval-decision" }>["approval"]
    | null;
  operation: AuthorityRepairOperationV1 | null;
  mirrored_event_digest: string | null;
  terminal: Exclude<
    AuthorityRepairTerminalStateV1,
    typeof AUTHORITY_REPAIR_TERMINAL_STATE.NEEDS_RECOVERY
  > | null;
}

export interface RecoveryBootstrapJournalFoldV1 {
  events: readonly RecoveryBootstrapEventV1[];
  proposals: ReadonlyMap<string, Readonly<BootstrapProposalFoldV1>>;
  event_head_digest: string | null;
}

function fail(message: string): never {
  throw new Error(`invalid recovery bootstrap journal: ${message}`);
}

function exact(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function journalCodec(identity: RecoveryBootstrapIdentityV1): VffrReadOptions {
  assertRecoveryBootstrapIdentity(identity);
  return {
    domain: RECOVERY_BOOTSTRAP_IDENTITY_KIND,
    maxFrames: AUTHORITY_REPAIR_LIMIT.FRAMES,
    maxPayloadBytes: AUTHORITY_REPAIR_LIMIT.FRAME_BYTES,
    maxAggregateBytes: AUTHORITY_REPAIR_LIMIT.JOURNAL_BYTES,
    sequenceStart: 0,
    initialPreviousDigest: null,
    validatePayload: (payload) =>
      assertRecoveryBootstrapEvent(payload as unknown as RecoveryBootstrapEventV1),
    computePayloadDigest: (payload) => {
      const { event_digest: _, ...preimage } = payload;
      return digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.BOOTSTRAP_EVENT, preimage);
    },
    validateJournalIdentity: (payload) =>
      payload.bootstrap_identity_digest === identity.content_digest,
  };
}

export function foldRecoveryBootstrapJournal(
  identity: RecoveryBootstrapIdentityV1,
  events: readonly RecoveryBootstrapEventV1[],
): RecoveryBootstrapJournalFoldV1 {
  assertRecoveryBootstrapIdentity(identity);
  const proposals = new Map<string, BootstrapProposalFoldV1>();
  let previous: string | null = null;
  for (const [sequence, event] of events.entries()) {
    assertRecoveryBootstrapEvent(event);
    if (
      event.bootstrap_identity_digest !== identity.content_digest ||
      event.sequence !== sequence ||
      event.previous_event_digest !== previous
    )
      fail("event chain is not dense or identity-bound");
    const payload = event.payload;
    if (payload.kind === RECOVERY_BOOTSTRAP_PAYLOAD_KIND.PROPOSAL_CREATED) {
      assertRecoveryBootstrapProposal(payload.proposal);
      if (
        payload.proposal.action_root_locator.kind !== ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP ||
        payload.proposal.action_root_locator.bootstrap_identity_digest !==
          identity.content_digest ||
        payload.proposal.action.type !== HOST_ACTION_KIND.AUTHORITY_REPAIR ||
        payload.repair_plan_digest !== payload.proposal.action.plan.plan_digest ||
        proposals.has(payload.proposal.proposal_id)
      )
        fail("proposal-created escaped the fixed repair root");
      proposals.set(payload.proposal.proposal_id, {
        proposal: structuredClone(payload.proposal),
        approval: null,
        operation: null,
        mirrored_event_digest: null,
        terminal: null,
      });
    } else if (payload.kind === RECOVERY_BOOTSTRAP_PAYLOAD_KIND.APPROVAL_DECISION) {
      const state = proposals.get(payload.proposal_id);
      if (!state || state.approval || state.operation || state.terminal)
        fail("approval-decision has no unique pending proposal");
      assertRecoveryBootstrapApproval(state.proposal, payload.approval);
      const expectedTo =
        payload.approval.decision === ACTION_DECISION.APPROVED
          ? RECOVERY_BOOTSTRAP_APPROVAL_TRANSITION.APPROVED
          : RECOVERY_BOOTSTRAP_APPROVAL_TRANSITION.DENIED;
      if (
        payload.from !== RECOVERY_BOOTSTRAP_APPROVAL_TRANSITION.FROM ||
        payload.to !== expectedTo ||
        payload.approval.proposal_id !== payload.proposal_id
      )
        fail("approval-decision transition mismatch");
      state.approval = structuredClone(payload.approval);
      if (payload.to === RECOVERY_BOOTSTRAP_APPROVAL_TRANSITION.DENIED)
        state.terminal = AUTHORITY_REPAIR_TERMINAL_STATE.FAILED;
    } else if (payload.kind === RECOVERY_BOOTSTRAP_PAYLOAD_KIND.REPAIR_DISPATCH) {
      const state = proposals.get(payload.proposal_id);
      if (
        !state?.approval ||
        state.approval.decision !== ACTION_DECISION.APPROVED ||
        state.operation ||
        state.terminal
      )
        fail("repair-dispatch has no unique approved proposal");
      assertAuthorityRepairOperation(payload.operation);
      const expected = materializeAuthorityRepairOperation(state.proposal, state.approval);
      if (!exact(payload.operation, expected)) fail("repair-dispatch operation mismatch");
      state.operation = structuredClone(payload.operation);
    } else if (payload.kind === RECOVERY_BOOTSTRAP_PAYLOAD_KIND.TERMINAL_MIRROR) {
      const state = proposals.get(payload.proposal_id);
      if (!state?.operation || state.terminal) fail("terminal-mirror has no live repair dispatch");
      if (
        payload.repair_id !== state.operation.repair_id ||
        payload.operation_id !== state.operation.operation_id ||
        payload.header_digest !== state.operation.header_digest ||
        payload.previous_mirrored_event_digest !== state.mirrored_event_digest
      )
        fail("terminal-mirror operation or chain mismatch");
      state.mirrored_event_digest = payload.authority_repair_event_digest;
      if (payload.outcome === AUTHORITY_REPAIR_TERMINAL_STATE.VERIFIED)
        state.terminal = AUTHORITY_REPAIR_TERMINAL_STATE.VERIFIED;
      else if (payload.outcome === AUTHORITY_REPAIR_TERMINAL_STATE.FAILED)
        state.terminal = AUTHORITY_REPAIR_TERMINAL_STATE.FAILED;
      else if (payload.outcome !== AUTHORITY_REPAIR_TERMINAL_STATE.NEEDS_RECOVERY)
        fail("terminal-mirror outcome is invalid");
    } else fail("unknown bootstrap payload kind");
    previous = event.event_digest;
  }
  return Object.freeze({
    events: Object.freeze(events.map((event) => Object.freeze(structuredClone(event)))),
    proposals,
    event_head_digest: previous,
  });
}

export function readRecoveryBootstrapJournalBytes(
  identity: RecoveryBootstrapIdentityV1,
  bytes: Uint8Array,
): RecoveryBootstrapJournalFoldV1 {
  if (bytes.byteLength === 0) return foldRecoveryBootstrapJournal(identity, []);
  const events = readVffrBytes(bytes, journalCodec(identity)).map(
    (frame) => frame.payload as unknown as RecoveryBootstrapEventV1,
  );
  return foldRecoveryBootstrapJournal(identity, events);
}

export function appendRecoveryBootstrapEvent(input: {
  path: string;
  lock: ProcessLock;
  identity: RecoveryBootstrapIdentityV1;
  prior: RecoveryBootstrapJournalFoldV1;
  payload: RecoveryBootstrapEventV1["payload"];
  recorded_at: string;
}): RecoveryBootstrapJournalFoldV1 {
  const event = materializeRecoveryBootstrapEvent(input.identity, {
    sequence: input.prior.events.length,
    previous_event_digest: input.prior.event_head_digest,
    payload: structuredClone(input.payload),
    recorded_at: input.recorded_at,
  });
  const options = journalCodec(input.identity);
  if (input.prior.events.length === 0) {
    const encoded = encodeVffrFrame(
      RECOVERY_BOOTSTRAP_IDENTITY_KIND,
      event as unknown as JsonValue,
      options,
    );
    atomicCompareAndSwap(input.path, Buffer.alloc(0), encoded, { lock: input.lock });
  } else {
    appendVffrFrame(input.path, RECOVERY_BOOTSTRAP_IDENTITY_KIND, event as unknown as JsonValue, {
      ...options,
      lock: input.lock,
    });
  }
  return foldRecoveryBootstrapJournal(input.identity, [...input.prior.events, event]);
}
