import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionAuthorityStore,
  actionIdempotencyScopeDigest,
  createDurableActionAuthorityReaderV1,
} from "../../src/actions/index.js";
import {
  CapabilityRuntimeFactoryV1,
  activateProjectCapabilityAuthorityForVfInit,
  productionCapabilityRuntimeV1,
} from "../../src/capabilities/index.js";
import { capabilityClosurePackageSet } from "../../src/capabilities/planning/closure-packages.js";
import { digestHex, digestV1 } from "../../src/durability/index.js";
import { ConversationActionReceiptStore } from "../../src/orchestrator/conversation/conversation-action-receipt-store.js";
import { ConversationActionDomainRegistryV1 } from "../../src/orchestrator/conversation/conversation-action-registry.js";
import { ConversationActionService } from "../../src/orchestrator/conversation/conversation-action-service.js";
import { ConversationRevisionStore } from "../../src/orchestrator/conversation/revision-store.js";
import { startServer } from "../../src/server.js";
import { resolvedRolePackage, retainRuntimePackageCache } from "./runtime-fixtures.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const now = () => "2026-08-25T12:00:00.000Z";
const conversation = {
  root_session_id: "root-capability-action",
  conversation_id: "conversation-capability-action",
  revision_id: "revision-capability-action",
  last_seq: 4,
  conversation_lock_digest: digestV1("VF-TEST-CONVERSATION-LOCK\0v1\0", 1),
  lineage_head_digest: digestV1("VF-TEST-LINEAGE-HEAD\0v1\0", 1),
  lineage_head_epoch: 2,
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vf-capability-action-domain-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  const homeRoot = join(root, "home");
  const userVibeflowRoot = join(homeRoot, ".vibeflow");
  const artifactRoot = join(root, "conversation-artifacts");
  mkdirSync(join(projectRoot, ".vibeflow"), { recursive: true });
  mkdirSync(userVibeflowRoot, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(projectRoot, ".vibeflow", "SETTINGS.json"),
    JSON.stringify({ schema_version: "1.0", authority: null }),
  );
  activateProjectCapabilityAuthorityForVfInit(projectRoot, { now });
  const runtimeOptions = {
    projectRoot,
    userHomeRoot: homeRoot,
    userVibeflowRoot,
    now,
    vfVersion: "0.15.0",
    engineVersions: { codex: "1.0.0" },
  } as const;
  const runtime = productionCapabilityRuntimeV1(runtimeOptions);
  const service = runtime.service("project");
  const pkg = resolvedRolePackage();
  retainRuntimePackageCache(service.options.storage, pkg);
  const makeActions = () => {
    const actions = new ConversationActionService(
      artifactRoot,
      now,
      new ConversationRevisionStore({ artifactRoot }),
      new ConversationActionReceiptStore(artifactRoot),
    );
    actions.registerCapabilityActionRootResolver((conversationId) => {
      if (conversationId !== conversation.conversation_id) throw new Error("unknown conversation");
      return { root_session_id: conversation.root_session_id };
    });
    actions.registerCapabilityProposalBaseResolver(({ conversation_id, expected }) => {
      if (
        conversation_id !== conversation.conversation_id ||
        expected.conversation_id !== conversation.conversation_id ||
        expected.revision_id !== conversation.revision_id ||
        expected.last_seq !== conversation.last_seq ||
        expected.conversation_lock_digest !== conversation.conversation_lock_digest
      )
        throw new Error("stale conversation source");
      return structuredClone(conversation);
    });
    return actions;
  };
  const locator = { kind: "conversation" as const, root_session_id: conversation.root_session_id };
  const authority = {
    schema_version: "1.0" as const,
    principal_digest: digestV1("VF-TEST-PRINCIPAL\0v1\0", "browser"),
    authority_scope_digest: actionIdempotencyScopeDigest(locator),
    control_session_digest: digestV1("VF-TEST-CONTROL-SESSION\0v1\0", 1),
    csrf_epoch_digest: digestV1("VF-TEST-CSRF\0v1\0", 1),
    actor: {
      kind: "human-browser" as const,
      public_actor_id: "browser-test",
      credential_class: "loopback-session" as const,
    },
  };
  const request = {
    schema_version: "1.0" as const,
    idempotency_key: "install-reviewer",
    anchor_event_id: "event-capability-request",
    expected: {
      mode: "writable-revision" as const,
      conversation_id: conversation.conversation_id,
      revision_id: conversation.revision_id,
      last_seq: conversation.last_seq,
      conversation_lock_digest: conversation.conversation_lock_digest,
    },
    candidate: {
      type: "capability.install" as const,
      package: {
        id: pkg.pin.id,
        version: pkg.pin.version,
        source_kind: pkg.pin.source.kind,
        content_sha256: pkg.pin.content_sha256,
        package_pin_digest: pkg.pin.pin_digest,
      },
      scope: "project" as const,
      requested_targets: [{ engine: "codex" as const, participant_id: null }],
      inputs: [],
    },
  };
  return {
    root,
    projectRoot,
    artifactRoot,
    runtime,
    runtimeOptions,
    service,
    makeActions,
    authority,
    request,
  };
}

describe("conversation Capability action domain", () => {
  test("collapses only byte-identical packages in the desired/effect closure union", () => {
    const pkg = resolvedRolePackage();
    expect(capabilityClosurePackageSet([pkg], [pkg])).toEqual([pkg]);
    expect(() =>
      capabilityClosurePackageSet(
        [pkg],
        [
          {
            ...pkg,
            private_input_binding_digest: digestV1("VF-TEST-OTHER-PRIVATE-INPUT\0v1\0", 1),
          },
        ],
      ),
    ).toThrow(/conflicting package identities/);
  });

  test("rejects an expired retained source authority before execution", () => {
    const fx = fixture();
    const actions = fx.makeActions();
    const locator = {
      kind: "conversation" as const,
      root_session_id: conversation.root_session_id,
    };
    fx.runtime.bindActionAuthority(locator, actions.authority.reader);
    const graph = fx.service.prepareIntentGraph({
      schema_version: "1.0",
      action: fx.request.candidate,
      planning_options: { mode: "durable", network_read: "ordinary-host-policy" },
      action_root_locator: locator,
      request_authority: fx.authority,
    });
    const sourceAuthority = fx.service.options.sourceAuthority;
    if (!sourceAuthority) throw new Error("production source authority is absent");
    expect(() => sourceAuthority.readSourceAuthoritySet(graph, "2026-08-25T12:05:00.000Z")).toThrow(
      /source authority cache or trust head changed/,
    );
  });

  test("issues, replays, proposes, and commits one scanner-owned legacy adoption", async () => {
    const fx = fixture();
    const skill = Buffer.from("---\nname: managed-reviewer\n---\n");
    mkdirSync(join(fx.root, "home", ".vibeflow", "skills", "managed-reviewer"), {
      recursive: true,
    });
    mkdirSync(join(fx.projectRoot, ".claude", "skills", "managed-reviewer"), {
      recursive: true,
    });
    writeFileSync(
      join(fx.root, "home", ".vibeflow", "skills", "managed-reviewer", "SKILL.md"),
      skill,
    );
    writeFileSync(join(fx.projectRoot, ".claude", "skills", "managed-reviewer", "SKILL.md"), skill);
    writeFileSync(
      join(fx.projectRoot, ".vibeflow", "SKILL_REGISTRY.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "verified",
            url: "https://example.com/skills.git",
            ref: "main",
            commitOID: "a".repeat(40),
            installed: [
              {
                name: "managed-reviewer",
                version: "1.0.0",
                commitOID: "b".repeat(40),
              },
            ],
          },
        ],
      }),
    );
    const actions = fx.makeActions();
    const domain = fx.runtime.conversationActionDomain(actions);
    const inspectionRequest = {
      schema_version: "1.0" as const,
      idempotency_key: "inspect-managed-mcp",
      scope: "project" as const,
      legacy_sources: ["skill-lock" as const],
    };
    const issued = domain.inspectAdoptCandidates({
      conversation_id: conversation.conversation_id,
      request: inspectionRequest,
      authority: fx.authority,
    });
    expect(issued.created).toBeTrue();
    expect(issued.response.candidates).toHaveLength(1);
    const publicCandidate = issued.response.candidates[0];
    if (!publicCandidate) throw new Error("legacy inspection returned no candidate");
    expect(
      existsSync(
        join(
          fx.artifactRoot,
          "actions/v1/legacy-adopt-candidates",
          `${publicCandidate.candidate_id}.json`,
        ),
      ),
    ).toBeTrue();
    expect(
      domain.inspectAdoptCandidates({
        conversation_id: conversation.conversation_id,
        request: inspectionRequest,
        authority: fx.authority,
      }),
    ).toEqual({ created: false, response: issued.response });
    expect(() =>
      domain.inspectAdoptCandidates({
        conversation_id: conversation.conversation_id,
        request: { ...inspectionRequest, legacy_sources: ["mcp-managed-sidecar"] },
        authority: fx.authority,
      }),
    ).toThrow(/idempotency/i);

    const proposed = await domain.propose({
      conversation_id: conversation.conversation_id,
      request: {
        ...fx.request,
        idempotency_key: "adopt-managed-mcp",
        candidate: {
          type: "capability.adopt",
          scope: "project",
          candidate_id: publicCandidate.candidate_id,
          candidate_digest: publicCandidate.candidate_digest,
        },
      },
      authority: fx.authority,
    });
    const approved = await domain.approve({
      conversation_id: conversation.conversation_id,
      proposal_id: proposed.response.proposal.proposal_id,
      request: {
        schema_version: "1.0",
        proposal_digest: proposed.response.proposal.proposal_digest,
        decision: "approved",
        challenge_id: null,
        challenge_response: null,
      },
      authority: fx.authority,
    });
    const before = readFileSync(
      join(fx.projectRoot, ".claude", "skills", "managed-reviewer", "SKILL.md"),
    );
    const committed = await domain.commit({
      conversation_id: conversation.conversation_id,
      proposal_id: proposed.response.proposal.proposal_id,
      request: {
        schema_version: "1.0",
        proposal_digest: proposed.response.proposal.proposal_digest,
        approval_id: approved.approval.approval_id,
      },
      authority: fx.authority,
    });
    expect(committed.operation.state).toBe("succeeded");
    expect(
      readFileSync(join(fx.projectRoot, ".claude", "skills", "managed-reviewer", "SKILL.md")),
    ).toEqual(before);
    expect(fx.service.options.storage.readStatus().lock?.packages[0]?.pin.source.kind).toBe(
      "legacy-adopt",
    );
  });

  test("restarts through one conversation Action Authority and projects the real Capability WAL", async () => {
    const fx = fixture();
    const firstActions = fx.makeActions();
    const first = fx.runtime.conversationActionDomain(firstActions);
    const proposed = await first.propose({
      conversation_id: conversation.conversation_id,
      request: fx.request,
      authority: fx.authority,
    });
    expect(proposed.created).toBeTrue();
    const proposalId = proposed.response.proposal.proposal_id;
    const snapshot = firstActions.authority.get(proposalId);
    if (!snapshot) throw new Error("proposal missing");
    const graph = first.objects.readGraph(snapshot.proposal);
    expect(
      existsSync(
        join(fx.artifactRoot, "actions/v1/objects", `${digestHex(graph.plan.plan_digest)}.json`),
      ),
    ).toBeFalse();
    expect(existsSync(join(fx.artifactRoot, "actions/v1/capability-proposals"))).toBeFalse();
    const approved = await first.approve({
      conversation_id: conversation.conversation_id,
      proposal_id: proposalId,
      request: {
        schema_version: "1.0",
        proposal_digest: proposed.response.proposal.proposal_digest,
        decision: "approved",
        challenge_id: null,
        challenge_response: null,
      },
      authority: fx.authority,
    });
    const restartedActions = fx.makeActions();
    const restarted = new CapabilityRuntimeFactoryV1(fx.runtimeOptions).conversationActionDomain(
      restartedActions,
    );
    expect(await restarted.pending(conversation.conversation_id)).toEqual([
      expect.objectContaining({
        proposal: expect.objectContaining({ proposal_id: proposalId }),
        operation: expect.objectContaining({ state: "approved" }),
      }),
    ]);
    const committed = await restarted.commit({
      conversation_id: conversation.conversation_id,
      proposal_id: proposalId,
      request: {
        schema_version: "1.0",
        proposal_digest: proposed.response.proposal.proposal_digest,
        approval_id: approved.approval.approval_id,
      },
      authority: fx.authority,
    });
    expect(committed.operation.state).toBe("succeeded");
    expect(await restarted.pending(conversation.conversation_id)).toEqual([]);
    expect(committed.operation.targets).toHaveLength(1);
    expect(committed.operation.targets[0]?.outcome).toBe("applied");
    expect(
      readFileSync(join(fx.projectRoot, ".codex/agents/acme.reviewer--reviewer.toml"), "utf8"),
    ).toContain("Capability role acme.reviewer--reviewer");
    const events = await restarted.events(conversation.conversation_id, proposalId);
    expect(events?.map((event) => event.progress?.phase)).toEqual([
      "operation-started",
      "target-applied",
      "operation-succeeded",
    ]);
    expect(await restarted.get(conversation.conversation_id, proposalId)).toEqual({
      schema_version: "1.0",
      proposal: expect.any(Object),
      approval: expect.any(Object),
      operation: committed.operation,
    });
  });

  test("rejects a conversation locator bound to another physical action root", () => {
    const fx = fixture();
    const locator = {
      kind: "conversation" as const,
      root_session_id: conversation.root_session_id,
    };
    const first = fx.makeActions();
    fx.runtime.bindActionAuthority(locator, first.authority.reader);
    const otherRoot = join(fx.root, "other-actions");
    mkdirSync(otherRoot, { recursive: true });
    const foreign = createDurableActionAuthorityReaderV1(new ActionAuthorityStore(otherRoot));
    expect(() => fx.runtime.bindActionAuthority(locator, foreign)).toThrow(/another owner/i);
  });

  test("rejects a tampered retained action-plan member before dispatch or effects", async () => {
    const fx = fixture();
    const actions = fx.makeActions();
    const domain = fx.runtime.conversationActionDomain(actions);
    const proposed = await domain.propose({
      conversation_id: conversation.conversation_id,
      request: fx.request,
      authority: fx.authority,
    });
    const proposal = proposed.response.proposal;
    const snapshot = actions.authority.get(proposal.proposal_id);
    if (!snapshot) throw new Error("proposal missing");
    const graph = domain.objects.readGraph(snapshot.proposal);
    const member = graph.plan.adapter_plans[0];
    if (!member) throw new Error("adapter plan missing");
    writeFileSync(
      join(fx.artifactRoot, "actions/v1/objects", `${digestHex(member.plan_digest)}.json`),
      "{}",
    );
    await expect(
      domain.approve({
        conversation_id: conversation.conversation_id,
        proposal_id: proposal.proposal_id,
        request: {
          schema_version: "1.0",
          proposal_digest: proposal.proposal_digest,
          decision: "approved",
          challenge_id: null,
          challenge_response: null,
        },
        authority: fx.authority,
      }),
    ).rejects.toThrow(/adapter plan|object binding/i);
    expect(
      existsSync(join(fx.projectRoot, ".codex/agents/acme.reviewer--reviewer.toml")),
    ).toBeFalse();
  });

  test("uses the real conversation HTTP proposal, approval, commit, and SSE routes across restart", async () => {
    const fx = fixture();
    const authority = (runtime: CapabilityRuntimeFactoryV1) => {
      const actions = fx.makeActions();
      const capabilityDomain = runtime.conversationActionDomain(actions);
      const domains = new ConversationActionDomainRegistryV1([capabilityDomain]);
      return {
        service: {} as never,
        sessions: {
          loopback: true,
          authorize: () => true,
          issueCookie: () => null,
        },
        streamTokens: {
          authorize: () => true,
          issue: () => ({ stream_token: "unused", stream_token_expires_at: now() }),
        },
        csrf: () => true,
        browser: {
          actions: domains,
          legacyAdopt: {
            inspect: (input: Parameters<typeof capabilityDomain.inspectAdoptCandidates>[0]) =>
              capabilityDomain.inspectAdoptCandidates(input),
          },
          rootSessionId: (conversationId: string) =>
            conversationId === conversation.conversation_id ? conversation.root_session_id : null,
          principal: () => structuredClone(fx.authority),
        } as never,
      };
    };
    writeFileSync(
      join(fx.projectRoot, ".vibeflow", ".mcp-managed.json"),
      JSON.stringify(["http-managed-server"]),
    );
    writeFileSync(
      join(fx.projectRoot, ".mcp.json"),
      JSON.stringify({ mcpServers: { "http-managed-server": { command: "vf-mcp" } } }),
    );
    const actionPath = `/api/conversations/${conversation.conversation_id}/action-proposals`;
    const post = (base: string, path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const first = await startServer(0, {
      repoDir: fx.projectRoot,
      conversation: authority(fx.runtime),
    });
    let proposal: {
      proposal: { proposal_id: string; proposal_digest: string };
    };
    let approval: { approval: { approval_id: string } };
    try {
      const proposed = await post(first.url, actionPath, fx.request);
      expect(proposed.status).toBe(201);
      expect(proposed.headers.get("cache-control")).toBe("no-store");
      proposal = (await proposed.json()) as typeof proposal;
      const approved = await post(
        first.url,
        `${actionPath}/${proposal.proposal.proposal_id}/approval`,
        {
          schema_version: "1.0",
          proposal_digest: proposal.proposal.proposal_digest,
          decision: "approved",
          challenge_id: null,
          challenge_response: null,
        },
      );
      expect(approved.status).toBe(200);
      approval = (await approved.json()) as typeof approval;
      const inspected = await post(
        first.url,
        `/api/conversations/${conversation.conversation_id}/legacy-adopt-candidates`,
        {
          schema_version: "1.0",
          idempotency_key: "http-legacy-inspection",
          scope: "project",
          legacy_sources: ["mcp-managed-sidecar"],
        },
      );
      expect(inspected.status).toBe(201);
      expect(inspected.headers.get("cache-control")).toBe("no-store");
      expect(((await inspected.json()) as { candidates: unknown[] }).candidates).toHaveLength(1);
    } finally {
      await first.server.stop(true);
    }

    const restartedRuntime = new CapabilityRuntimeFactoryV1(fx.runtimeOptions);
    const second = await startServer(0, {
      repoDir: fx.projectRoot,
      conversation: authority(restartedRuntime),
    });
    try {
      const replayed = await post(
        second.url,
        `/api/conversations/${conversation.conversation_id}/legacy-adopt-candidates`,
        {
          schema_version: "1.0",
          idempotency_key: "http-legacy-inspection",
          scope: "project",
          legacy_sources: ["mcp-managed-sidecar"],
        },
      );
      expect(replayed.status).toBe(200);
      const committed = await post(
        second.url,
        `${actionPath}/${proposal.proposal.proposal_id}/commit`,
        {
          schema_version: "1.0",
          proposal_digest: proposal.proposal.proposal_digest,
          approval_id: approval.approval.approval_id,
        },
      );
      expect(committed.status).toBe(200);
      expect(((await committed.json()) as { operation: { state: string } }).operation.state).toBe(
        "succeeded",
      );
      const eventResponse = await fetch(
        `${second.url}${actionPath}/${proposal.proposal.proposal_id}/events`,
      );
      const eventPage = (await eventResponse.json()) as {
        items: Array<{ event_cursor: string; progress: { phase: string } | null }>;
      };
      expect(eventPage.items.map((event) => event.progress?.phase)).toEqual([
        "operation-started",
        "target-applied",
        "operation-succeeded",
      ]);
      const stream = await fetch(
        `${second.url}${actionPath}/${proposal.proposal.proposal_id}/events?after=${eventPage.items[1]?.event_cursor}`,
        { headers: { accept: "text/event-stream" } },
      );
      expect(stream.headers.get("content-type")).toContain("text/event-stream");
      const reader = stream.body?.getReader();
      const firstFrame = await reader?.read();
      await reader?.cancel();
      expect(new TextDecoder().decode(firstFrame?.value)).toContain("operation-succeeded");
    } finally {
      await second.server.stop(true);
    }
  });
});
