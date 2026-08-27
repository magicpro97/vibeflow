import { type WorkUnitStatus, isWorkUnitStatus } from "../../core/workflow-contract.js";
import { sanitizePublicText } from "../../dispatch/public-redaction.js";
import { TRACE_LIMITS, utf8Bytes } from "../trace/limits.js";
import type { OrchestrateService, PlanArtifact } from "./services.js";
import type {
  ApprovalDecision,
  ConversationContext,
  ConversationOrchestrationResult,
  ConversationPolicy,
  DryRunResult,
} from "./types.js";

export interface OrchestrationResultSnapshot {
  readonly units: readonly Readonly<{ name: string; status: WorkUnitStatus }>[];
  readonly reviews: readonly Readonly<{ unit: string; pass: boolean; reason: string }>[];
}

const ownValue = (value: unknown, key: PropertyKey): unknown => {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};

const denseBounded = (value: unknown): unknown[] | null => {
  if (!Array.isArray(value) || value.length > TRACE_LIMITS.maxArrayItems) return null;
  const items: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) return null;
    items.push(descriptor.value);
  }
  return items;
};

const boundedText = (value: unknown, maxBytes: number): value is string =>
  typeof value === "string" && utf8Bytes(value) <= maxBytes;

const boundedReference = (value: unknown): value is string =>
  boundedText(value, TRACE_LIMITS.maxReferenceBytes) && value.length > 0;

/** Bound, project, then detach an injected runner result before any durable writer can yield. */
export function snapshotOrchestrationResult(value: unknown): OrchestrationResultSnapshot {
  const rawUnits = denseBounded(ownValue(value, "units"));
  const rawReviews = denseBounded(ownValue(value, "reviews"));
  if (!rawUnits || !rawReviews) throw new Error("invalid orchestration result");
  const units = rawUnits.map((unit) => ({
    name: ownValue(unit, "name"),
    status: ownValue(unit, "status"),
  }));
  const reviews = rawReviews.map((review) => ({
    unit: ownValue(review, "unit"),
    pass: ownValue(review, "pass"),
    reason: ownValue(review, "reason"),
  }));
  if (
    units.some(({ name, status }) => !boundedReference(name) || !isWorkUnitStatus(status)) ||
    reviews.some(
      ({ unit, pass, reason }) =>
        !boundedReference(unit) ||
        typeof pass !== "boolean" ||
        !boundedText(reason, TRACE_LIMITS.maxTextBytes),
    )
  ) {
    throw new Error("invalid orchestration result");
  }
  const output = structuredClone({ units, reviews }) as OrchestrationResultSnapshot;
  for (const unit of output.units) Object.freeze(unit);
  for (const review of output.reviews) Object.freeze(review);
  Object.freeze(output.units);
  Object.freeze(output.reviews);
  return Object.freeze(output);
}

/** Minimal authenticated artifact projection; raw worktree/evidence/reviewer text stays private. */
export const orchestrationArtifactSummary = (output: OrchestrationResultSnapshot): string =>
  `${JSON.stringify({
    units: output.units.map((unit) => ({
      unit: sanitizePublicText(unit.name, [], [], "unit"),
      status: unit.status,
    })),
    reviews: output.reviews.map((review) => ({
      unit: sanitizePublicText(review.unit, [], [], "unit"),
      pass: review.pass,
    })),
  })}\n`;

/** Approval continuation adapter over the existing work-unit orchestration service. */
export class OrchestrateConversationPolicy implements ConversationPolicy {
  readonly name = "orchestrate";

  constructor(private readonly orchestrate: OrchestrateService) {}

  dryRun(context: ConversationContext): Promise<DryRunResult> {
    return this.orchestrate.dryRun(context);
  }

  execute(context: ConversationContext): Promise<ConversationOrchestrationResult> {
    return this.orchestrate.execute(context, null);
  }

  continueAfterApproval = (
    context: ConversationContext,
    decision: ApprovalDecision,
  ): Promise<ConversationOrchestrationResult> => {
    return this.orchestrate.execute(context, decision);
  };

  continuePlanAfterApproval = (
    context: ConversationContext,
    decision: ApprovalDecision,
    artifact: PlanArtifact,
  ): Promise<ConversationOrchestrationResult> => {
    return this.orchestrate.execute(context, decision, artifact);
  };
}
