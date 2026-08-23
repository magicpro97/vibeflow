import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MaterializedAgentBinding, PreviewAgentBinding } from "../../src/agents/binding.js";
import type { WorkUnit } from "../../src/core.js";
import { conversationEnvPolicy } from "../../src/dispatch/env-filter.js";
import { createSpawnOptionsProjection } from "../../src/dispatch/session-types.js";
import { createConversationBootstrap } from "../../src/orchestrator/conversation/bootstrap.js";
import { OrchestrateConversationPolicy } from "../../src/orchestrator/conversation/orchestrate-policy.js";
import { PlanConversationPolicy } from "../../src/orchestrator/conversation/plan-policy.js";
import {
  ReviewConversationPolicy,
  createReviewEvidenceAuthority,
} from "../../src/orchestrator/conversation/review-policy.js";
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
import { VerifyConversationPolicy } from "../../src/orchestrator/conversation/verify-policy.js";

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

function contextHarness(
  messages: Array<{ content: string }> = [],
  beforeCreateArtifact?: () => void,
) {
  const controller = new AbortController();
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
    signal: controller.signal,
    messages: async () => messages,
    emit: async (emission: Record<string, unknown>) => {
      emissions.push(emission);
      return {};
    },
    launchAttempt: () => {
      throw new Error("unexpected attempt");
    },
    createArtifact: async (request: Record<string, unknown>) => {
      beforeCreateArtifact?.();
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
  return { context, controller, emissions, creates, updates };
}

const passingReport = (): PolicyVerifyReport =>
  Object.fromEntries(
    POLICY_VERIFY_GATE_NAMES.map((name) => [
      name,
      { status: "pass", details: `${name} passed`, evidence_refs: [`evidence:${name}`] },
    ]),
  ) as unknown as PolicyVerifyReport;

const completedWorkUnit = (): WorkUnit => ({
  name: "unit-a",
  status: "done",
  confidence: 1,
  gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
  resources: { agents: 1, tokens: 1, cost_usd: 0, wall_seconds: 1 },
  evidence: ["test:unit-a"],
});

const cleanWorktree = async () => ({
  ok: true,
  fingerprint: "worktree-a",
  reason: "review worktree is clean",
});

describe("injected workflow services", () => {
  test("plan create/update persists only through conversation artifact authority", async () => {
    const run = contextHarness();
    const prior = artifact();
    const calls: string[] = [];
    const service = new InjectedPlanService({
      create: async ({ context }) => {
        calls.push(`create:${context.topic}`);
        return { content: "# Plan", revision_id: "untrusted-library-revision" };
      },
      update: async ({ revision, previous }) => {
        calls.push(`update:${revision.reason}:${previous.artifact_id}`);
        return { content: revision.content };
      },
      locate: async () => prior,
    });

    expect(await service.createPlan(run.context)).toEqual({
      artifact_id: "artifact-1",
      revision_id: "revision-1",
      ref: "vf-artifact-1",
    });
    expect(
      await service.updatePlan(run.context, {
        revision_id: "revision-1",
        content: "# Revised plan",
        reason: "review changes",
      }),
    ).toEqual({
      artifact_id: "plan-1",
      revision_id: "revision-1",
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

  test("plan cancellation after the planner await prevents an artifact write", async () => {
    const run = contextHarness();
    const service = new InjectedPlanService({
      create: async () => {
        run.controller.abort();
        return { content: "# Plan" };
      },
    });

    await expect(service.createPlan(run.context)).rejects.toThrow("operation aborted");
    expect(run.creates).toHaveLength(0);
  });

  test("review is human-only, pinned to current HEAD, and publishes only an artifact ref", async () => {
    const run = contextHarness();
    const seen: Record<string, unknown>[] = [];
    const checked: string[] = [];
    const service = new InjectedReviewService(
      {
        review: async (input) => {
          seen.push(input as unknown as Record<string, unknown>);
          return {
            reviewed_head: "a".repeat(40),
            reviewer: "human:alice",
            outcome: "approved",
            evidence_refs: ["/private/review/result.json"],
          };
        },
      },
      {
        currentHead: async () => "a".repeat(40),
        checkWorktree: cleanWorktree,
        checkCurrentHead: async (head) => {
          checked.push(head);
          return { ok: true, reason: "review-evidence(ok)" };
        },
      },
    );

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
    expect(checked).toEqual(["a".repeat(40), "a".repeat(40)]);
    expect(String(run.creates[0]?.content)).not.toContain("/private/review/result.json");
    expect(JSON.parse(String(run.creates[0]?.content))).toMatchObject({
      reviewed_head: "a".repeat(40),
      evidence_check: "review-evidence(ok)",
    });
  });

  test("review rejects invalid HEAD and missing authoritative evidence before publishing", async () => {
    const run = contextHarness();
    const library = {
      review: async ({ head_sha }: { head_sha: string }) => ({
        reviewed_head: head_sha,
        reviewer: "human:alice",
        outcome: "approved" as const,
        evidence_refs: ["missing.json"],
      }),
    };
    await expect(
      new InjectedReviewService(library, {
        currentHead: async () => "not-a-sha",
        checkWorktree: cleanWorktree,
        checkCurrentHead: async () => ({ ok: true, reason: "should not run" }),
      }).requestReview(run.context, artifact()),
    ).rejects.toThrow("review HEAD is invalid");
    await expect(
      new InjectedReviewService(library, {
        currentHead: async () => "a".repeat(40),
        checkWorktree: cleanWorktree,
        checkCurrentHead: async () => ({
          ok: false,
          reason: "review-evidence: record missing",
        }),
      }).requestReview(run.context, artifact()),
    ).rejects.toThrow("review-evidence: record missing");
    expect(run.creates).toHaveLength(0);
  });

  test("review rejects reviewer evidence pinned to a different HEAD", async () => {
    const run = contextHarness();
    const service = new InjectedReviewService(
      {
        review: async () => ({
          reviewed_head: "b".repeat(40),
          reviewer: "human:alice",
          outcome: "approved",
          evidence_refs: ["review.json"],
        }),
      },
      {
        currentHead: async () => "a".repeat(40),
        checkWorktree: cleanWorktree,
        checkCurrentHead: async () => ({ ok: true, reason: "review-evidence(ok)" }),
      },
    );
    await expect(service.requestReview(run.context, artifact())).rejects.toThrow(
      "review HEAD changed",
    );
    expect(run.creates).toHaveLength(0);
  });

  test("review snapshots the validated resolution before evidence and artifact awaits", async () => {
    const run = contextHarness();
    const resolution = {
      reviewed_head: "a".repeat(40),
      reviewer: "human:alice",
      outcome: "approved" as "approved" | "changes_requested",
      evidence_refs: ["/private/review/result.json"],
    };
    const service = new InjectedReviewService(
      { review: async () => resolution },
      {
        currentHead: async () => "a".repeat(40),
        checkWorktree: cleanWorktree,
        checkCurrentHead: async () => {
          resolution.reviewer = "/private/mutated-reviewer";
          resolution.outcome = "changes_requested";
          return { ok: true, reason: "review-evidence(ok)" };
        },
      },
    );

    expect(await service.requestReview(run.context, artifact())).toMatchObject({
      reviewer: "human:alice",
      outcome: "approved",
    });
    expect(JSON.parse(String(run.creates[0]?.content))).toMatchObject({
      reviewer: "human:alice",
      outcome: "approved",
    });
    expect(String(run.creates[0]?.content)).not.toContain("/private/");
  });

  test("review snapshots and freezes the exact plan identity before invoking its library", async () => {
    const run = contextHarness();
    const head = "a".repeat(40);
    const plan = artifact("vf-artifact-plan-original");
    let received: PlanArtifact | undefined;
    const service = new InjectedReviewService(
      {
        review: async (input) => {
          received = input.artifact;
          plan.artifact_id = "mutated-artifact";
          plan.revision_id = "mutated-revision";
          plan.ref = "vf-artifact-mutated";
          return {
            reviewed_head: input.head_sha,
            reviewer: "human:alice",
            outcome: "approved",
            evidence_refs: ["review.json"],
          };
        },
      },
      {
        currentHead: async () => head,
        checkWorktree: cleanWorktree,
        checkCurrentHead: async () => ({ ok: true, reason: "review-evidence(ok)" }),
      },
    );

    expect(await service.requestReview(run.context, plan)).toMatchObject({
      artifact_id: "plan-1",
      outcome: "approved",
    });
    expect(received).not.toBe(plan);
    expect(received).toEqual({
      artifact_id: "plan-1",
      revision_id: "revision-1",
      ref: "vf-artifact-plan-original",
    });
    expect(Object.isFrozen(received)).toBe(true);
    expect(Object.keys(received ?? {})).toEqual(["artifact_id", "revision_id", "ref"]);
    expect(JSON.parse(String(run.creates[0]?.content))).toMatchObject({ artifact_id: "plan-1" });
    expect(run.creates[0]?.idempotency_key).toBe(
      `review-policy:resolution:${createHash("sha256")
        .update(JSON.stringify(["operation-1", "vf-artifact-plan-original", head]))
        .digest("hex")}`,
    );
  });

  test("review revalidates HEAD and worktree after persistence before returning approval", async () => {
    const head = "a".repeat(40);
    for (const mutation of ["head", "worktree"] as const) {
      let persisted = false;
      let evidenceChecks = 0;
      let worktreeChecks = 0;
      const run = contextHarness([], () => {
        persisted = true;
      });
      const service = new InjectedReviewService(
        {
          review: async ({ head_sha }) => ({
            reviewed_head: head_sha,
            reviewer: "human:alice",
            outcome: "approved",
            evidence_refs: ["review.json"],
          }),
        },
        {
          currentHead: async () => head,
          checkCurrentHead: async () => {
            evidenceChecks += 1;
            return persisted && mutation === "head"
              ? { ok: false, reason: "review HEAD changed" }
              : { ok: true, reason: "review-evidence(ok)" };
          },
          checkWorktree: async () => {
            worktreeChecks += 1;
            return {
              ok: true,
              fingerprint: persisted && mutation === "worktree" ? "worktree-b" : "worktree-a",
              reason: "review worktree is clean",
            };
          },
        },
      );
      const policy = new ReviewConversationPolicy(service, async () => artifact());

      expect(await policy.execute(run.context), mutation).toEqual({
        operation_id: "operation-1",
        status: "failed",
        artifact_refs: [],
      });
      expect(run.creates, mutation).toHaveLength(1);
      expect(evidenceChecks, mutation).toBe(2);
      expect(worktreeChecks, mutation).toBe(mutation === "head" ? 2 : 3);
    }
  });

  test("production review authority rejects tracked and untracked dirty worktrees opaquely", async () => {
    const head = "a".repeat(40);
    for (const dirty of [" M src/private.ts\0", "?? private-secret.txt\0"]) {
      const authority = createReviewEvidenceAuthority("/repo", (_repo, args) => {
        if (args[0] === "rev-parse") return { status: 0, stdout: `${head}\n` };
        if (args[0] === "status") return { status: 0, stdout: dirty };
        return { status: 1, stdout: "" };
      });
      const checked = await authority.checkWorktree(head);
      expect(checked).toEqual({
        ok: false,
        fingerprint: "",
        reason: "review worktree is dirty",
      });
      expect(JSON.stringify(checked)).not.toContain(dirty.slice(3, -1));
    }
  });

  test("review rejects a clean worktree fingerprint that changes during the human await", async () => {
    const run = contextHarness();
    const head = "a".repeat(40);
    let changed = false;
    const service = new InjectedReviewService(
      {
        review: async ({ head_sha }) => {
          await Promise.resolve();
          changed = true;
          return {
            reviewed_head: head_sha,
            reviewer: "human:alice",
            outcome: "approved",
            evidence_refs: ["review.json"],
          };
        },
      },
      {
        currentHead: async () => head,
        checkCurrentHead: async () => ({ ok: true, reason: "review-evidence(ok)" }),
        checkWorktree: async () => ({
          ok: true,
          fingerprint: changed ? "worktree-b" : "worktree-a",
          reason: "review worktree is clean",
        }),
      },
    );

    await expect(service.requestReview(run.context, artifact())).rejects.toThrow(
      "review worktree changed",
    );
    expect(run.creates).toHaveLength(0);
  });

  test("review cancellation prevents pre-abort human dispatch and mid-flight artifact writes", async () => {
    const head = "a".repeat(40);
    const makeService = (run: ReturnType<typeof contextHarness>, calls: string[]) =>
      new InjectedReviewService(
        {
          review: async ({ head_sha }) => {
            calls.push("review");
            run.controller.abort();
            return {
              reviewed_head: head_sha,
              reviewer: "human:alice",
              outcome: "approved",
              evidence_refs: ["review.json"],
            };
          },
        },
        {
          currentHead: async () => head,
          checkWorktree: cleanWorktree,
          checkCurrentHead: async () => ({ ok: true, reason: "review-evidence(ok)" }),
        },
      );

    const preAborted = contextHarness();
    const preCalls: string[] = [];
    preAborted.controller.abort();
    await expect(
      makeService(preAborted, preCalls).requestReview(preAborted.context, artifact()),
    ).rejects.toThrow("operation aborted");
    expect(preCalls).toHaveLength(0);
    expect(preAborted.creates).toHaveLength(0);

    const midFlight = contextHarness();
    const midCalls: string[] = [];
    await expect(
      makeService(midFlight, midCalls).requestReview(midFlight.context, artifact()),
    ).rejects.toThrow("operation aborted");
    expect(midCalls).toEqual(["review"]);
    expect(midFlight.creates).toHaveLength(0);
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

  test("verify snapshots and freezes the exact plan identity before invoking its library", async () => {
    const run = contextHarness();
    const plan = artifact("vf-artifact-plan-original");
    let received: Readonly<PlanArtifact> | undefined;
    const service = new InjectedVerifyService({
      run: async (input) => {
        received = input.artifact;
        expect(() => Object.assign(input.artifact, { ref: "vf-artifact-forged" })).toThrow();
        plan.artifact_id = "mutated-artifact";
        plan.revision_id = "mutated-revision";
        plan.ref = "vf-artifact-mutated";
        return passingReport();
      },
    });

    await service.runVerify(run.context, plan);
    expect(received).not.toBe(plan);
    expect(received).toEqual({
      artifact_id: "plan-1",
      revision_id: "revision-1",
      ref: "vf-artifact-plan-original",
    });
    expect(Object.isFrozen(received)).toBe(true);
    expect(Object.keys(received ?? {})).toEqual(["artifact_id", "revision_id", "ref"]);
  });

  test("verify snapshots accessor-backed reports before validating and deeply freezing", async () => {
    const run = contextHarness();
    const report = passingReport();
    let statusReads = 0;
    Object.defineProperty(report.confidence, "status", {
      configurable: true,
      enumerable: true,
      get: () => {
        statusReads += 1;
        return statusReads === 1 ? "pass" : "bogus";
      },
    });

    const snapshot = await new InjectedVerifyService({ run: async () => report }).runVerify(
      run.context,
      artifact(),
    );
    expect(snapshot.confidence.status).toBe("pass");
    expect(statusReads).toBe(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.confidence)).toBe(true);
    expect(Object.isFrozen(snapshot.confidence.evidence_refs)).toBe(true);
  });

  test("verify rejects non-exact, sparse, over-count, and oversized gate DTOs", async () => {
    const run = contextHarness();
    const extra = passingReport();
    Object.assign(extra.toolchain, { private_ref: "/private/verify.json" });
    const sparse = passingReport();
    sparse.confidence.evidence_refs = new Array(1);
    const overCount = passingReport();
    overCount.evidence.evidence_refs = Array.from({ length: 513 }, (_, index) => `ref-${index}`);
    const oversizedDetails = passingReport();
    oversizedDetails.scope.details = "é".repeat(32_769);
    const oversizedReference = passingReport();
    oversizedReference.test_evidence.evidence_refs = ["é".repeat(2_049)];

    for (const [name, report] of [
      ["extra", extra],
      ["sparse", sparse],
      ["over-count", overCount],
      ["oversized-details", oversizedDetails],
      ["oversized-reference", oversizedReference],
    ] as const) {
      await expect(
        new InjectedVerifyService({ run: async () => report }).runVerify(run.context, artifact()),
        name,
      ).rejects.toThrow("full structured verify report");
    }
    expect(run.creates).toHaveLength(0);
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
        return {
          units: [completedWorkUnit()],
          reviews: [{ unit: "unit-a", pass: true, reason: "approved" }],
        };
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

  test("orchestrate cancellation prevents pre-abort dispatch and mid-flight artifact writes", async () => {
    const preAborted = contextHarness();
    let preDispatches = 0;
    const preService = new InjectedOrchestrateService({
      dryRun: async () => ({}) as never,
      execute: async () => {
        preDispatches += 1;
        return { units: [], reviews: [] };
      },
    });
    preAborted.controller.abort();
    expect(
      await preService.execute(preAborted.context, {
        ...orchestrationApprovalToken(preAborted.context),
        outcome: "approve",
        reason: null,
      }),
    ).toEqual({
      operation_id: "operation-1",
      status: "aborted",
      artifact_refs: [],
    });
    expect(preDispatches).toBe(0);
    expect(preAborted.creates).toHaveLength(0);

    const midFlight = contextHarness();
    const midService = new InjectedOrchestrateService({
      dryRun: async () => ({}) as never,
      execute: async () => {
        midFlight.controller.abort();
        return { units: [], reviews: [] };
      },
    });
    expect(
      await midService.execute(midFlight.context, {
        ...orchestrationApprovalToken(midFlight.context),
        outcome: "approve",
        reason: null,
      }),
    ).toEqual({
      operation_id: "operation-1",
      status: "aborted",
      artifact_refs: [],
    });
    expect(midFlight.creates).toHaveLength(0);
  });

  test("orchestrate requires exactly one passing review per non-empty executed unit", async () => {
    const run = contextHarness();
    const decision = {
      ...orchestrationApprovalToken(run.context),
      outcome: "approve" as const,
      reason: null,
    };
    const execute = (output: {
      units: Array<{ name: string; status: string; evidence?: string[] }>;
      reviews: Array<{ unit: string; pass: boolean; reason: string }>;
    }) =>
      new InjectedOrchestrateService({
        dryRun: async () => ({
          participants: [],
          evaluator_auto_added: false,
          engines_available: [],
          models_valid: true,
        }),
        execute: async () => output as never,
      }).execute(run.context, decision);

    expect(
      await execute({ units: [{ name: "unit-a", status: "done" }], reviews: [] }),
    ).toMatchObject({ status: "failed" });
    expect(
      await execute({
        units: [{ name: "unit-a", status: "done" }],
        reviews: [
          { unit: "unit-a", pass: true, reason: "ok" },
          { unit: "unit-extra", pass: true, reason: "not executed" },
        ],
      }),
    ).toMatchObject({ status: "failed" });
    expect(
      await execute({
        units: [{ name: "unit-a", status: "done", evidence: ["/private/evidence.json"] }],
        reviews: [{ unit: "unit-a", pass: true, reason: "/private/review.json" }],
      }),
    ).toMatchObject({ status: "completed" });
    expect(await execute({ units: [], reviews: [] })).toMatchObject({ status: "failed" });
    expect(run.creates.every(({ content }) => !String(content).includes("/private/"))).toBe(true);
  });

  test("orchestrate snapshots and validates one result before persisting and gating it", async () => {
    const output = {
      units: [{ name: "unit-a", status: "done" }],
      reviews: [{ unit: "unit-a", pass: false, reason: "failed review" }],
    };
    const run = contextHarness([], () => {
      const review = output.reviews[0];
      if (!review) throw new Error("missing mutable review fixture");
      review.pass = true;
    });
    const decision = {
      ...orchestrationApprovalToken(run.context),
      outcome: "approve" as const,
      reason: null,
    };
    const service = new InjectedOrchestrateService({
      dryRun: async () => ({
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      }),
      execute: async () => output as never,
    });

    expect(await service.execute(run.context, decision)).toMatchObject({ status: "failed" });
    expect(JSON.parse(String(run.creates[0]?.content))).toMatchObject({
      reviews: [{ unit: "unit-a", pass: false }],
    });
    const malformed = new InjectedOrchestrateService({
      dryRun: async () => service.dryRun(run.context),
      execute: async () => ({ units: null, reviews: [] }) as never,
    });
    await expect(malformed.execute(run.context, decision)).rejects.toThrow(
      "invalid orchestration result",
    );
    expect(run.creates).toHaveLength(1);
  });

  test("orchestrate rejects sparse, over-count, and oversized runner output before persistence", async () => {
    const run = contextHarness();
    const decision = {
      ...orchestrationApprovalToken(run.context),
      outcome: "approve" as const,
      reason: null,
    };
    const execute = (output: unknown) =>
      new InjectedOrchestrateService({
        dryRun: async () => ({}) as never,
        execute: async () => output as never,
      }).execute(run.context, decision);
    const sparse = new Array(1);
    const tooMany = Array.from({ length: 513 }, (_, index) => ({
      name: `unit-${index}`,
      status: "done",
    }));

    await expect(execute({ units: sparse, reviews: [] })).rejects.toThrow(
      "invalid orchestration result",
    );
    await expect(execute({ units: tooMany, reviews: [] })).rejects.toThrow(
      "invalid orchestration result",
    );
    await expect(
      execute({
        units: [{ name: "é".repeat(2049), status: "done" }],
        reviews: [{ unit: "unit-a", pass: true, reason: "ok" }],
      }),
    ).rejects.toThrow("invalid orchestration result");
    await expect(
      execute({
        units: [{ name: "unit-a", status: "done" }],
        reviews: [{ unit: "unit-a", pass: true, reason: "é".repeat(32_769) }],
      }),
    ).rejects.toThrow("invalid orchestration result");
    expect(run.creates).toHaveLength(0);
  });
});

test("plan policy creates a plan, requests approval, then reviews and verifies existing work", async () => {
  const run = contextHarness();
  let current: PlanArtifact | null = null;
  const calls: string[] = [];
  const policy = new PlanConversationPolicy(
    {
      createPlan: async () => {
        calls.push("plan:create");
        current = artifact("vf-artifact-plan-created");
        return current;
      },
      updatePlan: async () => {
        throw new Error("unexpected update");
      },
    },
    async () => current,
    {
      orchestrate: {
        name: "orchestrate",
        dryRun: async () => ({
          participants: [],
          evaluator_auto_added: false,
          engines_available: [],
          models_valid: true,
        }),
        execute: async () => {
          calls.push("orchestrate:approval");
          return {
            operation_id: "operation-1",
            status: "awaiting_approval",
            artifact_refs: [],
          };
        },
        continueAfterApproval: async () => {
          calls.push("orchestrate:execute");
          return {
            operation_id: "operation-1",
            status: "completed",
            artifact_refs: ["vf-artifact-work"],
          };
        },
      },
      review: {
        name: "review",
        dryRun: async () => {
          throw new Error("unexpected dry run");
        },
        execute: async () => {
          calls.push("review");
          return {
            operation_id: "operation-1",
            status: "completed",
            artifact_refs: ["vf-artifact-review"],
          };
        },
      },
      verify: {
        name: "verify",
        dryRun: async () => {
          throw new Error("unexpected dry run");
        },
        execute: async () => {
          calls.push("verify");
          return {
            operation_id: "operation-1",
            status: "completed",
            artifact_refs: ["vf-artifact-verify"],
          };
        },
      },
    },
  );

  expect(await policy.execute(run.context)).toEqual({
    operation_id: "operation-1",
    status: "awaiting_approval",
    artifact_refs: ["vf-artifact-plan-created"],
  });
  expect(await policy.execute(run.context)).toEqual({
    operation_id: "operation-1",
    status: "awaiting_approval",
    artifact_refs: ["vf-artifact-plan-created"],
  });
  expect(
    await policy.continueAfterApproval?.(run.context, {
      ...orchestrationApprovalToken(run.context),
      outcome: "approve",
      reason: null,
    }),
  ).toEqual({
    operation_id: "operation-1",
    status: "completed",
    artifact_refs: [
      "vf-artifact-plan-created",
      "vf-artifact-work",
      "vf-artifact-review",
      "vf-artifact-verify",
    ],
  });
  expect(calls).toEqual([
    "plan:create",
    "orchestrate:approval",
    "orchestrate:approval",
    "orchestrate:execute",
    "review",
    "verify",
  ]);
});

test("passing runner reviews cannot replace canonical current-HEAD human review", async () => {
  const run = contextHarness();
  const head = "a".repeat(40);
  let verifyCalls = 0;
  const orchestrate = new OrchestrateConversationPolicy(
    new InjectedOrchestrateService({
      dryRun: async () => ({
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      }),
      execute: async () => ({
        units: [
          {
            name: "unit-a",
            status: "done",
            confidence: 1,
            gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
            resources: { agents: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
          },
        ],
        reviews: [{ unit: "unit-a", pass: true, reason: "runner gate passed" }],
      }),
    }),
  );
  const review = new ReviewConversationPolicy(
    new InjectedReviewService(
      {
        review: async ({ head_sha }) => ({
          reviewed_head: head_sha,
          reviewer: "human:alice",
          outcome: "approved",
          evidence_refs: ["review.json"],
        }),
      },
      {
        currentHead: async () => head,
        checkWorktree: cleanWorktree,
        checkCurrentHead: async () => ({
          ok: false,
          reason: "review-evidence: record missing",
        }),
      },
    ),
    async () => artifact(),
  );
  const policy = new PlanConversationPolicy({} as never, async () => artifact(), {
    orchestrate,
    review,
    verify: {
      name: "verify",
      dryRun: async () => ({}) as never,
      execute: async () => {
        verifyCalls += 1;
        return {
          operation_id: "operation-1",
          status: "completed",
          artifact_refs: ["vf-artifact-verify"],
        };
      },
    },
  });

  expect(
    await policy.continueAfterApproval?.(run.context, {
      ...orchestrationApprovalToken(run.context),
      outcome: "approve",
      reason: null,
    }),
  ).toEqual({
    operation_id: "operation-1",
    status: "failed",
    artifact_refs: [],
  });
  expect(JSON.parse(String(run.creates[0]?.content))).toMatchObject({
    reviews: [{ unit: "unit-a", pass: true }],
  });
  expect(run.creates).toHaveLength(1);
  expect(verifyCalls).toBe(0);
});

test("plan policy updates an ancestor once and reuses the current revision on retry", async () => {
  const run = contextHarness([{ content: "Revise the rollout section" }]);
  let current = { ...artifact("vf-artifact-parent-plan"), revision_id: "revision-parent" };
  const revisions: Array<Record<string, unknown>> = [];
  const policy = new PlanConversationPolicy(
    {
      createPlan: async () => {
        throw new Error("unexpected create");
      },
      updatePlan: async (_context, revision) => {
        revisions.push(revision as unknown as Record<string, unknown>);
        current = {
          ...current,
          revision_id: revision.revision_id,
          ref: "vf-artifact-revised-plan",
        };
        return current;
      },
    },
    async () => current,
    {
      orchestrate: {
        name: "orchestrate",
        dryRun: async () => {
          throw new Error("unexpected dry run");
        },
        execute: async () => ({
          operation_id: "operation-1",
          status: "awaiting_approval",
          artifact_refs: [],
        }),
        continueAfterApproval: async () => {
          throw new Error("unexpected continuation");
        },
      },
      review: {} as never,
      verify: {} as never,
    },
  );

  expect(await policy.execute(run.context)).toMatchObject({
    status: "awaiting_approval",
    artifact_refs: ["vf-artifact-revised-plan"],
  });
  expect(await policy.execute(run.context)).toMatchObject({
    status: "awaiting_approval",
    artifact_refs: ["vf-artifact-revised-plan"],
  });
  expect(revisions).toEqual([
    {
      revision_id: "revision-1",
      content: "Revise the rollout section",
      reason: "conversation revision",
    },
  ]);
});

test("plan approval continuation rejects every foreign operation before downstream work", async () => {
  const run = contextHarness();
  let foreignStatus: "completed" | "aborted" | "failed" | "awaiting_approval" = "completed";
  let downstream = 0;
  const policy = new PlanConversationPolicy({} as never, async () => artifact(), {
    orchestrate: {
      name: "orchestrate",
      dryRun: async () => ({}) as never,
      execute: async () => ({}) as never,
      continueAfterApproval: async () => ({
        operation_id: "operation-foreign",
        status: foreignStatus,
        artifact_refs: ["vf-artifact-foreign"],
      }),
    },
    review: {
      name: "review",
      dryRun: async () => ({}) as never,
      execute: async () => {
        downstream += 1;
        return {} as never;
      },
    },
    verify: {} as never,
  });
  const decision = {
    ...orchestrationApprovalToken(run.context),
    outcome: "approve" as const,
    reason: null,
  };

  for (const status of ["completed", "aborted", "failed", "awaiting_approval"] as const) {
    foreignStatus = status;
    expect(await policy.continueAfterApproval?.(run.context, decision)).toEqual({
      operation_id: "operation-1",
      status: "failed",
      artifact_refs: [],
    });
  }
  expect(downstream).toBe(0);
});

test("plan approval continuation stops downstream policies after mid-flight cancellation", async () => {
  const run = contextHarness();
  let reviews = 0;
  let verifies = 0;
  const policy = new PlanConversationPolicy({} as never, async () => artifact(), {
    orchestrate: {
      name: "orchestrate",
      dryRun: async () => ({}) as never,
      execute: async () => ({}) as never,
      continueAfterApproval: async () => {
        run.controller.abort();
        return {
          operation_id: "operation-1",
          status: "completed",
          artifact_refs: ["vf-artifact-work"],
        };
      },
    },
    review: {
      name: "review",
      dryRun: async () => ({}) as never,
      execute: async () => {
        reviews += 1;
        return {} as never;
      },
    },
    verify: {
      name: "verify",
      dryRun: async () => ({}) as never,
      execute: async () => {
        verifies += 1;
        return {} as never;
      },
    },
  });

  expect(
    await policy.continueAfterApproval?.(run.context, {
      ...orchestrationApprovalToken(run.context),
      outcome: "approve",
      reason: null,
    }),
  ).toEqual({
    operation_id: "operation-1",
    status: "aborted",
    artifact_refs: [],
  });
  expect(reviews).toBe(0);
  expect(verifies).toBe(0);
});

test("verify policy uses core blocking semantics for terminal status", async () => {
  const blocking = passingReport();
  blocking.confidence = { status: "fail", details: "confidence 0.9", evidence_refs: [] };
  const failedRun = contextHarness();
  const failed = new VerifyConversationPolicy({ runVerify: async () => blocking }, async () =>
    artifact(),
  );
  expect(await failed.execute(failedRun.context)).toMatchObject({
    status: "failed",
    artifact_refs: [],
  });
  expect(failedRun.creates).toHaveLength(1);

  const advisory = passingReport();
  advisory.advisory_e2e = { status: "fail", details: "advisory", evidence_refs: [] };
  const advisoryRun = contextHarness();
  const allowed = new VerifyConversationPolicy({ runVerify: async () => advisory }, async () =>
    artifact(),
  );
  expect(await allowed.execute(advisoryRun.context)).toMatchObject({ status: "completed" });
});

test("verify policy does not write an artifact after cancellation during the runner", async () => {
  const run = contextHarness();
  const policy = new VerifyConversationPolicy(
    {
      runVerify: async () => {
        run.controller.abort();
        return passingReport();
      },
    },
    async () => artifact(),
  );

  expect(await policy.execute(run.context)).toEqual({
    operation_id: "operation-1",
    status: "aborted",
    artifact_refs: [],
  });
  expect(run.creates).toHaveLength(0);
});

test("production review authority delegates to current-HEAD review evidence and fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-review-authority-"));
  try {
    const head = "a".repeat(40);
    const gitCalls: string[][] = [];
    const authority = createReviewEvidenceAuthority(root, (_repo, args) => {
      gitCalls.push(args);
      return args[0] === "rev-parse"
        ? { status: 0, stdout: `${head}\n` }
        : { status: 1, stdout: "" };
    });
    expect(await authority.currentHead()).toBe(head);
    expect(await authority.checkCurrentHead(head)).toEqual({
      ok: false,
      reason: "review-evidence: record missing",
    });
    expect(gitCalls.filter((args) => args[0] === "rev-parse").length).toBeGreaterThanOrEqual(4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
    const revisions: string[] = [];
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
      reviewEvidenceAuthority: {
        currentHead: async () => "a".repeat(40),
        checkWorktree: cleanWorktree,
        checkCurrentHead: async () => ({ ok: true, reason: "review-evidence(ok)" }),
      },
      libraries: {
        plan: {
          create: async () => ({ content: "# Plan" }),
          update: async ({ revision }) => {
            revisions.push(revision.content);
            return { content: `# Revised\n${revision.content}` };
          },
        },
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
          execute: async () => ({
            units: [completedWorkUnit()],
            reviews: [{ unit: "unit-a", pass: true, reason: "approved" }],
          }),
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
      status: "awaiting_approval",
      artifact_refs: ["artifact-1"],
    });
    let events = await bootstrap.service.events(created.conversation_id, 0);
    expect(events?.some(({ event }) => event.type === "artifact_created")).toBe(true);
    const request = events?.find(({ event }) => event.type === "approval_requested");
    if (request?.event.type !== "approval_requested") throw new Error("approval not requested");
    expect(
      await bootstrap.service.resolveApproval(created.conversation_id, {
        ...request.event.payload.token,
        outcome: "approve",
        reason: null,
      }),
    ).toMatchObject({ status: 202 });
    for (let index = 0; index < 100; index += 1) {
      if ((await bootstrap.service.snapshot(created.conversation_id))?.lifecycle === "COMPLETED") {
        break;
      }
      await Bun.sleep(2);
    }
    events = await bootstrap.service.events(created.conversation_id, 0);
    expect((await bootstrap.service.snapshot(created.conversation_id))?.lifecycle).toBe(
      "COMPLETED",
    );
    expect(events?.filter(({ event }) => event.type === "artifact_created")).toHaveLength(4);
    expect(events?.some(({ event }) => event.type === "approval_resolved")).toBe(true);

    const revised = await bootstrap.service.message(created.conversation_id, {
      content: "Revise the rollout section",
    });
    if (!revised.child_conversation_id) throw new Error("revision child not created");
    let childEvents = await bootstrap.service.events(revised.child_conversation_id, 0);
    for (let index = 0; index < 100; index += 1) {
      if (childEvents?.some(({ event }) => event.type === "approval_requested")) break;
      await Bun.sleep(2);
      childEvents = await bootstrap.service.events(revised.child_conversation_id, 0);
    }
    expect(revisions).toEqual(["Revise the rollout section"]);
    expect(childEvents?.some(({ event }) => event.type === "artifact_updated")).toBe(true);
    expect(childEvents?.some(({ event }) => event.type === "approval_requested")).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
