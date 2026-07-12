import type { WorkUnit } from "../core/types.js";
import type { Logbus } from "../logbus.js";
import { deriveHandoff } from "./handoff.js";
import { scheduleWaves } from "./plan.js";
import {
  type OrchestrationResult,
  type ProgressEvent,
  type Reviewer,
  type UnitDispatcher,
  orchestrateUnits,
} from "./run.js";

export interface WaveDispatchOpts {
  units: WorkUnit[];
  concurrency: number;
  onProgress: (ev: ProgressEvent) => void;
  dispatcher: UnitDispatcher;
  reviewer: Reviewer;
  logbus?: Logbus;
  security?: { base: string };
}

export interface WaveDispatchResult {
  ran: WorkUnit[];
  reviews: Array<{ unit: string; pass: boolean; reason: string }>;
  /** Unit name → derived handoff summary, accumulated across waves. */
  handoffs: Map<string, string>;
}

/**
 * Dispatch units as dependency-ordered waves. `scheduleWaves` groups by
 * `depends_on` so each wave only contains units whose deps are already done;
 * units within a wave run concurrently. After every wave, each finished
 * unit's derived handoff is recorded and injected into its dependents'
 * upstream context for the next wave. With no deps this collapses to a
 * single wave → one `orchestrateUnits` call (back-compat).
 */
export async function dispatchInWaves(opts: WaveDispatchOpts): Promise<WaveDispatchResult> {
  const waveOrder = scheduleWaves(
    opts.units.map((u) => ({ name: u.name, scope: u.scope ?? [], depends_on: u.depends_on })),
  );
  const handoffs = new Map<string, string>();
  const ran: WorkUnit[] = [];
  const reviews: WaveDispatchResult["reviews"] = [];
  for (const wave of waveOrder) {
    const waveUnits = opts.units.filter((u) => wave.includes(u.name));
    // Inject derived summaries from completed upstream units onto each wave unit.
    for (const u of waveUnits) {
      const deps = (u.depends_on ?? []).filter((d) => handoffs.has(d));
      if (deps.length) {
        u.upstreamHandoffs = deps.map((d) => ({ unit: d, summary: handoffs.get(d) ?? "" }));
      }
    }
    const waveResult: OrchestrationResult = await orchestrateUnits({
      units: waveUnits,
      concurrency: opts.concurrency,
      onProgress: opts.onProgress,
      dispatcher: opts.dispatcher,
      reviewer: opts.reviewer,
      ...(opts.logbus ? { logbus: opts.logbus } : {}),
      ...(opts.security ? { security: opts.security } : {}),
    });
    // #612: handoff persistence onto the DispatchMarker (crash/resume replay)
    // is DEFERRED — see issue #612 PR body; the in-memory `handoffs`
    // map covers the normal (non-crashing) run path.
    for (const u of waveResult.units) handoffs.set(u.name, deriveHandoff(u));
    ran.push(...waveResult.units);
    reviews.push(...waveResult.reviews);
  }
  return { ran, reviews, handoffs };
}
