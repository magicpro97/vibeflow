import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPABILITY_TRUST_TRANSITION } from "../../src/actions/capability-security-contract.js";
import { HOST_ACTION_KIND } from "../../src/actions/host-action-contract.js";
import {
  ActionAuthorityStore,
  type ActionRequestAuthorityV1,
  actionIdempotencyScopeDigest,
  createDurableActionAuthorityReaderV1,
} from "../../src/actions/index.js";
import {
  AUTHORITY_CHANGE_DIGEST_DOMAIN,
  ORDINARY_AUTHORITY_MUTATION_FAULT_POINT,
  type OrdinaryAuthorityMutationFaultPointV1,
  OrdinaryAuthorityMutationServiceV1,
  type OrdinaryAuthorityRequestActionV1,
  type SecretRevocationCandidateV1,
} from "../../src/capabilities/authority-mutation/index.js";
import { createDurableAuthorityTransitionResolver } from "../../src/capabilities/source/durable-authority-transition-resolver.js";
import {
  activateProjectCapabilityAuthorityForVfInit,
  activateUserCapabilityAuthorityForTrustedInstall,
  readDurableAuthorityState,
} from "../../src/capabilities/source/index.js";
import {
  projectCapabilityPaths,
  userCapabilityPaths,
} from "../../src/capabilities/storage/index.js";
import {
  acquireProcessLock,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestV1,
} from "../../src/durability/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function testDigest(label: string): string {
  return digestV1("VF-TEST-ORDINARY-AUTHORITY\0v1\0", label);
}

function fixture(scope: "project" | "user") {
  const root = mkdtempSync(join(tmpdir(), `vf-ordinary-authority-${scope}-`));
  roots.push(root);
  const projectRoot = join(root, "project");
  const userRoot = join(root, "home", ".vibeflow");
  const settings = Buffer.from(
    '{\n  "schema_version": "1.0",\n  "theme": "warm",\n  "authority": {"mode":"strict"}\n}\n',
  );
  let paths: ReturnType<typeof projectCapabilityPaths>;
  let activation: ReturnType<typeof activateProjectCapabilityAuthorityForVfInit>;
  if (scope === "project") {
    mkdirSync(join(projectRoot, ".vibeflow"), { recursive: true });
    writeFileSync(join(projectRoot, ".vibeflow", "SETTINGS.json"), settings);
    paths = projectCapabilityPaths(projectRoot);
    activation = activateProjectCapabilityAuthorityForVfInit(projectRoot, {
      now: () => "2030-01-01T00:00:00.000Z",
      random_bytes: (size) => Buffer.alloc(size, 1),
    });
  } else {
    mkdirSync(userRoot, { recursive: true });
    writeFileSync(join(userRoot, "SETTINGS.json"), settings);
    paths = userCapabilityPaths(userRoot);
    activation = activateUserCapabilityAuthorityForTrustedInstall(userRoot, {
      now: () => "2030-01-01T00:00:00.000Z",
      random_bytes: (size) => Buffer.alloc(size, 2),
    });
  }
  let clock = Date.parse("2030-01-01T00:00:01.000Z");
  const readerRef: { value: ReturnType<typeof createDurableActionAuthorityReaderV1> | null } = {
    value: null,
  };
  const transitionResolver = createDurableAuthorityTransitionResolver({
    resolve: (locator) => {
      if (
        locator.kind !== "capability" ||
        locator.scope !== scope ||
        locator.scope_identity_digest !== activation.identity.content_digest
      )
        throw new Error("test action locator changed");
      if (!readerRef.value) throw new Error("test action reader is not bound");
      return readerRef.value;
    },
  });
  let faultPoint: OrdinaryAuthorityMutationFaultPointV1 | null = null;
  const domain = new OrdinaryAuthorityMutationServiceV1({
    paths,
    authority_transition_resolver: transitionResolver,
    action_authority: () => {
      if (!readerRef.value) throw new Error("test action reader is not bound");
      return readerRef.value;
    },
    now: () => new Date(clock).toISOString(),
    random_bytes: (size) => Buffer.alloc(size, 9),
    secret_candidate_authority: { validateCurrent: () => undefined },
    fault: (point) => {
      if (point === faultPoint) throw new Error(`fault:${point}`);
    },
  });
  const actionStore = new ActionAuthorityStore(paths.privateRoot, {
    now: () => clock,
    random_bytes: (size) => Buffer.alloc(size, 8),
    hmac_key: Buffer.alloc(32, 7),
    authority_resolver: domain.resolver,
  });
  readerRef.value = createDurableActionAuthorityReaderV1(actionStore);
  const locator = {
    kind: "capability" as const,
    scope,
    scope_identity_digest: activation.identity.content_digest,
  };
  const authority: ActionRequestAuthorityV1 = {
    schema_version: "1.0",
    principal_digest: testDigest(`${scope}:principal`),
    authority_scope_digest: actionIdempotencyScopeDigest(locator),
    control_session_digest: testDigest(`${scope}:session`),
    csrf_epoch_digest: testDigest(`${scope}:csrf`),
    actor: {
      kind: "human-cli",
      public_actor_id: `${scope}-operator`,
      credential_class: "interactive-tty",
    },
  };

  function run(action: OrdinaryAuthorityRequestActionV1, key: string) {
    const prepared = domain.prepareProposal({
      request_action: action,
      request_authority: authority,
      idempotency_key: key,
      secret_candidate:
        action.type === HOST_ACTION_KIND.SECRET_REVOKE
          ? domain.store.readSecretCandidate(action.private_binding_id)
          : null,
    });
    domain.store.writeActionClosure(prepared.private_closure);
    actionStore.createProposal({
      authority,
      canonical_request: prepared.canonical_request,
      proposal: prepared.proposal,
    });
    clock += 1_000;
    const challenge =
      scope === "user"
        ? actionStore.issueChallenge({
            proposal_id: prepared.proposal.proposal_id,
            proposal_digest: prepared.proposal.proposal_digest,
            challenge_class: "fresh-user-scope",
            authority,
          })
        : null;
    const approval = actionStore.decide({
      proposal_id: prepared.proposal.proposal_id,
      proposal_digest: prepared.proposal.proposal_digest,
      authority,
      decision: "approved",
      challenge_id: challenge?.challenge_id ?? null,
      challenge_response: challenge?.display_phrase ?? null,
    });
    domain.prepareApproved(prepared.proposal, approval);
    actionStore.prepareDispatch(prepared.proposal.proposal_id, approval.approval_id);
    actionStore.beginDispatch(prepared.proposal.proposal_id, approval.approval_id);
    const terminal = domain.execute(
      actionStore.getRecorded(prepared.proposal.proposal_id)?.operation_id ?? "missing",
    );
    const final = actionStore.recordTerminal(prepared.proposal.proposal_id);
    expect(final.state).toBe("succeeded");
    expect(final.domain_terminal_digest).toBe(terminal.domain_terminal_digest);
    clock += 1_000;
    return { prepared, approval, terminal };
  }

  return {
    root,
    paths,
    activation,
    authority,
    domain,
    actionStore,
    transitionResolver,
    run,
    setFault: (point: OrdinaryAuthorityMutationFaultPointV1 | null) => {
      faultPoint = point;
    },
  };
}

function grant(scope: "project" | "user") {
  return {
    scope,
    principal_id: `${scope}-agent`,
    action_types: [HOST_ACTION_KIND.CAPABILITY_INSTALL],
    permissions: [],
    target_engines: [],
    expires_at: "2031-01-01T00:00:00.000Z",
  };
}

function prepareCommittingGrant(fx: ReturnType<typeof fixture>, idempotencyKey: string) {
  const prepared = fx.domain.prepareProposal({
    request_action: { type: HOST_ACTION_KIND.GRANT_CREATE, grant: grant("project") },
    request_authority: fx.authority,
    idempotency_key: idempotencyKey,
  });
  fx.domain.store.writeActionClosure(prepared.private_closure);
  fx.actionStore.createProposal({
    authority: fx.authority,
    canonical_request: prepared.canonical_request,
    proposal: prepared.proposal,
  });
  const approval = fx.actionStore.decide({
    proposal_id: prepared.proposal.proposal_id,
    proposal_digest: prepared.proposal.proposal_digest,
    authority: fx.authority,
    decision: "approved",
    challenge_id: null,
    challenge_response: null,
  });
  fx.domain.prepareApproved(prepared.proposal, approval);
  fx.actionStore.prepareDispatch(prepared.proposal.proposal_id, approval.approval_id);
  const committing = fx.actionStore.beginDispatch(
    prepared.proposal.proposal_id,
    approval.approval_id,
  );
  return {
    prepared,
    operationId: committing.operation_id ?? "missing",
  };
}

function reopenAuthority(fx: ReturnType<typeof fixture>) {
  let reader: ReturnType<typeof createDurableActionAuthorityReaderV1> | null = null;
  const domain = new OrdinaryAuthorityMutationServiceV1({
    paths: fx.paths,
    authority_transition_resolver: fx.transitionResolver,
    action_authority: () => {
      if (!reader) throw new Error("reader absent");
      return reader;
    },
    now: () => "2030-01-01T00:00:02.000Z",
    secret_candidate_authority: { validateCurrent: () => undefined },
  });
  const store = new ActionAuthorityStore(fx.paths.privateRoot, {
    now: () => Date.parse("2030-01-01T00:00:02.000Z"),
    authority_resolver: domain.resolver,
  });
  reader = createDurableActionAuthorityReaderV1(store);
  return { domain, store };
}

describe("ordinary capability-authority mutation domain", () => {
  test("commits every typed project mutation and replays through durable authority verification", () => {
    const fx = fixture("project");
    const issued = fx.run(
      { type: HOST_ACTION_KIND.GRANT_CREATE, grant: grant("project") },
      "issue",
    );
    const grantId = issued.prepared.authority_plan.authority_subject_id;
    fx.run(
      { type: HOST_ACTION_KIND.GRANT_RENEW, grant_id: grantId, grant: grant("project") },
      "renew",
    );
    const { publicKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ format: "der", type: "spki" });
    fx.run(
      {
        type: HOST_ACTION_KIND.REGISTRY_TRUST_KEY,
        scope: "project",
        change: {
          transition: "added",
          key_id: `sha256:${Bun.CryptoHasher.hash("sha256", spki, "hex")}`,
          algorithm: "Ed25519",
          public_key_spki_base64: spki.toString("base64"),
          registry_origin: "https://registry.example",
          publisher_id: "acme",
          valid_from: "2029-01-01T00:00:00.000Z",
          valid_until: "2032-01-01T00:00:00.000Z",
          reason: null,
        },
      },
      "trust",
    );
    fx.run(
      {
        type: HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY,
        scope: "project",
        replacement_authority_subtree: { mode: "strict", approvals: "two-person" },
      },
      "policy",
    );

    const candidateDraft = {
      schema_version: "1.0" as const,
      scope: "project" as const,
      scope_identity_digest: fx.activation.identity.content_digest,
      package_id: "acme.tool",
      input_id: "token",
      secret_handle_id_digest: testDigest("secret-handle"),
      broker_binding_epoch: 1,
      broker_scope_digest: testDigest("broker-scope"),
      source_current_head_digest: testDigest("broker-head"),
      source_action_root_locator: {
        kind: "capability" as const,
        scope: "project" as const,
        scope_identity_digest: fx.activation.identity.content_digest,
      },
      source_private_input_binding_digest: testDigest("private-input"),
      created_at: "2030-01-01T00:00:00.000Z",
    };
    const bindingDigest = digestV1(AUTHORITY_CHANGE_DIGEST_DOMAIN.SECRET_CANDIDATE, candidateDraft);
    const candidate: SecretRevocationCandidateV1 = {
      ...candidateDraft,
      private_binding_id: `vf-secret-revocation-binding-${bindingDigest.slice(7)}`,
      binding_digest: bindingDigest,
    };
    const candidateRoot = join(
      fx.paths.privateRoot,
      "actions",
      "v1",
      "secret-revocation-candidates",
    );
    const candidateLock = acquireProcessLock(
      join(fx.paths.privateRoot, "actions", "v1", "writer.lock"),
      { operation: "ordinary-authority-test-candidate", coverageRoot: fx.paths.privateRoot },
    );
    try {
      createOrVerifyPrivateFile(
        join(candidateRoot, `${candidate.private_binding_id}.json`),
        canonicalJsonBytes(candidate),
        { lock: candidateLock },
      );
    } finally {
      candidateLock.release();
    }
    fx.run(
      {
        type: HOST_ACTION_KIND.SECRET_REVOKE,
        scope: "project",
        private_binding_id: candidate.private_binding_id,
        expected_binding_digest: candidate.binding_digest,
      },
      "secret",
    );
    fx.run({ type: HOST_ACTION_KIND.GRANT_REVOKE, scope: "project", grant_id: grantId }, "revoke");

    const verified = readDurableAuthorityState({
      private_root: fx.paths.privateRoot,
      identity_path: fx.paths.identity,
      scope: "project",
      scope_identity_digest: fx.activation.identity.content_digest,
      initial_authority_head_digest: fx.activation.receipt.initial_authority_head_digest,
      authority_transition_resolver: fx.transitionResolver,
    });
    expect(verified.current.authority_epoch).toBe(6);
    expect(verified.grants).toHaveLength(3);
    expect(verified.policies).toHaveLength(3);
    expect(verified.secrets).toHaveLength(1);
    expect(verified.trust).toHaveLength(1);
  });

  test("recovers an fsynced event tail idempotently without minting a second epoch", () => {
    const fx = fixture("project");
    const prepared = fx.domain.prepareProposal({
      request_action: { type: HOST_ACTION_KIND.GRANT_CREATE, grant: grant("project") },
      request_authority: fx.authority,
      idempotency_key: "crash-replay",
    });
    fx.domain.store.writeActionClosure(prepared.private_closure);
    fx.actionStore.createProposal({
      authority: fx.authority,
      canonical_request: prepared.canonical_request,
      proposal: prepared.proposal,
    });
    const approval = fx.actionStore.decide({
      proposal_id: prepared.proposal.proposal_id,
      proposal_digest: prepared.proposal.proposal_digest,
      authority: fx.authority,
      decision: "approved",
      challenge_id: null,
      challenge_response: null,
    });
    fx.domain.prepareApproved(prepared.proposal, approval);
    fx.actionStore.prepareDispatch(prepared.proposal.proposal_id, approval.approval_id);
    const committing = fx.actionStore.beginDispatch(
      prepared.proposal.proposal_id,
      approval.approval_id,
    );
    fx.setFault("after-epoch-event");
    expect(() => fx.domain.execute(committing.operation_id ?? "missing")).toThrow(
      /fault:after-epoch-event/,
    );
    fx.setFault(null);
    const terminal = fx.domain.execute(committing.operation_id ?? "missing");
    fx.actionStore.recordTerminal(prepared.proposal.proposal_id);
    expect(terminal.outcome).toBe("succeeded");
    expect(fx.domain.execute(committing.operation_id ?? "missing").domain_terminal_digest).toBe(
      terminal.domain_terminal_digest,
    );
    expect(fx.domain.store.readRaw().events).toHaveLength(1);
    expect(fx.domain.store.readRaw().grants).toHaveLength(1);
  });

  test("turns a concurrently superseded proposal stale before any second domain frame", () => {
    const fx = fixture("project");
    const superseded = fx.domain.prepareProposal({
      request_action: { type: HOST_ACTION_KIND.GRANT_CREATE, grant: grant("project") },
      request_authority: fx.authority,
      idempotency_key: "superseded",
    });
    fx.domain.store.writeActionClosure(superseded.private_closure);
    fx.actionStore.createProposal({
      authority: fx.authority,
      canonical_request: superseded.canonical_request,
      proposal: superseded.proposal,
    });
    fx.run({ type: HOST_ACTION_KIND.GRANT_CREATE, grant: grant("project") }, "winning-change");
    expect(() =>
      fx.actionStore.decide({
        proposal_id: superseded.proposal.proposal_id,
        proposal_digest: superseded.proposal.proposal_digest,
        authority: fx.authority,
        decision: "approved",
        challenge_id: null,
        challenge_response: null,
      }),
    ).toThrow();
    expect(fx.actionStore.getRecorded(superseded.proposal.proposal_id)?.state).toBe("stale");
    expect(fx.domain.store.readRaw().grants).toHaveLength(1);
  });

  test("resumes the policy three-frame state machine after the exact settings CAS", () => {
    const fx = fixture("project");
    const prepared = fx.domain.prepareProposal({
      request_action: {
        type: HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY,
        scope: "project",
        replacement_authority_subtree: { mode: "strict", quorum: 2 },
      },
      request_authority: fx.authority,
      idempotency_key: "policy-cas-crash",
    });
    fx.domain.store.writeActionClosure(prepared.private_closure);
    fx.actionStore.createProposal({
      authority: fx.authority,
      canonical_request: prepared.canonical_request,
      proposal: prepared.proposal,
    });
    const approval = fx.actionStore.decide({
      proposal_id: prepared.proposal.proposal_id,
      proposal_digest: prepared.proposal.proposal_digest,
      authority: fx.authority,
      decision: "approved",
      challenge_id: null,
      challenge_response: null,
    });
    fx.domain.prepareApproved(prepared.proposal, approval);
    fx.actionStore.prepareDispatch(prepared.proposal.proposal_id, approval.approval_id);
    const committing = fx.actionStore.beginDispatch(
      prepared.proposal.proposal_id,
      approval.approval_id,
    );
    fx.setFault("after-policy-settings-cas");
    expect(() => fx.domain.execute(committing.operation_id ?? "missing")).toThrow(
      /fault:after-policy-settings-cas/,
    );
    expect(fx.domain.store.readRaw().policies).toHaveLength(2);
    expect(fx.domain.store.readRaw().settings.toString("utf8")).toContain('"theme": "warm"');
    fx.setFault(null);
    fx.domain.execute(committing.operation_id ?? "missing");
    fx.actionStore.recordTerminal(prepared.proposal.proposal_id);
    expect(fx.domain.store.readRaw().policies.map((row) => row.state)).toEqual([
      "prepared",
      "effect_in_progress",
      "observed",
    ]);
    expect(fx.domain.store.readCommitted().current.authority_epoch).toBe(1);
  });

  test("supports the fixed user authority root and fails closed on a corrupted plan", () => {
    const fx = fixture("user");
    const issued = fx.run(
      { type: HOST_ACTION_KIND.GRANT_CREATE, grant: grant("user") },
      "user-issue",
    );
    expect(fx.domain.store.readCommitted().current.authority_epoch).toBe(1);

    const pending = fx.domain.prepareProposal({
      request_action: {
        type: HOST_ACTION_KIND.GRANT_RENEW,
        grant_id: issued.prepared.authority_plan.authority_subject_id,
        grant: grant("user"),
      },
      request_authority: fx.authority,
      idempotency_key: "corrupt-plan",
    });
    fx.domain.store.writeActionClosure(pending.private_closure);
    fx.actionStore.createProposal({
      authority: fx.authority,
      canonical_request: pending.canonical_request,
      proposal: pending.proposal,
    });
    writeFileSync(
      join(
        fx.paths.privateRoot,
        "actions",
        "v1",
        "objects",
        `${pending.authority_plan.plan_digest.slice(7)}.json`,
      ),
      "{}",
    );
    expect(() =>
      fx.actionStore.issueChallenge({
        proposal_id: pending.proposal.proposal_id,
        proposal_digest: pending.proposal.proposal_digest,
        challenge_class: "fresh-user-scope",
        authority: fx.authority,
      }),
    ).toThrow();
  });

  test("rejects terminal grant and trust state transitions before review or COMMITTING", () => {
    const grantFx = fixture("project");
    const issued = grantFx.run(
      { type: HOST_ACTION_KIND.GRANT_CREATE, grant: grant("project") },
      "terminal-grant-issue",
    );
    const grantId = issued.prepared.authority_plan.authority_subject_id;
    grantFx.run(
      { type: HOST_ACTION_KIND.GRANT_REVOKE, scope: "project", grant_id: grantId },
      "terminal-grant-revoke",
    );
    for (const action of [
      { type: HOST_ACTION_KIND.GRANT_RENEW, grant_id: grantId, grant: grant("project") },
      { type: HOST_ACTION_KIND.GRANT_REVOKE, scope: "project", grant_id: grantId },
    ] as const)
      expect(() =>
        grantFx.domain.prepareProposal({
          request_action: action,
          request_authority: grantFx.authority,
          idempotency_key: `invalid-${action.type}`,
        }),
      ).toThrow(/revoked grant authority is terminal/);
    expect(grantFx.actionStore.listRecorded()).toHaveLength(2);

    const trustFx = fixture("project");
    const { publicKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ format: "der", type: "spki" });
    const trustBase = {
      key_id: `sha256:${Bun.CryptoHasher.hash("sha256", spki, "hex")}`,
      algorithm: "Ed25519" as const,
      public_key_spki_base64: spki.toString("base64"),
      registry_origin: "https://registry.example",
      publisher_id: "acme",
      valid_from: "2029-01-01T00:00:00.000Z",
      valid_until: "2032-01-01T00:00:00.000Z",
      reason: null,
    };
    const trustAction = (
      transition: (typeof CAPABILITY_TRUST_TRANSITION)[keyof typeof CAPABILITY_TRUST_TRANSITION],
      registryOrigin = trustBase.registry_origin,
    ) =>
      ({
        type: HOST_ACTION_KIND.REGISTRY_TRUST_KEY,
        scope: "project" as const,
        change: { ...trustBase, registry_origin: registryOrigin, transition },
      }) as const;
    expect(() =>
      trustFx.domain.prepareProposal({
        request_action: trustAction(CAPABILITY_TRUST_TRANSITION.RESCOPED, "https://other.example"),
        request_authority: trustFx.authority,
        idempotency_key: "missing-trust-predecessor",
      }),
    ).toThrow(/no current predecessor/);
    trustFx.run(trustAction(CAPABILITY_TRUST_TRANSITION.ADDED), "trust-added");
    expect(() =>
      trustFx.domain.prepareProposal({
        request_action: trustAction(CAPABILITY_TRUST_TRANSITION.ADDED),
        request_authority: trustFx.authority,
        idempotency_key: "duplicate-trust-add",
      }),
    ).toThrow(/duplicates an existing key/);
    trustFx.run(trustAction(CAPABILITY_TRUST_TRANSITION.DEPRECATED), "trust-deprecated");
    expect(() =>
      trustFx.domain.prepareProposal({
        request_action: trustAction(CAPABILITY_TRUST_TRANSITION.RESCOPED, "https://other.example"),
        request_authority: trustFx.authority,
        idempotency_key: "deprecated-trust-rescope",
      }),
    ).toThrow(/deprecated trust may only narrow to revoked/);
    trustFx.run(trustAction(CAPABILITY_TRUST_TRANSITION.REVOKED), "trust-revoked");
    for (const transition of Object.values(CAPABILITY_TRUST_TRANSITION))
      expect(() =>
        trustFx.domain.prepareProposal({
          request_action: trustAction(
            transition,
            transition === CAPABILITY_TRUST_TRANSITION.RESCOPED
              ? "https://other.example"
              : trustBase.registry_origin,
          ),
          request_authority: trustFx.authority,
          idempotency_key: `after-revoked-${transition}`,
        }),
      ).toThrow();
    expect(trustFx.actionStore.listRecorded()).toHaveLength(3);
  });

  test("terminalizes a no-effect execution validation failure and cold-start replay", () => {
    const fx = fixture("project");
    const { prepared, operationId } = prepareCommittingGrant(fx, "pre-effect-terminal");
    writeFileSync(
      join(fx.root, "project", ".vibeflow", "SETTINGS.json"),
      canonicalJsonBytes({ schema_version: "1.0", authority: { changed: true } }),
    );
    const failed = fx.domain.execute(operationId);
    expect(failed.outcome).toBe("failed");
    expect(failed.receipt?.reason_code).toBe("pre-effect-revalidation-failed");
    expect(fx.actionStore.getRecorded(prepared.proposal.proposal_id)?.state).toBe("committing");

    const reopened = reopenAuthority(fx);
    expect(reopened.domain.execute(operationId)).toEqual(failed);
    expect(reopened.store.recordTerminal(prepared.proposal.proposal_id).state).toBe("failed");
    expect(reopened.domain.store.readRaw().current.authority_epoch).toBe(0);
  });

  test("terminalizes every injected no-effect execution boundary for cold replay", () => {
    for (const fault of [
      ORDINARY_AUTHORITY_MUTATION_FAULT_POINT.BEFORE_RECOVERY_PREFIX_READ,
      ORDINARY_AUTHORITY_MUTATION_FAULT_POINT.BEFORE_ACTION_CLOSURE_READ,
      ORDINARY_AUTHORITY_MUTATION_FAULT_POINT.BEFORE_PRE_EFFECT_REVALIDATION,
    ]) {
      const fx = fixture("project");
      const { prepared, operationId } = prepareCommittingGrant(fx, `no-effect-${fault}`);
      fx.setFault(fault);
      const terminal = fx.domain.execute(operationId);
      fx.setFault(null);
      const expectedOutcome =
        fault === ORDINARY_AUTHORITY_MUTATION_FAULT_POINT.BEFORE_RECOVERY_PREFIX_READ
          ? "needs_recovery"
          : "failed";
      expect(terminal.outcome).toBe(expectedOutcome);
      expect(fx.actionStore.recordTerminal(prepared.proposal.proposal_id).state).toBe(
        expectedOutcome,
      );
      const reopened = reopenAuthority(fx);
      expect(reopened.domain.execute(operationId)).toEqual(terminal);
      expect(reopened.store.getRecorded(prepared.proposal.proposal_id)?.state).toBe(
        expectedOutcome,
      );
      expect(reopened.domain.store.readRaw().current.authority_epoch).toBe(0);
    }
  });

  test("terminalizes corrupt immutable execution closure without bricking Action replay", () => {
    const fx = fixture("project");
    const { prepared, operationId } = prepareCommittingGrant(fx, "corrupt-closure-terminal");
    writeFileSync(
      join(
        fx.paths.privateRoot,
        "actions",
        "v1",
        "objects",
        `${prepared.authority_plan.plan_digest.slice("sha256:".length)}.json`,
      ),
      "{}",
    );
    const failed = fx.domain.execute(operationId);
    expect(failed.outcome).toBe("failed");
    expect(failed.receipt?.reason_code).toBe("pre-effect-revalidation-failed");
    expect(fx.actionStore.recordTerminal(prepared.proposal.proposal_id).state).toBe("failed");

    const reopened = reopenAuthority(fx);
    expect(reopened.domain.execute(operationId)).toEqual(failed);
    expect(reopened.store.getRecorded(prepared.proposal.proposal_id)?.state).toBe("failed");
    expect(reopened.domain.store.readRaw().current.authority_epoch).toBe(0);
  });
});
