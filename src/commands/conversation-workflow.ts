import { defaultContext } from "../adapters/context-builders.js";
import { type Engine, type WorkUnit, readState, recomputeTotals, writeState } from "../core.js";
import type { ConversationContext } from "../orchestrator/conversation/types.js";
import { deriveHandoff } from "../orchestrator/handoff.js";
import { thresholdFor } from "../orchestrator/investigate.js";
import { scheduleWaves } from "../orchestrator/plan.js";
import {
  DEFAULT_CONCURRENCY,
  type OrchestrationResult,
  type Reviewer,
  type UnitDispatcher,
  orchestrateUnits,
} from "../orchestrator/run.js";
import { readSettings } from "../settings.js";
import { DEFAULT_ENGINE, isComplete, makeDispatcher, makeReviewer } from "./_shared.js";

const WORKFLOW_DISPATCH_FAILED = "workflow dispatch failed";
const WORKFLOW_CANCELLED = "workflow cancelled";

interface WorkflowDispatchResult {
  ran: WorkUnit[];
  reviews: OrchestrationResult["reviews"];
}

interface WorkflowDispatchInput {
  units: WorkUnit[];
  concurrency: number;
  onProgress: () => void;
  dispatcher: UnitDispatcher;
  reviewer: Reviewer;
  signal: AbortSignal;
}

export interface ConversationWorkflowDeps {
  readState?: typeof readState;
  writeState?: typeof writeState;
  recomputeTotals?: typeof recomputeTotals;
  defaultContext?: typeof defaultContext;
  readSettings?: typeof readSettings;
  thresholdFor?: typeof thresholdFor;
  makeDispatcher?: typeof makeDispatcher;
  makeReviewer?: typeof makeReviewer;
  dispatch?: (input: WorkflowDispatchInput) => Promise<WorkflowDispatchResult>;
  defaultEngine?: Engine;
}

const failClosed = (
  pending: readonly WorkUnit[],
  reason: string,
  partial: readonly WorkUnit[] = [],
): WorkflowDispatchResult => {
  const partialByName = new Map(partial.map((unit) => [unit.name, unit]));
  return {
    ran: pending.map((unit) => {
      const current = partialByName.get(unit.name);
      return {
        ...unit,
        ...current,
        status: "blocked",
        confidence: 0,
        gates: { ...unit.gates, ...(current?.gates ?? {}), review: "fail" },
      };
    }),
    reviews: pending.map(({ name }) => ({ unit: name, pass: false, reason })),
  };
};

const dispatchWorkflowInWaves = async ({
  units,
  concurrency,
  onProgress,
  dispatcher,
  reviewer,
  signal,
}: WorkflowDispatchInput): Promise<WorkflowDispatchResult> => {
  const waveOrder = scheduleWaves(
    units.map((unit) => ({
      name: unit.name,
      scope: unit.scope ?? [],
      depends_on: unit.depends_on,
    })),
  );
  const handoffs = new Map<string, string>();
  const ran: WorkUnit[] = [];
  const reviews: OrchestrationResult["reviews"] = [];
  for (const wave of waveOrder) {
    const waveUnits = units.filter((unit) => wave.includes(unit.name));
    for (const unit of waveUnits) {
      const deps = (unit.depends_on ?? []).filter((dependency) => handoffs.has(dependency));
      if (deps.length) {
        unit.upstreamHandoffs = deps.map((dependency) => ({
          unit: dependency,
          summary: handoffs.get(dependency) ?? "",
        }));
      }
    }
    const waveResult = await orchestrateUnits({
      units: waveUnits,
      concurrency,
      onProgress,
      dispatcher,
      reviewer,
      signal,
    });
    for (const unit of waveResult.units) handoffs.set(unit.name, deriveHandoff(unit));
    ran.push(...waveResult.units);
    reviews.push(...waveResult.reviews);
  }
  return { ran, reviews };
};

export async function executeConversationWorkflow(
  base: string,
  context: ConversationContext,
  deps: ConversationWorkflowDeps = {},
): Promise<OrchestrationResult> {
  const read = deps.readState ?? readState;
  const write = deps.writeState ?? writeState;
  const refreshTotals = deps.recomputeTotals ?? recomputeTotals;
  const workflow = read(base);
  if (!workflow) throw new Error("workflow state not found");
  const done = workflow.work_units.filter(isComplete);
  const pending = workflow.work_units.filter((unit) => !isComplete(unit));
  if (pending.length === 0) return { units: [], reviews: [] };
  const engine = (context.bindings[0]?.engine ?? deps.defaultEngine ?? DEFAULT_ENGINE) as Engine;
  const riskClass = pending.find((unit) => unit.riskClass)?.riskClass ?? "feature";
  const project = {
    ...(deps.defaultContext ?? defaultContext)({ base }),
    goal: workflow.goal,
    settings: (deps.readSettings ?? readSettings)(base),
  };
  const dispatcher = (deps.makeDispatcher ?? makeDispatcher)(
    engine,
    project,
    base,
    "bridge",
    riskClass,
  );
  const reviewer = (deps.makeReviewer ?? makeReviewer)(
    "bridge",
    (deps.thresholdFor ?? thresholdFor)(riskClass),
    {
      cwd: base,
      implementer: engine,
      ...(workflow.goal ? { goal: workflow.goal } : {}),
    },
  );
  let result: WorkflowDispatchResult;
  try {
    result = await (deps.dispatch ?? dispatchWorkflowInWaves)({
      units: pending,
      concurrency: Math.min(DEFAULT_CONCURRENCY, pending.length),
      onProgress: () => {},
      dispatcher,
      reviewer,
      signal: context.signal,
    });
  } catch {
    result = failClosed(pending, WORKFLOW_DISPATCH_FAILED);
  }
  if (context.signal.aborted) {
    result = failClosed(pending, WORKFLOW_CANCELLED, result.ran);
  }
  workflow.work_units = done.length ? [...done, ...result.ran] : result.ran;
  refreshTotals(workflow);
  write(base, workflow);
  return { units: result.ran, reviews: result.reviews };
}
