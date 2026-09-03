import { describe, expect, test } from "bun:test";
import {
  ActionStateError,
  foldActionAuthority,
  materializeApproval,
  materializeAuthorityEvent,
  materializeDispatchRecord,
  materializeProposal,
} from "../../src/actions/index.js";
import { human, proposalDraft, testDigest } from "./fixtures.js";

describe("action authority fold", () => {
  test("folds the only legal dispatch path and preserves exact records", () => {
    const proposal = materializeProposal(proposalDraft());
    const created = materializeAuthorityEvent(proposal, 0, null, {
      kind: "proposal-created",
      proposal,
    });
    const approval = materializeApproval(proposal, {
      decision: "approved",
      decided_by: human,
      challenge_class: "normal-confirm",
      challenge_digest: null,
      decided_at: "2026-08-25T00:01:00.000Z",
      expires_at: "2026-08-25T00:30:00.000Z",
    });
    const decided = materializeAuthorityEvent(proposal, 1, created.event_digest, {
      kind: "approval-decision",
      from: "pending_review",
      to: "approved",
      approval,
    });
    const dispatch = materializeDispatchRecord(proposal, approval, null);
    const committing = materializeAuthorityEvent(
      proposal,
      2,
      decided.event_digest,
      {
        kind: "state-transition",
        from: "approved",
        to: "committing",
        operation_id: dispatch.operation_id,
        dispatch_record_digest: dispatch.dispatch_record_digest,
        domain_terminal_digest: null,
        reason_code: null,
      },
      "2026-08-25T00:02:00.000Z",
    );
    const succeeded = materializeAuthorityEvent(
      proposal,
      3,
      committing.event_digest,
      {
        kind: "state-transition",
        from: "committing",
        to: "succeeded",
        operation_id: dispatch.operation_id,
        dispatch_record_digest: dispatch.dispatch_record_digest,
        domain_terminal_digest: testDigest("terminal"),
        reason_code: null,
      },
      "2026-08-25T00:03:00.000Z",
    );
    const folded = foldActionAuthority([created, decided, committing, succeeded]);
    expect(folded.state).toBe("succeeded");
    expect(folded.operation_id).toBe(dispatch.operation_id);
    expect(folded.approval?.approval_id).toBe(approval.approval_id);
  });

  test("rejects gaps, tamper, illegal edges, and dispatch without a durable record", () => {
    const proposal = materializeProposal(proposalDraft());
    const created = materializeAuthorityEvent(proposal, 0, null, {
      kind: "proposal-created",
      proposal,
    });
    const bad = materializeAuthorityEvent(
      proposal,
      1,
      created.event_digest,
      {
        kind: "state-transition",
        from: "pending_review",
        to: "committing",
        operation_id: "vf-operation-forged",
        dispatch_record_digest: null,
        domain_terminal_digest: null,
        reason_code: null,
      },
      "2026-08-25T00:01:00.000Z",
    );
    expect(() => foldActionAuthority([created, bad])).toThrow(ActionStateError);
    expect(() => foldActionAuthority([{ ...created, event_digest: "sha256:tampered" }])).toThrow(
      ActionStateError,
    );
  });
});
