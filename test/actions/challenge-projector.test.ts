import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionAuthorityStore,
  ActionConflictError,
  ActionFilePersistence,
  actionIdempotencyFileKey,
  actionIdempotencyKeyDigest,
  materializeProposal,
  projectActionSnapshot,
  targetId,
} from "../../src/actions/index.js";
import { validateChallengeFrame } from "../../src/actions/persistence-validation.js";
import { assertConsumedChallengeMatchesVisible } from "../../src/actions/store-read-validation.js";
import { digestV1 } from "../../src/durability/index.js";
import {
  authority,
  canonicalRequest,
  proposalDraft,
  testAuthorityResolver,
  testDigest,
} from "./fixtures.js";

const roots: string[] = [];
afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { force: true, recursive: true });
});

function setup(now: { value: number }) {
  const root = mkdtempSync(join(tmpdir(), "vf-actions-challenge-"));
  roots.push(root);
  let random = 0;
  const store = new ActionAuthorityStore(root, {
    now: () => now.value,
    hmac_key: Buffer.alloc(32, 9),
    random_bytes: (size) => Buffer.alloc(size, ++random),
    authority_resolver: testAuthorityResolver(),
  });
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
  const baseDraft = proposalDraft();
  const proposal = materializeProposal(
    proposalDraft({
      expires_at: "2030-08-25T01:00:00.000Z",
      risk: "high",
      target_set: [target],
      preview: {
        ...baseDraft.preview,
        targets: [target],
        target_dispositions: [
          { target_id: target.target_id, execution: "host", reason_code: null },
        ],
      },
    }),
  );
  store.createProposal({ authority, canonical_request: canonicalRequest(), proposal });
  return { store, proposal, root };
}

describe("approval challenges and public projection", () => {
  test("rejects a consumed frame timestamped before issuance", () => {
    const now = { value: Date.parse("2026-08-25T00:00:00.000Z") };
    const { store, proposal } = setup(now);
    const response = store.issueChallenge({
      proposal_id: proposal.proposal_id,
      proposal_digest: proposal.proposal_digest,
      challenge_class: "fresh-user-scope",
      authority,
    });
    const created = store.getChallenge(response.challenge_id);
    if (!created) throw new Error("missing created challenge frame");
    const { frame_digest: previous, ...createdWithoutDigest } = created;
    const preimage = {
      ...createdWithoutDigest,
      sequence: 1,
      previous_frame_digest: previous,
      state: "consumed",
      approval_decided_by: authority.actor,
      approval_expires_at: "2026-08-25T00:01:00.000Z",
      consumed_at: "2026-08-24T23:59:59.999Z",
    };
    expect(() =>
      validateChallengeFrame({
        ...preimage,
        frame_digest: digestV1("VF-APPROVAL-CHALLENGE-FRAME\0v1\0", preimage),
      }),
    ).toThrow(/before issuance/i);
  });

  test("binds principal, session, CSRF and consumes the exact phrase once", () => {
    const now = { value: Date.parse("2026-08-25T00:00:00.000Z") };
    const { store, proposal, root } = setup(now);
    const challenge = store.issueChallenge({
      proposal_id: proposal.proposal_id,
      proposal_digest: proposal.proposal_digest,
      challenge_class: "fresh-user-scope",
      authority,
    });
    expect(challenge.display_phrase).toMatch(/^user [0-9a-f]{12}$/);
    expect(() =>
      store.decide({
        proposal_id: proposal.proposal_id,
        proposal_digest: proposal.proposal_digest,
        authority: { ...authority, csrf_epoch_digest: testDigest("csrf-2") },
        decision: "approved",
        challenge_id: challenge.challenge_id,
        challenge_response: challenge.display_phrase,
      }),
    ).toThrow(ActionConflictError);
    const reopened = new ActionAuthorityStore(root, {
      now: () => now.value,
      hmac_key: Buffer.alloc(32, 9),
      authority_resolver: testAuthorityResolver(),
    });
    const approval = reopened.decide({
      proposal_id: proposal.proposal_id,
      proposal_digest: proposal.proposal_digest,
      authority,
      decision: "approved",
      challenge_id: challenge.challenge_id,
      challenge_response: challenge.display_phrase,
    });
    const consumed = reopened.getChallenge(challenge.challenge_id);
    expect(consumed?.state).toBe("consumed");
    const snapshot = reopened.get(proposal.proposal_id);
    if (!snapshot || !consumed) throw new Error("consumed approval closure is missing");
    const files = new ActionFilePersistence(root);
    const visible = files
      .readIdempotency(
        files.idempotencyPath(
          actionIdempotencyFileKey(
            authority.principal_digest,
            authority.authority_scope_digest,
            actionIdempotencyKeyDigest(proposal.idempotency_key),
          ),
        ),
      )
      .at(-1);
    if (!visible) throw new Error("visible idempotency fixture is missing");
    expect(() =>
      assertConsumedChallengeMatchesVisible(
        snapshot,
        { ...visible, principal_digest: testDigest("other-principal") },
        consumed,
      ),
    ).toThrow(/consumed-challenge closure/i);
    expect(
      store.decide({
        proposal_id: proposal.proposal_id,
        proposal_digest: proposal.proposal_digest,
        authority,
        decision: "approved",
        challenge_id: challenge.challenge_id,
        challenge_response: challenge.display_phrase,
      }),
    ).toEqual(approval);
  });

  test("locks after five failures and expires at 120 seconds", () => {
    const now = { value: Date.parse("2026-08-25T00:00:00.000Z") };
    const first = setup(now);
    const challenge = first.store.issueChallenge({
      proposal_id: first.proposal.proposal_id,
      proposal_digest: first.proposal.proposal_digest,
      challenge_class: "fresh-user-scope",
      authority,
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(() =>
        first.store.decide({
          proposal_id: first.proposal.proposal_id,
          proposal_digest: first.proposal.proposal_digest,
          authority,
          decision: "approved",
          challenge_id: challenge.challenge_id,
          challenge_response: "user wrong",
        }),
      ).toThrow();
    }
    expect(first.store.getChallenge(challenge.challenge_id)?.state).toBe("locked");

    const second = setup(now);
    const expiring = second.store.issueChallenge({
      proposal_id: second.proposal.proposal_id,
      proposal_digest: second.proposal.proposal_digest,
      challenge_class: "fresh-user-scope",
      authority,
    });
    now.value += 120_000;
    expect(() =>
      second.store.decide({
        proposal_id: second.proposal.proposal_id,
        proposal_digest: second.proposal.proposal_digest,
        authority,
        decision: "approved",
        challenge_id: expiring.challenge_id,
        challenge_response: expiring.display_phrase,
      }),
    ).toThrow(/expired/i);
  });

  test("public projection drops authority bindings, keys, local paths, and secret canaries", () => {
    const now = { value: Date.parse("2026-08-25T00:00:00.000Z") };
    const { store, proposal } = setup(now);
    const snapshot = store.get(proposal.proposal_id);
    expect(snapshot).not.toBeNull();
    if (!snapshot) throw new Error("action snapshot missing");
    const projected = projectActionSnapshot(snapshot);
    const json = JSON.stringify(projected);
    for (const canary of [
      "request-1",
      authority.principal_digest,
      authority.authority_scope_digest,
      testDigest("authority-head"),
      "action_root_locator",
      "/Users/",
      "BEGIN PRIVATE KEY",
    ]) {
      expect(json).not.toContain(canary);
    }
    expect(projected.proposal.proposal_id).toBe(proposal.proposal_id);
    expect(projected.operation.delivery).toBe("not-applicable");
  });
});
