import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionAuthorityStore, materializeProposal } from "../../src/actions/index.js";
import {
  authority,
  canonicalRequest,
  fixedNow,
  proposalDraft,
  testAuthorityResolver,
} from "./fixtures.js";

const roots: string[] = [];
const root = () => {
  const value = mkdtempSync(join(tmpdir(), "vf-actions-cache-"));
  roots.push(value);
  return value;
};
afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { force: true, recursive: true });
});

describe("durable action authority store proposal listing cache", () => {
  test("list() reflects proposals created after the first read (write invalidation)", () => {
    const store = new ActionAuthorityStore(root(), {
      now: () => fixedNow,
      authority_resolver: testAuthorityResolver(),
    });
    const first = materializeProposal(proposalDraft({ idempotency_key: "cache-request-a" }));
    store.createProposal({ authority, canonical_request: canonicalRequest(), proposal: first });
    expect(store.list().length).toBe(1);
    const second = materializeProposal(proposalDraft({ idempotency_key: "cache-request-b" }));
    store.createProposal({ authority, canonical_request: canonicalRequest(), proposal: second });
    expect(store.list().length).toBe(2);
    expect(store.listPending().length).toBe(2);
  });

  test("a second store instance's writes are visible to the cached listing", () => {
    const directory = root();
    const reader = new ActionAuthorityStore(directory, {
      now: () => fixedNow,
      authority_resolver: testAuthorityResolver(),
    });
    const writer = new ActionAuthorityStore(directory, {
      now: () => fixedNow,
      authority_resolver: testAuthorityResolver(),
    });
    expect(reader.list().length).toBe(0);
    const proposal = materializeProposal(proposalDraft({ idempotency_key: "cache-request-c" }));
    writer.createProposal({ authority, canonical_request: canonicalRequest(), proposal });
    expect(reader.list().length).toBe(1);
    expect(reader.get(proposal.proposal_id)?.proposal.proposal_digest).toBe(
      proposal.proposal_digest,
    );
    // Removing the backing files must invalidate the cached listing.
    rmSync(reader.actionRootPath(), { force: true, recursive: true });
    expect(reader.list().length).toBe(0);
  });

  test("a second instance's state transition is visible to the cached snapshot read", () => {
    const directory = root();
    const reader = new ActionAuthorityStore(directory, {
      now: () => fixedNow,
      authority_resolver: testAuthorityResolver(),
    });
    const writer = new ActionAuthorityStore(directory, {
      now: () => fixedNow,
      authority_resolver: testAuthorityResolver(),
    });
    const proposal = materializeProposal(proposalDraft({ idempotency_key: "cache-request-e" }));
    writer.createProposal({ authority, canonical_request: canonicalRequest(), proposal });
    expect(reader.get(proposal.proposal_id)?.state).toBe("pending_review");
    const approval = writer.decide({
      proposal_id: proposal.proposal_id,
      proposal_digest: proposal.proposal_digest,
      authority,
      decision: "denied",
      challenge_id: null,
      challenge_response: null,
    });
    expect(approval.decision).toBe("denied");
    expect(reader.get(proposal.proposal_id)?.state).toBe("denied");
  });

  test("fresh store instance still reads persisted state from disk", () => {
    const directory = root();
    const store = new ActionAuthorityStore(directory, {
      now: () => fixedNow,
      authority_resolver: testAuthorityResolver(),
    });
    const proposal = materializeProposal(proposalDraft({ idempotency_key: "cache-request-d" }));
    store.createProposal({ authority, canonical_request: canonicalRequest(), proposal });
    const reopened = new ActionAuthorityStore(directory);
    expect(reopened.list().length).toBe(1);
    expect(reopened.get(proposal.proposal_id)?.proposal.proposal_digest).toBe(
      proposal.proposal_digest,
    );
  });
});
