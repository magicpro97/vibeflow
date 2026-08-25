import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionAuthorityStore,
  ActionConflictError,
  canonicalActionRequestDigest,
  materializeProposal,
} from "../../src/actions/index.js";
import {
  authority,
  canonicalRequest,
  fixedNow,
  human,
  proposalDraft,
  testAuthorityResolver,
  testDigest,
} from "./fixtures.js";

const roots: string[] = [];
const root = () => {
  const value = mkdtempSync(join(tmpdir(), "vf-actions-"));
  roots.push(value);
  return value;
};
afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { force: true, recursive: true });
});

describe("durable action authority store", () => {
  test("replays only the exact scoped request and survives restart", () => {
    const directory = root();
    const store = new ActionAuthorityStore(directory, {
      now: () => fixedNow,
      authority_resolver: testAuthorityResolver(),
    });
    const proposal = materializeProposal(proposalDraft());
    const request = canonicalRequest();
    expect(store.createProposal({ authority, canonical_request: request, proposal }).created).toBe(
      true,
    );
    expect(store.createProposal({ authority, canonical_request: request, proposal }).created).toBe(
      false,
    );
    const reopened = new ActionAuthorityStore(directory);
    expect(reopened.get(proposal.proposal_id)?.proposal.proposal_digest).toBe(
      proposal.proposal_digest,
    );
    expect(() =>
      reopened.createProposal({
        authority,
        canonical_request: {
          ...request,
          request: {
            ...request.request,
            candidate: { type: "conversation.stop_operation", operation_id: "other" },
          },
        },
        proposal,
      }),
    ).toThrow(ActionConflictError);
  });

  test("approval, write-before-dispatch, terminal mirror, and pending state survive independently", () => {
    const directory = root();
    const store = new ActionAuthorityStore(directory, {
      now: () => fixedNow,
      authority_resolver: testAuthorityResolver(),
    });
    const proposal = materializeProposal(proposalDraft());
    store.createProposal({ authority, canonical_request: canonicalRequest(), proposal });
    const pendingStore = new ActionAuthorityStore(directory);
    expect(pendingStore.listPending().map((row) => row.proposal.proposal_id)).toEqual([
      proposal.proposal_id,
    ]);
    const approval = store.decide({
      proposal_id: proposal.proposal_id,
      proposal_digest: proposal.proposal_digest,
      authority,
      decision: "approved",
      challenge_id: null,
      challenge_response: null,
    });
    expect(() => store.beginDispatch(proposal.proposal_id, approval.approval_id)).toThrow(
      /dispatch record/i,
    );
    store.prepareDispatch(proposal.proposal_id, approval.approval_id);
    expect(store.beginDispatch(proposal.proposal_id, approval.approval_id).state).toBe(
      "committing",
    );
    expect(store.recordTerminal(proposal.proposal_id).state).toBe("succeeded");
    expect(
      new ActionAuthorityStore(directory, {
        authority_resolver: testAuthorityResolver(),
      }).get(proposal.proposal_id)?.state,
    ).toBe("succeeded");
  });

  test("rejects an agent approval and principal/scope replay mismatch", () => {
    const store = new ActionAuthorityStore(root(), {
      now: () => fixedNow,
      authority_resolver: testAuthorityResolver(),
    });
    const proposal = materializeProposal(proposalDraft());
    store.createProposal({ authority, canonical_request: canonicalRequest(), proposal });
    expect(() =>
      store.decide({
        proposal_id: proposal.proposal_id,
        proposal_digest: proposal.proposal_digest,
        authority: {
          ...authority,
          actor: {
            kind: "agent",
            public_actor_id: "agent-1",
            credential_class: "automation-grant",
          },
        },
        decision: "approved",
        challenge_id: null,
        challenge_response: null,
      }),
    ).toThrow(/agent/i);
    const otherAuthority = {
      ...authority,
      principal_digest: testDigest("other-principal"),
      actor: human,
    };
    const otherRequest = canonicalRequest({ principal_digest: otherAuthority.principal_digest });
    const otherProposal = materializeProposal(
      proposalDraft({
        producer_request_binding: {
          kind: "canonical-action-request",
          digest: canonicalActionRequestDigest(otherRequest),
        },
      }),
    );
    expect(
      store.createProposal({
        authority: otherAuthority,
        canonical_request: otherRequest,
        proposal: otherProposal,
      }).created,
    ).toBe(true);
  });
});
