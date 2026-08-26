import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionAuthorityStaleError,
  type BrowserHostActionRequestV1,
  type PublicCompactionInputV1,
  actionIdempotencyKeyDigest,
  actionIdempotencyScopeDigest,
  deriveOperationId,
} from "../../src/actions/index.js";
import type { AgentBinding, MaterializedAgentBinding } from "../../src/agents/binding.js";
import type { CapabilityConversationActionDomainOptionsV1 } from "../../src/capabilities/action-domain/domain-handler.js";
import {
  activateProjectCapabilityAuthorityForVfInit,
  activateUserCapabilityAuthorityForTrustedInstall,
  productionCapabilityRuntimeV1,
} from "../../src/capabilities/index.js";
import { capabilityOperationPaths } from "../../src/capabilities/storage/paths.js";
import { conversationEnvPolicy } from "../../src/dispatch/env-filter.js";
import {
  type EngineProcess,
  type EngineProcessSpawnOptions,
  createSpawnOptionsProjection,
} from "../../src/dispatch/session-types.js";
import { canonicalJsonBytes, digestHex, digestV1 } from "../../src/durability/index.js";
import {
  type ConversationBootstrap,
  type ConversationBootstrapOptions,
  createConversationBootstrap,
} from "../../src/orchestrator/conversation/bootstrap.js";
import { AGENT_ACTION_CANDIDATE_SOURCE_STALE_CODE } from "../../src/orchestrator/conversation/conversation-agent-action-candidate-contract.js";
import { ConversationAgentActionCandidateMaterializationLockV1 } from "../../src/orchestrator/conversation/conversation-agent-action-candidate-materialization-lock.js";
import {
  assertCurrentAgentActionCandidateGrant,
  assertCurrentAgentActionCandidateOrigin,
} from "../../src/orchestrator/conversation/conversation-agent-action-candidate-review.js";
import { materializeConversationHostTools } from "../../src/orchestrator/conversation/conversation-host-tool-policy.js";
import { HandoffTooLargeError } from "../../src/orchestrator/conversation/handoff-selection.js";
import { revisionReservationDigest } from "../../src/orchestrator/conversation/lineage-reservation.js";
import { applyConversationRevisionMutation } from "../../src/orchestrator/conversation/revision-action-manifest.js";
import {
  buildRevisionHandoff,
  resolveRevisionBase,
} from "../../src/orchestrator/conversation/revision-source.js";
import type { ConversationCreateParticipant } from "../../src/orchestrator/conversation/types.js";
import { VERIFY_GATE_ORDER, type VerifyGateManifest } from "../../src/verify/core.js";
import {
  resolvedRolePackage,
  retainRuntimePackageCache,
} from "../capabilities/runtime-fixtures.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const NOW = "2026-08-25T12:00:00.000Z";

const passingVerify = (): VerifyGateManifest =>
  Object.fromEntries(
    VERIFY_GATE_ORDER.map((name) => [
      name,
      { status: "pass", details: `${name} passed`, evidence_refs: [`test:${name}`] },
    ]),
  ) as VerifyGateManifest;

const libraries = {
  plan: {
    create: async () => ({ content: "unused" }),
    update: async ({ revision }: { revision: { content: string } }) => ({
      content: revision.content,
    }),
  },
  review: {
    currentHead: async () => "a".repeat(40),
    review: async () => ({
      reviewed_head: "a".repeat(40),
      reviewer: "human:test",
      outcome: "approved" as const,
      evidence_refs: ["review.json"],
    }),
  },
  verify: { run: async () => passingVerify() },
  orchestrate: {
    dryRun: async () => ({
      participants: [],
      evaluator_auto_added: false,
      engines_available: [],
      models_valid: true,
    }),
    execute: async () => ({ units: [], reviews: [] }),
  },
};

function binding(input: AgentBinding): MaterializedAgentBinding {
  const roleHash = digestHex(digestV1("VF-TEST-ROLE\0v1\0", input.roleRef));
  const provenance = { roleSource: "builtin" as const, roleHash, skillHashes: [] as string[] };
  const traceMetadata = { role_resolved_hash: roleHash, skill_resolved_hashes: [] as string[] };
  const envPolicy = conversationEnvPolicy(input.engine);
  const model = input.modelOverride ?? (input.engine === "codex" ? "gpt-5.4" : null);
  const resolved = {
    role: {
      spec: {
        name: input.roleRef,
        description: `test ${input.roleRef}`,
        body: `test ${input.roleRef}`,
        tools: ["read" as const],
        model: "sonnet" as const,
        sandbox: "read-only" as const,
      },
      source: "builtin" as const,
      resolved_hash: roleHash,
      metadata: {},
    },
    skills: [],
    engine: input.engine,
    model,
    sessionMode: input.sessionMode,
    tool_intents: ["read" as const],
    sandbox: "read-only" as const,
    env_policy: envPolicy,
    isolation: null,
    provenance,
    trace_metadata: traceMetadata,
  };
  return {
    resolved,
    spawn: createSpawnOptionsProjection({
      engine: input.engine,
      model,
      sessionMode: input.sessionMode,
      rendered_prompt: `host-action-test:${input.roleRef}`,
      rendered_tools: [],
      sandbox: "read-only",
      env_policy: envPolicy,
      isolation: null,
      provenance,
      trace_metadata: traceMetadata,
    }),
  };
}

function completedProcess(output: string): EngineProcess {
  const bytes = new TextEncoder().encode(`${output}\n`);
  return {
    stdin: null,
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    stderr: null,
    exited: Promise.resolve(0),
    kill: () => undefined,
  };
}

interface BootstrapFixture {
  root: string;
  bootstrap: ConversationBootstrap;
  prompts: string[];
}

function bootstrapFixture(
  outputs: string[],
  options: Partial<ConversationBootstrapOptions> = {},
): BootstrapFixture {
  const root = mkdtempSync(join(tmpdir(), "vf-agent-action-candidate-"));
  roots.push(root);
  return bootstrapAt(root, outputs, options);
}

function bootstrapAt(
  root: string,
  outputs: string[],
  options: Partial<ConversationBootstrapOptions> = {},
): BootstrapFixture {
  const prompts: string[] = [];
  let sequence = 0;
  const queue = [...outputs];
  const bootstrap = createConversationBootstrap({
    repoRoot: root,
    stateDir: join(root, "conversation-state"),
    readiness: () => [{ engine: "codex", ready: true, admitted: true }],
    registeredRoles: ["direct", "responder-a", "responder-b", "brainstorm-evaluator"],
    bindingFactory: {
      materialize: (input) => binding(input),
      preview: () => {
        throw new Error("candidate test does not preview bindings");
      },
    } as ConversationBootstrapOptions["bindingFactory"],
    session: {
      protocol: "bridge",
      sourceEnv: {},
      spawn: (_argv: readonly string[], spawnOptions: EngineProcessSpawnOptions) => {
        prompts.push(spawnOptions.stdinText ?? "");
        const output = queue.shift();
        if (output === undefined) throw new Error("candidate test output queue exhausted");
        return completedProcess(output);
      },
    },
    now: () => NOW,
    id: (kind) => `${kind}-agent-action-${++sequence}`,
    schedule: (task) => task(),
    libraries,
    ...options,
  });
  return { root, bootstrap, prompts };
}

const directParticipant = (hostTools?: [] | ["propose_action"]): ConversationCreateParticipant => ({
  role_ref: "direct",
  engine: "codex",
  ...(hostTools === undefined ? {} : { host_tools: hostTools }),
});

const addParticipant = {
  type: "conversation.add_participant" as const,
  participant: {
    role_ref: "direct",
    engine: "codex" as const,
    model: null,
    skill_refs: [],
  },
};

const actionOutput = (candidate: unknown, answer = "Tôi đã chuẩn bị đề xuất.") =>
  JSON.stringify({
    answer,
    propose_action: { schema_version: "1.0", candidate },
  });

function capabilityInstallFixture(
  outputs = 1,
  candidate: (install: ReturnType<typeof capabilityInstallCandidate>) => unknown = (install) =>
    install,
  domainOptions: CapabilityConversationActionDomainOptionsV1 = {},
  answer = "Tôi đã chuẩn bị gói cài đặt.",
) {
  const root = mkdtempSync(join(tmpdir(), "vf-agent-capability-candidate-"));
  roots.push(root);
  const home = join(root, "home");
  const userVibeflow = join(home, ".vibeflow");
  mkdirSync(join(root, ".vibeflow"), { recursive: true });
  mkdirSync(userVibeflow, { recursive: true });
  writeFileSync(
    join(root, ".vibeflow", "SETTINGS.json"),
    JSON.stringify({ schema_version: "1.0", authority: null }),
  );
  writeFileSync(
    join(userVibeflow, "SETTINGS.json"),
    JSON.stringify({ schema_version: "1.0", authority: null }),
  );
  activateProjectCapabilityAuthorityForVfInit(root, { now: () => NOW });
  activateUserCapabilityAuthorityForTrustedInstall(userVibeflow, { now: () => NOW });
  const capability = productionCapabilityRuntimeV1({
    projectRoot: root,
    userHomeRoot: home,
    userVibeflowRoot: userVibeflow,
    now: () => NOW,
    vfVersion: "0.15.0",
    engineVersions: { codex: "1.0.0" },
  });
  const pkg = resolvedRolePackage();
  retainRuntimePackageCache(capability.service("user").options.storage, pkg);
  const install = capabilityInstallCandidate(pkg);
  const fx = bootstrapAt(
    root,
    Array.from({ length: outputs }, () => actionOutput(candidate(install), answer)),
    {
      actionDomainFactories: [
        (actions) => capability.conversationActionDomain(actions, domainOptions),
      ],
    },
  );
  return { capability, fx, install, pkg };
}

function capabilityInstallCandidate(pkg: ReturnType<typeof resolvedRolePackage>) {
  return {
    type: "capability.install" as const,
    package: {
      id: pkg.pin.id,
      version: pkg.pin.version,
      source_kind: pkg.pin.source.kind,
      content_sha256: pkg.pin.content_sha256,
      package_pin_digest: pkg.pin.pin_digest,
    },
    scope: "user" as const,
    requested_targets: [{ engine: "codex" as const, participant_id: "participant-1" }],
    inputs: [],
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, label: string, milliseconds = 8_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function browserAuthority(rootSessionId: string, label: string) {
  const controlSessionDigest = digestV1("VF-TEST-BROWSER-CONTROL\0v1\0", label);
  const principalDigest = digestV1("VF-BROWSER-ACTION-PRINCIPAL\0v1\0", {
    schema_version: "1.0",
    control_session_digest: controlSessionDigest,
  });
  return {
    schema_version: "1.0" as const,
    principal_digest: principalDigest,
    authority_scope_digest: actionIdempotencyScopeDigest({
      kind: "conversation" as const,
      root_session_id: rootSessionId,
    }),
    control_session_digest: controlSessionDigest,
    csrf_epoch_digest: digestV1("VF-TEST-BROWSER-CSRF\0v1\0", label),
    actor: {
      kind: "human-browser" as const,
      public_actor_id: `browser-${digestHex(principalDigest)}`,
      credential_class: "loopback-session" as const,
    },
  };
}

function agentAuthority(input: {
  rootSessionId: string;
  conversationId: string;
  revisionId: string;
  participantId: string;
}) {
  const grantDigest = proposeActionGrantDigest(input);
  const binding = {
    schema_version: "1.0" as const,
    root_session_id: input.rootSessionId,
    participant_id: input.participantId,
    host_tool: "propose_action" as const,
    grant_digest: grantDigest,
  };
  return {
    schema_version: "1.0" as const,
    principal_digest: digestV1("VF-AGENT-HOST-ACTION-PRINCIPAL\0v1\0", binding),
    authority_scope_digest: actionIdempotencyScopeDigest({
      kind: "conversation" as const,
      root_session_id: input.rootSessionId,
    }),
    control_session_digest: digestV1("VF-AGENT-HOST-ACTION-CONTROL\0v1\0", binding),
    csrf_epoch_digest: digestV1("VF-AGENT-HOST-ACTION-GRANT-EPOCH\0v1\0", binding),
    actor: {
      kind: "agent" as const,
      public_actor_id: input.participantId,
      credential_class: "loopback-session" as const,
    },
  };
}

function proposeActionGrantDigest(input: {
  conversationId: string;
  revisionId: string;
  participantId: string;
}) {
  return digestV1("VF-CONVERSATION-HOST-TOOL-GRANT\0v1\0", {
    schema_version: "1.0",
    conversation_id: input.conversationId,
    revision_id: input.revisionId,
    participant_id: input.participantId,
    host_tools: ["propose_action"],
  });
}

async function commitBrowserHeadMove(fx: BootstrapFixture, conversationId: string, label: string) {
  return commitBrowserAction(fx, conversationId, label, addParticipant);
}

function activeRevisionReservation(
  rootSessionId: string,
  parent: { conversation_id: string; revision_id: string; revision_ordinal: number },
  label: string,
) {
  const identity = digestHex(digestV1("VF-TEST-ACTIVE-REVISION-RESERVATION\0v1\0", label));
  const body = {
    schema_version: "1.0" as const,
    root_session_id: rootSessionId,
    reservation_epoch: 1,
    previous_reservation_digest: null,
    status: "active" as const,
    parent: structuredClone(parent),
    revision_claim_epoch: 1,
    operation_id: `vf-operation-${identity}`,
    proposal_id: `vf-proposal-${identity}`,
    plan_digest: digestV1("VF-TEST-REVISION-PLAN\0v1\0", label),
    child: {
      conversation_id: `child-${identity.slice(0, 16)}`,
      revision_id: `revision-${identity.slice(0, 16)}`,
      revision_ordinal: parent.revision_ordinal + 1,
    },
    created_at: NOW,
    updated_at: NOW,
  };
  return { ...body, content_digest: revisionReservationDigest(body) };
}

async function commitBrowserAction(
  fx: BootstrapFixture,
  conversationId: string,
  label: string,
  candidate: BrowserHostActionRequestV1,
) {
  const base = resolveRevisionBase({
    artifactRoot: join(fx.root, "conversation-state", "artifacts"),
    traceRoot: join(fx.root, "conversation-state", "trace"),
    conversationId,
    home: fx.bootstrap.authorities.homeAuthorities,
  });
  const authority = browserAuthority(base.lineage.root_session_id, label);
  const proposed = await fx.bootstrap.authorities.browser.actions.propose({
    conversation_id: conversationId,
    request: {
      schema_version: "1.0",
      idempotency_key: `browser-head-move-${label}`,
      anchor_event_id: null,
      expected: {
        mode: "writable-revision",
        conversation_id: base.parent.node.conversation_id,
        revision_id: base.parent.node.revision_id,
        last_seq: base.parent.source.journal_head.last_seq,
        conversation_lock_digest: base.lock.lock_digest,
      },
      candidate,
    },
    authority,
  });
  const approval = await fx.bootstrap.authorities.browser.actions.approve({
    conversation_id: conversationId,
    proposal_id: proposed.response.proposal.proposal_id,
    request: {
      schema_version: "1.0",
      proposal_digest: proposed.response.proposal.proposal_digest,
      decision: "approved",
      challenge_id: null,
      challenge_response: null,
    },
    authority,
  });
  await fx.bootstrap.authorities.browser.actions.commit({
    conversation_id: conversationId,
    proposal_id: proposed.response.proposal.proposal_id,
    request: {
      schema_version: "1.0",
      proposal_digest: proposed.response.proposal.proposal_digest,
      approval_id: approval.approval.approval_id,
    },
    authority,
  });
  return { authority, proposal: proposed.response.proposal };
}

async function approvePendingCapability(
  fx: BootstrapFixture,
  conversationId: string,
  label: string,
) {
  const pending = await fx.bootstrap.authorities.browser.actions.pending(conversationId);
  const proposal = pending[0]?.proposal;
  const rootSessionId = fx.bootstrap.authorities.browser.rootSessionId(conversationId);
  if (!proposal || !rootSessionId) throw new Error("capability approval fixture is incomplete");
  const authority = browserAuthority(rootSessionId, label);
  const challenge = await fx.bootstrap.authorities.browser.actions.challenge({
    conversation_id: conversationId,
    proposal_id: proposal.proposal_id,
    request: {
      schema_version: "1.0",
      proposal_digest: proposal.proposal_digest,
      challenge_class: "fresh-user-scope",
    },
    authority,
  });
  const approval = await fx.bootstrap.authorities.browser.actions.approve({
    conversation_id: conversationId,
    proposal_id: proposal.proposal_id,
    request: {
      schema_version: "1.0",
      proposal_digest: proposal.proposal_digest,
      decision: "approved",
      challenge_id: challenge.challenge_id,
      challenge_response: challenge.display_phrase,
    },
    authority,
  });
  return { proposal, approval: approval.approval, authority };
}

function currentRevisionBase(fx: BootstrapFixture, conversationId: string) {
  return resolveRevisionBase({
    artifactRoot: join(fx.root, "conversation-state", "artifacts"),
    traceRoot: join(fx.root, "conversation-state", "trace"),
    conversationId,
    home: fx.bootstrap.authorities.homeAuthorities,
  });
}

async function approvePublicLiteral(
  fx: BootstrapFixture,
  conversationId: string,
  label: string,
  content = `token=reviewed-${label}`,
) {
  const base = currentRevisionBase(fx, conversationId);
  const sourceEvent = (await fx.bootstrap.service.events(conversationId, 0))?.at(-1);
  if (!sourceEvent) throw new Error("public literal source event is absent");
  const binding = fx.bootstrap.authorities.homeAuthorities.literalStaging.stage({
    private_staging_id: `vf-literal-${digestHex(
      digestV1("VF-TEST-PUBLIC-LITERAL-STAGING\0v1\0", label),
    )}`,
    root_session_id: base.lineage.root_session_id,
    conversation_id: base.parent.node.conversation_id,
    revision_id: base.parent.node.revision_id,
    source_event_id: sourceEvent.event_id,
    content,
    staged_at: NOW,
  });
  const authority = browserAuthority(base.lineage.root_session_id, `literal-${label}`);
  const proposed = await fx.bootstrap.authorities.browser.actions.propose({
    conversation_id: conversationId,
    request: {
      schema_version: "1.0",
      idempotency_key: `literal-${label}`,
      anchor_event_id: sourceEvent.event_id,
      expected: {
        mode: "writable-revision",
        conversation_id: base.parent.node.conversation_id,
        revision_id: base.parent.node.revision_id,
        last_seq: base.parent.source.journal_head.last_seq,
        conversation_lock_digest: base.lock.lock_digest,
      },
      candidate: {
        type: "conversation.publish_suspected_literal",
        private_staging_id: binding.private_staging_id,
        staging_record_digest: binding.staging_record_digest,
        staged_content_digest: binding.staged_content_digest,
        findings_digest: binding.findings_digest,
      },
    },
    authority,
  });
  const proposal = proposed.response.proposal;
  const challenge = await fx.bootstrap.authorities.browser.actions.challenge({
    conversation_id: conversationId,
    proposal_id: proposal.proposal_id,
    request: {
      schema_version: "1.0",
      proposal_digest: proposal.proposal_digest,
      challenge_class: "public-literal",
    },
    authority,
  });
  const approved = await fx.bootstrap.authorities.browser.actions.approve({
    conversation_id: conversationId,
    proposal_id: proposal.proposal_id,
    request: {
      schema_version: "1.0",
      proposal_digest: proposal.proposal_digest,
      decision: "approved",
      challenge_id: challenge.challenge_id,
      challenge_response: challenge.display_phrase,
    },
    authority,
  });
  return { authority, binding, proposal, approval: approved.approval };
}

async function approveContextCompaction(
  fx: BootstrapFixture,
  conversationId: string,
  label: string,
) {
  const base = currentRevisionBase(fx, conversationId);
  const snapshot = await fx.bootstrap.service.snapshot(conversationId);
  const manifest = fx.bootstrap.authorities.artifactStore.read(conversationId);
  if (!snapshot || !manifest) throw new Error("compaction source snapshot is absent");
  let oversized: HandoffTooLargeError;
  try {
    buildRevisionHandoff({
      base,
      bindings: manifest.bindings.map((row) => ({
        participant_id: row.participant_id,
        engine: row.input.engine,
        model: row.input.modelOverride ?? null,
        role_ref: row.input.roleRef,
        continuity: "retained" as const,
      })),
      snapshot,
      promptBudgetBytes: 10_000,
    });
    throw new Error("compaction test source did not overflow");
  } catch (error) {
    if (!(error instanceof HandoffTooLargeError)) throw error;
    oversized = error;
  }
  const home = fx.bootstrap.authorities.homeAuthorities;
  home.handoffs.writeOmissions(oversized.omitted_public_event_artifacts);
  const rejected = home.oversizedHandoffs.materializeRejected({
    source: oversized.projection.source,
    source_public_head_digest: oversized.selection_plan.source_public_head_digest,
    selection_plan_digest: oversized.selection_plan.selection_digest,
    prompt_budget_bytes: oversized.selection_plan.prompt_budget_bytes,
    prompt_projection: oversized.projection,
  });
  const authority = browserAuthority(base.lineage.root_session_id, `compaction-${label}`);
  const candidate = home.oversizedHandoffs.issue({
    rejected,
    principal_digest: authority.principal_digest,
    authority_scope_digest: authority.authority_scope_digest,
    idempotency_key_digest: actionIdempotencyKeyDigest(`overflow-${label}`),
    canonical_request_digest: digestV1("VF-TEST-COMPACTION-REQUEST\0v1\0", label),
    created_at: NOW,
  });
  const compactionPreimage = {
    schema_version: "1.0" as const,
    profile: "vf-public-compaction/1" as const,
    public_summary: `Reviewed compact summary for ${label}.`,
    retained_event_ids: [] as string[],
    retained_artifact_ids: [] as string[],
  };
  const compactionInput: PublicCompactionInputV1 = {
    ...compactionPreimage,
    input_digest: digestV1("VF-PUBLIC-COMPACTION-INPUT\0v1\0", compactionPreimage),
  };
  const proposed = await fx.bootstrap.authorities.browser.actions.propose({
    conversation_id: conversationId,
    request: {
      schema_version: "1.0",
      idempotency_key: `compact-${label}`,
      anchor_event_id: null,
      expected: {
        mode: "writable-revision",
        conversation_id: base.parent.node.conversation_id,
        revision_id: base.parent.node.revision_id,
        last_seq: base.parent.source.journal_head.last_seq,
        conversation_lock_digest: base.lock.lock_digest,
      },
      candidate: {
        type: "context.compact",
        oversized_candidate_id: candidate.candidate_id,
        oversized_candidate_digest: candidate.candidate_digest,
        profile: "vf-public-compaction/1",
        compaction_input: compactionInput,
      },
    },
    authority,
  });
  const proposal = proposed.response.proposal;
  const approved = await fx.bootstrap.authorities.browser.actions.approve({
    conversation_id: conversationId,
    proposal_id: proposal.proposal_id,
    request: {
      schema_version: "1.0",
      proposal_digest: proposal.proposal_digest,
      decision: "approved",
      challenge_id: null,
      challenge_response: null,
    },
    authority,
  });
  return { authority, candidate, proposal, approval: approved.approval };
}

function claimApprovedLineageMutation(
  fx: BootstrapFixture,
  conversationId: string,
  proposalId: string,
  kind: "public-literal" | "context-compaction",
) {
  const home = fx.bootstrap.authorities.homeAuthorities;
  const snapshot = home.actions.authority.get(proposalId);
  if (!snapshot?.approval) throw new Error("reviewed lineage mutation fixture is incomplete");
  const base = currentRevisionBase(fx, conversationId);
  const reservation = home.lineageMutations.claim({
    kind,
    proposal: snapshot.proposal,
    approval: snapshot.approval,
    now: snapshot.approval.decided_at,
    resolveSource: () => ({
      root_session_id: base.lineage.root_session_id,
      conversation_id: base.parent.node.conversation_id,
      revision_id: base.parent.node.revision_id,
      last_seq: base.parent.source.journal_head.last_seq,
      conversation_lock_digest: base.lock.lock_digest,
      lineage_head_digest: base.head.content_digest,
      lineage_head_epoch: base.head.head_epoch,
    }),
  });
  return { reservation, snapshot };
}

async function approveBrowserCapability(
  fx: BootstrapFixture,
  conversationId: string,
  label: string,
  candidate: BrowserHostActionRequestV1,
) {
  const base = currentRevisionBase(fx, conversationId);
  const authority = browserAuthority(base.lineage.root_session_id, label);
  const proposed = await fx.bootstrap.authorities.browser.actions.propose({
    conversation_id: conversationId,
    request: {
      schema_version: "1.0",
      idempotency_key: `browser-capability-${label}`,
      anchor_event_id: null,
      expected: {
        mode: "writable-revision",
        conversation_id: base.parent.node.conversation_id,
        revision_id: base.parent.node.revision_id,
        last_seq: base.parent.source.journal_head.last_seq,
        conversation_lock_digest: base.lock.lock_digest,
      },
      candidate,
    },
    authority,
  });
  const proposal = proposed.response.proposal;
  const challenge = await fx.bootstrap.authorities.browser.actions.challenge({
    conversation_id: conversationId,
    proposal_id: proposal.proposal_id,
    request: {
      schema_version: "1.0",
      proposal_digest: proposal.proposal_digest,
      challenge_class: "fresh-user-scope",
    },
    authority,
  });
  const approved = await fx.bootstrap.authorities.browser.actions.approve({
    conversation_id: conversationId,
    proposal_id: proposal.proposal_id,
    request: {
      schema_version: "1.0",
      proposal_digest: proposal.proposal_digest,
      decision: "approved",
      challenge_id: challenge.challenge_id,
      challenge_response: challenge.display_phrase,
    },
    authority,
  });
  return { authority, proposal, approval: approved.approval };
}

describe("agent natural-language host action candidates", () => {
  test("recovers a privately staged candidate after response/flush crash without duplication", async () => {
    const fx = bootstrapFixture([actionOutput(addParticipant)]);
    const authority = fx.bootstrap.authorities.agentActionCandidates;
    authority.flush = async () => {
      throw new Error("simulated process loss before candidate flush");
    };
    const created = await fx.bootstrap.service.create({
      topic: "Stage an add-agent proposal, then simulate a crash before materialization.",
    });
    expect(created.result.status).toBe("completed");
    await expect(
      fx.bootstrap.authorities.browser.actions.pending(created.conversation_id),
    ).rejects.toThrow("simulated process loss");
    expect(
      fx.bootstrap.authorities.homeAuthorities.actions.authority
        .list()
        .filter((row) => row.proposal.base.conversation_id === created.conversation_id),
    ).toEqual([]);
    expect(await authority.materializations(created.conversation_id)).toMatchObject([
      { state: "pending", proposal: null },
    ]);
    const journal = await fx.bootstrap.authorities.traceStore.readConversation(
      created.conversation_id,
    );
    expect(
      journal.some(
        ({ stored_event }) =>
          stored_event.event.type === "agent_response_delta" &&
          stored_event.event.payload.completes_response === true,
      ),
    ).toBeTrue();

    const restarted = bootstrapAt(fx.root, []);
    await restarted.bootstrap.authorities.agentActionCandidates.awaitRecovery();
    expect(
      await restarted.bootstrap.authorities.browser.actions.pending(created.conversation_id),
    ).toHaveLength(1);
    expect(
      await restarted.bootstrap.authorities.agentActionCandidates.materializations(
        created.conversation_id,
      ),
    ).toMatchObject([{ state: "materialized", proposal: { approval: null } }]);

    const restartedAgain = bootstrapAt(fx.root, []);
    await restartedAgain.bootstrap.authorities.agentActionCandidates.awaitRecovery();
    expect(
      restartedAgain.bootstrap.authorities.homeAuthorities.actions.authority
        .list()
        .filter((row) => row.proposal.base.conversation_id === created.conversation_id),
    ).toHaveLength(1);
  });

  test("heals a crash after action-authority sequence zero through exact idempotency recovery", async () => {
    let faultCount = 0;
    const fx = bootstrapFixture([actionOutput(addParticipant)], {
      actionAuthorityFault: (point) => {
        if (point === "after-authority-sequence-zero") {
          faultCount += 1;
          throw new Error("simulated process loss after authority sequence zero");
        }
      },
    });
    const created = await fx.bootstrap.service.create({
      topic: "Crash after the proposal won sequence zero, before visibility and receipt.",
    });
    expect(created.result.status).toBe("completed");
    expect(faultCount).toBeGreaterThan(0);
    expect(
      await fx.bootstrap.authorities.agentActionCandidates.materializations(
        created.conversation_id,
      ),
    ).toMatchObject([{ state: "pending", proposal: null }]);

    const restarted = bootstrapAt(fx.root, []);
    await restarted.bootstrap.authorities.agentActionCandidates.awaitRecovery();
    expect(
      await restarted.bootstrap.authorities.agentActionCandidates.materializations(
        created.conversation_id,
      ),
    ).toMatchObject([{ state: "materialized", proposal: { approval: null } }]);
    expect(
      restarted.bootstrap.authorities.homeAuthorities.actions.authority
        .list()
        .filter((row) => row.proposal.base.conversation_id === created.conversation_id),
    ).toHaveLength(1);
  });

  test("recovers a proposal winner before a later source-changed rejection can win", async () => {
    const fx = bootstrapFixture([actionOutput(addParticipant)], {
      agentActionCandidateBarrier: async () => {
        throw new Error(
          "simulated process loss after proposal publication, before private receipt",
        );
      },
    });
    const created = await fx.bootstrap.service.create({
      topic: "Race a published agent proposal with a source-head transition.",
    });
    const selected = created.conversation_id;
    expect(
      await fx.bootstrap.authorities.agentActionCandidates.materializations(selected),
    ).toMatchObject([{ state: "pending", proposal: null }]);
    await commitBrowserHeadMove(fx, selected, "materialization-race-source-move");
    const restarted = bootstrapAt(fx.root, []);
    await restarted.bootstrap.authorities.agentActionCandidates.awaitRecovery();
    expect(
      await restarted.bootstrap.authorities.agentActionCandidates.materializations(selected),
    ).toMatchObject([{ state: "materialized", rejection_code: null }]);
    expect(
      restarted.bootstrap.authorities.homeAuthorities.actions.authority
        .list()
        .filter(
          (row) =>
            row.proposal.base.conversation_id === selected &&
            row.proposal.requested_by.kind === "agent",
        ),
    ).toHaveLength(1);
  });

  test("re-runs a materialization task requested after the first snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-agent-materialization-lock-"));
    roots.push(root);
    const lock = new ConversationAgentActionCandidateMaterializationLockV1(root);
    const entered = deferred();
    const release = deferred();
    let runs = 0;
    const first = lock.run("conversation-drain", async () => {
      runs += 1;
      if (runs === 1) {
        entered.resolve();
        await release.promise;
      }
    });
    await entered.promise;
    const second = lock.run("conversation-drain", async () => {
      throw new Error("the shared drain must retain the authoritative first task");
    });
    release.resolve();
    await Promise.all([first, second]);
    expect(runs).toBe(2);
  });

  test("durably rejects a private candidate when its writable source moves before recovery", async () => {
    const fx = bootstrapFixture([actionOutput(addParticipant)]);
    fx.bootstrap.authorities.agentActionCandidates.flush = async () => {
      throw new Error("simulated process loss before candidate flush");
    };
    const created = await fx.bootstrap.service.create({
      topic: "Keep the candidate private until the terminal source changes.",
    });
    await commitBrowserHeadMove(fx, created.conversation_id, "source-move");

    const restarted = bootstrapAt(fx.root, []);
    await restarted.bootstrap.authorities.agentActionCandidates.awaitRecovery();
    expect(
      await restarted.bootstrap.authorities.agentActionCandidates.materializations(
        created.conversation_id,
      ),
    ).toMatchObject([{ state: "rejected", proposal: null, rejection_code: "source_changed" }]);
    expect(
      await restarted.bootstrap.authorities.browser.actions.pending(created.conversation_id),
    ).toEqual([]);
  });

  test("durably rejects terminal planner-invalid and revoked-grant candidates without poisoning pending", async () => {
    const invalid = bootstrapFixture([
      actionOutput({
        type: "conversation.remove_participant",
        participant_id: "participant-does-not-exist",
      }),
    ]);
    const invalidCreated = await invalid.bootstrap.service.create({
      topic: "Remove a participant that does not exist.",
    });
    expect(
      await invalid.bootstrap.authorities.browser.actions.pending(invalidCreated.conversation_id),
    ).toEqual([]);
    expect(
      await invalid.bootstrap.authorities.agentActionCandidates.materializations(
        invalidCreated.conversation_id,
      ),
    ).toMatchObject([
      { state: "rejected", proposal: null, rejection_code: "candidate_not_actionable" },
    ]);
    expect(
      invalid.bootstrap.authorities.homeAuthorities.actions.authority
        .list()
        .filter((row) => row.proposal.base.conversation_id === invalidCreated.conversation_id),
    ).toEqual([]);

    const revoked = bootstrapFixture([actionOutput(addParticipant)]);
    const revokedCreated = await revoked.bootstrap.service.create({
      topic: "The evaluator-style binding explicitly revokes host action proposals.",
      policy: "direct",
      participants: [directParticipant([])],
    });
    const manifest = revoked.bootstrap.authorities.artifactStore.read(
      revokedCreated.conversation_id,
    );
    const journal = await revoked.bootstrap.authorities.traceStore.readConversation(
      revokedCreated.conversation_id,
    );
    const origin = journal.find(
      ({ stored_event }) =>
        stored_event.event.type === "agent_response_delta" &&
        stored_event.event.payload.completes_response,
    )?.stored_event;
    if (!manifest || !origin) throw new Error("revoked candidate source is absent");
    const forgedGrant = structuredClone(manifest);
    const binding = forgedGrant.bindings[0];
    if (!binding) throw new Error("revoked candidate binding is absent");
    binding.host_tools = ["propose_action"];
    expect(
      revoked.bootstrap.authorities.agentActionCandidates.stage({
        manifest: forgedGrant,
        participant_id: binding.participant_id,
        response_idempotency_key: origin.idempotency_key,
        candidate: { schema_version: "1.0", candidate: addParticipant },
      }),
    ).toMatchObject({ accepted: true });
    await revoked.bootstrap.authorities.agentActionCandidates.flush(revokedCreated.conversation_id);
    expect(
      await revoked.bootstrap.authorities.agentActionCandidates.materializations(
        revokedCreated.conversation_id,
      ),
    ).toMatchObject([{ state: "rejected", rejection_code: "grant_revoked" }]);
  });

  test("materializes one immutable add-agent proposal with exact producer/origin and controller separation", async () => {
    const fx = bootstrapFixture([actionOutput(addParticipant)]);
    const created = await fx.bootstrap.service.create({
      topic: "Thêm một Codex reviewer nhưng đợi tôi xác nhận.",
    });
    expect(created.result.status).toBe("completed");
    expect(fx.prompts[0]).toContain("propose_action");
    expect(fx.prompts[0]).toContain("conversation.add_participant");
    const manifest = fx.bootstrap.authorities.artifactStore.read(created.conversation_id);
    expect(manifest?.bindings[0]?.host_tools).toEqual(["propose_action"]);
    const pending = await fx.bootstrap.authorities.browser.actions.pending(created.conversation_id);
    expect(pending).toHaveLength(1);
    const proposal = pending[0]?.proposal;
    const producerId = manifest?.bindings[0]?.participant_id;
    if (!proposal || !manifest || !producerId)
      throw new Error("agent proposal fixture is incomplete");
    expect(proposal.action_type).toBe("conversation.add_participant");
    const stored = fx.bootstrap.authorities.homeAuthorities.actions.authority.get(
      proposal.proposal_id,
    );
    expect(stored?.proposal.requested_by).toEqual({
      kind: "agent",
      public_actor_id: producerId,
      credential_class: "loopback-session",
    });
    expect(stored?.proposal.origin_event_id).toBe(proposal.origin_event_id);
    const journal = await fx.bootstrap.authorities.traceStore.readConversation(
      created.conversation_id,
    );
    const origin = journal.find(
      ({ stored_event }) => stored_event.event_id === proposal.origin_event_id,
    )?.stored_event;
    expect(origin?.event).toMatchObject({
      type: "agent_response_delta",
      payload: { participant_id: manifest.bindings[0]?.participant_id, completes_response: true },
    });

    const rootSessionId = fx.bootstrap.authorities.browser.rootSessionId(created.conversation_id);
    if (!rootSessionId || !origin) throw new Error("agent proposal lineage is absent");
    const self = agentAuthority({
      rootSessionId,
      conversationId: created.conversation_id,
      revisionId: created.revision_id,
      participantId: manifest.bindings[0]?.participant_id ?? "",
    });
    await expect(
      fx.bootstrap.authorities.browser.actions.approve({
        conversation_id: created.conversation_id,
        proposal_id: proposal.proposal_id,
        request: {
          schema_version: "1.0",
          proposal_digest: proposal.proposal_digest,
          decision: "approved",
          challenge_id: null,
          challenge_response: null,
        },
        authority: self,
      }),
    ).rejects.toThrow(/agent cannot approve/i);
    await expect(
      fx.bootstrap.authorities.browser.actions.approve({
        conversation_id: created.conversation_id,
        proposal_id: proposal.proposal_id,
        request: {
          schema_version: "1.0",
          proposal_digest: proposal.proposal_digest,
          decision: "denied",
          challenge_id: null,
          challenge_response: null,
        },
        authority: self,
      }),
    ).rejects.toThrow(/agent cannot approve or deny/i);

    const unrelated = browserAuthority("another-conversation-root", "unrelated");
    await expect(
      fx.bootstrap.authorities.browser.actions.approve({
        conversation_id: created.conversation_id,
        proposal_id: proposal.proposal_id,
        request: {
          schema_version: "1.0",
          proposal_digest: proposal.proposal_digest,
          decision: "approved",
          challenge_id: null,
          challenge_response: null,
        },
        authority: unrelated,
      }),
    ).rejects.toThrow(/binding changed|stale/i);

    const forgedController = {
      ...browserAuthority(rootSessionId, "forged-controller"),
      actor: {
        kind: "human-browser" as const,
        public_actor_id: "browser-forged-controller",
        credential_class: "loopback-session" as const,
      },
    };
    await expect(
      fx.bootstrap.authorities.browser.actions.approve({
        conversation_id: created.conversation_id,
        proposal_id: proposal.proposal_id,
        request: {
          schema_version: "1.0",
          proposal_digest: proposal.proposal_digest,
          decision: "approved",
          challenge_id: null,
          challenge_response: null,
        },
        authority: forgedController,
      }),
    ).rejects.toThrow(/binding changed|stale/i);

    expect(
      fx.bootstrap.authorities.agentActionCandidates.stage({
        manifest,
        participant_id: manifest.bindings[0]?.participant_id ?? "",
        response_idempotency_key: origin.idempotency_key,
        candidate: { schema_version: "1.0", candidate: addParticipant },
      }),
    ).toMatchObject({ accepted: true, diagnostic_code: null });
    expect(
      fx.bootstrap.authorities.agentActionCandidates.stage({
        manifest,
        participant_id: manifest.bindings[0]?.participant_id ?? "",
        response_idempotency_key: origin.idempotency_key,
        candidate: {
          schema_version: "1.0",
          candidate: {
            type: "conversation.update_settings",
            changes: { max_rounds: 2 },
          },
        },
      }),
    ).toEqual({ accepted: false, diagnostic_code: "action_candidate_conflict" });
    await fx.bootstrap.authorities.agentActionCandidates.flush(created.conversation_id);
    expect(
      fx.bootstrap.authorities.homeAuthorities.actions.authority
        .list()
        .filter((row) => row.proposal.base.conversation_id === created.conversation_id),
    ).toHaveLength(1);

    const controller = browserAuthority(rootSessionId, "controller");
    const approved = await fx.bootstrap.authorities.browser.actions.approve({
      conversation_id: created.conversation_id,
      proposal_id: proposal.proposal_id,
      request: {
        schema_version: "1.0",
        proposal_digest: proposal.proposal_digest,
        decision: "approved",
        challenge_id: null,
        challenge_response: null,
      },
      authority: controller,
    });
    expect(approved.approval.decided_by).toEqual(controller.actor);
    await expect(
      fx.bootstrap.authorities.browser.actions.commit({
        conversation_id: created.conversation_id,
        proposal_id: proposal.proposal_id,
        request: {
          schema_version: "1.0",
          proposal_digest: proposal.proposal_digest,
          approval_id: approved.approval.approval_id,
        },
        authority: self,
      }),
    ).rejects.toThrow(/controller|stale/i);
    let committed: Awaited<ReturnType<typeof fx.bootstrap.authorities.browser.actions.commit>>;
    try {
      committed = await fx.bootstrap.authorities.browser.actions.commit({
        conversation_id: created.conversation_id,
        proposal_id: proposal.proposal_id,
        request: {
          schema_version: "1.0",
          proposal_digest: proposal.proposal_digest,
          approval_id: approved.approval.approval_id,
        },
        authority: controller,
      });
    } catch (error) {
      throw new Error(`agent-controller commit failed: ${(error as Error).message}`, {
        cause: error,
      });
    }
    expect(committed).toMatchObject({
      operation: { state: expect.stringMatching(/committing|succeeded/) },
    });
    const transition = fx.bootstrap.authorities.homeAuthorities
      .publishedRevisionTransitions()
      .find(
        ({ authority }) =>
          (authority as { proposal?: { proposal_id?: string } }).proposal?.proposal_id ===
          proposal.proposal_id,
      );
    const childId = (
      transition?.authority as { operation?: { child?: { conversation_id?: string } } } | undefined
    )?.operation?.child?.conversation_id;
    expect(childId).toBeString();
    expect(
      childId
        ? fx.bootstrap.authorities.artifactStore
            .read(childId)
            ?.bindings.map((row) => row.host_tools)
        : null,
    ).toEqual([["propose_action"], ["propose_action"]]);
    expect(await fx.bootstrap.authorities.browser.actions.pending(created.conversation_id)).toEqual(
      [],
    );
  });

  test("marks an agent conversation proposal stale when the source changes before review", async () => {
    const fx = bootstrapFixture([actionOutput(addParticipant)]);
    const created = await fx.bootstrap.service.create({
      topic: "Prepare a proposal, then change the writable head before review.",
      policy: "direct",
      participants: [directParticipant()],
    });
    const pending = await fx.bootstrap.authorities.browser.actions.pending(created.conversation_id);
    const proposal = pending[0]?.proposal;
    const rootSessionId = fx.bootstrap.authorities.browser.rootSessionId(created.conversation_id);
    if (!proposal || !rootSessionId) throw new Error("stale review fixture is incomplete");
    await commitBrowserHeadMove(fx, created.conversation_id, "review-source-move");
    const reviewer = browserAuthority(rootSessionId, "late-agent-reviewer");
    await expect(
      fx.bootstrap.authorities.browser.actions.approve({
        conversation_id: created.conversation_id,
        proposal_id: proposal.proposal_id,
        request: {
          schema_version: "1.0",
          proposal_digest: proposal.proposal_digest,
          decision: "approved",
          challenge_id: null,
          challenge_response: null,
        },
        authority: reviewer,
      }),
    ).rejects.toThrow(/stale|authority changed/i);
    expect(
      fx.bootstrap.authorities.homeAuthorities.actions.authority.get(proposal.proposal_id)?.state,
    ).toBe("stale");
  });

  test("rejects a private stage when its public grant or completed origin diverges", async () => {
    const fx = bootstrapFixture([actionOutput(addParticipant)]);
    const created = await fx.bootstrap.service.create({
      topic: "Keep candidate review bound to its public grant and completed response.",
      policy: "direct",
      participants: [directParticipant()],
    });
    const proposal = (
      await fx.bootstrap.authorities.browser.actions.pending(created.conversation_id)
    )[0]?.proposal;
    const manifest = fx.bootstrap.authorities.artifactStore.read(created.conversation_id);
    const participant = manifest?.bindings[0];
    const events = (
      await fx.bootstrap.authorities.traceStore.readConversation(created.conversation_id)
    ).map(({ stored_event: event }) => event);
    const originEventId = proposal?.origin_event_id;
    const origin = events.find((event) => event.event_id === originEventId);
    if (!proposal || !originEventId || !manifest || !participant || !origin)
      throw new Error("candidate source continuity fixture is incomplete");
    const stage = {
      participant_id: participant.participant_id,
      response_idempotency_key: origin.idempotency_key,
      grant_digest: proposeActionGrantDigest({
        conversationId: manifest.conversation_id,
        revisionId: manifest.revision_id,
        participantId: participant.participant_id,
      }),
    };
    expect(() =>
      assertCurrentAgentActionCandidateGrant({ manifest, stage, now: NOW }),
    ).not.toThrow();
    const revoked = structuredClone(manifest);
    const revokedParticipant = revoked.bindings[0];
    if (!revokedParticipant) throw new Error("candidate grant fixture has no participant");
    revokedParticipant.host_tools = [];
    let grantError: unknown;
    try {
      assertCurrentAgentActionCandidateGrant({ manifest: revoked, stage, now: NOW });
    } catch (error) {
      grantError = error;
    }
    expect(grantError).toBeInstanceOf(ActionAuthorityStaleError);
    expect((grantError as ActionAuthorityStaleError).reason_code).toBe(
      AGENT_ACTION_CANDIDATE_SOURCE_STALE_CODE.AGENT_GRANT_CHANGED,
    );
    const receipt = { origin_response_event_id: originEventId };
    expect(() =>
      assertCurrentAgentActionCandidateOrigin({ manifest, events, stage, receipt, now: NOW }),
    ).not.toThrow();
    let originError: unknown;
    try {
      assertCurrentAgentActionCandidateOrigin({ manifest, events: [], stage, receipt, now: NOW });
    } catch (error) {
      originError = error;
    }
    expect(originError).toBeInstanceOf(ActionAuthorityStaleError);
    expect((originError as ActionAuthorityStaleError).reason_code).toBe(
      AGENT_ACTION_CANDIDATE_SOURCE_STALE_CODE.AGENT_ORIGIN_CHANGED,
    );
  });

  test("keeps ordinary Vietnamese public and rejects denied or malformed candidates without proposals", async () => {
    const ordinary = "Tôi nghĩ nên thêm reviewer, nhưng đây chỉ là thảo luận.";
    const fx = bootstrapFixture([
      ordinary,
      actionOutput({ type: "not-a-host-action" }),
      actionOutput(addParticipant),
    ]);
    const plain = await fx.bootstrap.service.create({
      topic: "Hãy cân nhắc agent mới.",
      policy: "direct",
      participants: [directParticipant()],
    });
    expect(await fx.bootstrap.authorities.browser.actions.pending(plain.conversation_id)).toEqual(
      [],
    );
    expect(
      (await fx.bootstrap.service.events(plain.conversation_id, 0))?.some(
        (event) =>
          event.event.type === "agent_response_delta" &&
          event.event.payload.content_delta.includes(ordinary),
      ),
    ).toBeTrue();

    const invalid = await fx.bootstrap.service.create({
      topic: "Malformed candidate.",
      policy: "direct",
      participants: [directParticipant()],
    });
    expect(await fx.bootstrap.authorities.browser.actions.pending(invalid.conversation_id)).toEqual(
      [],
    );
    expect(
      (await fx.bootstrap.service.events(invalid.conversation_id, 0))?.some(
        (event) =>
          event.event.type === "error" && event.event.payload.code === "invalid_action_candidate",
      ),
    ).toBeTrue();

    const denied = await fx.bootstrap.service.create({
      topic: "Explicitly denied host tool.",
      policy: "direct",
      participants: [{ ...directParticipant([]), role_ref: "DIRECT" }],
    });
    expect(fx.prompts[2]).not.toContain("propose_action");
    expect(await fx.bootstrap.authorities.browser.actions.pending(denied.conversation_id)).toEqual(
      [],
    );
    expect(
      (await fx.bootstrap.service.events(denied.conversation_id, 0))?.some(
        (event) =>
          event.event.type === "error" && event.event.payload.code === "host_tool_not_granted",
      ),
    ).toBeTrue();
  });

  test("rejects recovery-only and private-reference agent intents before private staging", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const candidates: BrowserHostActionRequestV1[] = [
      {
        type: "conversation.select_lineage_head",
        root_session_id: "root-recovery",
        candidate_conversation_id: "conversation-recovery",
        candidate_revision_id: "revision-recovery",
      },
      {
        type: "conversation.publish_suspected_literal",
        private_staging_id: "private-literal",
        staging_record_digest: digest,
        staged_content_digest: digest,
        findings_digest: digest,
      },
      {
        type: "capability.install",
        package: { id: "private-capability" },
        scope: "project",
        requested_targets: [{ engine: "codex", participant_id: "participant-1" }],
        inputs: [
          {
            input_id: "token",
            value: { private_input_binding_id: "private-input", binding_digest: digest },
          },
        ],
      },
      {
        type: "capability.update",
        package_id: "private-capability",
        selector: { id: "private-capability" },
        scope: "project",
        requested_targets: null,
        inputs: [
          {
            input_id: "token",
            value: { private_input_binding_id: "private-input", binding_digest: digest },
          },
        ],
      },
    ];
    const fx = bootstrapFixture(candidates.map((candidate) => actionOutput(candidate)));
    for (const [index] of candidates.entries()) {
      const created = await fx.bootstrap.service.create({
        topic: `Reject private/recovery agent surface ${index}.`,
        policy: "direct",
        participants: [directParticipant()],
      });
      expect(
        await fx.bootstrap.authorities.browser.actions.pending(created.conversation_id),
      ).toEqual([]);
      expect(
        await fx.bootstrap.authorities.agentActionCandidates.materializations(
          created.conversation_id,
        ),
      ).toEqual([]);
      expect(
        (await fx.bootstrap.service.events(created.conversation_id, 0))?.some(
          (event) =>
            event.event.type === "error" && event.event.payload.code === "invalid_action_candidate",
        ),
      ).toBeTrue();
    }
  });

  test("durably rejects a missing receipt/control target without wedging pending recovery", async () => {
    const fx = bootstrapFixture([
      actionOutput({ type: "conversation.stop_operation", operation_id: "operation-missing" }),
    ]);
    const created = await fx.bootstrap.service.create({
      topic: "Stop an operation that does not exist.",
    });
    expect(await fx.bootstrap.authorities.browser.actions.pending(created.conversation_id)).toEqual(
      [],
    );
    expect(
      await fx.bootstrap.authorities.agentActionCandidates.materializations(
        created.conversation_id,
      ),
    ).toMatchObject([
      { state: "rejected", proposal: null, rejection_code: "candidate_not_actionable" },
    ]);
    const restarted = bootstrapAt(fx.root, []);
    await restarted.bootstrap.authorities.agentActionCandidates.awaitRecovery();
  });

  test("hard-denies a schema-valid retained evaluator grant and preserves omitted legacy denial", async () => {
    const fx = bootstrapFixture(["ordinary evaluator authority source"]);
    const created = await fx.bootstrap.service.create({
      topic: "Build a completed source for retained authority checks.",
      policy: "direct",
      participants: [directParticipant()],
    });
    const manifest = fx.bootstrap.authorities.artifactStore.read(created.conversation_id);
    const origin = (
      await fx.bootstrap.authorities.traceStore.readConversation(created.conversation_id)
    ).find(
      ({ stored_event }) =>
        stored_event.event.type === "agent_response_delta" &&
        stored_event.event.payload.completes_response,
    )?.stored_event;
    const sourceBinding = manifest?.bindings[0];
    if (!manifest || !sourceBinding || !origin)
      throw new Error("retained evaluator authority fixture is incomplete");
    const forged = structuredClone(manifest);
    const forgedBinding = forged.bindings[0];
    if (!forgedBinding) throw new Error("forged evaluator binding is absent");
    forgedBinding.input.roleRef = "brainstorm-evaluator";
    forgedBinding.host_tools = ["propose_action"];
    expect(
      fx.bootstrap.authorities.agentActionCandidates.stage({
        manifest: forged,
        participant_id: forgedBinding.participant_id,
        response_idempotency_key: origin.idempotency_key,
        candidate: { schema_version: "1.0", candidate: addParticipant },
      }),
    ).toEqual({ accepted: false, diagnostic_code: "host_tool_not_granted" });

    const legacy = structuredClone(manifest);
    legacy.bindings = legacy.bindings.map(({ host_tools: _hostTools, ...binding }) => binding);
    const updated = applyConversationRevisionMutation({
      parent: legacy,
      action: {
        type: "conversation.update_participant",
        participant_id: sourceBinding.participant_id,
        changes: { model: "gpt-5.4-mini" },
      },
      idempotencyKey: "legacy-omitted-host-tools",
    });
    expect(updated.bindings[0]?.host_tools).toEqual([]);
  });

  test("materializes a real capability install candidate through the production Capability domain", async () => {
    const { capability, fx, pkg } = capabilityInstallFixture(2);
    const created = await fx.bootstrap.service.create({
      topic: "Cài capability reviewer cho Codex, nhưng phải cho tôi review trước.",
      policy: "direct",
      participants: [directParticipant()],
    });
    expect(created.result.status).toBe("completed");
    expect(fx.prompts[0]).toContain("capability.install");
    expect(fx.prompts[0]).not.toContain('"participant_id":null');
    expect(fx.prompts[0]).toContain(
      '"participant_id":"<existing participant_id from delivered conversation context>"',
    );
    expect(fx.prompts[0]).toContain("if no exact participant identity and matching engine");
    expect(fx.prompts[0]).toContain("do not propose the action");
    const pending = await fx.bootstrap.authorities.browser.actions.pending(created.conversation_id);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      proposal: {
        action_type: "capability.install",
        domain: "capability",
        scope: "user",
        package_pins: [{ id: pkg.pin.id, version: pkg.pin.version }],
      },
      approval: null,
      operation: { state: "pending_review", operation_id: null },
    });
    const stored = fx.bootstrap.authorities.homeAuthorities.actions.authority.get(
      pending[0]?.proposal.proposal_id ?? "",
    );
    expect(stored?.proposal.requested_by.kind).toBe("agent");
    expect(stored?.proposal.origin_event_id).toBe(pending[0]?.proposal.origin_event_id);
    expect(capability.service("user").options.storage.readStatus().lock?.packages ?? []).toEqual(
      [],
    );
    const rootSessionId = fx.bootstrap.authorities.browser.rootSessionId(created.conversation_id);
    if (!rootSessionId || !pending[0]) throw new Error("capability proposal root is absent");
    const reviewer = browserAuthority(rootSessionId, "user-scope-reviewer");
    const challenge = await fx.bootstrap.authorities.browser.actions.challenge({
      conversation_id: created.conversation_id,
      proposal_id: pending[0].proposal.proposal_id,
      request: {
        schema_version: "1.0",
        proposal_digest: pending[0].proposal.proposal_digest,
        challenge_class: "fresh-user-scope",
      },
      authority: reviewer,
    });
    const otherSession = browserAuthority(rootSessionId, "other-browser-session");
    await expect(
      fx.bootstrap.authorities.browser.actions.approve({
        conversation_id: created.conversation_id,
        proposal_id: pending[0].proposal.proposal_id,
        request: {
          schema_version: "1.0",
          proposal_digest: pending[0].proposal.proposal_digest,
          decision: "approved",
          challenge_id: challenge.challenge_id,
          challenge_response: challenge.display_phrase,
        },
        authority: otherSession,
      }),
    ).rejects.toThrow(/challenge authority changed|stale/i);
    const approval = await fx.bootstrap.authorities.browser.actions.approve({
      conversation_id: created.conversation_id,
      proposal_id: pending[0].proposal.proposal_id,
      request: {
        schema_version: "1.0",
        proposal_digest: pending[0].proposal.proposal_digest,
        decision: "approved",
        challenge_id: challenge.challenge_id,
        challenge_response: challenge.display_phrase,
      },
      authority: reviewer,
    });
    expect(approval).toMatchObject({ approval: { decided_by: reviewer.actor } });
    await fx.bootstrap.authorities.browser.actions.commit({
      conversation_id: created.conversation_id,
      proposal_id: pending[0].proposal.proposal_id,
      request: {
        schema_version: "1.0",
        proposal_digest: pending[0].proposal.proposal_digest,
        approval_id: approval.approval.approval_id,
      },
      authority: reviewer,
    });
    expect(
      capability
        .service("user")
        .options.storage.readStatus()
        .lock?.packages.map((row) => row.package_id),
    ).toContain(pkg.pin.id);

    const noOp = await fx.bootstrap.service.create({
      topic: "Request the same installed capability again.",
      policy: "direct",
      participants: [directParticipant()],
    });
    expect(await fx.bootstrap.authorities.browser.actions.pending(noOp.conversation_id)).toEqual(
      [],
    );
    expect(
      await fx.bootstrap.authorities.agentActionCandidates.materializations(noOp.conversation_id),
    ).toMatchObject([
      { state: "rejected", proposal: null, rejection_code: "candidate_not_actionable" },
    ]);
  });

  test("rejects null, ghost, and cross-engine conversation capability selectors", async () => {
    const cases: Array<{
      name: string;
      target: { engine: "codex" | "claude"; participant_id: string | null };
    }> = [
      { name: "null", target: { engine: "codex", participant_id: null } },
      { name: "ghost", target: { engine: "codex", participant_id: "participant-ghost" } },
      { name: "cross-engine", target: { engine: "claude", participant_id: "participant-1" } },
    ];
    for (const selected of cases) {
      const { fx } = capabilityInstallFixture(1, (install) => ({
        ...install,
        requested_targets: [selected.target],
      }));
      const created = await fx.bootstrap.service.create({
        topic: `Reject ${selected.name} conversation capability target.`,
        policy: "direct",
        participants: [directParticipant()],
      });
      expect(
        await fx.bootstrap.authorities.browser.actions.pending(created.conversation_id),
      ).toEqual([]);
      expect(
        await fx.bootstrap.authorities.agentActionCandidates.materializations(
          created.conversation_id,
        ),
      ).toMatchObject([
        { state: "rejected", proposal: null, rejection_code: "candidate_not_actionable" },
      ]);
      expect(
        fx.bootstrap.authorities.homeAuthorities.actions.authority
          .list()
          .filter((row) => row.proposal.base.conversation_id === created.conversation_id),
      ).toEqual([]);
    }
  });

  test("discards a capability target draft when its participant source drifts before proposal", async () => {
    const { fx } = capabilityInstallFixture();
    fx.bootstrap.authorities.agentActionCandidates.flush = async () => {
      throw new Error("hold capability candidate as a private draft");
    };
    const created = await fx.bootstrap.service.create({
      topic: "Hold a participant-targeted capability candidate until its source changes.",
      policy: "direct",
      participants: [directParticipant()],
    });
    await commitBrowserAction(fx, created.conversation_id, "capability-target-engine-drift", {
      type: "conversation.update_participant",
      participant_id: "participant-1",
      changes: { engine: "claude" },
    });
    const restarted = bootstrapAt(fx.root, []);
    await restarted.bootstrap.authorities.agentActionCandidates.awaitRecovery();
    expect(
      await restarted.bootstrap.authorities.agentActionCandidates.materializations(
        created.conversation_id,
      ),
    ).toMatchObject([{ state: "rejected", proposal: null, rejection_code: "source_changed" }]);
    expect(
      await restarted.bootstrap.authorities.browser.actions.pending(created.conversation_id),
    ).toEqual([]);
  });

  test("marks an agent capability proposal stale before challenge when its conversation source moves", async () => {
    const { fx } = capabilityInstallFixture();
    const created = await fx.bootstrap.service.create({
      topic: "Prepare a capability proposal whose conversation source will move.",
      policy: "direct",
      participants: [directParticipant()],
    });
    const pending = await fx.bootstrap.authorities.browser.actions.pending(created.conversation_id);
    const proposal = pending[0]?.proposal;
    const rootSessionId = fx.bootstrap.authorities.browser.rootSessionId(created.conversation_id);
    if (!proposal || !rootSessionId) throw new Error("capability stale fixture is incomplete");
    await commitBrowserHeadMove(fx, created.conversation_id, "capability-source-move");
    await expect(
      fx.bootstrap.authorities.browser.actions.challenge({
        conversation_id: created.conversation_id,
        proposal_id: proposal.proposal_id,
        request: {
          schema_version: "1.0",
          proposal_digest: proposal.proposal_digest,
          challenge_class: "fresh-user-scope",
        },
        authority: browserAuthority(rootSessionId, "late-capability-reviewer"),
      }),
    ).rejects.toThrow(/stale|authority changed/i);
    expect(
      fx.bootstrap.authorities.homeAuthorities.actions.authority.get(proposal.proposal_id)?.state,
    ).toBe("stale");
  });

  test("revalidates an approved agent capability proposal before dispatching any effect", async () => {
    const { capability, fx } = capabilityInstallFixture();
    const created = await fx.bootstrap.service.create({
      topic: "Approve a capability proposal, then move its source before commit.",
      policy: "direct",
      participants: [directParticipant()],
    });
    const pending = await fx.bootstrap.authorities.browser.actions.pending(created.conversation_id);
    const proposal = pending[0]?.proposal;
    const rootSessionId = fx.bootstrap.authorities.browser.rootSessionId(created.conversation_id);
    if (!proposal || !rootSessionId) throw new Error("capability dispatch fixture is incomplete");
    const reviewer = browserAuthority(rootSessionId, "capability-dispatch-reviewer");
    const challenge = await fx.bootstrap.authorities.browser.actions.challenge({
      conversation_id: created.conversation_id,
      proposal_id: proposal.proposal_id,
      request: {
        schema_version: "1.0",
        proposal_digest: proposal.proposal_digest,
        challenge_class: "fresh-user-scope",
      },
      authority: reviewer,
    });
    const approval = await fx.bootstrap.authorities.browser.actions.approve({
      conversation_id: created.conversation_id,
      proposal_id: proposal.proposal_id,
      request: {
        schema_version: "1.0",
        proposal_digest: proposal.proposal_digest,
        decision: "approved",
        challenge_id: challenge.challenge_id,
        challenge_response: challenge.display_phrase,
      },
      authority: reviewer,
    });
    await commitBrowserHeadMove(fx, created.conversation_id, "capability-post-approval-move");
    await expect(
      fx.bootstrap.authorities.browser.actions.commit({
        conversation_id: created.conversation_id,
        proposal_id: proposal.proposal_id,
        request: {
          schema_version: "1.0",
          proposal_digest: proposal.proposal_digest,
          approval_id: approval.approval.approval_id,
        },
        authority: reviewer,
      }),
    ).rejects.toThrow(/stale|authority changed/i);
    expect(
      fx.bootstrap.authorities.homeAuthorities.actions.authority.get(proposal.proposal_id)?.state,
    ).toBe("stale");
    const operationId = deriveOperationId(proposal, approval.approval.approval_id);
    expect(
      existsSync(
        capabilityOperationPaths(capability.service("user").options.storage.paths, operationId)
          .header,
      ),
    ).toBeFalse();
    expect(capability.service("user").options.storage.readStatus().lock?.packages ?? []).toEqual(
      [],
    );
  });

  test("loses a prepared capability dispatch race to an unrelated head writer before claim", async () => {
    const prepared = deferred();
    const resume = deferred();
    const { capability, fx } = capabilityInstallFixture(1, (install) => install, {
      barrier: async ({ point }) => {
        if (point !== "after-dispatch-prepared") return;
        prepared.resolve();
        await resume.promise;
      },
    });
    const created = await fx.bootstrap.service.create({
      topic: "Interleave a conversation head move immediately before capability claim.",
      policy: "direct",
      participants: [directParticipant()],
    });
    const reviewed = await approvePendingCapability(
      fx,
      created.conversation_id,
      "capability-pre-claim-race",
    );
    const committing = fx.bootstrap.authorities.browser.actions.commit({
      conversation_id: created.conversation_id,
      proposal_id: reviewed.proposal.proposal_id,
      request: {
        schema_version: "1.0",
        proposal_digest: reviewed.proposal.proposal_digest,
        approval_id: reviewed.approval.approval_id,
      },
      authority: reviewed.authority,
    });
    const outcome = committing.then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    );
    await within(prepared.promise, "prepared-dispatch barrier");
    const other = bootstrapAt(fx.root, [], {
      actionDomainFactories: [
        (actions) => capability.conversationActionDomain(actions, { recover_on_bootstrap: false }),
      ],
    });
    await within(
      commitBrowserHeadMove(other, created.conversation_id, "capability-pre-claim-winner"),
      "pre-claim head writer",
    );
    resume.resolve();
    const rejected = await within(outcome, "stale capability commit");
    expect(rejected.error).toBeInstanceOf(Error);
    expect((rejected.error as Error).message).toMatch(/stale|authority changed/i);
    const action = fx.bootstrap.authorities.homeAuthorities.actions.authority.get(
      reviewed.proposal.proposal_id,
    );
    expect(action?.state).toBe("stale");
    const operationId = deriveOperationId(reviewed.proposal, reviewed.approval.approval_id);
    expect(
      existsSync(
        capabilityOperationPaths(capability.service("user").options.storage.paths, operationId)
          .header,
      ),
    ).toBeTrue();
    expect(capability.service("user").options.storage.readStatus().lock?.packages ?? []).toEqual(
      [],
    );
    expect(
      fx.bootstrap.authorities.homeAuthorities.actions.capabilityDispatches.current(
        fx.bootstrap.authorities.browser.rootSessionId(created.conversation_id) as string,
      ),
    ).toBeNull();
  }, 20_000);

  test("blocks every lineage writer while a capability effect claim is active", async () => {
    const reserved = deferred();
    const resume = deferred();
    const { capability, fx, pkg } = capabilityInstallFixture(1, (install) => install, {
      barrier: async ({ point }) => {
        if (point !== "after-dispatch-reserved") return;
        reserved.resolve();
        await resume.promise;
      },
    });
    const created = await fx.bootstrap.service.create({
      topic: "Hold the exact capability lineage claim while another writer races.",
      policy: "direct",
      participants: [directParticipant()],
    });
    const reviewed = await approvePendingCapability(
      fx,
      created.conversation_id,
      "capability-active-claim",
    );
    const committing = fx.bootstrap.authorities.browser.actions.commit({
      conversation_id: created.conversation_id,
      proposal_id: reviewed.proposal.proposal_id,
      request: {
        schema_version: "1.0",
        proposal_digest: reviewed.proposal.proposal_digest,
        approval_id: reviewed.approval.approval_id,
      },
      authority: reviewed.authority,
    });
    await within(reserved.promise, "active-claim barrier");
    const other = bootstrapAt(fx.root, [], {
      actionDomainFactories: [
        (actions) => capability.conversationActionDomain(actions, { recover_on_bootstrap: false }),
      ],
    });
    const base = resolveRevisionBase({
      artifactRoot: join(fx.root, "conversation-state", "artifacts"),
      traceRoot: join(fx.root, "conversation-state", "trace"),
      conversationId: created.conversation_id,
      home: other.bootstrap.authorities.homeAuthorities,
    });
    expect(() =>
      other.bootstrap.authorities.homeAuthorities.lineage.commitReservation(
        null,
        activeRevisionReservation(
          base.lineage.root_session_id,
          base.parent.node,
          "capability-active-claim-direct-reservation",
        ),
      ),
    ).toThrow(/active capability dispatch/i);
    const blocked = await within(
      commitBrowserHeadMove(other, created.conversation_id, "capability-active-claim-loser").then(
        () => ({ error: null }),
        (error: unknown) => ({ error }),
      ),
      "blocked lineage writer",
    );
    expect(blocked.error).toBeInstanceOf(Error);
    expect((blocked.error as Error).message).toMatch(
      /active capability dispatch|owns the lineage/i,
    );
    resume.resolve();
    await within(committing, "claimed capability commit");
    expect(
      capability
        .service("user")
        .options.storage.readStatus()
        .lock?.packages.map((row) => row.package_id),
    ).toContain(pkg.pin.id);
    const rootSessionId = fx.bootstrap.authorities.browser.rootSessionId(created.conversation_id);
    expect(
      fx.bootstrap.authorities.homeAuthorities.actions.capabilityDispatches.current(
        rootSessionId as string,
      )?.status,
    ).toBe("released");
    await commitBrowserHeadMove(other, created.conversation_id, "capability-after-release");
  }, 20_000);

  test("blocks reviewed literal and compaction trace writers from a second bootstrap while capability effects own the lineage", async () => {
    const reserved = deferred();
    const resume = deferred();
    const { capability, fx, install, pkg } = capabilityInstallFixture(
      1,
      () => ({ type: "not-a-host-action" }),
      {
        barrier: async ({ point }) => {
          if (point !== "after-dispatch-reserved") return;
          reserved.resolve();
          await resume.promise;
        },
      },
    );
    const created = await fx.bootstrap.service.create({
      topic: "Hold capability authority while reviewed trace mutations race.",
      policy: "direct",
      participants: [directParticipant()],
    });
    const seed = await approvePublicLiteral(
      fx,
      created.conversation_id,
      "capability-trace-mutation-seed",
      `token=${"x".repeat(12_000)}`,
    );
    await fx.bootstrap.authorities.browser.actions.commit({
      conversation_id: created.conversation_id,
      proposal_id: seed.proposal.proposal_id,
      request: {
        schema_version: "1.0",
        proposal_digest: seed.proposal.proposal_digest,
        approval_id: seed.approval.approval_id,
      },
      authority: seed.authority,
    });
    const reviewed = await approveBrowserCapability(
      fx,
      created.conversation_id,
      "capability-trace-mutation-fence",
      install,
    );
    const literal = await approvePublicLiteral(
      fx,
      created.conversation_id,
      "capability-trace-mutation-fence",
    );
    const compaction = await approveContextCompaction(
      fx,
      created.conversation_id,
      "capability-trace-mutation-fence",
    );
    const beforeTrace = await fx.bootstrap.authorities.traceStore.readConversation(
      created.conversation_id,
    );
    const beforeArtifacts = fx.bootstrap.authorities.artifactStore.readRecord(
      created.conversation_id,
    );
    const beforeLiteralFrames = fx.bootstrap.authorities.homeAuthorities.literalStaging.readFrames(
      literal.binding.private_staging_id,
    );
    const committing = fx.bootstrap.authorities.browser.actions.commit({
      conversation_id: created.conversation_id,
      proposal_id: reviewed.proposal.proposal_id,
      request: {
        schema_version: "1.0",
        proposal_digest: reviewed.proposal.proposal_digest,
        approval_id: reviewed.approval.approval_id,
      },
      authority: reviewed.authority,
    });
    await within(reserved.promise, "active capability trace-mutation barrier");
    const other = bootstrapAt(fx.root, [], {
      actionDomainFactories: [
        (actions) => capability.conversationActionDomain(actions, { recover_on_bootstrap: false }),
      ],
    });
    const blockedLiteral = await within(
      other.bootstrap.authorities.browser.actions
        .commit({
          conversation_id: created.conversation_id,
          proposal_id: literal.proposal.proposal_id,
          request: {
            schema_version: "1.0",
            proposal_digest: literal.proposal.proposal_digest,
            approval_id: literal.approval.approval_id,
          },
          authority: literal.authority,
        })
        .then(
          () => ({ error: null }),
          (error: unknown) => ({ error }),
        ),
      "blocked public literal writer",
    );
    const blockedCompaction = await within(
      other.bootstrap.authorities.browser.actions
        .commit({
          conversation_id: created.conversation_id,
          proposal_id: compaction.proposal.proposal_id,
          request: {
            schema_version: "1.0",
            proposal_digest: compaction.proposal.proposal_digest,
            approval_id: compaction.approval.approval_id,
          },
          authority: compaction.authority,
        })
        .then(
          () => ({ error: null }),
          (error: unknown) => ({ error }),
        ),
      "blocked context compaction writer",
    );
    expect(blockedLiteral.error).toBeInstanceOf(Error);
    expect((blockedLiteral.error as Error).message).toMatch(/active capability dispatch/i);
    expect(blockedCompaction.error).toBeInstanceOf(Error);
    expect((blockedCompaction.error as Error).message).toMatch(/active capability dispatch/i);
    expect(
      await other.bootstrap.authorities.traceStore.readConversation(created.conversation_id),
    ).toEqual(beforeTrace);
    expect(other.bootstrap.authorities.artifactStore.readRecord(created.conversation_id)).toEqual(
      beforeArtifacts,
    );
    expect(
      other.bootstrap.authorities.homeAuthorities.literalStaging.readFrames(
        literal.binding.private_staging_id,
      ),
    ).toEqual(beforeLiteralFrames);
    expect(
      other.bootstrap.authorities.homeAuthorities.actions.authority.get(
        literal.proposal.proposal_id,
      )?.state,
    ).toBe("approved");
    expect(
      other.bootstrap.authorities.homeAuthorities.actions.authority.get(
        compaction.proposal.proposal_id,
      )?.state,
    ).toBe("approved");
    resume.resolve();
    await within(committing, "capability commit after trace writers were refused");
    expect(
      capability
        .service("user")
        .options.storage.readStatus()
        .lock?.packages.map((row) => row.package_id),
    ).toContain(pkg.pin.id);
  }, 30_000);

  test("releases only the exact reviewed literal cancellation after process restart", async () => {
    const fx = bootstrapFixture(["ordinary response"]);
    const created = await fx.bootstrap.service.create({
      topic: "Recover a reviewed literal cancellation without releasing a newer owner.",
      policy: "direct",
      participants: [directParticipant()],
    });
    const first = await approvePublicLiteral(
      fx,
      created.conversation_id,
      "canceled-literal-owner-a",
    );
    const claimed = claimApprovedLineageMutation(
      fx,
      created.conversation_id,
      first.proposal.proposal_id,
      "public-literal",
    );
    expect(claimed.reservation.status).toBe("active");

    const restarted = bootstrapAt(fx.root, []);
    await restarted.bootstrap.authorities.browser.actions.awaitRecovery();
    expect(
      restarted.bootstrap.authorities.homeAuthorities.lineageMutations.current(
        claimed.reservation.root_session_id,
      ),
    ).toEqual(claimed.reservation);
    const canceledView = await restarted.bootstrap.authorities.browser.actions.cancel({
      conversation_id: created.conversation_id,
      proposal_id: first.proposal.proposal_id,
      request: {
        schema_version: "1.0",
        proposal_digest: first.proposal.proposal_digest,
        reason: "reviewed literal was canceled after process loss",
      },
      authority: first.authority,
    });
    expect(canceledView.operation.state).toBe("canceled");
    const canceled = restarted.bootstrap.authorities.homeAuthorities.actions.authority.get(
      first.proposal.proposal_id,
    );
    const cancellation = canceled?.events.at(-1);
    if (!canceled || !cancellation) throw new Error("literal cancellation authority is absent");
    expect(
      restarted.bootstrap.authorities.homeAuthorities.lineageMutations.current(
        claimed.reservation.root_session_id,
      ),
    ).toMatchObject({
      status: "released",
      proposal_id: first.proposal.proposal_id,
      release_outcome: "aborted",
      terminal_digest: cancellation.event_digest,
      updated_at: cancellation.recorded_at,
    });

    const second = await approvePublicLiteral(
      restarted,
      created.conversation_id,
      "newer-literal-owner-b",
    );
    const newer = claimApprovedLineageMutation(
      restarted,
      created.conversation_id,
      second.proposal.proposal_id,
      "public-literal",
    ).reservation;
    const beforeReplay = canonicalJsonBytes(newer);
    expect(
      restarted.bootstrap.authorities.homeAuthorities.lineageMutations.releaseCanceled(canceled),
    ).toBeNull();
    const afterReplay = restarted.bootstrap.authorities.homeAuthorities.lineageMutations.current(
      newer.root_session_id,
    );
    expect(afterReplay && canonicalJsonBytes(afterReplay)).toEqual(beforeReplay);

    await restarted.bootstrap.authorities.browser.actions.cancel({
      conversation_id: created.conversation_id,
      proposal_id: second.proposal.proposal_id,
      request: {
        schema_version: "1.0",
        proposal_digest: second.proposal.proposal_digest,
        reason: "release the exact newer owner",
      },
      authority: second.authority,
    });
    await commitBrowserHeadMove(restarted, created.conversation_id, "after-literal-cancel-release");
  }, 20_000);

  test("recovers a reviewed compaction canceled durably before its mutation release", async () => {
    const fx = bootstrapFixture(["ordinary response"]);
    const created = await fx.bootstrap.service.create({
      topic: "Recover a compaction cancellation across the cancel-to-release crash window.",
      policy: "direct",
      participants: [directParticipant()],
    });
    const seed = await approvePublicLiteral(
      fx,
      created.conversation_id,
      "compaction-cancel-recovery-seed",
      `token=${"x".repeat(12_000)}`,
    );
    await fx.bootstrap.authorities.browser.actions.commit({
      conversation_id: created.conversation_id,
      proposal_id: seed.proposal.proposal_id,
      request: {
        schema_version: "1.0",
        proposal_digest: seed.proposal.proposal_digest,
        approval_id: seed.approval.approval_id,
      },
      authority: seed.authority,
    });
    const compaction = await approveContextCompaction(
      fx,
      created.conversation_id,
      "cancel-recovery",
    );
    const claimed = claimApprovedLineageMutation(
      fx,
      created.conversation_id,
      compaction.proposal.proposal_id,
      "context-compaction",
    ).reservation;

    const cancelingProcess = bootstrapAt(fx.root, []);
    await cancelingProcess.bootstrap.authorities.browser.actions.awaitRecovery();
    expect(
      cancelingProcess.bootstrap.authorities.homeAuthorities.lineageMutations.current(
        claimed.root_session_id,
      ),
    ).toEqual(claimed);
    cancelingProcess.bootstrap.authorities.homeAuthorities.actions.cancel({
      proposal_id: compaction.proposal.proposal_id,
      proposal_digest: compaction.proposal.proposal_digest,
      authority: compaction.authority,
      reason: "crash after durable compaction cancellation",
    });
    const canceled = cancelingProcess.bootstrap.authorities.homeAuthorities.actions.authority.get(
      compaction.proposal.proposal_id,
    );
    const cancellation = canceled?.events.at(-1);
    if (!canceled || !cancellation) throw new Error("compaction cancellation authority is absent");
    expect(
      cancelingProcess.bootstrap.authorities.homeAuthorities.lineageMutations.current(
        claimed.root_session_id,
      ),
    ).toEqual(claimed);

    const recovered = bootstrapAt(fx.root, []);
    await recovered.bootstrap.authorities.browser.actions.awaitRecovery();
    expect(
      recovered.bootstrap.authorities.homeAuthorities.lineageMutations.current(
        claimed.root_session_id,
      ),
    ).toMatchObject({
      status: "released",
      proposal_id: compaction.proposal.proposal_id,
      release_outcome: "aborted",
      terminal_digest: cancellation.event_digest,
      updated_at: cancellation.recorded_at,
    });
    await commitBrowserHeadMove(
      recovered,
      created.conversation_id,
      "after-compaction-cancel-recovery",
    );
  }, 20_000);

  test("re-resolves the capability source after a reviewed literal writer wins first", async () => {
    const { capability, fx } = capabilityInstallFixture();
    const created = await fx.bootstrap.service.create({
      topic: "Let the reviewed public writer win before capability reservation.",
      policy: "direct",
      participants: [directParticipant()],
    });
    const reviewed = await approvePendingCapability(
      fx,
      created.conversation_id,
      "literal-wins-capability-race",
    );
    const literal = await approvePublicLiteral(
      fx,
      created.conversation_id,
      "literal-wins-capability-race",
    );
    const other = bootstrapAt(fx.root, [], {
      actionDomainFactories: [
        (actions) => capability.conversationActionDomain(actions, { recover_on_bootstrap: false }),
      ],
    });
    const literalCommit = await other.bootstrap.authorities.browser.actions.commit({
      conversation_id: created.conversation_id,
      proposal_id: literal.proposal.proposal_id,
      request: {
        schema_version: "1.0",
        proposal_digest: literal.proposal.proposal_digest,
        approval_id: literal.approval.approval_id,
      },
      authority: literal.authority,
    });
    expect(literalCommit.operation.state).toBe("succeeded");
    expect(
      other.bootstrap.authorities.homeAuthorities.lineageMutations.current(
        currentRevisionBase(other, created.conversation_id).lineage.root_session_id,
      ),
    ).toMatchObject({
      status: "released",
      proposal_id: literal.proposal.proposal_id,
      release_outcome: "succeeded",
    });
    await expect(
      fx.bootstrap.authorities.browser.actions.commit({
        conversation_id: created.conversation_id,
        proposal_id: reviewed.proposal.proposal_id,
        request: {
          schema_version: "1.0",
          proposal_digest: reviewed.proposal.proposal_digest,
          approval_id: reviewed.approval.approval_id,
        },
        authority: reviewed.authority,
      }),
    ).rejects.toThrow(/stale|authority changed/i);
    expect(
      fx.bootstrap.authorities.homeAuthorities.actions.authority.get(reviewed.proposal.proposal_id)
        ?.state,
    ).toBe("stale");
    expect(capability.service("user").options.storage.readStatus().lock?.packages ?? []).toEqual(
      [],
    );
  }, 20_000);

  test("does not claim capability effects while an active revision owns the lineage", async () => {
    const prepared = deferred();
    const resume = deferred();
    const { capability, fx } = capabilityInstallFixture(1, (install) => install, {
      barrier: async ({ point }) => {
        if (point !== "after-dispatch-prepared") return;
        prepared.resolve();
        await resume.promise;
      },
    });
    const created = await fx.bootstrap.service.create({
      topic: "Keep a prepared capability dispatch behind the active revision reservation.",
      policy: "direct",
      participants: [directParticipant()],
    });
    const reviewed = await approvePendingCapability(
      fx,
      created.conversation_id,
      "revision-reservation-wins",
    );
    const committing = fx.bootstrap.authorities.browser.actions.commit({
      conversation_id: created.conversation_id,
      proposal_id: reviewed.proposal.proposal_id,
      request: {
        schema_version: "1.0",
        proposal_digest: reviewed.proposal.proposal_digest,
        approval_id: reviewed.approval.approval_id,
      },
      authority: reviewed.authority,
    });
    const outcome = committing.then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    );
    await within(prepared.promise, "prepared capability dispatch");
    const base = resolveRevisionBase({
      artifactRoot: join(fx.root, "conversation-state", "artifacts"),
      traceRoot: join(fx.root, "conversation-state", "trace"),
      conversationId: created.conversation_id,
      home: fx.bootstrap.authorities.homeAuthorities,
    });
    const revision = activeRevisionReservation(
      base.lineage.root_session_id,
      base.parent.node,
      "active-revision-before-capability-claim",
    );
    fx.bootstrap.authorities.homeAuthorities.lineage.commitReservation(null, revision);
    const snapshot = fx.bootstrap.authorities.homeAuthorities.actions.authority.get(
      reviewed.proposal.proposal_id,
    );
    const dispatch = fx.bootstrap.authorities.homeAuthorities.actions.authority.getDispatch(
      deriveOperationId(reviewed.proposal, reviewed.approval.approval_id),
    );
    const producerParticipantId = snapshot?.proposal.requested_by.public_actor_id;
    if (
      !snapshot ||
      !dispatch ||
      !snapshot.approval ||
      snapshot.proposal.requested_by.kind !== "agent" ||
      !producerParticipantId ||
      !snapshot.proposal.base.root_session_id ||
      !snapshot.proposal.base.conversation_id ||
      !snapshot.proposal.base.revision_id ||
      snapshot.proposal.base.last_seq === null ||
      !snapshot.proposal.base.conversation_lock_digest ||
      !snapshot.proposal.base.lineage_head_digest ||
      snapshot.proposal.base.lineage_head_epoch === null
    )
      throw new Error("prepared capability claim fixture is incomplete");
    const approval = snapshot.approval;
    expect(() =>
      fx.bootstrap.authorities.homeAuthorities.actions.capabilityDispatches.claim({
        proposal: snapshot.proposal,
        approval,
        dispatch,
        now: NOW,
        resolveSource: () => ({
          root_session_id: snapshot.proposal.base.root_session_id as string,
          conversation_id: snapshot.proposal.base.conversation_id as string,
          revision_id: snapshot.proposal.base.revision_id as string,
          last_seq: snapshot.proposal.base.last_seq as number,
          conversation_lock_digest: snapshot.proposal.base.conversation_lock_digest as string,
          lineage_head_digest: snapshot.proposal.base.lineage_head_digest as string,
          lineage_head_epoch: snapshot.proposal.base.lineage_head_epoch as number,
          participant_binding_set_digest: digestV1(
            "VF-CONVERSATION-PARTICIPANT-BINDING-SET\0v1\0",
            base.parent.source.manifest.bindings,
          ),
          target_set_digest: digestV1("VF-ACTION-TARGET-SET\0v1\0", snapshot.proposal.target_set),
          producer_participant_id: producerParticipantId,
          producer_request_binding_digest: snapshot.proposal.producer_request_binding.digest,
          producer_host_tool_grant_digest: proposeActionGrantDigest({
            conversationId: snapshot.proposal.base.conversation_id as string,
            revisionId: snapshot.proposal.base.revision_id as string,
            participantId: producerParticipantId,
          }),
          capability_grant_digest: snapshot.proposal.grant_digest,
        }),
      }),
    ).toThrow(/revision dispatch already owns/i);
    resume.resolve();

    const rejected = await within(outcome, "revision-owned capability rejection");
    expect(rejected.error).toBeInstanceOf(Error);
    expect((rejected.error as Error).message).toMatch(/authority changed/i);
    expect(
      fx.bootstrap.authorities.homeAuthorities.actions.authority.get(reviewed.proposal.proposal_id)
        ?.state,
    ).toBe("stale");
    expect(
      fx.bootstrap.authorities.homeAuthorities.actions.capabilityDispatches.current(
        base.lineage.root_session_id,
      ),
    ).toBeNull();
    expect(
      fx.bootstrap.authorities.homeAuthorities.lineage.readReservation(
        base.lineage.root_session_id,
      ),
    ).toEqual(revision);
    expect(capability.service("user").options.storage.readStatus().lock?.packages ?? []).toEqual(
      [],
    );
  }, 20_000);

  test("durably discards a staged participant candidate when the debate turn fails", async () => {
    const validAssessment = JSON.stringify({
      agreement: { value: true, evidence: "yes" },
      conflict_resolution: { value: true, evidence: "yes" },
      evidence_quality: { value: true, evidence: "yes" },
      convergence: { value: "not_applicable", evidence: "first round" },
    });
    const fx = bootstrapFixture([
      JSON.stringify({ answer: "baseline" }),
      JSON.stringify({
        answer: "Option A",
        content: "Option A evidence",
        claim: "Option A",
        evidence: ["evidence-a"],
        propose_action: { schema_version: "1.0", candidate: addParticipant },
      }),
      JSON.stringify({
        answer: "Option B",
        content: "Option B evidence",
        claim: "Option B",
        evidence: ["evidence-b"],
      }),
      validAssessment,
      "malformed full evaluator output",
    ]);
    const created = await fx.bootstrap.service.create({
      topic: "A participant may propose, but the terminal must still succeed.",
      policy: "debate",
      max_rounds: 1,
      participants: [
        { role_ref: "responder-a", engine: "codex" },
        { role_ref: "responder-b", engine: "codex" },
      ],
    });
    expect(created.result.status).toBe("failed");
    expect(await fx.bootstrap.authorities.browser.actions.pending(created.conversation_id)).toEqual(
      [],
    );
    expect(
      await fx.bootstrap.authorities.agentActionCandidates.materializations(
        created.conversation_id,
      ),
    ).toMatchObject([
      { state: "rejected", proposal: null, rejection_code: "terminal_not_completed" },
    ]);
  });

  test("never advertises or accepts the host tool for baseline/evaluator attempts", async () => {
    expect(
      materializeConversationHostTools({
        roleRef: "brainstorm-evaluator",
        explicit: ["propose_action"],
      }),
    ).toEqual([]);
    const assessmentWithCandidate = JSON.stringify({
      agreement: { value: true, evidence: "yes" },
      conflict_resolution: { value: true, evidence: "yes" },
      evidence_quality: { value: true, evidence: "yes" },
      convergence: { value: "not_applicable", evidence: "first round" },
      propose_action: { schema_version: "1.0", candidate: addParticipant },
    });
    const fx = bootstrapFixture([
      actionOutput(addParticipant, "baseline must stay isolated"),
      JSON.stringify({
        answer: "Option A",
        content: "Option A evidence",
        claim: "Option A",
        evidence: ["evidence-a"],
      }),
      JSON.stringify({
        answer: "Option B",
        content: "Option B evidence",
        claim: "Option B",
        evidence: ["evidence-b"],
      }),
      assessmentWithCandidate,
    ]);
    const created = await fx.bootstrap.service.create({
      topic: "Compare two options.",
      policy: "debate",
      max_rounds: 1,
      participants: [
        { role_ref: "responder-a", engine: "codex" },
        { role_ref: "responder-b", engine: "codex" },
      ],
    });
    expect(created.result.status).toBe("failed");
    expect(fx.prompts).toHaveLength(4);
    expect(fx.prompts[0]).not.toContain("propose_action");
    expect(fx.prompts[1]).toContain("propose_action");
    expect(fx.prompts[2]).toContain("propose_action");
    expect(fx.prompts[3]).not.toContain("propose_action");
    const manifest = fx.bootstrap.authorities.artifactStore.read(created.conversation_id);
    expect(manifest?.bindings.map((row) => row.host_tools)).toEqual([
      ["propose_action"],
      ["propose_action"],
      [],
    ]);
    if (!manifest?.bindings[0]) throw new Error("evaluator role-change fixture is absent");
    const evaluatorRevision = applyConversationRevisionMutation({
      parent: manifest,
      action: {
        type: "conversation.update_participant",
        participant_id: manifest.bindings[0].participant_id,
        changes: { role_ref: "brainstorm-evaluator" },
      },
      idempotencyKey: "evaluator-role-change",
    });
    expect(evaluatorRevision.bindings[0]?.host_tools).toEqual([]);
    expect(await fx.bootstrap.authorities.browser.actions.pending(created.conversation_id)).toEqual(
      [],
    );
  });
});
