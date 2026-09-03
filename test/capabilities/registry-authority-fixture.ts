import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionAuthorityStore,
  EMPTY_ADAPTER_SET_DIGEST,
  EMPTY_PERMISSION_DIGEST,
  EMPTY_SOURCE_AUTHORITY_SET_DIGEST,
  actionIdempotencyScopeDigest,
  canonicalActionRequestDigest,
  createDurableActionAuthorityReaderV1,
  materializeDispatchPreparationProof,
  materializeDispatchRecord,
  materializeDomainPreparedProof,
  materializeDomainTerminalProof,
  materializeProposal,
  materializeProposalPublicationProof,
  materializeReviewAuthorityProof,
} from "../../src/actions/index.js";
import type {
  ActionAuthorityResolverV1,
  ActionProposalDraftV1,
  ActionRequestAuthorityV1,
  CanonicalActionRequestV1,
} from "../../src/actions/index.js";
import {
  applyAuthorityEvent,
  authorityEpochEventDigest,
  authorityEpochHeadDigest,
  authorityScopeIdentityDigest,
  grantStateDigest,
  registryTrustFrameDigest,
  secretRevocationStateDigest,
  validateAuthorityEvent,
  validateTrustFrame,
} from "../../src/capabilities/authority/index.js";
import type {
  AuthorityEpochEventV1,
  AuthorityEpochHeadV1,
  RegistryTrustKeyFrameV1,
} from "../../src/capabilities/authority/index.js";
import { createDurableAuthorityTransitionResolver } from "../../src/capabilities/source/durable-authority-transition-resolver.js";
import {
  type RegistryTrustSnapshotV1,
  readDurableRegistryTrustSnapshot,
} from "../../src/capabilities/source/index.js";
import { projectCapabilityPaths } from "../../src/capabilities/storage/index.js";
import {
  acquireProcessLock,
  canonicalJson,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestV1,
  encodeVffrFrame,
} from "../../src/durability/index.js";

function logicalState(head: AuthorityEpochHeadV1) {
  return {
    grant_head_digest: head.grant_head_digest,
    grant_digest: head.grant_digest,
    policy_head_digest: head.policy_head_digest,
    policy_digest: head.policy_digest,
    secret_revocation_digest: head.secret_revocation_digest,
    trust_head_digest: head.trust_head_digest,
    trust_epoch: head.trust_epoch,
  };
}

function encodeJournal<T extends AuthorityEpochEventV1 | RegistryTrustKeyFrameV1>(
  domain: "authority-epoch" | "registry-trust",
  rows: readonly T[],
): Buffer {
  return Buffer.concat(
    rows.map((row, index) =>
      encodeVffrFrame(domain, row as never, {
        domain,
        maxFrames: 10,
        maxPayloadBytes: 256 * 1024,
        maxAggregateBytes: 1024 * 1024,
        sequenceStart: index + 1,
        initialPreviousDigest:
          index === 0
            ? null
            : domain === "authority-epoch"
              ? (rows[index - 1] as AuthorityEpochEventV1).event_digest
              : (rows[index - 1] as RegistryTrustKeyFrameV1).frame_digest,
        validatePayload: (payload) =>
          domain === "authority-epoch"
            ? validateAuthorityEvent(payload as never)
            : validateTrustFrame(payload as never),
        computePayloadDigest: (payload) =>
          domain === "authority-epoch"
            ? authorityEpochEventDigest(payload as never)
            : registryTrustFrameDigest(payload as never),
        validateJournalIdentity: (payload) =>
          payload.scope === "project" && typeof payload.scope_identity_digest === "string",
      }),
    ),
  );
}

export function durableRegistryTrustFixture(input: {
  public_key_spki: Buffer;
  state?: "active" | "deprecated" | "revoked";
  action_origin?: "standalone" | "conversation";
  resolver_root?: "selected" | "authority";
}): RegistryTrustSnapshotV1 {
  const root = mkdtempSync(join(tmpdir(), "vf-registry-authority-fixture-"));
  const paths = projectCapabilityPaths(root);
  mkdirSync(join(root, ".vibeflow"));
  const settings = { schema_version: "1.0", authority: { registry: "test-fixture" } };
  writeFileSync(join(root, ".vibeflow", "SETTINGS.json"), canonicalJsonBytes(settings));
  const identityDraft = {
    schema_version: "1.0" as const,
    scope: "project" as const,
    identity_id: `vf-project-${"7".repeat(64)}`,
    created_at: "2026-01-01T00:00:00.000Z",
    content_digest: "",
  };
  const identity = {
    ...identityDraft,
    content_digest: authorityScopeIdentityDigest(identityDraft),
  };
  writeFileSync(paths.identity, canonicalJsonBytes(identity));
  const conversation = {
    root_session_id: "registry-conversation-root",
    conversation_id: "registry-conversation",
    revision_id: "registry-revision",
    last_seq: 1,
    conversation_lock_digest: digestV1("VF-TEST-REGISTRY-CONVERSATION-LOCK\0v1\0", 1),
    lineage_head_digest: digestV1("VF-TEST-REGISTRY-LINEAGE-HEAD\0v1\0", 1),
    lineage_head_epoch: 1,
  };
  const actionOrigin = input.action_origin ?? "standalone";
  const locator =
    actionOrigin === "conversation"
      ? { kind: "conversation" as const, root_session_id: conversation.root_session_id }
      : {
          kind: "capability" as const,
          scope: "project" as const,
          scope_identity_digest: identity.content_digest,
        };
  const actionRoot =
    actionOrigin === "conversation" ? join(root, "conversation-action-root") : paths.privateRoot;
  if (actionOrigin === "conversation") mkdirSync(actionRoot, { recursive: true, mode: 0o700 });
  const policyDigest = digestV1("VF-POLICY-STATE\0v1\0", {
    schema_version: "1.0",
    scope: "project",
    scope_identity_digest: identity.content_digest,
    settings_schema_version: settings.schema_version,
    authority_subtree: settings.authority,
  });
  const initialDraft = {
    schema_version: "1.0" as const,
    scope: "project" as const,
    scope_identity_digest: identity.content_digest,
    authority_epoch: 0,
    event_head_digest: null,
    grant_head_digest: null,
    grant_digest: grantStateDigest("project", identity.content_digest, null, new Map()),
    policy_head_digest: null,
    policy_digest: policyDigest,
    secret_revocation_digest: secretRevocationStateDigest("project", identity.content_digest, null),
    trust_head_digest: null,
    trust_epoch: 0,
    updated_by_operation_id: null,
    updated_at: identity.created_at,
    content_digest: "",
  };
  const initial: AuthorityEpochHeadV1 = {
    ...initialDraft,
    content_digest: authorityEpochHeadDigest(initialDraft),
  };
  const keyId = `sha256:${createHash("sha256").update(input.public_key_spki).digest("hex")}`;
  const transitions: RegistryTrustKeyFrameV1["transition"][] =
    input.state && input.state !== "active" ? ["added", input.state] : ["added"];
  const frames: RegistryTrustKeyFrameV1[] = [];
  const events: AuthorityEpochEventV1[] = [];
  const heads: AuthorityEpochHeadV1[] = [initial];
  const actionObjects = new Map<string, unknown>();
  const operationHeaders = new Map<string, unknown>();
  const headerByProposal = new Map<string, string>();
  const terminalByOperation = new Map<string, { digest: string; at: string }>();
  let actionNow = Date.parse("2026-01-01T00:00:00.000Z");
  const actionResolver: ActionAuthorityResolverV1 = {
    validateProposalPublication: ({ proposal, canonical_request_digest, now }) =>
      materializeProposalPublicationProof(
        proposal,
        canonical_request_digest,
        digestV1("VF-TEST-REGISTRY-PUBLICATION\0v1\0", proposal.proposal_id),
        now,
      ),
    review: ({ proposal, authority, now }) =>
      materializeReviewAuthorityProof(proposal, authority, now, "2026-01-01T00:30:00.000Z"),
    prepareDispatch: ({ proposal, approval, now }) =>
      materializeDispatchPreparationProof(
        proposal,
        approval,
        headerByProposal.get(proposal.proposal_id) ?? null,
        now,
      ),
    proveDomainPrepared: ({ dispatch }) =>
      materializeDomainPreparedProof(
        dispatch,
        dispatch.domain_header_digest as string,
        dispatch.created_at,
      ),
    resolveTerminal: ({ dispatch }) => {
      const terminal = terminalByOperation.get(dispatch.operation_id);
      if (!terminal) throw new Error("test authority terminal is absent");
      return materializeDomainTerminalProof(dispatch, "succeeded", terminal.digest, terminal.at);
    },
    validateRecordedTerminal: ({ dispatch, outcome, domain_terminal_digest, recorded_at }) =>
      materializeDomainTerminalProof(dispatch, outcome, domain_terminal_digest, recorded_at),
  };
  const actionStore = new ActionAuthorityStore(actionRoot, {
    now: () => actionNow,
    authority_resolver: actionResolver,
  });
  let prior = initial;
  for (const [index, transition] of transitions.entries()) {
    const ordinal = index + 1;
    const recordedAt = `2026-01-01T00:00:0${ordinal}.000Z`;
    const action = {
      type: "registry.trust_key" as const,
      scope: "project" as const,
      change: {
        transition,
        key_id: keyId,
        algorithm: "Ed25519" as const,
        public_key_spki_base64: input.public_key_spki.toString("base64"),
        registry_origin: "https://registry.example",
        publisher_id: "acme",
        valid_from: "2025-01-01T00:00:00.000Z",
        valid_until: "2028-01-01T00:00:00.000Z",
        reason: transition === "added" ? null : transition,
      },
    };
    const effectDigest = digestV1("VF-AUTHORITY-DOMAIN-EFFECT\0v1\0", {
      schema_version: "1.0",
      scope: "project",
      scope_identity_digest: identity.content_digest,
      change: "registry-trust-changed",
      authority_subject_id: keyId,
      authority_action: action,
      expected_authority_epoch: prior.authority_epoch,
      expected_authority_head_digest: prior.content_digest,
      expected_domain_head_digest: prior.trust_head_digest,
    });
    const nativePlanDraft = {
      schema_version: "1.0" as const,
      scope: "project" as const,
      scope_identity_digest: identity.content_digest,
      change: "registry-trust-changed" as const,
      authority_subject_id: keyId,
      authority_action: action,
      expected_authority_epoch: prior.authority_epoch,
      expected_authority_head_digest: prior.content_digest,
      expected_domain_head_digest: prior.trust_head_digest,
      permission_digest: EMPTY_PERMISSION_DIGEST,
      proposed_effect_digest: effectDigest,
      recovery_plan_digest: digestV1("VF-TEST-REGISTRY-RECOVERY\0v1\0", ordinal),
      created_at: `2026-01-01T00:00:0${ordinal - 1}.000Z`,
      expires_at: "2026-01-01T01:00:00.000Z",
    };
    const nativePlan = {
      ...nativePlanDraft,
      plan_digest: digestV1("VF-AUTHORITY-CHANGE-PLAN\0v1\0", nativePlanDraft),
    };
    const outerPlan = {
      schema_version: "1.0" as const,
      domain: "capability" as const,
      action_root_locator: locator,
      planning_options: { mode: "durable" as const, network_read: "ordinary-host-policy" as const },
      execution_object_closure_digest: null,
      permission_digest: EMPTY_PERMISSION_DIGEST,
      steps: [
        {
          order: 0,
          step_id: `authority-${ordinal}`,
          plan_kind: "authority-change" as const,
          plan_digest: nativePlan.plan_digest,
          target_ids: [],
          effect_classes: ["project-write" as const],
          reversibility: "reversible" as const,
        },
      ],
    };
    const outerPlanDigest = digestV1("VF-ACTION-PLAN\0v1\0", outerPlan);
    const principalDigest = digestV1("VF-TEST-REGISTRY-PRINCIPAL\0v1\0", 1);
    const authorityScopeDigest = actionIdempotencyScopeDigest(locator);
    const canonicalRequest: CanonicalActionRequestV1 =
      actionOrigin === "conversation"
        ? {
            schema_version: "1.0",
            origin: "conversation",
            principal_digest: principalDigest,
            authority_scope_digest: authorityScopeDigest,
            planning_options: outerPlan.planning_options,
            request: {
              schema_version: "1.0",
              anchor_event_id: `registry-event-${ordinal}`,
              expected: {
                mode: "writable-revision",
                conversation_id: conversation.conversation_id,
                revision_id: conversation.revision_id,
                last_seq: conversation.last_seq,
                conversation_lock_digest: conversation.conversation_lock_digest,
              },
              candidate: action,
            },
          }
        : {
            schema_version: "1.0",
            origin: "standalone",
            principal_digest: principalDigest,
            authority_scope_digest: authorityScopeDigest,
            scope: "project",
            planning_options: outerPlan.planning_options,
            action,
          };
    const actionAuthority: ActionRequestAuthorityV1 = {
      schema_version: "1.0",
      principal_digest: principalDigest,
      authority_scope_digest: authorityScopeDigest,
      control_session_digest: digestV1("VF-TEST-REGISTRY-SESSION\0v1\0", 1),
      csrf_epoch_digest: digestV1("VF-TEST-REGISTRY-CSRF\0v1\0", 1),
      actor: {
        kind: actionOrigin === "conversation" ? "human-browser" : "human-cli",
        public_actor_id: "registry-fixture",
        credential_class: actionOrigin === "conversation" ? "loopback-session" : "interactive-tty",
      },
    };
    const draft: ActionProposalDraftV1 = {
      schema_version: "1.0",
      idempotency_key: `registry-${ordinal}`,
      origin_event_id: actionOrigin === "conversation" ? `registry-event-${ordinal}` : null,
      domain: "capability",
      action_root_locator: locator,
      producer_request_binding: {
        kind: "canonical-action-request",
        digest: canonicalActionRequestDigest(canonicalRequest),
      },
      planning_options: outerPlan.planning_options,
      execution_object_closure_digest: null,
      base: {
        root_session_id: actionOrigin === "conversation" ? conversation.root_session_id : null,
        conversation_id: actionOrigin === "conversation" ? conversation.conversation_id : null,
        revision_id: actionOrigin === "conversation" ? conversation.revision_id : null,
        last_seq: actionOrigin === "conversation" ? conversation.last_seq : null,
        conversation_lock_digest:
          actionOrigin === "conversation" ? conversation.conversation_lock_digest : null,
        lineage_head_digest:
          actionOrigin === "conversation" ? conversation.lineage_head_digest : null,
        lineage_head_epoch:
          actionOrigin === "conversation" ? conversation.lineage_head_epoch : null,
        capability_scope: "project",
        capability_generation_ordinal: null,
        capability_generation_id: null,
        capability_lock_digest: null,
        capability_parent_generation_digests: [],
        user_prerequisites: [],
        authority_binding_mode: "current",
        authority_epoch: prior.authority_epoch,
        authority_head_digest: prior.content_digest,
        repair_authorization_binding_digest: null,
      },
      action,
      requested_by: actionAuthority.actor,
      risk: "high",
      effect_classes: ["project-write"],
      target_set: [],
      package_pins: [],
      source_authority_set_digest: EMPTY_SOURCE_AUTHORITY_SET_DIGEST,
      adapter_set_digest: EMPTY_ADAPTER_SET_DIGEST,
      plan_digest: outerPlanDigest,
      handoff_selection_digest: null,
      policy_digest: prior.policy_digest,
      grant_digest: prior.grant_digest,
      permission_digest: EMPTY_PERMISSION_DIGEST,
      reversibility: "reversible",
      preview: {
        title: "Registry trust change",
        summary: "Apply an exact registry trust transition.",
        action_type: "registry.trust_key",
        planning_options: outerPlan.planning_options,
        review_fields: [],
        targets: [],
        target_dispositions: [],
        package_pins: [],
        permission_delta: [],
        dependency_delta: [],
        config_diffs: [],
        effect_classes: ["project-write"],
        enforcement: [],
        reversibility: "reversible",
        health_plan: [],
        recovery_actions: ["repair-authority"],
        projector_version: "vf-public-projector/1",
        rules_digest: digestV1("VF-TEST-REGISTRY-RULES\0v1\0", 1),
        redaction_manifest_digest: digestV1("VF-TEST-REGISTRY-REDACTION\0v1\0", 1),
      },
      created_at: nativePlan.created_at,
      expires_at: nativePlan.expires_at,
    };
    const proposal = materializeProposal(draft);
    actionNow = Date.parse(proposal.created_at);
    actionStore.createProposal({
      authority: actionAuthority,
      canonical_request: canonicalRequest,
      proposal,
    });
    actionNow = Date.parse(recordedAt);
    const approval = actionStore.decide({
      proposal_id: proposal.proposal_id,
      proposal_digest: proposal.proposal_digest,
      authority: actionAuthority,
      decision: "approved",
      challenge_id: null,
      challenge_response: null,
    });
    const operationId = materializeDispatchRecord(proposal, approval, null).operation_id;
    const headerDraft = {
      schema_version: "1.0" as const,
      operation_id: operationId,
      proposal_id: proposal.proposal_id,
      proposal_digest: proposal.proposal_digest,
      approval_id: approval.approval_id,
      approval_digest: approval.approval_digest,
      action_type: action.type,
      action_root_locator: locator,
      action_plan_binding_digest: outerPlanDigest,
      authority_change_plan_digest: nativePlan.plan_digest,
      scope: "project" as const,
      scope_identity_digest: identity.content_digest,
      change: "registry-trust-changed" as const,
      authority_subject_id: keyId,
      expected_authority_epoch: prior.authority_epoch,
      expected_authority_head_digest: prior.content_digest,
      expected_domain_head_digest: prior.trust_head_digest,
      proposed_effect_digest: effectDigest,
      recovery_plan_digest: nativePlan.recovery_plan_digest,
      permission_digest: EMPTY_PERMISSION_DIGEST,
      created_at: approval.decided_at,
    };
    const header = {
      ...headerDraft,
      header_digest: digestV1("VF-AUTHORITY-CHANGE-OPERATION\0v1\0", headerDraft),
    };
    const headerDigest = header.header_digest;
    headerByProposal.set(proposal.proposal_id, headerDigest);
    const dispatch = actionStore.prepareDispatch(proposal.proposal_id, approval.approval_id);
    actionStore.beginDispatch(proposal.proposal_id, approval.approval_id);
    const proposalId = proposal.proposal_id;
    const approvalId = approval.approval_id;
    const planDigest = nativePlan.plan_digest;
    const frameDraft = {
      schema_version: "1.0" as const,
      scope: "project" as const,
      scope_identity_digest: identity.content_digest,
      previous_frame_digest: frames.at(-1)?.frame_digest ?? null,
      trust_epoch: ordinal,
      authority_epoch: ordinal,
      operation_id: operationId,
      proposal_id: proposalId,
      approval_id: approvalId,
      plan_digest: planDigest,
      action_root_locator: locator,
      operation_header_digest: headerDigest,
      transition,
      key_id: keyId,
      algorithm: "Ed25519" as const,
      public_key_spki_base64: input.public_key_spki.toString("base64"),
      registry_origin: "https://registry.example",
      publisher_id: "acme",
      valid_from: "2025-01-01T00:00:00.000Z",
      valid_until: "2028-01-01T00:00:00.000Z",
      reason_digest:
        transition === "added" ? null : digestV1("VF-TEST-REGISTRY-REASON\0v1\0", transition),
      recorded_at: recordedAt,
      frame_digest: "",
    };
    const frame = {
      ...frameDraft,
      frame_digest: registryTrustFrameDigest(frameDraft),
    };
    frames.push(frame);
    const priorState = logicalState(prior);
    const eventDraft: AuthorityEpochEventV1 = {
      schema_version: "1.0",
      scope: "project",
      scope_identity_digest: identity.content_digest,
      authority_epoch: ordinal,
      previous_event_digest: prior.event_head_digest,
      previous_head_digest: prior.content_digest,
      previous_head_checkpoint_digest: prior.content_digest,
      change: "registry-trust-changed",
      prior_state: priorState,
      next_state: {
        ...priorState,
        trust_head_digest: frame.frame_digest,
        trust_epoch: frame.trust_epoch,
      },
      proposal_id: proposalId,
      approval_id: approvalId,
      operation_id: operationId,
      plan_digest: planDigest,
      action_root_locator: frame.action_root_locator,
      operation_header_digest: headerDigest,
      recorded_at: recordedAt,
      event_digest: "",
    };
    eventDraft.event_digest = authorityEpochEventDigest(eventDraft);
    events.push(eventDraft);
    prior = applyAuthorityEvent(prior, eventDraft, {
      change: "registry-trust-changed",
      trust_frames: frames,
    });
    heads.push(prior);
    terminalByOperation.set(operationId, { digest: eventDraft.event_digest, at: recordedAt });
    actionStore.recordTerminal(proposalId);
    actionObjects.set(nativePlan.plan_digest, nativePlan);
    actionObjects.set(outerPlanDigest, outerPlan);
    operationHeaders.set(operationId, header);
  }
  const receiptDraft = {
    schema_version: "1.0" as const,
    identity_kind: "project-authority" as const,
    scope: "project" as const,
    scope_identity_digest: identity.content_digest,
    bootstrap_identity_digest: null,
    initial_authority_head_digest: initial.content_digest,
    identity_created_at: identity.created_at,
  };
  const receipt = {
    ...receiptDraft,
    receipt_digest: digestV1("VF-FABRIC-ACTIVATION-RECEIPT\0v1\0", receiptDraft),
  };
  const actionObjectLock = acquireProcessLock(join(actionRoot, "actions", "v1", "writer.lock"), {
    operation: "registry-authority-action-object-fixture",
  });
  try {
    for (const [objectDigest, value] of actionObjects)
      createOrVerifyPrivateFile(
        join(actionRoot, "actions", "v1", "objects", `${objectDigest.slice(7)}.json`),
        canonicalJsonBytes(value),
        { lock: actionObjectLock },
      );
  } finally {
    actionObjectLock.release();
  }
  const lock = acquireProcessLock(paths.writerLock, { operation: "registry-authority-fixture" });
  try {
    for (const head of heads.slice(0, -1))
      createOrVerifyPrivateFile(
        join(
          paths.privateRoot,
          "recovery",
          "v1",
          "checkpoints",
          `${head.content_digest.slice(7)}.json`,
        ),
        canonicalJsonBytes(head),
        { lock },
      );
    createOrVerifyPrivateFile(
      join(paths.privateRoot, "activation", "v1", "project-authority.json"),
      canonicalJsonBytes(receipt),
      { lock },
    );
    for (const [operationId, value] of operationHeaders)
      createOrVerifyPrivateFile(
        join(paths.privateRoot, "authority", "v1", "operations", operationId, "header.json"),
        canonicalJsonBytes(value),
        { lock },
      );
    createOrVerifyPrivateFile(
      join(paths.privateRoot, "authority", "v1", "epoch-head.json"),
      canonicalJsonBytes(prior),
      { lock },
    );
    createOrVerifyPrivateFile(
      join(paths.privateRoot, "authority", "v1", "registry-trust.frames"),
      encodeJournal("registry-trust", frames),
      { lock },
    );
    createOrVerifyPrivateFile(
      join(paths.privateRoot, "authority", "v1", "epoch-events.frames"),
      encodeJournal("authority-epoch", events),
      { lock },
    );
  } finally {
    lock.release();
  }
  try {
    const selectedReader = createDurableActionAuthorityReaderV1(actionStore);
    const authorityReader =
      actionRoot === paths.privateRoot
        ? selectedReader
        : createDurableActionAuthorityReaderV1(new ActionAuthorityStore(paths.privateRoot));
    const reader = input.resolver_root === "authority" ? authorityReader : selectedReader;
    const transitionResolver = createDurableAuthorityTransitionResolver({
      resolve: (requestedLocator) => {
        if (canonicalJson(requestedLocator) !== canonicalJson(locator))
          throw new Error("test fixture action locator mismatch");
        return reader;
      },
    });
    return readDurableRegistryTrustSnapshot({
      private_root: paths.privateRoot,
      identity_path: paths.identity,
      scope: "project",
      scope_identity_digest: identity.content_digest,
      authority_transition_resolver: transitionResolver,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
