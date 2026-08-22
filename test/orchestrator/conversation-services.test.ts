import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MaterializedAgentBinding, PreviewAgentBinding } from "../../src/agents/binding.js";
import { conversationEnvPolicy } from "../../src/dispatch/env-filter.js";
import { createSpawnOptionsProjection } from "../../src/dispatch/session-types.js";
import { createConversationBootstrap } from "../../src/orchestrator/conversation/bootstrap.js";
import { OrchestrateConversationPolicy } from "../../src/orchestrator/conversation/orchestrate-policy.js";
import {
  InjectedOrchestrateService,
  InjectedPlanService,
  InjectedReviewService,
  InjectedVerifyService,
  POLICY_VERIFY_GATE_NAMES,
  type PlanArtifact,
  type PolicyVerifyReport,
  orchestrationApprovalToken,
} from "../../src/orchestrator/conversation/services.js";
import type { ConversationContext } from "../../src/orchestrator/conversation/types.js";

const artifact = (ref = "vf-artifact-plan") => ({
  artifact_id: "plan-1",
  revision_id: "revision-1",
  ref,
});

function materializedBinding(): MaterializedAgentBinding {
  const roleHash = "a".repeat(64);
  const provenance = { roleSource: "builtin" as const, roleHash, skillHashes: [] };
  const traceMetadata = { role_resolved_hash: roleHash, skill_resolved_hashes: [] };
  const envPolicy = conversationEnvPolicy("codex");
  const resolved = {
    role: {
      spec: {
        name: "direct",
        description: "direct",
        body: "answer directly",
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
      rendered_prompt: "answer directly",
      rendered_tools: ["read"],
      sandbox: "read-only",
      env_policy: envPolicy,
      isolation: null,
      provenance,
      trace_metadata: traceMetadata,
    }),
  };
}

function contextHarness() {
  const emissions: Array<Record<string, unknown>> = [];
  const creates: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const context = {
    correlation: {
      workflow_id: "workflow-1",
      conversation_id: "conversation-1",
      revision_id: "revision-1",
      run_id: "run-1",
      turn_id: "turn-1",
      operation_id: "operation-1",
      attempt_id: "coordinator",
    },
    topic: "Plan and ship the feature",
    policy: "plan",
    maxRounds: 1,
    baselineEnabled: false,
    evaluatorAutoAdded: false,
    bindings: [],
    participantIds: [],
    bindingReadiness: [],
    signal: new AbortController().signal,
    messages: async () => [],
    emit: async (emission: Record<string, unknown>) => {
      emissions.push(emission);
      return {};
    },
    launchAttempt: () => {
      throw new Error("unexpected attempt");
    },
    createArtifact: async (request: Record<string, unknown>) => {
      creates.push(request);
      return { artifact_id: `artifact-${creates.length}`, ref: `vf-artifact-${creates.length}` };
    },
    updateArtifact: async (request: Record<string, unknown>) => {
      updates.push(request);
      return {
        artifact_id: String(request.artifact_id),
        ref: `vf-artifact-update-${updates.length}`,
        previous_ref: String(request.previous_ref),
      };
    },
  } as unknown as ConversationContext;
  return { context, emissions, creates, updates };
}

const passingReport = (): PolicyVerifyReport =>
  Object.fromEntries(
    POLICY_VERIFY_GATE_NAMES.map((name) => [
      name,
      { status: "pass", details: `${name} passed`, evidence_refs: [`evidence:${name}`] },
    ]),
  ) as unknown as PolicyVerifyReport;

describe("injected workflow services", () => {
  test("plan create/update persists only through conversation artifact authority", async () => {
    const run = contextHarness();
    const prior = artifact();
    const calls: string[] = [];
    const service = new InjectedPlanService({
      create: async ({ context }) => {
        calls.push(`create:${context.topic}`);
        return { content: "# Plan", revision_id: "revision-created" };
      },
      update: async ({ revision, previous }) => {
        calls.push(`update:${revision.reason}:${previous.artifact_id}`);
        return { content: revision.content };
      },
      locate: async () => prior,
    });

    expect(await service.createPlan(run.context)).toEqual({
      artifact_id: "artifact-1",
      revision_id: "revision-created",
      ref: "vf-artifact-1",
    });
    expect(
      await service.updatePlan(run.context, {
        revision_id: "revision-2",
        content: "# Revised plan",
        reason: "review changes",
      }),
    ).toEqual({
      artifact_id: "plan-1",
      revision_id: "revision-2",
      ref: "vf-artifact-update-1",
    });
    expect(calls).toEqual(["create:Plan and ship the feature", "update:review changes:plan-1"]);
    expect(run.creates[0]).toMatchObject({ artifact_type: "plan", content: "# Plan" });
    expect(run.updates[0]).toMatchObject({
      artifact_id: "plan-1",
      artifact_type: "plan",
      content: "# Revised plan",
      previous_ref: "vf-artifact-plan",
    });
  });

  test("review is human-only, pinned to current HEAD, and publishes only an artifact ref", async () => {
    const run = contextHarness();
    const heads = ["a".repeat(40), "a".repeat(40)];
    const seen: Record<string, unknown>[] = [];
    const service = new InjectedReviewService({
      currentHead: async () => heads.shift() as string,
      review: async (input) => {
        seen.push(input as unknown as Record<string, unknown>);
        return {
          reviewed_head: "a".repeat(40),
          reviewer: "human:alice",
          outcome: "approved",
          evidence_refs: ["/private/review/result.json"],
        };
      },
    });

    const result = await service.requestReview(run.context, artifact());
    expect(seen[0]).toMatchObject({ mode: "human-only", head_sha: "a".repeat(40) });
    expect(result).toEqual({
      artifact_id: "plan-1",
      reviewer: "human:alice",
      outcome: "approved",
      evidence_refs: ["vf-artifact-1"],
    });
    expect(run.creates).toHaveLength(1);
    expect(run.creates[0]).toMatchObject({ artifact_type: "transcript" });
    expect(JSON.parse(String(run.creates[0]?.content)).evidence_refs).toEqual([
      "/private/review/result.json",
    ]);
  });

  test("review rejects stale current-head evidence before publishing", async () => {
    const run = contextHarness();
    const heads = ["a".repeat(40), "b".repeat(40)];
    const service = new InjectedReviewService({
      currentHead: async () => heads.shift() as string,
      review: async ({ head_sha }) => ({
        reviewed_head: head_sha,
        reviewer: "human:alice",
        outcome: "approved",
        evidence_refs: ["review.json"],
      }),
    });
    await expect(service.requestReview(run.context, artifact())).rejects.toThrow(
      "review HEAD changed",
    );
    expect(run.creates).toHaveLength(0);
  });

  test("verify accepts exactly the full structured core manifest", async () => {
    const run = contextHarness();
    const report = passingReport();
    const service = new InjectedVerifyService({ run: async () => report });
    expect(await service.runVerify(run.context, artifact())).toEqual(report);

    const incomplete = Object.fromEntries(
      Object.entries(report).filter(([name]) => name !== "journal_result"),
    );
    await expect(
      new InjectedVerifyService({
        run: async () => incomplete as unknown as PolicyVerifyReport,
      }).runVerify(run.context, artifact()),
    ).rejects.toThrow("full structured verify report");
  });

  test("orchestrate dry-run is approval-free; execute is correlated and cancel delegates", async () => {
    const run = contextHarness();
    let executions = 0;
    let cancelled = 0;
    const service = new InjectedOrchestrateService({
      dryRun: async () => ({
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      }),
      execute: async () => {
        executions += 1;
        return { units: [], reviews: [] };
      },
      cancel: async (command) => {
        cancelled += 1;
        return { status: 202, body: { operation_id: command.operation_id, cancelled: true } };
      },
    });

    expect(await service.dryRun(run.context)).toMatchObject({ models_valid: true });
    expect(run.emissions).toHaveLength(0);
    expect(await service.execute(run.context, null)).toMatchObject({
      status: "awaiting_approval",
      operation_id: "operation-1",
    });
    expect(executions).toBe(0);
    expect(run.emissions[0]).toMatchObject({
      event: {
        type: "approval_requested",
        payload: { token: orchestrationApprovalToken(run.context) },
      },
    });
    expect(
      await service.execute(run.context, {
        ...orchestrationApprovalToken(run.context),
        outcome: "approve",
        reason: null,
      }),
    ).toMatchObject({ status: "completed", operation_id: "operation-1" });
    expect(executions).toBe(1);
    expect(
      await service.cancel({
        conversation_id: "conversation-1",
        operation_id: "operation-1",
        actor: "user",
        reason: "stop",
      }),
    ).toEqual({ status: 202, body: { operation_id: "operation-1", cancelled: true } });
    expect(cancelled).toBe(1);
  });
});

test("orchestrate policy delegates approval continuation without a second authority", async () => {
  const run = contextHarness();
  const calls: Array<"dry" | "execute" | "continue"> = [];
  const policy = new OrchestrateConversationPolicy({
    dryRun: async () => {
      calls.push("dry");
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    execute: async (_context, approval) => {
      calls.push(approval ? "continue" : "execute");
      return {
        operation_id: "operation-1",
        status: approval ? "completed" : "awaiting_approval",
        artifact_refs: [],
      };
    },
    cancel: async () => ({ status: 404, body: { code: "operation_not_found" } }),
  });
  await policy.dryRun(run.context);
  await policy.execute(run.context);
  await policy.continueAfterApproval?.(run.context, {
    ...orchestrationApprovalToken(run.context),
    outcome: "approve",
    reason: null,
  });
  expect(calls).toEqual(["dry", "execute", "continue"]);
});

test("bootstrap creates one shared authority set and registers every built-in policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-conversation-bootstrap-"));
  try {
    const counters = new Map<string, number>();
    const bootstrap = createConversationBootstrap({
      repoRoot: process.cwd(),
      stateDir: join(root, "state"),
      readiness: () => [{ engine: "codex", ready: true, admitted: true }],
      bindingFactory: {
        materialize: () => materializedBinding(),
        preview: () => {
          throw new Error("preview is not used by this execution test");
        },
      } as unknown as {
        materialize: () => MaterializedAgentBinding;
        preview: () => PreviewAgentBinding;
      },
      id: (kind) => {
        const next = (counters.get(kind) ?? 0) + 1;
        counters.set(kind, next);
        return `${kind}-${next}`;
      },
      schedule: (task) => task(),
      libraries: {
        plan: { create: async () => ({ content: "# Plan" }) },
        review: {
          currentHead: async () => "a".repeat(40),
          review: async ({ head_sha }) => ({
            reviewed_head: head_sha,
            reviewer: "human:alice",
            outcome: "approved",
            evidence_refs: ["review.json"],
          }),
        },
        verify: { run: async () => passingReport() },
        orchestrate: {
          dryRun: async () => ({
            participants: [],
            evaluator_auto_added: false,
            engines_available: [],
            models_valid: true,
          }),
          execute: async () => ({ units: [], reviews: [] }),
        },
      },
    });
    expect(bootstrap.service).toBeTruthy();
    expect(bootstrap.authorities.traceStore).toBeTruthy();
    expect(bootstrap.authorities.artifactRegistry).toBeTruthy();
    expect(bootstrap.authorities.artifactStore).toBeTruthy();
    for (const name of ["direct", "debate", "plan", "review", "verify", "orchestrate"]) {
      expect(bootstrap.authorities.policies.require(name).name).toBe(name);
    }
    expect(bootstrap.services.orchestrate).toBeTruthy();
    const created = await bootstrap.service.create({ topic: "Plan this feature" });
    expect(created.result).toEqual({
      operation_id: "operation-1",
      status: "completed",
      artifact_refs: ["artifact-1"],
    });
    const events = await bootstrap.service.events(created.conversation_id, 0);
    expect(events?.some(({ event }) => event.type === "artifact_created")).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
