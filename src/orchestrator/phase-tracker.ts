import type { ProgressEvent } from "./run.js";

export interface PhaseSnapshot {
  total: number;
  done: number;
  units: Array<{
    unit: string;
    phase: "pending" | "running" | "done";
    pass?: boolean;
    startedAt?: number;
    endedAt?: number;
  }>;
}

export function makePhaseTracker(total: number, now: () => number = () => Date.now()) {
  const units = new Map<string, PhaseSnapshot["units"][number]>();

  return {
    onProgress(ev: ProgressEvent): void {
      if (ev.phase === "start") {
        units.set(ev.unit, { unit: ev.unit, phase: "running", startedAt: now() });
      } else {
        const u = units.get(ev.unit) ?? {
          unit: ev.unit,
          phase: "running" as const,
        };
        units.set(ev.unit, {
          ...u,
          phase: "done",
          pass: ev.pass,
          endedAt: now(),
        });
      }
    },

    snapshot(): PhaseSnapshot {
      const list = [...units.values()];
      return {
        total,
        done: list.filter((u) => u.phase === "done").length,
        units: list,
      };
    },

    render(totals?: { cost_usd: number; tokens: number }, elapsed?: string): string {
      const snap = this.snapshot();
      const parts: string[] = [];

      parts.push(`[${snap.done}/${snap.total}]`);

      for (const u of snap.units) {
        let glyph: string;
        if (u.phase === "done") {
          glyph = u.pass ? "✓" : "•";
        } else {
          const elapsed = u.startedAt != null ? Math.floor((now() - u.startedAt) / 1000) : 0;
          glyph = `▶${elapsed > 0 ? ` (${elapsed}s)` : ""}`;
        }
        parts.push(`${glyph} ${u.unit}`);
      }

      const pending = snap.total - snap.units.length;
      if (pending > 0) {
        parts.push(`·${pending}`);
      }

      let line = parts.join("  ");

      if (totals) {
        const cost = `$${totals.cost_usd.toFixed(2)}`;
        const tok = `${Math.round(totals.tokens / 1000)}k tok`;
        line += ` · ${cost} · ${tok}`;
        if (elapsed) line += ` · ${elapsed}`;
      }

      return line;
    },
  };
}
