// Turn elapsed-time math for the Home transcript (Orca 1.4.196 "per-turn timers" port).
export interface TurnSpan {
  startedAt: string | null;
  finishedAt: string | null;
}

/** The assistant turn starts at the nearest preceding user/boundary timestamp. */
export function turnStartAt(
  items: readonly { kind: string; at: string | null }[],
  index: number,
): string | null {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = items[cursor];
    if (!candidate) continue; // noUncheckedIndexedAccess: indexed reads are `T | undefined`
    if (candidate.kind === "user" || candidate.kind === "boundary") return candidate.at;
  }
  return null;
}

export function turnElapsedMs(span: TurnSpan, nowMs: number): number | null {
  if (!span.startedAt) return null;
  const startMs = Date.parse(span.startedAt);
  if (Number.isNaN(startMs)) return null;
  const endMs = span.finishedAt ? Date.parse(span.finishedAt) : nowMs;
  if (Number.isNaN(endMs) || endMs < startMs) return null;
  return endMs - startMs;
}

export function formatTurnElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60)
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
