import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MaterializedAgentBinding, PreviewAgentBinding } from "../../src/agents/binding.js";
import { conversationEnvPolicy } from "../../src/dispatch/env-filter.js";
import { createSpawnOptionsProjection } from "../../src/dispatch/session-types.js";
import { createConversationBootstrap } from "../../src/orchestrator/conversation/bootstrap.js";
import type {
  PlanArtifact,
  PolicyVerifyReport,
} from "../../src/orchestrator/conversation/services.js";
import type { ConversationService } from "../../src/orchestrator/conversation/types.js";
import type {
  PublicStoredTraceEvent,
  PublicTraceEvent,
} from "../../src/orchestrator/trace/types.js";

const HEAD_SHA = "a".repeat(40);
const PLAN_CONTENT = [
  "# Existing work-unit plan",
  "",
  "1. Execute `brainstorm-runtime`.",
  "2. Require its independent runner review to pass.",
  "3. Record current-HEAD human review and all verification gates.",
].join("\n");

const VERIFY_REPORT = {
  toolchain: {
    status: "pass",
    details: "typecheck, lint, and tests passed",
    evidence_refs: ["evidence:toolchain"],
  },
  confidence: {
    status: "pass",
    details: "confidence is exactly 1.0",
    evidence_refs: ["evidence:confidence"],
  },
  goal: {
    status: "pass",
    details: "behavioral goal is covered",
    evidence_refs: ["evidence:goal"],
  },
  evidence: {
    status: "pass",
    details: "durable evidence is present",
    evidence_refs: ["evidence:ledger"],
  },
  test_evidence: {
    status: "pass",
    details: "test evidence is current",
    evidence_refs: ["evidence:tests"],
  },
  scope: {
    status: "pass",
    details: "changes remain in scope",
    evidence_refs: ["evidence:scope"],
  },
  skill: {
    status: "pass",
    details: "required skills are satisfied",
    evidence_refs: ["evidence:skill"],
  },
  canary: {
    status: "pass",
    details: "canary coverage passed",
    evidence_refs: ["evidence:canary"],
  },
  implementation_drift: {
    status: "pass",
    details: "implementation matches the verified snapshot",
    evidence_refs: ["evidence:implementation-drift"],
  },
  coverage: {
    status: "pass",
    details: "coverage gate passed",
    evidence_refs: ["evidence:coverage"],
  },
  sandbox: {
    status: "pass",
    details: "sandbox policy passed",
    evidence_refs: ["evidence:sandbox"],
  },
  waiver: {
    status: "pass",
    details: "waiver policy passed",
    evidence_refs: ["evidence:waiver"],
  },
  registry_lock: {
    status: "pass",
    details: "registry lock passed",
    evidence_refs: ["evidence:registry-lock"],
  },
  review_evidence: {
    status: "pass",
    details: "current-HEAD review evidence passed",
    evidence_refs: ["evidence:review"],
  },
  advisory_e2e: {
    status: "pass",
    details: "advisory end-to-end checks passed",
    evidence_refs: ["evidence:e2e"],
  },
  marker_result: {
    status: "pass",
    details: "verification marker passed",
    evidence_refs: ["evidence:marker"],
  },
  journal_result: {
    status: "pass",
    details: "verification journal passed",
    evidence_refs: ["evidence:journal"],
  },
} as const satisfies PolicyVerifyReport;

function materializedBinding(): MaterializedAgentBinding {
  const roleHash = "b".repeat(64);
  const provenance = { roleSource: "builtin" as const, roleHash, skillHashes: [] };
  const traceMetadata = { role_resolved_hash: roleHash, skill_resolved_hashes: [] };
  const envPolicy = conversationEnvPolicy("codex");
  const resolved = {
    role: {
      spec: {
        name: "direct",
        description: "acceptance-test binder",
        body: "This binding must never launch an engine process.",
        tools: ["read" as const],
        model: "sonnet" as const,
        sandbox: "read-only" as const,
      },
      source: "builtin" as const,
      resolved_hash: roleHash,
      metadata: {},
    },
    skills: [],
    engine: "codex" as const,
    model: "gpt-5.4",
    sessionMode: "fresh" as const,
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
      engine: "codex",
      model: "gpt-5.4",
      sessionMode: "fresh",
      rendered_prompt: "acceptance-test process sentinel",
      rendered_tools: ["read"],
      sandbox: "read-only",
      env_policy: envPolicy,
      isolation: null,
      provenance,
      trace_metadata: traceMetadata,
    }),
  };
}

async function awaitCompleted(service: ConversationService, conversationId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await service.snapshot(conversationId))?.lifecycle === "COMPLETED") return;
    await Bun.sleep(2);
  }
  throw new Error("conversation did not reach COMPLETED");
}

type ArtifactCreatedRecord = PublicStoredTraceEvent & {
  event: Extract<PublicTraceEvent, { type: "artifact_created" }>;
};

const artifactCreated = (record: PublicStoredTraceEvent): record is ArtifactCreatedRecord =>
  record.event.type === "artifact_created";

test("plan policy executes existing work once and replays approval without duplicate effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-policy-acceptance-"));
  try {
    const idCounters = new Map<string, number>();
    const calls = { plan: 0, orchestrate: 0, review: 0, verify: 0 };
    const observedPlans: Readonly<PlanArtifact>[] = [];
    let clockTick = 0;

    const bootstrap = createConversationBootstrap({
      repoRoot: process.cwd(),
      stateDir: join(root, "state"),
      readiness: () => [{ engine: "codex", ready: true, admitted: true }],
      bindingFactory: {
        materialize: () => materializedBinding(),
        preview: () => {
          throw new Error("acceptance test must not preview an engine binding");
        },
      } as unknown as {
        materialize: () => MaterializedAgentBinding;
        preview: () => PreviewAgentBinding;
      },
      session: {
        sourceEnv: {},
        spawn: () => {
          throw new Error("acceptance test must not spawn an engine process");
        },
        writeEvidence: () => {
          throw new Error("acceptance test must not write attempt evidence");
        },
      },
      reviewEvidenceAuthority: {
        currentHead: () => HEAD_SHA,
        checkCurrentHead: (headSha) => ({
          ok: headSha === HEAD_SHA,
          reason: headSha === HEAD_SHA ? "review-evidence(ok)" : "review-evidence: HEAD changed",
        }),
        checkWorktree: (headSha) => ({
          ok: headSha === HEAD_SHA,
          fingerprint: headSha === HEAD_SHA ? "clean-current-head" : "",
          reason: headSha === HEAD_SHA ? "review worktree is clean" : "review HEAD changed",
        }),
      },
      id: (kind) => {
        const next = (idCounters.get(kind) ?? 0) + 1;
        idCounters.set(kind, next);
        return `${kind}-acceptance-${next}`;
      },
      now: () => new Date(Date.UTC(2026, 7, 22, 0, 0, 0, clockTick++)).toISOString(),
      schedule: (task) => task(),
      libraries: {
        plan: {
          create: async ({ context }) => {
            calls.plan += 1;
            expect(context.topic).toBe("Plan and execute existing work units");
            expect(context.policy).toBe("plan");
            return { content: PLAN_CONTENT };
          },
        },
        orchestrate: {
          dryRun: async () => ({
            participants: [],
            evaluator_auto_added: false,
            engines_available: ["codex"],
            models_valid: true,
          }),
          execute: async ({ context, approval, artifact }) => {
            calls.orchestrate += 1;
            if (!artifact) throw new Error("orchestration did not receive the persisted plan");
            observedPlans.push(artifact);
            expect(artifact.revision_id).toBe(context.correlation.revision_id);
            expect(Object.isFrozen(artifact)).toBe(true);
            expect(() => Object.assign(artifact, { ref: "forged-plan-ref" })).toThrow();
            expect(approval.outcome).toBe("approve");
            return {
              units: [
                {
                  name: "brainstorm-runtime",
                  status: "done",
                  confidence: 1,
                  scope: ["src/orchestrator/brainstorm-runtime.ts"],
                  spec: "execute the existing brainstorm runtime work unit",
                  gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
                  resources: { agents: 1, tokens: 144, cost_usd: 0, wall_seconds: 1 },
                  evidence: ["/private/work-unit-evidence.json"],
                },
              ],
              reviews: [
                {
                  unit: "brainstorm-runtime",
                  pass: true,
                  reason: "/private/runner-review.json passed",
                },
              ],
            };
          },
        },
        review: {
          review: async ({ context, artifact, mode, head_sha }) => {
            calls.review += 1;
            const orchestratedPlan = observedPlans[0];
            if (!orchestratedPlan) throw new Error("review ran before orchestration");
            expect(artifact).toEqual(orchestratedPlan);
            observedPlans.push(artifact);
            expect(artifact.revision_id).toBe(context.correlation.revision_id);
            expect(Object.isFrozen(artifact)).toBe(true);
            expect(mode).toBe("human-only");
            expect(head_sha).toBe(HEAD_SHA);
            return {
              reviewed_head: head_sha,
              reviewer: "human:acceptance-reviewer",
              outcome: "approved",
              evidence_refs: ["review-evidence:current-head"],
            };
          },
        },
        verify: {
          run: async ({ context, artifact }) => {
            calls.verify += 1;
            const orchestratedPlan = observedPlans[0];
            if (!orchestratedPlan) throw new Error("verify ran before orchestration");
            expect(artifact).toEqual(orchestratedPlan);
            observedPlans.push(artifact);
            expect(artifact.revision_id).toBe(context.correlation.revision_id);
            expect(Object.isFrozen(artifact)).toBe(true);
            return VERIFY_REPORT;
          },
        },
      },
    });

    const service = bootstrap.service;
    const created = await service.create({
      topic: "Plan and execute existing work units",
      policy: "plan",
    });
    const beforeApproval = await service.events(created.conversation_id, 0);
    if (!beforeApproval) throw new Error("conversation events are unavailable");
    const planEvents = beforeApproval.filter(artifactCreated);
    const approvalRequest = beforeApproval.find(({ event }) => event.type === "approval_requested");
    if (approvalRequest?.event.type !== "approval_requested") {
      throw new Error("approval was not requested");
    }
    expect(planEvents).toHaveLength(1);
    const planEvent = planEvents[0];
    if (!planEvent) throw new Error("plan artifact event is unavailable");

    expect(created.result).toEqual({
      operation_id: created.result.operation_id,
      status: "awaiting_approval",
      artifact_refs: [String(planEvent.event.payload.artifact_id)],
    });
    expect(String(approvalRequest.operation_id)).toBe(created.result.operation_id);
    expect(String(planEvent.event.payload.artifact_type)).toBe("plan");
    expect(approvalRequest).toMatchObject({
      conversation_id: created.conversation_id,
      revision_id: created.revision_id,
      operation_id: created.result.operation_id,
    });
    expect(
      (await service.events(created.conversation_id, 0))?.find(
        ({ event }) => event.type === "approval_requested",
      ),
    ).toEqual(approvalRequest);

    const decision = {
      ...approvalRequest.event.payload.token,
      outcome: "approve" as const,
      reason: "execute the persisted plan",
    };
    const resolved = await service.resolveApproval(created.conversation_id, decision);
    expect(resolved).toEqual({ status: 202, body: { ...decision, resolved: true } });
    await awaitCompleted(service, created.conversation_id);

    const completedEvents = await service.events(created.conversation_id, 0);
    if (!completedEvents) throw new Error("completed events are unavailable");
    const artifactEvents = completedEvents.filter(artifactCreated);
    const approvalResolved = completedEvents.filter(
      ({ event }) => event.type === "approval_resolved",
    );
    expect(await service.snapshot(created.conversation_id)).toMatchObject({
      lifecycle: "COMPLETED",
      health: "healthy",
      policy: "plan",
      topic: "Plan and execute existing work units",
    });
    expect(calls).toEqual({ plan: 1, orchestrate: 1, review: 1, verify: 1 });
    expect(observedPlans).toHaveLength(3);
    expect(observedPlans.every(Object.isFrozen)).toBe(true);
    const persistedPlan = observedPlans[0];
    if (!persistedPlan) throw new Error("downstream libraries did not receive the plan");
    expect(observedPlans).toEqual([persistedPlan, persistedPlan, persistedPlan]);
    expect(artifactEvents.map(({ event }) => String(event.payload.artifact_type))).toEqual([
      "plan",
      "tests",
      "transcript",
      "tests",
    ]);
    expect(approvalResolved).toHaveLength(1);
    expect(approvalResolved[0]).toMatchObject({
      conversation_id: created.conversation_id,
      revision_id: created.revision_id,
      operation_id: created.result.operation_id,
      event: { payload: { decision } },
    });

    const durable = bootstrap.authorities.artifactStore.readRecord(created.conversation_id);
    if (!durable) throw new Error("durable conversation record is unavailable");
    expect(durable.artifacts).toHaveLength(4);
    const contents = durable.artifacts.map((entry) => {
      const bytes = bootstrap.authorities.artifactStore.readArtifactRef(
        created.conversation_id,
        entry.ref,
      );
      if (!bytes) throw new Error(`artifact content is unavailable: ${entry.artifact_id}`);
      return new TextDecoder().decode(bytes);
    });
    expect(contents).toEqual([
      PLAN_CONTENT,
      '{"units":[{"unit":"brainstorm-runtime","status":"done"}],"reviews":[{"unit":"brainstorm-runtime","pass":true}]}\n',
      `${JSON.stringify({
        artifact_id: durable.artifacts[0]?.artifact_id,
        reviewed_head: HEAD_SHA,
        reviewer: "human:acceptance-reviewer",
        outcome: "approved",
        evidence_check: "review-evidence(ok)",
      })}\n`,
      `${JSON.stringify(VERIFY_REPORT)}\n`,
    ]);
    expect(contents[1]).not.toContain("/private/");

    const finalRefs = artifactEvents.map(({ event }) => String(event.payload.artifact_id));
    expect(finalRefs).toEqual(durable.artifacts.map(({ artifact_id }) => artifact_id));
    expect(
      artifactEvents.map(({ event }) => {
        const ref = event.payload.ref;
        if (!ref) throw new Error("public artifact ref is unavailable");
        return bootstrap.authorities.artifactRegistry.resolve(created.conversation_id, ref);
      }),
    ).toEqual(durable.artifacts.map(({ ref }) => ({ internalRef: ref })));

    const eventCount = completedEvents.length;
    const durableBeforeReplay = structuredClone(durable);
    expect(await service.resolveApproval(created.conversation_id, decision)).toEqual(resolved);
    expect((await service.snapshot(created.conversation_id))?.lifecycle).toBe("COMPLETED");
    expect(await service.events(created.conversation_id, 0)).toHaveLength(eventCount);
    expect(bootstrap.authorities.artifactStore.readRecord(created.conversation_id)).toEqual(
      durableBeforeReplay,
    );
    expect(calls).toEqual({ plan: 1, orchestrate: 1, review: 1, verify: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
