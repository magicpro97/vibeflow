import { createHash } from "node:crypto";
import {
  type PolicyVerifyReport,
  VERIFY_GATE_ORDER,
  type VerifyGateResult,
} from "../../verify/core.js";
import type { OrchestrationResult } from "../run.js";
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
  ): Promise<ConversationOrchestrationResult>;
  cancel(command: OperationCancelCommand): Promise<OperationCancelResult>;
}

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

const assertPlan = (value: PlanArtifact | null): PlanArtifact => {
  if (!value?.artifact_id || !value.revision_id || !value.ref) {
    throw new Error("plan artifact not found");
  }
  return value;
};

/** Injected adapter over the existing planner library; context remains the sole artifact writer. */
export class InjectedPlanService implements PlanService {
  constructor(
    private readonly options: PlanLibrary & {
      locate?: PlanArtifactLocator;
    },
  ) {}

  async createPlan(context: ConversationContext): Promise<PlanArtifact> {
    const output = await this.options.create({ context });
    assertContent(output.content, "plan");
    const revisionId = output.revision_id ?? context.correlation.revision_id;
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
    if (!revision?.revision_id || !revision.content.trim())
      throw new Error("invalid plan revision");
    if (!this.options.update || !this.options.locate) throw new Error("plan update is unavailable");
    const previous = assertPlan(await this.options.locate(context));
    const output = await this.options.update({ context, revision, previous });
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

export interface ReviewLibraryResult {
  reviewed_head: string;
  reviewer: string;
  outcome: "approved" | "changes_requested";
  evidence_refs: readonly string[];
}

export interface ReviewLibrary {
  currentHead(): Promise<string> | string;
  review(input: {
    context: ConversationContext;
    artifact: PlanArtifact;
    mode: "human-only";
    head_sha: string;
  }): Promise<ReviewLibraryResult>;
}

const validReview = (value: ReviewLibraryResult): boolean =>
  Boolean(
    value?.reviewed_head &&
      value.reviewer &&
      (value.outcome === "approved" || value.outcome === "changes_requested") &&
      Array.isArray(value.evidence_refs) &&
      value.evidence_refs.length > 0 &&
      value.evidence_refs.every((ref) => typeof ref === "string" && ref.length > 0),
  );

/** Keeps legacy review HUMAN-ONLY and pins its evidence to one immutable HEAD. */
export class InjectedReviewService implements ReviewService {
  constructor(private readonly library: ReviewLibrary) {}

  async requestReview(
    context: ConversationContext,
    artifact: PlanArtifact,
  ): Promise<ReviewResolution> {
    assertPlan(artifact);
    const head = await this.library.currentHead();
    if (!head) throw new Error("review HEAD is unavailable");
    const resolution = await this.library.review({
      context,
      artifact,
      mode: "human-only",
      head_sha: head,
    });
    const finalHead = await this.library.currentHead();
    if (finalHead !== head || resolution.reviewed_head !== head) {
      throw new Error("review HEAD changed");
    }
    if (!validReview(resolution)) throw new Error("invalid human review resolution");
    const stored = await context.createArtifact({
      artifact_type: "transcript",
      content: `${JSON.stringify({ artifact_id: artifact.artifact_id, ...resolution })}\n`,
      idempotency_key: hashKey("review-policy:resolution", [
        context.correlation.operation_id,
        artifact.ref,
        head,
      ]),
    });
    return {
      artifact_id: artifact.artifact_id,
      reviewer: resolution.reviewer,
      outcome: resolution.outcome,
      evidence_refs: [stored.ref],
    };
  }
}

export interface VerifyLibrary {
  run(input: {
    context: ConversationContext;
    artifact: PlanArtifact;
  }): Promise<PolicyVerifyReport>;
}

const verifyStatus = new Set(["pass", "fail", "warn", "skipped"]);
const validVerifyReport = (value: unknown): value is PolicyVerifyReport => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  if (
    Object.keys(report).length !== POLICY_VERIFY_GATE_NAMES.length ||
    POLICY_VERIFY_GATE_NAMES.some((name) => !(name in report))
  ) {
    return false;
  }
  return POLICY_VERIFY_GATE_NAMES.every((name) => {
    const gate = report[name] as Partial<VerifyGateResult> | undefined;
    return (
      gate !== undefined &&
      verifyStatus.has(String(gate.status)) &&
      typeof gate.details === "string" &&
      Array.isArray(gate.evidence_refs) &&
      gate.evidence_refs.every((ref) => typeof ref === "string")
    );
  });
};

export class InjectedVerifyService implements VerifyService {
  constructor(private readonly library: VerifyLibrary) {}

  async runVerify(
    context: ConversationContext,
    artifact: PlanArtifact,
  ): Promise<PolicyVerifyReport> {
    assertPlan(artifact);
    const report = await this.library.run({ context, artifact });
    if (!validVerifyReport(report))
      throw new Error("verify did not return the full structured verify report");
    return Object.freeze(structuredClone(report));
  }
}

export interface OrchestrateLibrary {
  dryRun(context: ConversationContext): Promise<DryRunResult>;
  execute(input: {
    context: ConversationContext;
    approval: ApprovalDecision;
  }): Promise<OrchestrationResult | ConversationOrchestrationResult>;
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

const conversationResult = (value: unknown): value is ConversationOrchestrationResult =>
  Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as ConversationOrchestrationResult).operation_id === "string" &&
      Array.isArray((value as ConversationOrchestrationResult).artifact_refs),
  );

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
  ): Promise<ConversationOrchestrationResult> {
    const token = orchestrationApprovalToken(context, this.actor);
    if (!approval) {
      await context.emit({
        idempotency_key: hashKey("orchestrate-policy:approval", [token.approval_id]),
        event: {
          type: "approval_requested",
          payload: { token, description: "Execute the current VibeFlow work units" },
        },
      });
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
    const output = await this.library.execute({ context, approval });
    if (conversationResult(output)) {
      if (output.operation_id !== context.correlation.operation_id) {
        throw new Error("orchestration result correlation mismatch");
      }
      return structuredClone(output);
    }
    const summary = await context.createArtifact({
      artifact_type: "tests",
      content: `${JSON.stringify(output)}\n`,
      idempotency_key: hashKey("orchestrate-policy:result", [
        context.correlation.operation_id,
        approval.approval_id,
      ]),
    });
    const passed =
      output.units.every((unit) => unit.status === "done") &&
      output.reviews.every((review) => review.pass);
    return {
      operation_id: context.correlation.operation_id,
      status: context.signal.aborted ? "aborted" : passed ? "completed" : "failed",
      artifact_refs: [summary.ref],
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
