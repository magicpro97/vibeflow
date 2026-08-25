import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionAuthorityStaleError,
  ActionAuthorityStore,
  EMPTY_PERMISSION_DIGEST,
  actionIdempotencyFileKey,
  actionIdempotencyKeyDigest,
  actionIdempotencyScopeDigest,
  boundedActionNamespaceNames,
  canonicalActionRequestDigest,
  materializeApproval,
  materializeDispatchPreparationProof,
  materializeDomainTerminalProof,
  materializeProposal,
  targetId,
} from "../../src/actions/index.js";
import { canonicalJsonBytes, digestHex, digestV1 } from "../../src/durability/index.js";
import {
  authority,
  canonicalRequest,
  fixedNow,
  proposalDraft,
  testAuthorityResolver,
  testDigest,
} from "./fixtures.js";

const roots: string[] = [];
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "vf-action-hardening-"));
  roots.push(path);
  return path;
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("action idempotency durability", () => {
  test("uses the exact file key, ignores decoys, and repairs prepared crash state", () => {
    const path = root();
    const request = canonicalRequest();
    const proposal = materializeProposal(proposalDraft());
    let crashed = false;
    const faulted = new ActionAuthorityStore(path, {
      now: () => fixedNow,
      authority_resolver: testAuthorityResolver(),
      fault: (point) => {
        if (!crashed && point === "after-idempotency-prepared") {
          crashed = true;
          throw new Error("simulated prepared crash");
        }
      },
    });
    expect(() =>
      faulted.createProposal({ authority, canonical_request: request, proposal }),
    ).toThrow(/simulated/i);
    const keyDigest = actionIdempotencyKeyDigest(proposal.idempotency_key);
    const expected = digestHex(
      digestV1("VF-ACTION-IDEMPOTENCY-FILE-KEY\0v1\0", {
        schema_version: "1.0",
        principal_digest: authority.principal_digest,
        authority_scope_digest: authority.authority_scope_digest,
        idempotency_key_digest: keyDigest,
      }),
    );
    expect(
      actionIdempotencyFileKey(
        authority.principal_digest,
        authority.authority_scope_digest,
        keyDigest,
      ),
    ).toBe(expected);
    const idempotencyDirectory = join(path, "actions", "v1", "idempotency");
    writeFileSync(join(idempotencyDirectory, `${"f".repeat(64)}.frames`), "decoy-corruption", {
      mode: 0o600,
    });
    const recovered = new ActionAuthorityStore(path, {
      now: () => fixedNow,
      authority_resolver: testAuthorityResolver(),
    });
    expect(
      recovered.createProposal({ authority, canonical_request: request, proposal }).created,
    ).toBe(false);
    expect(recovered.get(proposal.proposal_id)?.state).toBe("pending_review");
  });

  test("derives the namespace from the immutable locator and forbids bootstrap idempotency", () => {
    expect(actionIdempotencyScopeDigest({ kind: "conversation", root_session_id: "root-1" })).toBe(
      authority.authority_scope_digest,
    );
    expect(
      actionIdempotencyScopeDigest({
        kind: "capability",
        scope: "project",
        scope_identity_digest: testDigest("scope-identity"),
      }),
    ).toBe(
      digestV1("VF-ACTION-IDEMPOTENCY-SCOPE\0v1\0", {
        kind: "capability",
        scope: "project",
        scope_identity_digest: testDigest("scope-identity"),
      }),
    );

    const substitutedPath = root();
    const substituted = new ActionAuthorityStore(substitutedPath, {
      now: () => fixedNow,
      authority_resolver: testAuthorityResolver(),
    });
    const proposal = materializeProposal(proposalDraft());
    expect(() =>
      substituted.createProposal({
        authority: { ...authority, authority_scope_digest: testDigest("substituted-scope") },
        canonical_request: canonicalRequest(),
        proposal,
      }),
    ).toThrow(/scope digest/i);
    for (const directory of ["proposals", "operations", "idempotency"])
      expect(readdirSync(join(substitutedPath, "actions", "v1", directory))).toEqual([]);

    const bootstrapPath = root();
    const bootstrap = new ActionAuthorityStore(bootstrapPath, {
      now: () => fixedNow,
      authority_resolver: testAuthorityResolver(),
    });
    const bootstrapProposal = materializeProposal(repairProposalDraft("recovery-checkpoint"));
    expect(() =>
      bootstrap.createProposal({
        authority,
        canonical_request: canonicalRequest(),
        proposal: bootstrapProposal,
      }),
    ).toThrow(/bootstrap.*idempotency/i);
    for (const directory of ["proposals", "operations", "idempotency"])
      expect(readdirSync(join(bootstrapPath, "actions", "v1", directory))).toEqual([]);
  });
});

describe("review, challenge, and dispatch authority", () => {
  test("reconstructs one deterministic approval after a consumed-challenge crash", () => {
    const path = root();
    const now = { value: fixedNow };
    const { proposal, request } = userScopeProposal();
    let crashed = false;
    const first = new ActionAuthorityStore(path, {
      now: () => now.value,
      hmac_key: Buffer.alloc(32, 4),
      random_bytes: (size) => Buffer.alloc(size, 7),
      authority_resolver: testAuthorityResolver(),
      fault: (point) => {
        if (!crashed && point === "after-challenge-consume") {
          crashed = true;
          throw new Error("simulated approval crash");
        }
      },
    });
    first.createProposal({ authority, canonical_request: request, proposal });
    const challenge = first.issueChallenge({
      proposal_id: proposal.proposal_id,
      proposal_digest: proposal.proposal_digest,
      challenge_class: "fresh-user-scope",
      authority,
    });
    const decision = {
      proposal_id: proposal.proposal_id,
      proposal_digest: proposal.proposal_digest,
      authority,
      decision: "approved" as const,
      challenge_id: challenge.challenge_id,
      challenge_response: challenge.display_phrase,
    };
    expect(() => first.decide(decision)).toThrow(/simulated/i);
    const second = new ActionAuthorityStore(path, {
      now: () => now.value,
      hmac_key: Buffer.alloc(32, 4),
      authority_resolver: testAuthorityResolver(),
    });
    const approval = second.decide(decision);
    const consumed = second.getChallenge(challenge.challenge_id);
    if (!consumed?.consumed_at || !consumed.approval_expires_at)
      throw new Error("consumed challenge authority is missing");
    expect(approval.decided_at).toBe(consumed.consumed_at);
    expect(approval.expires_at).toBe(consumed.approval_expires_at);
    expect(second.decide(decision)).toEqual(approval);
    expect(second.get(proposal.proposal_id)?.state).toBe("approved");
  });

  test("derives expiry/class and persists expired or stale winners before rejecting", () => {
    const path = root();
    const now = { value: fixedNow };
    const expiredProposal = materializeProposal(
      proposalDraft({ expires_at: "2026-08-25T00:01:30.000Z" }),
    );
    const expiring = new ActionAuthorityStore(path, {
      now: () => now.value,
      authority_resolver: testAuthorityResolver(),
    });
    expiring.createProposal({
      authority,
      canonical_request: canonicalRequest(),
      proposal: expiredProposal,
    });
    now.value = Date.parse("2026-08-25T00:02:00.000Z");
    expect(() =>
      expiring.decide({
        proposal_id: expiredProposal.proposal_id,
        proposal_digest: expiredProposal.proposal_digest,
        authority,
        decision: "approved",
        challenge_id: null,
        challenge_response: null,
      }),
    ).toThrow(/expired/i);
    expect(expiring.get(expiredProposal.proposal_id)?.state).toBe("expired");

    const stalePath = root();
    const staleProposal = materializeProposal(proposalDraft());
    const stale = new ActionAuthorityStore(stalePath, {
      now: () => fixedNow,
      authority_resolver: {
        ...testAuthorityResolver(),
        review: () => {
          throw new ActionAuthorityStaleError("2026-08-25T00:01:00.000Z", "authority-head-stale");
        },
      },
    });
    stale.createProposal({
      authority,
      canonical_request: canonicalRequest(),
      proposal: staleProposal,
    });
    expect(() =>
      stale.decide({
        proposal_id: staleProposal.proposal_id,
        proposal_digest: staleProposal.proposal_digest,
        authority,
        decision: "approved",
        challenge_id: null,
        challenge_response: null,
      }),
    ).toThrow(/changed/i);
    expect(stale.get(staleProposal.proposal_id)?.state).toBe("stale");
  });

  test("rejects missing WAL proof, tampered dispatch bytes, and arbitrary terminal proof", () => {
    const path = root();
    const baseResolver = testAuthorityResolver();
    const missingWal = new ActionAuthorityStore(path, {
      now: () => fixedNow,
      authority_resolver: {
        ...baseResolver,
        proveDomainPrepared: () => {
          throw new Error("domain WAL sequence zero missing");
        },
      },
    });
    const proposal = materializeProposal(proposalDraft());
    missingWal.createProposal({ authority, canonical_request: canonicalRequest(), proposal });
    const approval = missingWal.decide(normalDecision(proposal));
    const dispatch = missingWal.prepareDispatch(proposal.proposal_id, approval.approval_id);
    expect(() => missingWal.beginDispatch(proposal.proposal_id, approval.approval_id)).toThrow(
      /WAL sequence zero/i,
    );
    expect(missingWal.get(proposal.proposal_id)?.state).toBe("committing");

    const dispatchPath = join(path, "actions", "v1", "dispatch", `${dispatch.operation_id}.json`);
    expect(existsSync(dispatchPath)).toBe(true);
    expect(existsSync(join(path, "actions", "v1", "dispatches"))).toBe(false);
    const tampered = JSON.parse(readFileSync(dispatchPath, "utf8"));
    tampered.plan_digest = testDigest("tampered-plan");
    const { dispatch_record_digest: _old, ...preimage } = tampered;
    tampered.dispatch_record_digest = digestV1("VF-ACTION-DISPATCH-RECORD\0v1\0", preimage);
    writeFileSync(dispatchPath, canonicalJsonBytes(tampered), { mode: 0o600 });
    const validWal = new ActionAuthorityStore(path, {
      now: () => fixedNow,
      authority_resolver: baseResolver,
    });
    expect(() => validWal.beginDispatch(proposal.proposal_id, approval.approval_id)).toThrow(
      /closure mismatch/i,
    );

    writeFileSync(dispatchPath, canonicalJsonBytes(dispatch), { mode: 0o600 });
    expect(validWal.beginDispatch(proposal.proposal_id, approval.approval_id).state).toBe(
      "committing",
    );
    const forgedTerminal = new ActionAuthorityStore(path, {
      now: () => fixedNow,
      authority_resolver: {
        ...baseResolver,
        resolveTerminal: ({ dispatch: durable }) => ({
          ...materializeDomainTerminalProof(
            durable,
            "succeeded",
            testDigest("terminal"),
            "2026-08-25T00:03:00.000Z",
          ),
          domain_terminal_digest: testDigest("caller-invented"),
        }),
      },
    });
    expect(() => forgedTerminal.recordTerminal(proposal.proposal_id)).toThrow(/proof mismatch/i);
    expect(forgedTerminal.get(proposal.proposal_id)?.state).toBe("committing");
  });

  test("orders header, dispatch, committing authority, then recoverable domain sequence zero", () => {
    const path = root();
    const order: string[] = [];
    const base = testAuthorityResolver();
    let interrupted = false;
    const first = new ActionAuthorityStore(path, {
      now: () => fixedNow,
      authority_resolver: {
        ...base,
        prepareDispatch: (input) => {
          order.push("header");
          return base.prepareDispatch(input);
        },
        proveDomainPrepared: (input) => {
          order.push("domain-sequence-zero");
          return base.proveDomainPrepared(input);
        },
      },
      fault: (point) => {
        if (!interrupted && point === "after-action-committing") {
          interrupted = true;
          order.push("committing-durable");
          throw new Error("simulated post-transition crash");
        }
      },
    });
    const proposal = materializeProposal(proposalDraft());
    first.createProposal({ authority, canonical_request: canonicalRequest(), proposal });
    const approval = first.decide(normalDecision(proposal));
    first.prepareDispatch(proposal.proposal_id, approval.approval_id);
    expect(order).toEqual(["header"]);
    expect(() => first.beginDispatch(proposal.proposal_id, approval.approval_id)).toThrow(
      /post-transition crash/i,
    );
    expect(order).toEqual(["header", "committing-durable"]);
    expect(first.get(proposal.proposal_id)?.state).toBe("committing");

    const recovered = new ActionAuthorityStore(path, {
      now: () => fixedNow,
      authority_resolver: {
        ...base,
        proveDomainPrepared: (input) => {
          order.push("domain-sequence-zero");
          return base.proveDomainPrepared(input);
        },
      },
    });
    expect(recovered.beginDispatch(proposal.proposal_id, approval.approval_id).state).toBe(
      "committing",
    );
    expect(order).toEqual(["header", "committing-durable", "domain-sequence-zero"]);
  });

  test("rejects wrong header nullability and stale live authority before dispatch", () => {
    const headerPath = root();
    const headerProposal = materializeProposal(proposalDraft());
    const wrongHeader = new ActionAuthorityStore(headerPath, {
      now: () => fixedNow,
      authority_resolver: {
        ...testAuthorityResolver(),
        prepareDispatch: ({ proposal, approval, now }) =>
          materializeDispatchPreparationProof(
            proposal,
            approval,
            testDigest("forbidden-simple-receipt-header"),
            now,
          ),
      },
    });
    wrongHeader.createProposal({
      authority,
      canonical_request: canonicalRequest(),
      proposal: headerProposal,
    });
    const headerApproval = wrongHeader.decide(normalDecision(headerProposal));
    expect(() =>
      wrongHeader.prepareDispatch(headerProposal.proposal_id, headerApproval.approval_id),
    ).toThrow(/header nullability/i);
    expect(wrongHeader.get(headerProposal.proposal_id)?.state).toBe("approved");

    const stalePath = root();
    const staleProposal = materializeProposal(proposalDraft());
    const stale = new ActionAuthorityStore(stalePath, {
      now: () => fixedNow,
      authority_resolver: {
        ...testAuthorityResolver(),
        prepareDispatch: () => {
          throw new ActionAuthorityStaleError("2026-08-25T00:02:00.000Z", "authority-head-stale");
        },
      },
    });
    stale.createProposal({
      authority,
      canonical_request: canonicalRequest(),
      proposal: staleProposal,
    });
    const staleApproval = stale.decide(normalDecision(staleProposal));
    expect(() =>
      stale.prepareDispatch(staleProposal.proposal_id, staleApproval.approval_id),
    ).toThrow(/authority changed/i);
    expect(stale.get(staleProposal.proposal_id)?.state).toBe("stale");
  });

  test("makes a competing approval decision first-writer-wins", () => {
    const path = root();
    const proposal = materializeProposal(proposalDraft());
    const first = new ActionAuthorityStore(path, {
      now: () => fixedNow,
      authority_resolver: testAuthorityResolver(),
    });
    const competitor = new ActionAuthorityStore(path, {
      now: () => fixedNow,
      authority_resolver: testAuthorityResolver(),
    });
    first.createProposal({ authority, canonical_request: canonicalRequest(), proposal });
    const winner = first.decide(normalDecision(proposal));
    expect(winner.decision).toBe("approved");
    expect(() =>
      competitor.decide({
        ...normalDecision(proposal),
        decision: "denied",
      }),
    ).toThrow(/not pending review/i);
    const settled = competitor.get(proposal.proposal_id);
    expect(settled?.approval).toEqual(winner);
    expect(settled?.events).toHaveLength(2);
  });

  test("rechecks approval expiry and typed staleness at the commit boundary", () => {
    const expiryPath = root();
    const clock = { value: fixedNow };
    const proposal = materializeProposal(proposalDraft());
    const expiring = new ActionAuthorityStore(expiryPath, {
      now: () => clock.value,
      authority_resolver: testAuthorityResolver(),
    });
    expiring.createProposal({ authority, canonical_request: canonicalRequest(), proposal });
    const approval = expiring.decide(normalDecision(proposal));
    expiring.prepareDispatch(proposal.proposal_id, approval.approval_id);
    clock.value = Date.parse("2026-08-25T00:30:00.000Z");
    expect(() => expiring.beginDispatch(proposal.proposal_id, approval.approval_id)).toThrow(
      /expired/i,
    );
    expect(expiring.get(proposal.proposal_id)?.state).toBe("expired");

    const stalePath = root();
    const staleProposal = materializeProposal(proposalDraft());
    const stale = new ActionAuthorityStore(stalePath, {
      now: () => fixedNow,
      authority_resolver: {
        ...testAuthorityResolver(),
        proveDomainPrepared: () => {
          throw new ActionAuthorityStaleError(
            "2026-08-25T00:02:00.000Z",
            "domain-precondition-stale",
          );
        },
      },
    });
    stale.createProposal({
      authority,
      canonical_request: canonicalRequest(),
      proposal: staleProposal,
    });
    const staleApproval = stale.decide(normalDecision(staleProposal));
    stale.prepareDispatch(staleProposal.proposal_id, staleApproval.approval_id);
    expect(() => stale.beginDispatch(staleProposal.proposal_id, staleApproval.approval_id)).toThrow(
      ActionAuthorityStaleError,
    );
    expect(stale.get(staleProposal.proposal_id)?.state).toBe("committing");
  });
});

describe("durable action codecs", () => {
  test("bounds proposal enumeration at the shared namespace ceiling", () => {
    const names = Array.from({ length: 16_385 }, (_, index) => `vf-proposal-${index}.json`);
    expect(() => boundedActionNamespaceNames(names, /\.json$/)).toThrow(/namespace exceeds bound/i);
  });

  test("rejects tampering in authority, idempotency, and challenge VFFR journals", () => {
    const authorityPath = root();
    const proposal = materializeProposal(proposalDraft());
    const actionStore = new ActionAuthorityStore(authorityPath, {
      now: () => fixedNow,
      authority_resolver: testAuthorityResolver(),
    });
    actionStore.createProposal({ authority, canonical_request: canonicalRequest(), proposal });
    tamperJournal(
      join(authorityPath, "actions", "v1", "operations", `${proposal.proposal_id}.frames`),
      proposal.proposal_id,
    );
    expect(() => actionStore.get(proposal.proposal_id)).toThrow();

    const idempotencyPath = root();
    const idempotentProposal = materializeProposal(proposalDraft());
    const idempotentStore = new ActionAuthorityStore(idempotencyPath, {
      now: () => fixedNow,
      authority_resolver: testAuthorityResolver(),
    });
    idempotentStore.createProposal({
      authority,
      canonical_request: canonicalRequest(),
      proposal: idempotentProposal,
    });
    const fileKey = actionIdempotencyFileKey(
      authority.principal_digest,
      authority.authority_scope_digest,
      actionIdempotencyKeyDigest(idempotentProposal.idempotency_key),
    );
    tamperJournal(
      join(idempotencyPath, "actions", "v1", "idempotency", `${fileKey}.frames`),
      idempotentProposal.proposal_id,
    );
    expect(() =>
      idempotentStore.createProposal({
        authority,
        canonical_request: canonicalRequest(),
        proposal: idempotentProposal,
      }),
    ).toThrow();

    const challengePath = root();
    const challenged = userScopeProposal();
    const challengeStore = new ActionAuthorityStore(challengePath, {
      now: () => fixedNow,
      hmac_key: Buffer.alloc(32, 3),
      random_bytes: (size) => Buffer.alloc(size, 9),
      authority_resolver: testAuthorityResolver(),
    });
    challengeStore.createProposal({
      authority,
      canonical_request: challenged.request,
      proposal: challenged.proposal,
    });
    const challenge = challengeStore.issueChallenge({
      proposal_id: challenged.proposal.proposal_id,
      proposal_digest: challenged.proposal.proposal_digest,
      challenge_class: "fresh-user-scope",
      authority,
    });
    tamperJournal(
      join(challengePath, "actions", "v1", "challenges", `${challenge.challenge_id}.frames`),
      challenged.proposal.proposal_id,
    );
    expect(() => challengeStore.getChallenge(challenge.challenge_id)).toThrow();
  });
});

describe("proposal closure validation", () => {
  test("rejects short digests, locator/base drift, target/pin tamper, and missing closure", () => {
    expect(() =>
      materializeProposal(
        proposalDraft({ base: { ...proposalDraft().base, authority_head_digest: "sha256:short" } }),
      ),
    ).toThrow(/digest/i);
    expect(() =>
      materializeProposal(
        proposalDraft({
          action_root_locator: {
            kind: "recovery-bootstrap",
            bootstrap_identity_digest: testDigest("bootstrap"),
          },
        }),
      ),
    ).toThrow(/producer binding|recovery-bootstrap/i);
    const target = userTarget();
    expect(() =>
      materializeProposal(
        proposalDraft({
          risk: "high",
          target_set: [{ ...target, target_id: "vf-target-deadbeef" }],
          preview: {
            ...proposalDraft().preview,
            targets: [{ ...target, target_id: "vf-target-deadbeef" }],
          },
        }),
      ),
    ).toThrow(/target ID/i);
    const pin = {
      id: "demo.package",
      version: "1.0.0",
      source: {
        kind: "git" as const,
        canonical_url: "https://example.invalid/repo.git",
        commit_oid: "a".repeat(40),
      },
      content_sha256: "a".repeat(64),
      trust: "source-pinned" as const,
      nonportable: false,
      pin_digest: testDigest("wrong-pin"),
    };
    expect(() =>
      materializeProposal(
        proposalDraft({
          package_pins: [pin],
          preview: {
            ...proposalDraft().preview,
            package_pins: [
              {
                id: pin.id,
                version: pin.version,
                source_kind: pin.source.kind,
                content_sha256: pin.content_sha256,
                trust: pin.trust,
                nonportable: pin.nonportable,
                pin_digest: pin.pin_digest,
              },
            ],
          },
        }),
      ),
    ).toThrow(/pin digest/i);
    expect(() =>
      materializeProposal(
        proposalDraft({
          domain: "capability",
          action: {
            type: "capability.install",
            package: { id: "demo.package" },
            scope: "project",
            requested_targets: [],
            inputs: [],
          },
          base: { ...proposalDraft().base, capability_scope: "project" },
          preview: { ...proposalDraft().preview, action_type: "capability.install" },
          execution_object_closure_digest: null,
        }),
      ),
    ).toThrow(/closure/i);
  });

  test("enforces capability/action scope and the current/bootstrap repair owner matrix", () => {
    const capability = capabilityProposalDraft();
    const capabilityAction = capability.action;
    if (capabilityAction.type !== "capability.install")
      throw new Error("capability fixture has wrong discriminant");
    expect(materializeProposal(capability).base.capability_scope).toBe("project");
    expect(() =>
      materializeProposal({
        ...capability,
        action: { ...capabilityAction, scope: "user" },
      }),
    ).toThrow(/scope mismatch/i);
    expect(() =>
      materializeProposal({
        ...capability,
        action_root_locator: {
          kind: "capability",
          scope: "project",
          scope_identity_digest: testDigest("project-scope"),
        },
      }),
    ).toThrow(/conversation authority/i);

    const currentRepair = repairProposalDraft("current");
    const repairAction = currentRepair.action;
    if (repairAction.type !== "authority.repair")
      throw new Error("repair fixture has wrong discriminant");
    expect(materializeProposal(currentRepair).action_root_locator.kind).toBe("capability");
    expect(() =>
      materializeProposal({
        ...currentRepair,
        base: {
          ...currentRepair.base,
          repair_authorization_binding_digest: testDigest("wrong-repair-binding"),
        },
      }),
    ).toThrow(/repair authority/i);
    expect(() =>
      materializeProposal({
        ...currentRepair,
        action: {
          ...repairAction,
          plan: {
            ...repairAction.plan,
            permission_digest: testDigest("forbidden-repair-permission"),
          },
        },
      }),
    ).toThrow(/permission binding/i);

    const bootstrapRepair = repairProposalDraft("recovery-checkpoint");
    expect(materializeProposal(bootstrapRepair).action_root_locator.kind).toBe(
      "recovery-bootstrap",
    );
    expect(() =>
      materializeProposal({
        ...bootstrapRepair,
        producer_request_binding: {
          kind: "recovery-bootstrap-repair-plan",
          digest: testDigest("another-repair-plan"),
        },
      }),
    ).toThrow(/does not bind the repair plan/i);
  });

  test("derives the exact approval class from actor, action, and bootstrap authority", () => {
    const ordinary = materializeProposal(proposalDraft());
    expect(() =>
      materializeApproval(ordinary, {
        decision: "approved",
        decided_by: {
          kind: "human-cli",
          public_actor_id: "automation-1",
          credential_class: "automation-grant",
        },
        challenge_class: "normal-confirm",
        challenge_digest: null,
        decided_at: "2026-08-25T00:01:00.000Z",
        expires_at: "2026-08-25T00:10:00.000Z",
      }),
    ).toThrow(/automation-grant/i);
    const bootstrap = materializeProposal(repairProposalDraft("recovery-checkpoint"));
    expect(
      materializeApproval(bootstrap, {
        decision: "approved",
        decided_by: {
          kind: "human-cli",
          public_actor_id: "recovery-operator-1",
          credential_class: "recovery",
        },
        challenge_class: "recovery-tty",
        challenge_digest: null,
        decided_at: "2026-08-25T00:01:00.000Z",
        expires_at: "2026-08-25T00:10:00.000Z",
      }).challenge_class,
    ).toBe("recovery-tty");
  });
});

function normalDecision(proposal: ReturnType<typeof materializeProposal>) {
  return {
    proposal_id: proposal.proposal_id,
    proposal_digest: proposal.proposal_digest,
    authority,
    decision: "approved" as const,
    challenge_id: null,
    challenge_response: null,
  };
}

function userTarget() {
  const value = {
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
  return { target_id: targetId(value), ...value };
}

function userScopeProposal() {
  const target = userTarget();
  const request = canonicalRequest();
  const proposal = materializeProposal(
    proposalDraft({
      risk: "high",
      target_set: [target],
      preview: {
        ...proposalDraft().preview,
        targets: [target],
        target_dispositions: [
          { target_id: target.target_id, execution: "host", reason_code: null },
        ],
      },
      producer_request_binding: {
        kind: "canonical-action-request",
        digest: canonicalActionRequestDigest(request),
      },
    }),
  );
  return { proposal, request };
}

function capabilityProposalDraft() {
  const draft = proposalDraft();
  return proposalDraft({
    domain: "capability",
    execution_object_closure_digest: testDigest("execution-closure"),
    base: { ...draft.base, capability_scope: "project" },
    action: {
      type: "capability.install",
      package: { id: "demo.package" },
      scope: "project",
      requested_targets: [{ engine: "codex", participant_id: null }],
      inputs: [],
    },
    preview: { ...draft.preview, action_type: "capability.install" },
  });
}

function repairProposalDraft(mode: "current" | "recovery-checkpoint") {
  const draft = proposalDraft();
  const repairBinding = testDigest("repair-authorization");
  const planPreimage = {
    schema_version: "1.0" as const,
    domain: "capability-lock" as const,
    authority_scope: "project" as const,
    scope_id: "project-1",
    target_preimage: {
      presence: "present" as const,
      corrupt_bytes_sha256: "a".repeat(64),
      quarantine_ref: testDigest("quarantine-1"),
      absence_evidence_digest: null,
    },
    last_valid_record_digest: testDigest("repair-last-valid"),
    proposed_restored_authority_digest: testDigest("repair-restored"),
    lost_tail_digest: null,
    journal_identity_digest: testDigest("repair-journal"),
    repair_steps_digest: testDigest("repair-steps"),
    repair_authorization_binding_digest: repairBinding,
    permission_digest: EMPTY_PERMISSION_DIGEST,
    risk: "critical" as const,
    created_at: "2026-08-25T00:00:00.000Z",
    expires_at: "2026-08-25T00:30:00.000Z",
  };
  const planDigest = digestV1("VF-AUTHORITY-REPAIR-PLAN\0v1\0", planPreimage);
  const plan = {
    ...planPreimage,
    repair_id: `vf-authority-repair-${digestHex(planDigest)}`,
    plan_digest: planDigest,
  };
  const bootstrap = mode === "recovery-checkpoint";
  return proposalDraft({
    origin_event_id: null,
    domain: "capability",
    action_root_locator: bootstrap
      ? { kind: "recovery-bootstrap", bootstrap_identity_digest: testDigest("bootstrap") }
      : {
          kind: "capability",
          scope: "project",
          scope_identity_digest: testDigest("project-scope"),
        },
    producer_request_binding: bootstrap
      ? { kind: "recovery-bootstrap-repair-plan", digest: plan.plan_digest }
      : { kind: "canonical-action-request", digest: testDigest("repair-request") },
    base: {
      ...draft.base,
      root_session_id: null,
      conversation_id: null,
      revision_id: null,
      last_seq: null,
      conversation_lock_digest: null,
      lineage_head_digest: null,
      lineage_head_epoch: null,
      capability_scope: "project",
      authority_binding_mode: mode,
      repair_authorization_binding_digest: repairBinding,
    },
    action: { type: "authority.repair", plan },
    risk: "critical",
    permission_digest: EMPTY_PERMISSION_DIGEST,
    preview: { ...draft.preview, action_type: "authority.repair" },
  });
}

function tamperJournal(path: string, marker: string): void {
  const bytes = readFileSync(path);
  const offset = bytes.indexOf(Buffer.from(marker, "utf8"));
  if (offset < 0) throw new Error("test marker is missing from durable journal");
  bytes[offset] = (bytes[offset] ?? 0) ^ 1;
  writeFileSync(path, bytes, { mode: 0o600 });
}
