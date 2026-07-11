// src/orchestrator/stuck-detector.ts
// #546 — Detect stuck/looping dispatched engines from their transcript

export interface StepRecord {
  action: string;
  file?: string;
  hash?: string;
  test?: string;
  status?: string;
  error?: string;
  diffSize?: number;
}

export interface StuckReason {
  reason: "repeat-edit" | "same-fail" | "no-progress";
  evidence: string[];
}

export interface StuckThresholds {
  maxRepeatEdits: number;
  maxConsecutiveFails: number;
  maxStepsNoProgress: number;
}

const DEFAULTS: StuckThresholds = {
  maxRepeatEdits: 3,
  maxConsecutiveFails: 3,
  maxStepsNoProgress: 5,
};

export class StuckDetector {
  private history: StepRecord[] = [];
  private thresholds: StuckThresholds;

  constructor(thresholds?: Partial<StuckThresholds>) {
    this.thresholds = { ...DEFAULTS, ...thresholds };
  }

  feed(step: StepRecord): StuckReason | null {
    this.history.push(step);
    return this.detect();
  }

  isStuck(): StuckReason | null {
    return this.detect();
  }

  private detect(): StuckReason | null {
    return this.detectRepeatEdit() ?? this.detectSameFail() ?? this.detectNoProgress() ?? null;
  }

  private detectRepeatEdit(): StuckReason | null {
    const edits = this.history.filter((s) => s.action === "edit" && s.file && s.hash);
    if (edits.length < this.thresholds.maxRepeatEdits * 2 + 1) return null;

    const fileHashes = new Map<string, string[]>();
    for (const step of edits) {
      const hashes = fileHashes.get(step.file!) || [];
      hashes.push(step.hash!);
      fileHashes.set(step.file!, hashes);
    }

    for (const [file, hashes] of fileHashes) {
      if (hashes.length < this.thresholds.maxRepeatEdits * 2 + 1) continue;
      const unique = [...new Set(hashes)];
      if (unique.length !== 2) continue;

      let oscillating = true;
      for (let i = 0; i < hashes.length - 1; i++) {
        if (hashes[i] === hashes[i + 1]) {
          oscillating = false;
          break;
        }
      }
      if (!oscillating) continue;

      const firstHash = unique[0];
      let count = 0;
      for (const h of hashes) if (h === firstHash) count++;
      if (count >= this.thresholds.maxRepeatEdits + 1) {
        return { reason: "repeat-edit", evidence: [file] };
      }
    }
    return null;
  }

  private detectSameFail(): StuckReason | null {
    const fails = this.history.filter((s) => s.action === "test" && s.status === "fail");
    if (fails.length < this.thresholds.maxConsecutiveFails) return null;
    const recent = fails.slice(-this.thresholds.maxConsecutiveFails);
    const testName = recent[0]!.test;
    const errorMsg = recent[0]!.error;
    const allSame = recent.every((s) => s.test === testName && s.error === errorMsg);
    if (allSame) {
      return { reason: "same-fail", evidence: [testName ?? "unknown"] };
    }
    return null;
  }

  private detectNoProgress(): StuckReason | null {
    const threshold = this.thresholds.maxStepsNoProgress;
    if (this.history.length < threshold) return null;
    const recent = this.history.slice(-threshold);
    const allStale = recent.every((s) => (s.diffSize ?? 1) === 0);
    if (allStale) {
      return { reason: "no-progress", evidence: [`${threshold} steps with no diff`] };
    }
    return null;
  }
}
