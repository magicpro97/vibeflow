import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  actionIdempotencyFileKey,
  actionIdempotencyKeyDigest,
} from "../../src/actions/idempotency.js";
import { actionIdempotencyScopeDigest } from "../../src/actions/index.js";
import type { PublicCompactionInputV1 } from "../../src/actions/request-types.js";
import type { MaterializedAgentBinding } from "../../src/agents/binding.js";
import { conversationEnvPolicy } from "../../src/dispatch/env-filter.js";
import {
  type EngineSessionAdapter,
  type EngineSessionRequest,
  type EngineSessionResult,
  createSpawnOptionsProjection,
} from "../../src/dispatch/session-types.js";
import { digestV1 } from "../../src/durability/index.js";
import { ConversationArtifactStore } from "../../src/orchestrator/conversation/artifact-store.js";
import { createConversationBrowserAuthorities } from "../../src/orchestrator/conversation/conversation-browser-authorities.js";
import { ConversationHomeAuthorities } from "../../src/orchestrator/conversation/conversation-home-authorities.js";
import { reviewedActionEventIds } from "../../src/orchestrator/conversation/conversation-reviewed-action.js";
import { DirectConversationPolicy } from "../../src/orchestrator/conversation/direct-policy.js";
import {
  HandoffTooLargeError,
  buildContextHandoff,
} from "../../src/orchestrator/conversation/handoff-selection.js";
import { OversizedHandoffStoreV1 } from "../../src/orchestrator/conversation/oversized-handoff-store.js";
import { ConversationPolicyRegistry } from "../../src/orchestrator/conversation/policy-registry.js";
import {
  buildRevisionHandoff,
  defaultConversationActionAuthority,
  resolveRevisionBase,
} from "../../src/orchestrator/conversation/revision-source.js";
import { ConversationOrchestrator } from "../../src/orchestrator/conversation/service.js";
import { DurableArtifactRegistry } from "../../src/orchestrator/trace/artifacts.js";
import { TraceStore } from "../../src/orchestrator/trace/store.js";

const NOW = "2026-08-25T00:00:00.000Z";

function materialized(): MaterializedAgentBinding {
  const envPolicy = conversationEnvPolicy("codex");
  const provenance = { roleSource: "builtin" as const, roleHash: "a".repeat(64), skillHashes: [] };
  const trace = { role_resolved_hash: provenance.roleHash, skill_resolved_hashes: [] };
  return {
    resolved: {
      role: {
        source: "builtin",
        resolved_hash: provenance.roleHash,
        metadata: {},
        spec: {
          name: "direct",
          description: "Direct",
          body: "Direct",
          tools: ["read"],
          model: "gpt-5.4",
          sandbox: "read-only",
        },
      },
      skills: [],
      engine: "codex",
      model: "gpt-5.4",
      sessionMode: "fresh",
      tool_intents: ["read"],
      sandbox: "read-only",
      env_policy: envPolicy,
      isolation: null,
      provenance,
      trace_metadata: trace,
    },
    spawn: createSpawnOptionsProjection({
      engine: "codex",
      model: "gpt-5.4",
      sessionMode: "fresh",
      rendered_prompt: "Direct",
      rendered_tools: ["read"],
      sandbox: "read-only",
      env_policy: envPolicy,
      isolation: null,
      provenance,
      trace_metadata: trace,
    }),
  };
}

class ManualAdapter implements EngineSessionAdapter {
  requests: EngineSessionRequest[] = [];
  private finishes: Array<((result: EngineSessionResult) => void) | undefined> = [];

  start(request: EngineSessionRequest) {
    this.requests.push(request);
    const completion = new Promise<EngineSessionResult>((resolve) => {
      this.finishes.push(resolve);
    });
    return {
      attemptId: request.attemptId,
      completion,
      terminate: async () => this.complete(this.requests.indexOf(request)),
      readResumeBinding: () => undefined,
      readEvidenceBinding: () => undefined,
    };
  }

  complete(index: number): void {
    const request = this.requests[index];
    const finish = this.finishes[index];
    if (!request || !finish) throw new Error("manual attempt is absent");
    request.onChunk?.({ stream: "stdout", content: "final" });
    finish({
      attemptId: request.attemptId,
      engine: "codex",
      ok: true,
      state: "completed",
      lifecycle: ["requested", "dispatched", "acknowledged", "completed"],
      output: "final",
      evidenceStatus: "persisted",
      nativeSessionStatus: "unavailable",
    });
    this.finishes[index] = undefined;
  }

  async reconcileHistory() {
    return {
      status: "unavailable" as const,
      imported_turn_count: 0,
      imported_tool_count: 0,
      completeness_reason: "not used",
    };
  }
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("test state timed out");
}

async function within<T>(label: string, value: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 3_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function overflow(
  source = {
    conversation_id: "conversation-source",
    revision_id: "revision-source",
    last_seq: 1,
    lock_digest: digestV1("TEST-LOCK\0v1\0", { source: true }),
  },
): HandoffTooLargeError {
  try {
    buildContextHandoff({
      source,
      topic: "topic",
      policy_value: "direct",
      bindings: [],
      user_messages: [
        {
          event_id: "event-large",
          conversation_id: source.conversation_id,
          revision_id: source.revision_id,
          revision_ordinal: 0,
          public_seq: 1,
          author_public_id: "human",
          text: "x".repeat(8_192),
          created_at: NOW,
          redaction_manifest_digest: digestV1("TEST-REDACTION\0v1\0", { event: 1 }),
        },
      ],
      final_responses: [],
      artifacts: [],
      consensus: { score: null, synthesis: null },
      prompt_budget_bytes: 2_048,
    });
  } catch (error) {
    if (error instanceof HandoffTooLargeError) return error;
    throw error;
  }
  throw new Error("fixture did not overflow");
}

test("oversized issuance recovers the exact prepared candidate and excludes action idempotency", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-oversized-issuance-"));
  try {
    const error = overflow();
    const initial = new OversizedHandoffStoreV1(root, () => {
      throw new Error("crash after prepared");
    });
    const rejected = initial.materializeRejected({
      source: error.projection.source,
      source_public_head_digest: error.selection_plan.source_public_head_digest,
      selection_plan_digest: error.selection_plan.selection_digest,
      prompt_budget_bytes: error.selection_plan.prompt_budget_bytes,
      prompt_projection: error.projection,
    });
    const authority = {
      principal_digest: digestV1("TEST-PRINCIPAL\0v1\0", { actor: 1 }),
      authority_scope_digest: actionIdempotencyScopeDigest({
        kind: "conversation",
        root_session_id: "conversation-source",
      }),
      idempotency_key_digest: actionIdempotencyKeyDigest("overflow-one"),
      canonical_request_digest: digestV1("TEST-REQUEST\0v1\0", { request: 1 }),
    };
    await expect(() => initial.issue({ ...authority, rejected, created_at: NOW })).toThrow(
      "crash after prepared",
    );
    const recovered = new OversizedHandoffStoreV1(root).issue({
      ...authority,
      rejected,
      created_at: "2026-08-25T00:00:01.000Z",
    });
    expect(recovered.created_at).toBe(NOW);
    expect(
      new OversizedHandoffStoreV1(root).issue({
        ...authority,
        rejected,
        created_at: "2026-08-25T00:00:02.000Z",
      }),
    ).toEqual(recovered);

    const conflictingKey = actionIdempotencyKeyDigest("overflow-conflict");
    const idempotencyDir = join(root, "actions", "v1", "idempotency");
    mkdirSync(idempotencyDir, { recursive: true });
    writeFileSync(
      join(
        idempotencyDir,
        `${actionIdempotencyFileKey(
          authority.principal_digest,
          authority.authority_scope_digest,
          conflictingKey,
        )}.frames`,
      ),
      "occupied",
      { mode: 0o600 },
    );
    expect(() =>
      new OversizedHandoffStoreV1(root).issue({
        ...authority,
        idempotency_key_digest: conflictingKey,
        rejected,
        created_at: NOW,
      }),
    ).toThrow("idempotency conflict");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reviewed compaction commits exact artifacts, survives restart, and drives later handoffs", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-context-compaction-"));
  const artifactRoot = join(root, "manifests");
  const traceRoot = join(root, "trace");
  try {
    const registry = new DurableArtifactRegistry({ dir: join(root, "opaque") });
    const traceStore = new TraceStore({
      dir: traceRoot,
      artifactRegistry: registry,
      now: () => NOW,
    });
    const artifactStore = new ConversationArtifactStore({ dir: artifactRoot });
    const home = new ConversationHomeAuthorities({ artifactRoot, now: () => NOW });
    const adapter = new ManualAdapter();
    const runtime = new ConversationOrchestrator({
      traceStore,
      artifactRegistry: registry,
      artifactStore,
      homeAuthorities: home,
      sessionAdapter: adapter,
      policies: new ConversationPolicyRegistry([new DirectConversationPolicy()]),
      id: (kind) => `${kind}-compaction`,
      now: () => NOW,
      rehydrateBinding: async () => materialized(),
    });
    const creating = runtime.create({
      topic: "topic",
      policy: "direct",
      maxRounds: 1,
      repoRoot: process.cwd(),
      phase: 1,
      bindings: [
        {
          participantId: "participant-1",
          input: { roleRef: "direct", engine: "codex", sessionMode: "fresh" },
          materialized: materialized(),
        },
      ],
    });
    await waitFor(() => adapter.requests.length === 1);
    await runtime.message("conversation-compaction", { content: "m".repeat(12_000) });
    adapter.complete(0);
    await waitFor(() => adapter.requests.length === 2);
    adapter.complete(1);
    const created = await within("create completion", creating);
    await waitFor(
      async () => (await runtime.snapshot(created.conversation_id))?.lifecycle === "COMPLETED",
    );
    const base = resolveRevisionBase({
      artifactRoot,
      traceRoot,
      conversationId: created.conversation_id,
      home,
    });
    const snapshot = await runtime.snapshot(created.conversation_id);
    if (!snapshot) throw new Error("terminal snapshot is absent");
    let oversized: HandoffTooLargeError;
    try {
      buildRevisionHandoff({
        base,
        bindings: [
          {
            participant_id: "participant-1",
            engine: "codex",
            model: "gpt-5.4",
            role_ref: "direct",
            continuity: "retained",
          },
        ],
        snapshot,
        promptBudgetBytes: 6_000,
      });
      throw new Error("revision handoff did not overflow");
    } catch (error) {
      if (!(error instanceof HandoffTooLargeError)) throw error;
      oversized = error;
    }
    home.handoffs.writeOmissions(oversized.omitted_public_event_artifacts);
    const rejected = home.oversizedHandoffs.materializeRejected({
      source: oversized.projection.source,
      source_public_head_digest: oversized.selection_plan.source_public_head_digest,
      selection_plan_digest: oversized.selection_plan.selection_digest,
      prompt_budget_bytes: oversized.selection_plan.prompt_budget_bytes,
      prompt_projection: oversized.projection,
    });
    const authority = defaultConversationActionAuthority(base.lineage.root_session_id);
    const candidate = home.oversizedHandoffs.issue({
      rejected,
      principal_digest: authority.principal_digest,
      authority_scope_digest: authority.authority_scope_digest,
      idempotency_key_digest: actionIdempotencyKeyDigest("overflow-source"),
      canonical_request_digest: digestV1("TEST-OVERFLOW-REQUEST\0v1\0", { source: 1 }),
      created_at: NOW,
    });
    const compactInputPreimage = {
      schema_version: "1.0" as const,
      profile: "vf-public-compaction/1" as const,
      public_summary: "Reviewed compact summary.",
      retained_event_ids: [] as string[],
      retained_artifact_ids: [] as string[],
    };
    const compactionInput: PublicCompactionInputV1 = {
      ...compactInputPreimage,
      input_digest: digestV1("VF-PUBLIC-COMPACTION-INPUT\0v1\0", compactInputPreimage),
    };
    let crash: "after-artifacts-durable" | "after-trace-append" | null = null;
    const compactionFault = (point: "after-artifacts-durable" | "after-trace-append") => {
      if (point !== crash) return;
      crash = null;
      throw new Error(`compaction crash at ${point}`);
    };
    const browser = createConversationBrowserAuthorities({
      artifactRoot,
      traceRoot,
      traceStore,
      browserAuthorityKey: Buffer.alloc(32, 9),
      artifactRegistry: registry,
      artifactStore,
      home,
      service: runtime,
      compactionFault,
    });
    const proposed = await within(
      "compaction propose",
      browser.actions.propose({
        conversation_id: created.conversation_id,
        authority,
        request: {
          schema_version: "1.0",
          idempotency_key: "compact-source",
          anchor_event_id: null,
          expected: {
            mode: "writable-revision",
            conversation_id: created.conversation_id,
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
      }),
    );
    expect(proposed.response.operation.state).toBe("pending_review");
    expect(
      (await runtime.events(created.conversation_id, 0))?.some(
        ({ event }) =>
          event.type === "artifact_created" && event.payload.artifact_type === "compaction",
      ),
    ).toBe(false);
    const approved = await within(
      "compaction approve",
      browser.actions.approve({
        conversation_id: created.conversation_id,
        proposal_id: proposed.response.proposal.proposal_id,
        authority,
        request: {
          schema_version: "1.0",
          proposal_digest: proposed.response.proposal.proposal_digest,
          decision: "approved",
          challenge_id: null,
          challenge_response: null,
        },
      }),
    );
    const commit = {
      conversation_id: created.conversation_id,
      proposal_id: proposed.response.proposal.proposal_id,
      authority,
      request: {
        schema_version: "1.0" as const,
        proposal_digest: proposed.response.proposal.proposal_digest,
        approval_id: approved.approval.approval_id,
      },
    };
    crash = "after-artifacts-durable";
    await expect(
      within("compaction artifacts frontier", browser.actions.commit(commit)),
    ).rejects.toThrow("compaction crash at after-artifacts-durable");
    expect(
      (await runtime.events(created.conversation_id, 0))?.filter(
        ({ event }) =>
          event.type === "artifact_created" && event.payload.artifact_type === "compaction",
      ),
    ).toHaveLength(0);
    const durableArtifact = artifactStore
      .readRecord(created.conversation_id)
      ?.artifacts.find((entry) => entry.artifact_type === "compaction");
    if (!durableArtifact) throw new Error("durable compaction artifact is absent");
    const durablePath = join(
      artifactRoot,
      "content",
      `${durableArtifact.ref.slice("vf-artifact-".length)}.bin`,
    );
    const durableBytes = readFileSync(durablePath);
    const missingPath = `${durablePath}.missing`;
    renameSync(durablePath, missingPath);
    const afterArtifactHome = new ConversationHomeAuthorities({ artifactRoot, now: () => NOW });
    const afterArtifact = createConversationBrowserAuthorities({
      artifactRoot,
      traceRoot,
      traceStore,
      browserAuthorityKey: Buffer.alloc(32, 9),
      artifactRegistry: registry,
      artifactStore: new ConversationArtifactStore({ dir: artifactRoot }),
      home: afterArtifactHome,
      service: runtime,
      compactionFault,
    });
    await expect(
      within("compaction missing replay", afterArtifact.actions.commit(commit)),
    ).rejects.toThrow();
    renameSync(missingPath, durablePath);
    writeFileSync(durablePath, "corrupt");
    await expect(
      within("compaction corrupt replay", afterArtifact.actions.commit(commit)),
    ).rejects.toThrow();
    writeFileSync(durablePath, durableBytes, { mode: 0o600 });
    crash = "after-trace-append";
    await expect(
      within("compaction trace frontier", afterArtifact.actions.commit(commit)),
    ).rejects.toThrow("compaction crash at after-trace-append");
    expect(
      (await runtime.events(created.conversation_id, 0))?.filter(
        ({ event }) =>
          event.type === "artifact_created" && event.payload.artifact_type === "compaction",
      ),
    ).toHaveLength(1);
    const traceRecords = await traceStore.readConversation(created.conversation_id);
    const traceArtifacts = artifactStore.readRecord(created.conversation_id)?.artifacts ?? [];
    const compactionRecord = traceRecords.find(({ stored_event }) =>
      stored_event.idempotency_key.startsWith("action-context-compaction:"),
    );
    if (!compactionRecord) throw new Error("compaction trace record is absent");
    expect(
      reviewedActionEventIds(
        artifactRoot,
        afterArtifactHome.reviewedActionAuthority(),
        traceArtifacts,
        traceRecords,
      ).has(compactionRecord.stored_event.event_id),
    ).toBe(true);
    const wrongRef = structuredClone(traceRecords);
    const forged = wrongRef.find(({ stored_event }) =>
      stored_event.idempotency_key.startsWith("action-context-compaction:"),
    );
    if (forged?.stored_event.event.type !== "artifact_created")
      throw new Error("compaction trace record changed type");
    forged.stored_event.event.payload.ref = `vf-artifact-${"f".repeat(64)}`;
    expect(
      reviewedActionEventIds(
        artifactRoot,
        afterArtifactHome.reviewedActionAuthority(),
        traceArtifacts,
        wrongRef,
      ).has(forged.stored_event.event_id),
    ).toBe(false);
    const afterTraceHome = new ConversationHomeAuthorities({ artifactRoot, now: () => NOW });
    const afterTrace = createConversationBrowserAuthorities({
      artifactRoot,
      traceRoot,
      traceStore,
      browserAuthorityKey: Buffer.alloc(32, 9),
      artifactRegistry: registry,
      artifactStore: new ConversationArtifactStore({ dir: artifactRoot }),
      home: afterTraceHome,
      service: runtime,
    });
    const committed = await within("compaction commit", afterTrace.actions.commit(commit));
    expect(committed.operation.state).toBe("succeeded");
    expect(
      (await within("compaction replay", afterTrace.actions.commit(commit))).operation.operation_id,
    ).toBe(committed.operation.operation_id);
    const compactionEvent = (await runtime.events(created.conversation_id, 0))?.find(
      ({ event }) =>
        event.type === "artifact_created" && event.payload.artifact_type === "compaction",
    );
    if (compactionEvent?.event.type !== "artifact_created")
      throw new Error("compaction event is absent");
    expect(
      artifactStore.readArtifact(
        created.conversation_id,
        compactionEvent.event.payload.artifact_id,
      ),
    ).not.toBeNull();
    const after = resolveRevisionBase({
      artifactRoot,
      traceRoot,
      conversationId: created.conversation_id,
      home,
    });
    expect(after.active_compaction?.public_summary).toBe(compactInputPreimage.public_summary);
    const fitted = buildRevisionHandoff({
      base: after,
      bindings: [
        {
          participant_id: "participant-1",
          engine: "codex",
          model: "gpt-5.4",
          role_ref: "direct",
          continuity: "retained",
        },
      ],
      snapshot,
      promptBudgetBytes: 6_000,
    });
    expect(fitted.handoff.compaction?.content_digest).toBe(after.active_compaction?.content_digest);
    expect(fitted.handoff.transcript.user_messages).toHaveLength(0);

    const restartedHome = new ConversationHomeAuthorities({ artifactRoot, now: () => NOW });
    const restarted = createConversationBrowserAuthorities({
      artifactRoot,
      traceRoot,
      traceStore,
      browserAuthorityKey: Buffer.alloc(32, 9),
      artifactRegistry: registry,
      artifactStore: new ConversationArtifactStore({ dir: artifactRoot }),
      home: restartedHome,
      service: runtime,
    });
    expect(
      (await within("compaction restart", restarted.actions.commit(commit))).operation.state,
    ).toBe("succeeded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
