import { matchesUnitFilter } from "../logbus.js";
import type { Logbus } from "../logbus.js";
import { StuckDetector } from "./stuck-detector.js";
import type { StuckDetectorOpts } from "./stuck-detector.js";

export interface StuckWireHandle {
  detector: StuckDetector;
  finish: (evidenceCount: number) => string[];
  unsub: () => void;
}

export function applyStuckDetection(
  unit: { evidence?: string[]; name: string },
  stuckOpts?: StuckDetectorOpts,
  logbus?: Logbus,
): StuckWireHandle {
  const detector = new StuckDetector(stuckOpts);
  detector.recordProgress();
  detector.recordEvidenceCount(unit.evidence?.length ?? 0);

  let unsub: (() => void) | undefined;
  if (logbus) {
    unsub = logbus.subscribe((ev) => {
      if (ev.channel === "engine-stdout" && matchesUnitFilter(ev, unit.name)) {
        detector.recordOutput(ev.text);
      }
    });
  }

  return {
    detector,
    finish: (evidenceCount: number) => {
      detector.recordEvidenceCount(evidenceCount);
      return detector.check().reasons;
    },
    unsub: () => {
      unsub?.();
    },
  };
}
