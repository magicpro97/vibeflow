import { createHash } from "node:crypto";
import {
  type PolicyVerifyReport,
  VERIFY_GATE_ORDER,
  type VerifyGateResult,
} from "../../verify/core.js";
import type { OrchestrationResult } from "../run.js";
import { TRACE_LIMITS, utf8Bytes } from "../trace/limits.js";
import {
  type OrchestrationResultSnapshot,
  orchestrationArtifactSummary,
  snapshotOrchestrationResult,
} from "./orchestrate-policy.js";
import type {
  ApprovalDecision,
  ApprovalToken,
  ConversationContext,
  ConversationOrchestrationResult,
  DryRunResult,
  OperationCancelCommand,
  OperationCancelResult,
} from "./types.js";
export interface PlanArtifact {
  artifact_id: string;
  revision_id: string;
  ref: string;
}

export interface PlanRevision {
  revision_id: string;
  content: string;
  reason: string | null;
}

export interface ReviewResolution {
  artifact_id: string;
  reviewer: string;
  outcome: "approved" | "changes_requested";
  evidence_refs: string[];
}

export type { PolicyVerifyReport, VerifyGateResult } from "../../verify/core.js";
export const POLICY_VERIFY_GATE_NAMES = VERIFY_GATE_ORDER;
export type PolicyVerifyGateName = (typeof POLICY_VERIFY_GATE_NAMES)[number];

export interface PlanService {
  createPlan(context: ConversationContext): Promise<PlanArtifact>;
  updatePlan(context: ConversationContext, revision: PlanRevision): Promise<PlanArtifact>;
}

export interface ReviewService {
  requestReview(context: ConversationContext, artifact: PlanArtifact): Promise<ReviewResolution>;
}

export interface VerifyService {
  runVerify(context: ConversationContext, artifact: PlanArtifact): Promise<PolicyVerifyReport>;
}

export interface OrchestrateService {
  dryRun(context: ConversationContext): Promise<DryRunResult>;
  execute(
    context: ConversationContext,
    approval: ApprovalDecision | null,
    artifact?: PlanArtifact,
  ): Promise<ConversationOrchestrationResult>;
  cancel(command: OperationCancelCommand): Promise<OperationCancelResult>;
}

export {
  InjectedReviewService,
  type ReviewEvidenceAuthority,
  type ReviewLibrary,
  type ReviewLibraryResult,
  type ReviewWorktreeCheck,
} from "./review-service.js";

export type PlanArtifactLocator = (
  context: ConversationContext,
) => Promise<PlanArtifact | null> | PlanArtifact | null;

export interface PlanLibrary {
  create(input: {
    context: ConversationContext;
  }): Promise<{ content: string; revision_id?: string }>;
  update?(input: {
    context: ConversationContext;
    revision: PlanRevision;
    previous: PlanArtifact;
  }): Promise<{ content: string }>;
}

const hashKey = (prefix: string, values: readonly unknown[]): string =>
  `${prefix}:${createHash("sha256").update(JSON.stringify(values)).digest("hex")}`;

function assertContent(value: unknown, kind: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${kind} content is empty`);
}

const snapshotPlan = (value: PlanArtifact | null): Readonly<PlanArtifact> => {
  const plan = structuredClone({
    artifact_id: value?.artifact_id,
    revision_id: value?.revision_id,
    ref: value?.ref,
  });
  if (!plan.artifact_id || !plan.revision_id || !plan.ref) {
    throw new Error("plan artifact not found");
  }
  return Object.freeze(plan) as Readonly<PlanArtifact>;
};

const assertActive = (context: ConversationContext): void => {
  if (context.signal.aborted) throw new Error("operation aborted");
};

/** Injected adapter over the existing planner library; context remains the sole artifact writer. */
export class InjectedPlanService implements PlanService {
  constructor(
    private readonly options: PlanLibrary & {
      locate?: PlanArtifactLocator;
    },
  ) {}

  async createPlan(context: ConversationContext): Promise<PlanArtifact> {
    assertActive(context);
    const output = await this.options.create({ context });
    assertActive(context);
    assertContent(output.content, "plan");
    const revisionId = context.correlation.revision_id;
    if (!revisionId) throw new Error("plan revision is missing");
    const created = await context.createArtifact({
      artifact_type: "plan",
      content: output.content,
      idempotency_key: hashKey("plan-policy:create", [
        context.correlation.operation_id,
        revisionId,
      ]),
    });
    return { artifact_id: created.artifact_id, revision_id: revisionId, ref: created.ref };
  }

  async updatePlan(context: ConversationContext, revision: PlanRevision): Promise<PlanArtifact> {
    assertActive(context);
    if (
      !revision?.revision_id ||
      revision.revision_id !== context.correlation.revision_id ||
      !revision.content.trim()
    )
      throw new Error("invalid plan revision");
    if (!this.options.update || !this.options.locate) throw new Error("plan update is unavailable");
    const previous = snapshotPlan(await this.options.locate(context));
    assertActive(context);
    const output = await this.options.update({ context, revision, previous });
    assertActive(context);
    assertContent(output.content, "plan");
    const updated = await context.updateArtifact({
      artifact_id: previous.artifact_id,
      artifact_type: "plan",
      content: output.content,
      previous_ref: previous.ref as never,
      idempotency_key: hashKey("plan-policy:update", [
        context.correlation.operation_id,
        previous.ref,
        revision.revision_id,
      ]),
    });
    return {
      artifact_id: updated.artifact_id,
      revision_id: revision.revision_id,
      ref: updated.ref,
    };
  }
}

export interface VerifyLibrary {
  run(input: {
    context: ConversationContext;
    artifact: Readonly<PlanArtifact>;
  }): Promise<PolicyVerifyReport>;
}

const verifyStatus = new Set<VerifyGateResult["status"]>(["pass", "fail", "warn", "skipped"]);
const verifyGateKeys = new Set(["status", "details", "evidence_refs"]);

const denseVerifyRefs = (value: unknown): value is string[] => {
  if (!Array.isArray(value) || value.length > TRACE_LIMITS.maxArrayItems) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (
      !Object.hasOwn(value, index) ||
      typeof value[index] !== "string" ||
      utf8Bytes(value[index]) > TRACE_LIMITS.maxReferenceBytes
    ) {
      return false;
    }
  }
  return true;
};

const projectVerifyReport = (value: unknown): PolicyVerifyReport => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("verify did not return the full structured verify report");
  }
  const report = value as Record<string, unknown>;
  if (
    Object.keys(report).length !== POLICY_VERIFY_GATE_NAMES.length ||
    POLICY_VERIFY_GATE_NAMES.some((name) => !Object.hasOwn(report, name))
  ) {
    throw new Error("verify did not return the full structured verify report");
  }
  const projected = {} as PolicyVerifyReport;
  for (const name of POLICY_VERIFY_GATE_NAMES) {
    const gate = report[name] as Record<string, unknown> | null;
    if (
      !gate ||
      typeof gate !== "object" ||
      Array.isArray(gate) ||
      Object.keys(gate).length !== verifyGateKeys.size ||
      Object.keys(gate).some((key) => !verifyGateKeys.has(key)) ||
      typeof gate.status !== "string" ||
      !verifyStatus.has(gate.status as VerifyGateResult["status"]) ||
      typeof gate.details !== "string" ||
      utf8Bytes(gate.details) > TRACE_LIMITS.maxTextBytes ||
      !denseVerifyRefs(gate.evidence_refs)
    ) {
      throw new Error("verify did not return the full structured verify report");
    }
    const evidenceRefs = Object.freeze([...gate.evidence_refs]) as string[];
    projected[name] = Object.freeze({
      status: gate.status as VerifyGateResult["status"],
      details: gate.details,
      evidence_refs: evidenceRefs,
    });
  }
  return Object.freeze(projected);
};

export class InjectedVerifyService implements VerifyService {
  constructor(private readonly library: VerifyLibrary) {}

  async runVerify(
    context: ConversationContext,
    artifact: PlanArtifact,
  ): Promise<PolicyVerifyReport> {
    const plan = snapshotPlan(artifact);
    if (context.signal.aborted) throw new Error("operation aborted");
    const report = structuredClone(await this.library.run({ context, artifact: plan })) as unknown;
    if (context.signal.aborted) throw new Error("operation aborted");
    return projectVerifyReport(report);
  }
}

export interface OrchestrateLibrary {
  dryRun(context: ConversationContext): Promise<DryRunResult>;
  execute(input: {
    context: ConversationContext;
    approval: ApprovalDecision;
    artifact?: Readonly<PlanArtifact>;
  }): Promise<OrchestrationResult>;
  cancel?(command: OperationCancelCommand): Promise<OperationCancelResult>;
}

export const orchestrationApprovalToken = (
  context: ConversationContext,
  actor = "user",
): ApprovalToken => ({
  approval_id: hashKey("approval", [
    context.correlation.conversation_id,
    context.correlation.operation_id,
  ]),
  operation_id: context.correlation.operation_id,
  actor,
});

const orchestrationPassed = (output: OrchestrationResultSnapshot): boolean => {
  if (output.units.length === 0) return false;
  if (output.units.length !== output.reviews.length) return false;
  const units = new Map(output.units.map((unit) => [unit.name, unit]));
  const reviews = new Map(output.reviews.map((review) => [review.unit, review]));
  if (units.size !== output.units.length || reviews.size !== output.reviews.length) return false;
  return [...units].every(
    ([name, unit]) => unit.status === "done" && reviews.get(name)?.pass === true,
  );
};

/** Structured facade over the existing work-unit runner; it never launches a nested vf process. */
export class InjectedOrchestrateService implements OrchestrateService {
  constructor(
    private readonly library: OrchestrateLibrary,
    private readonly actor = "user",
  ) {}

  async dryRun(context: ConversationContext): Promise<DryRunResult> {
    return Object.freeze(structuredClone(await this.library.dryRun(context)));
  }

  async execute(
    context: ConversationContext,
    approval: ApprovalDecision | null,
    artifact?: PlanArtifact,
  ): Promise<ConversationOrchestrationResult> {
    const aborted = (): ConversationOrchestrationResult => ({
      operation_id: context.correlation.operation_id,
      status: "aborted",
      artifact_refs: [],
    });
    if (context.signal.aborted) return aborted();
    const token = orchestrationApprovalToken(context, this.actor);
    if (!approval) {
      await context.emit({
        idempotency_key: hashKey("orchestrate-policy:approval", [token.approval_id]),
        event: {
          type: "approval_requested",
          payload: { token, description: "Execute the current VibeFlow work units" },
        },
      });
      if (context.signal.aborted) return aborted();
      return {
        operation_id: context.correlation.operation_id,
        status: "awaiting_approval",
        artifact_refs: [],
      };
    }
    if (
      approval.approval_id !== token.approval_id ||
      approval.operation_id !== token.operation_id ||
      approval.actor !== token.actor
    ) {
      throw new Error("orchestration approval mismatch");
    }
    if (approval.outcome === "reject") {
      return {
        operation_id: context.correlation.operation_id,
        status: "aborted",
        artifact_refs: [],
      };
    }
    const plan = artifact ? snapshotPlan(artifact) : undefined;
    const untrusted = await this.library.execute({
      context,
      approval,
      ...(plan ? { artifact: plan } : {}),
    });
    if (context.signal.aborted) return aborted();
    const output = snapshotOrchestrationResult(untrusted);
    if (context.signal.aborted) return aborted();
    const summary = await context.createArtifact({
      artifact_type: "tests",
      content: orchestrationArtifactSummary(output),
      idempotency_key: hashKey("orchestrate-policy:result", [
        context.correlation.operation_id,
        approval.approval_id,
      ]),
    });
    const passed = orchestrationPassed(output);
    const status = context.signal.aborted ? "aborted" : passed ? "completed" : "failed";
    return {
      operation_id: context.correlation.operation_id,
      status,
      artifact_refs: status === "completed" ? [summary.ref] : [],
    };
  }

  cancel(command: OperationCancelCommand): Promise<OperationCancelResult> {
    if (!this.library.cancel) throw new Error("operation cancellation authority is unavailable");
    return this.library.cancel(structuredClone(command));
  }
}

export function policyDryRun(context: ConversationContext): DryRunResult {
  const engines = new Set<(typeof context.bindings)[number]["engine"]>();
  const participants = context.bindings.map((binding, index) => {
    const readiness = context.bindingReadiness[index];
    if (readiness?.engine_available) engines.add(binding.engine);
    return {
      participant_id: context.participantIds[index] ?? "",
      role_ref: binding.role.spec.name,
      engine: binding.engine,
      model: binding.model,
      engine_available: readiness?.engine_available ?? false,
      model_valid: readiness?.model_valid ?? false,
    };
  });
  return {
    participants,
    evaluator_auto_added: context.evaluatorAutoAdded,
    engines_available: [...engines],
    models_valid:
      participants.length > 0 && participants.every((participant) => participant.model_valid),
  };
}
