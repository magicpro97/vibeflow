// src/orchestrator/stuck-detector.ts
//
// StuckDetector — 3 detection patterns for in-flight work units (#546).
// 1. Stalled: no progress event within stallSeconds (default 120s).
// 2. Looping: same output repeated loopThreshold times (default 3).
// 3. Evidence-stuck: evidence count unchanged across evidenceStallRounds+1 checks (default 2 rounds → 3 checks).
//
// All config driven; no non-null assertions. Consumer calls record*() on each
// progress tick / output chunk / evidence change, then check() to get a verdict.

export interface StuckDetectorOpts {
  /** Seconds without a progress event before declaring stalled. */
  stallSeconds?: number;
  /** Number of identical consecutive outputs that signal a loop. */
  loopThreshold?: number;
  /** Number of consecutive unchanged evidence-count checks that signal evidence-stuck. */
  evidenceStallRounds?: number;
}

export interface StuckState {
  stalled: boolean;
  looping: boolean;
  evidenceStuck: boolean;
  reasons: string[];
}

export class StuckDetector {
  private lastProgressTime: number;
  private outputHistory: string[];
  private evidenceHistory: number[];
  private readonly stallSeconds: number;
  private readonly loopThreshold: number;
  private readonly evidenceStallRounds: number;

  constructor(opts?: StuckDetectorOpts) {
    this.stallSeconds = opts?.stallSeconds ?? 120;
    this.loopThreshold = opts?.loopThreshold ?? 3;
    this.evidenceStallRounds = opts?.evidenceStallRounds ?? 2;
    this.lastProgressTime = Date.now();
    this.outputHistory = [];
    this.evidenceHistory = [];
  }

  /** Call on every progress event (start or done). */
  recordProgress(now?: number): void {
    this.lastProgressTime = now ?? Date.now();
  }

  /** Call with each engine output chunk. Keeps a bounded window. */
  recordOutput(text: string): void {
    this.outputHistory.push(text);
    // ponytail: bounded window, trim from front
    if (this.outputHistory.length > this.loopThreshold + 5) {
      this.outputHistory.shift();
    }
  }

  /** Call when the unit's evidence count changes. */
  recordEvidenceCount(count: number): void {
    this.evidenceHistory.push(count);
    if (this.evidenceHistory.length > this.evidenceStallRounds + 2) {
      this.evidenceHistory.shift();
    }
  }

  /** Evaluate all 3 detection patterns. Returns a StuckState with reasons. */
  check(now?: number): StuckState {
    const ts = now ?? Date.now();
    const stalled = ts - this.lastProgressTime > this.stallSeconds * 1000;

    const windowStart = Math.max(0, this.outputHistory.length - this.loopThreshold);
    const recentOutputs = this.outputHistory.slice(windowStart);
    const looping =
      recentOutputs.length >= this.loopThreshold &&
      recentOutputs.length > 0 &&
      new Set(recentOutputs).size === 1;

    let evidenceStuck = false;
    if (this.evidenceHistory.length >= this.evidenceStallRounds + 1) {
      const recent = this.evidenceHistory.slice(-(this.evidenceStallRounds + 1));
      const first = recent[0];
      evidenceStuck = first !== undefined && recent.every((c) => c === first);
    }

    const reasons: string[] = [];
    if (stalled) reasons.push(`stalled: no progress for ${this.stallSeconds}s`);
    if (looping) reasons.push(`looping: same output repeated ${this.loopThreshold} times`);
    if (evidenceStuck)
      reasons.push(`evidence-stuck: count unchanged across ${this.evidenceStallRounds + 1} checks`);

    return { stalled, looping, evidenceStuck, reasons };
  }
}
