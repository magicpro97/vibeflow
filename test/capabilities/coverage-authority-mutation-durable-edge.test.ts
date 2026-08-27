import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_ACTION_KIND } from "../../src/actions/host-action-contract.js";
import {
  ACTION_OPERATION_STATE,
  ActionAuthorityStore,
  actionIdempotencyScopeDigest,
  createDurableActionAuthorityReaderV1,
  deriveOperationId,
} from "../../src/actions/index.js";
import type { ActionRequestAuthorityV1 } from "../../src/actions/index.js";
import {
  AUTHORITY_CHANGE_DIGEST_DOMAIN,
  AUTHORITY_CHANGE_TERMINAL_OUTCOME,
  AUTHORITY_CHANGE_TERMINAL_REASON,
  OrdinaryAuthorityActionResolverV1,
  OrdinaryAuthorityMutationServiceV1,
  OrdinaryAuthorityProposalPlannerV1,
  assertCurrentOrdinaryAuthorityProposal,
  materializeTerminalReceipt,
  validateOperationHeader,
} from "../../src/capabilities/authority-mutation/index.js";
import type {
  OrdinaryAuthorityMutationOptionsV1,
  OrdinaryAuthorityRequestActionV1,
  SecretRevocationCandidateV1,
} from "../../src/capabilities/authority-mutation/index.js";
import { grantFrameDigest } from "../../src/capabilities/authority/index.js";
import { resumeCapabilityOrdinaryAuthorityCoreV1 } from "../../src/capabilities/ordinary-authority-runtime.js";
import { createDurableAuthorityTransitionResolver } from "../../src/capabilities/source/durable-authority-transition-resolver.js";
import { activateProjectCapabilityAuthorityForVfInit } from "../../src/capabilities/source/index.js";
import { projectCapabilityPaths } from "../../src/capabilities/storage/index.js";
import {
  acquireProcessLock,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestV1,
} from "../../src/durability/index.js";

const roots: string[] = [];
const digest = (label: string) => digestV1("VF-TEST-DURABLE-AUTHORITY-EDGE\0v1\0", label);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function grant() {
  return {
    scope: "project" as const,
    principal_id: "project-agent",
    action_types: [HOST_ACTION_KIND.CAPABILITY_INSTALL],
    permissions: [],
    target_engines: [],
    expires_at: "2031-01-01T00:00:00.000Z",
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vf-durable-authority-edge-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  mkdirSync(join(projectRoot, ".vibeflow"), { recursive: true });
  writeFileSync(
    join(projectRoot, ".vibeflow", "SETTINGS.json"),
    '{\n  "schema_version": "1.0",\n  "authority": {"mode":"strict"}\n}\n',
  );
  const paths = projectCapabilityPaths(projectRoot);
  const activation = activateProjectCapabilityAuthorityForVfInit(projectRoot, {
    now: () => "2030-01-01T00:00:00.000Z",
    random_bytes: (size) => Buffer.alloc(size, 1),
  });
  let clock = Date.parse("2030-01-01T00:00:01.000Z");
  const reader: { value: ReturnType<typeof createDurableActionAuthorityReaderV1> | null } = {
    value: null,
  };
  const transitionResolver = createDurableAuthorityTransitionResolver({
    resolve: () => {
      if (!reader.value) throw new Error("action reader is not bound");
      return reader.value;
    },
  });
  const options: OrdinaryAuthorityMutationOptionsV1 = {
    paths,
    authority_transition_resolver: transitionResolver,
    action_authority: () => {
      if (!reader.value) throw new Error("action reader is not bound");
      return reader.value;
    },
    now: () => new Date(clock).toISOString(),
    random_bytes: (size) => Buffer.alloc(size, 9),
    secret_candidate_authority: { validateCurrent: () => undefined },
  };
  const domain = new OrdinaryAuthorityMutationServiceV1(options);
  const actionStore = new ActionAuthorityStore(paths.privateRoot, {
    now: () => clock,
    random_bytes: (size) => Buffer.alloc(size, 8),
    hmac_key: Buffer.alloc(32, 7),
    authority_resolver: domain.resolver,
  });
  reader.value = createDurableActionAuthorityReaderV1(actionStore);
  const locator = {
    kind: "capability" as const,
    scope: "project" as const,
    scope_identity_digest: activation.identity.content_digest,
  };
  const authority: ActionRequestAuthorityV1 = {
    schema_version: "1.0",
    principal_digest: digest("principal"),
    authority_scope_digest: actionIdempotencyScopeDigest(locator),
    control_session_digest: digest("session"),
    csrf_epoch_digest: digest("csrf"),
    actor: {
      kind: "human-cli",
      public_actor_id: "project-operator",
      credential_class: "interactive-tty",
    },
  };

  function prepare(action: OrdinaryAuthorityRequestActionV1, key: string) {
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
    return prepared;
  }

  function approve(prepared: ReturnType<typeof prepare>) {
    clock += 1_000;
    return actionStore.decide({
      proposal_id: prepared.proposal.proposal_id,
      proposal_digest: prepared.proposal.proposal_digest,
      authority,
      decision: "approved",
      challenge_id: null,
      challenge_response: null,
    });
  }

  function prepareDispatch(prepared: ReturnType<typeof prepare>) {
    const approval = approve(prepared);
    domain.prepareApproved(prepared.proposal, approval);
    actionStore.prepareDispatch(prepared.proposal.proposal_id, approval.approval_id);
    const operationId = deriveOperationId(prepared.proposal, approval.approval_id);
    const dispatch = actionStore.getDispatch(operationId);
    if (!dispatch) throw new Error("dispatch is absent");
    return { approval, operationId, dispatch };
  }

  return {
    root,
    paths,
    activation,
    options,
    authority,
    domain,
    actionStore,
    prepare,
    prepareDispatch,
    now: () => new Date(clock).toISOString(),
  };
}

function persistCandidate(fx: ReturnType<typeof fixture>): SecretRevocationCandidateV1 {
  const draft = {
    schema_version: "1.0" as const,
    scope: "project" as const,
    scope_identity_digest: fx.activation.identity.content_digest,
    package_id: "acme.tool",
    input_id: "token",
    secret_handle_id_digest: digest("secret-handle"),
    broker_binding_epoch: 1,
    broker_scope_digest: digest("broker-scope"),
    source_current_head_digest: digest("source-head"),
    source_action_root_locator: {
      kind: "capability" as const,
      scope: "project" as const,
      scope_identity_digest: fx.activation.identity.content_digest,
    },
    source_private_input_binding_digest: digest("private-binding"),
    created_at: "2030-01-01T00:00:00.000Z",
  };
  const bindingDigest = digestV1(AUTHORITY_CHANGE_DIGEST_DOMAIN.SECRET_CANDIDATE, draft);
  const candidate: SecretRevocationCandidateV1 = {
    ...draft,
    private_binding_id: `vf-secret-revocation-binding-${bindingDigest.slice(7)}`,
    binding_digest: bindingDigest,
  };
  const held = acquireProcessLock(join(fx.paths.privateRoot, "actions", "v1", "writer.lock"), {
    operation: "candidate-edge",
    coverageRoot: fx.paths.privateRoot,
  });
  try {
    createOrVerifyPrivateFile(
      join(
        fx.paths.privateRoot,
        "actions",
        "v1",
        "secret-revocation-candidates",
        `${candidate.private_binding_id}.json`,
      ),
      canonicalJsonBytes(candidate),
      { lock: held },
    );
  } finally {
    held.release();
  }
  return candidate;
}

describe("ordinary authority durable coverage edges", () => {
  test("rejects an already-revoked secret against the exact proposal base", () => {
    const fx = fixture();
    const candidate = persistCandidate(fx);
    const prepared = fx.prepare(
      {
        type: HOST_ACTION_KIND.SECRET_REVOKE,
        scope: "project",
        private_binding_id: candidate.private_binding_id,
        expected_binding_digest: candidate.binding_digest,
      },
      "secret-edge",
    );
    const committed = fx.domain.store.readCommitted();
    const fakeStore = Object.create(fx.domain.store) as typeof fx.domain.store;
    Object.defineProperty(fakeStore, "readCommitted", {
      value: () => ({
        ...committed,
        secrets: [
          {
            secret_handle_id_digest: candidate.secret_handle_id_digest,
            expected_binding_digest: candidate.binding_digest,
          },
        ],
      }),
    });
    expect(() =>
      assertCurrentOrdinaryAuthorityProposal({
        store: fakeStore,
        proposal: prepared.proposal,
        options: fx.options,
        now: fx.now(),
      }),
    ).toThrow(/already revoked/);
  });

  test("rejects a non-canonical planner clock", () => {
    const fx = fixture();
    const planner = new OrdinaryAuthorityProposalPlannerV1(fx.domain.store, {
      ...fx.options,
      now: () => "not-a-canonical-time",
    });
    expect(() =>
      planner.prepare({
        request_action: { type: HOST_ACTION_KIND.GRANT_CREATE, grant: grant() },
        request_authority: fx.authority,
        idempotency_key: "bad-clock",
      }),
    ).toThrow(/non-canonical timestamp/);
  });

  test("validates dispatch and replayed terminal evidence through the public resolver", () => {
    const fx = fixture();
    const prepared = fx.prepare(
      { type: HOST_ACTION_KIND.GRANT_CREATE, grant: grant() },
      "resolver-edge",
    );
    const { approval, operationId, dispatch } = fx.prepareDispatch(prepared);
    fx.domain.resolver.prevalidateDispatch?.({
      proposal: prepared.proposal,
      approval,
      now: fx.now(),
    });
    const snapshot = fx.actionStore.beginDispatch(
      prepared.proposal.proposal_id,
      approval.approval_id,
    );
    const missingEventResolver = new OrdinaryAuthorityActionResolverV1(
      fx.domain.store,
      {
        ...fx.options,
        action_authority: () =>
          ({
            getRecorded: () => ({ ...snapshot, events: [] }),
          }) as never,
      },
      () => null,
    );
    expect(() =>
      missingEventResolver.proveDomainPrepared({ proposal: prepared.proposal, approval, dispatch }),
    ).toThrow(/committing event is absent/);

    const terminal = fx.domain.execute(operationId);
    fx.actionStore.recordTerminal(prepared.proposal.proposal_id);
    expect(
      fx.domain.resolver.validateRecordedTerminal({
        proposal: prepared.proposal,
        approval,
        dispatch,
        outcome: terminal.outcome,
        domain_terminal_digest: terminal.domain_terminal_digest,
        recorded_at: terminal.recorded_at,
      }).outcome,
    ).toBe(ACTION_OPERATION_STATE.SUCCEEDED);
    expect(() =>
      fx.domain.resolver.validateRecordedTerminal({
        proposal: prepared.proposal,
        approval,
        dispatch,
        outcome: terminal.outcome,
        domain_terminal_digest: terminal.domain_terminal_digest,
        recorded_at: "2030-01-01T00:00:59.000Z",
      }),
    ).toThrow(/terminal evidence changed/);
  });

  test("rejects changed terminal and domain-frame replays and an illegal receipt chain", () => {
    const fx = fixture();
    const prepared = fx.prepare(
      { type: HOST_ACTION_KIND.GRANT_CREATE, grant: grant() },
      "journal-edge",
    );
    const { approval, operationId } = fx.prepareDispatch(prepared);
    const header = fx.domain.store.readOperationHeader(operationId);
    if (!header) throw new Error("operation header is absent");
    expect(() => validateOperationHeader({ ...header, schema_version: "2.0" } as never)).toThrow(
      /header digest mismatch/,
    );
    const receipt0 = materializeTerminalReceipt({
      schema_version: "1.0",
      operation_id: operationId,
      sequence: 0,
      previous_receipt_digest: null,
      proposal_id: header.proposal_id,
      proposal_digest: header.proposal_digest,
      approval_id: header.approval_id,
      approval_digest: header.approval_digest,
      plan_digest: header.authority_change_plan_digest,
      action_root_locator: header.action_root_locator,
      operation_header_digest: header.header_digest,
      scope: header.scope,
      scope_identity_digest: header.scope_identity_digest,
      change: header.change,
      expected_authority_head_digest: header.expected_authority_head_digest,
      observed_authority_head_digest: header.expected_authority_head_digest,
      outcome: AUTHORITY_CHANGE_TERMINAL_OUTCOME.FAILED,
      reason_code: AUTHORITY_CHANGE_TERMINAL_REASON.AUTHORITY_STALE,
      recorded_at: approval.decided_at,
    });
    fx.domain.store.withAuthorityLock("terminal-edge", (_store, lock) => {
      fx.domain.store.appendTerminalHeld(receipt0, lock);
      fx.domain.store.appendTerminalHeld(receipt0, lock);
    });
    const { receipt_digest: _receipt0Digest, ...receipt0Draft } = receipt0;
    const changedReceipt = materializeTerminalReceipt({
      ...receipt0Draft,
      recorded_at: "2030-01-01T00:00:09.000Z",
    });
    expect(() =>
      fx.domain.store.withAuthorityLock("terminal-replay-edge", (_store, lock) => {
        fx.domain.store.appendTerminalHeld(changedReceipt, lock);
      }),
    ).toThrow(/terminal replay changed/);
    const receipt1 = materializeTerminalReceipt({
      ...receipt0Draft,
      sequence: 1,
      previous_receipt_digest: receipt0.receipt_digest,
      recorded_at: "2030-01-01T00:00:10.000Z",
    });
    fx.domain.store.withAuthorityLock("terminal-chain-edge", (_store, lock) => {
      fx.domain.store.appendTerminalHeld(receipt1, lock);
    });
    expect(() => fx.domain.store.readTerminalReceipts(operationId)).toThrow(/not dense or legal/);

    const grantFx = fixture();
    const grantPrepared = grantFx.prepare(
      { type: HOST_ACTION_KIND.GRANT_CREATE, grant: grant() },
      "grant-replay-edge",
    );
    const grantDispatch = grantFx.prepareDispatch(grantPrepared);
    grantFx.actionStore.beginDispatch(
      grantPrepared.proposal.proposal_id,
      grantDispatch.approval.approval_id,
    );
    const terminal = grantFx.domain.execute(grantDispatch.operationId);
    expect(terminal.outcome).toBe(ACTION_OPERATION_STATE.SUCCEEDED);
    const frame = grantFx.domain.store.readRaw().grants[0];
    if (!frame) throw new Error("grant frame is absent");
    grantFx.domain.store.withAuthorityLock("grant-idempotent-edge", (_store, lock) => {
      grantFx.domain.store.appendGrantHeld(frame, lock);
    });
    const changedFrame = { ...frame, reason_digest: digest("changed-reason") };
    changedFrame.frame_digest = grantFrameDigest(changedFrame);
    changedFrame.frame_id = `vf-grant-frame-${changedFrame.frame_digest.slice(7)}`;
    expect(() =>
      grantFx.domain.store.withAuthorityLock("grant-replay-edge", (_store, lock) => {
        grantFx.domain.store.appendGrantHeld(changedFrame, lock);
      }),
    ).toThrow(/replay changed immutable bytes/);
  });

  test("fails closed when a committing recovery row omits its operation identity", () => {
    expect(() =>
      resumeCapabilityOrdinaryAuthorityCoreV1({
        actionStore: {
          listRecordedForRecovery: () => [
            {
              state: ACTION_OPERATION_STATE.COMMITTING,
              operation_id: null,
              proposal: { action: { type: HOST_ACTION_KIND.GRANT_REVOKE } },
            },
          ],
        },
        domain: {},
      } as never),
    ).toThrow(/omitted its operation identity/);
  });
});
