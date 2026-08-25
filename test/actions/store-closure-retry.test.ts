import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionAuthorityStore,
  ActionFilePersistence,
  materializeAuthorityEvent,
  materializeProposal,
  targetId,
} from "../../src/actions/index.js";
import {
  authority,
  canonicalRequest,
  fixedNow,
  proposalDraft,
  testAuthorityResolver,
} from "./fixtures.js";

const roots: string[] = [];
function root(): string {
  const value = mkdtempSync(join(tmpdir(), "vf-action-closure-"));
  roots.push(value);
  return value;
}
afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

function setup() {
  const path = root();
  const store = new ActionAuthorityStore(path, {
    now: () => fixedNow,
    authority_resolver: testAuthorityResolver(),
  });
  const proposal = materializeProposal(proposalDraft());
  store.createProposal({ authority, canonical_request: canonicalRequest(), proposal });
  return { path, store, proposal };
}

describe("action read closure, cancellation, and retry", () => {
  test("never returns an orphan authority event without its visible idempotency chain", () => {
    const { path, store, proposal } = setup();
    const directory = join(path, "actions", "v1", "idempotency");
    for (const name of readdirSync(directory)) rmSync(join(directory, name), { force: true });
    expect(() => store.get(proposal.proposal_id)).toThrow(/idempotency closure/i);
    expect(() => store.listPending()).toThrow(/idempotency closure/i);
  });

  test("cancels pending and approved proposals idempotently while retaining approval", () => {
    const pending = setup();
    const cancel = {
      proposal_id: pending.proposal.proposal_id,
      proposal_digest: pending.proposal.proposal_digest,
      authority,
      reason: null,
    };
    expect(pending.store.cancel(cancel).state).toBe("canceled");
    expect(pending.store.cancel(cancel).state).toBe("canceled");

    const approved = setup();
    const approval = approved.store.decide({
      proposal_id: approved.proposal.proposal_id,
      proposal_digest: approved.proposal.proposal_digest,
      authority,
      decision: "approved",
      challenge_id: null,
      challenge_response: null,
    });
    const canceled = approved.store.cancel({
      proposal_id: approved.proposal.proposal_id,
      proposal_digest: approved.proposal.proposal_digest,
      authority,
      reason: "No longer needed",
    });
    expect(canceled.state).toBe("canceled");
    expect(canceled.approval?.approval_id).toBe(approval.approval_id);
  });

  test("replays dispatch and terminal records exactly and validates read closure", () => {
    const { path, store, proposal } = setup();
    const approval = store.decide({
      proposal_id: proposal.proposal_id,
      proposal_digest: proposal.proposal_digest,
      authority,
      decision: "approved",
      challenge_id: null,
      challenge_response: null,
    });
    const firstDispatch = store.prepareDispatch(proposal.proposal_id, approval.approval_id);
    expect(store.prepareDispatch(proposal.proposal_id, approval.approval_id)).toEqual(
      firstDispatch,
    );
    expect(store.beginDispatch(proposal.proposal_id, approval.approval_id).state).toBe(
      "committing",
    );
    expect(store.beginDispatch(proposal.proposal_id, approval.approval_id).state).toBe(
      "committing",
    );
    const terminal = store.recordTerminal(proposal.proposal_id);
    expect(store.recordTerminal(proposal.proposal_id)).toEqual(terminal);
    expect(() => new ActionAuthorityStore(path).get(proposal.proposal_id)).toThrow(/resolver/i);
    for (const name of readdirSync(join(path, "actions", "v1", "dispatch")))
      rmSync(join(path, "actions", "v1", "dispatch", name), { force: true });
    expect(() => store.get(proposal.proposal_id)).toThrow(/dispatch closure/i);
  });

  test("requires the exact consumed challenge journal when folding a challenged approval", () => {
    const path = root();
    const targetWithoutId = {
      target: {
        scope: "user" as const,
        engine: null,
        participant_id: null,
        required: true as const,
        on_apply_failure: "abort-scope" as const,
        on_health_failure: "abort-scope" as const,
      },
      subject: {
        kind: "conversation" as const,
        action_type: "conversation.stop_operation" as const,
        participant_id: null,
      },
    };
    const target = { target_id: targetId(targetWithoutId), ...targetWithoutId };
    const base = proposalDraft();
    const proposal = materializeProposal(
      proposalDraft({
        risk: "high",
        target_set: [target],
        preview: {
          ...base.preview,
          targets: [target],
          target_dispositions: [
            { target_id: target.target_id, execution: "host", reason_code: null },
          ],
        },
      }),
    );
    const store = new ActionAuthorityStore(path, {
      now: () => fixedNow,
      random_bytes: (size) => Buffer.alloc(size, 7),
      hmac_key: Buffer.alloc(32, 8),
      authority_resolver: testAuthorityResolver(),
    });
    store.createProposal({ authority, canonical_request: canonicalRequest(), proposal });
    const challenge = store.issueChallenge({
      proposal_id: proposal.proposal_id,
      proposal_digest: proposal.proposal_digest,
      challenge_class: "fresh-user-scope",
      authority,
    });
    store.decide({
      proposal_id: proposal.proposal_id,
      proposal_digest: proposal.proposal_digest,
      authority,
      decision: "approved",
      challenge_id: challenge.challenge_id,
      challenge_response: challenge.display_phrase,
    });
    for (const name of readdirSync(join(path, "actions", "v1", "challenges")))
      rmSync(join(path, "actions", "v1", "challenges", name), { force: true });
    expect(() => store.get(proposal.proposal_id)).toThrow(/consumed-challenge closure/i);
  });

  test("rejects an illegal semantic event before any durable append", () => {
    const { path, store, proposal } = setup();
    const files = new ActionFilePersistence(path);
    const snapshot = store.get(proposal.proposal_id);
    if (!snapshot) throw new Error("missing snapshot");
    const illegal = materializeAuthorityEvent(
      proposal,
      1,
      snapshot.events[0]?.event_digest ?? null,
      {
        kind: "state-transition",
        from: "pending_review",
        to: "succeeded",
        operation_id: null,
        dispatch_record_digest: null,
        domain_terminal_digest: null,
        reason_code: null,
      },
      new Date(fixedNow).toISOString(),
    );
    expect(() =>
      files.withLock("illegal-event-test", (lock) => files.appendAuthority(lock, illegal)),
    ).toThrow(/illegal transition/i);
    expect(store.get(proposal.proposal_id)?.events).toHaveLength(1);
  });
});
