/**
 * Pure rail presentation helpers: id builders, collapse toggling, and relative-time labels.
 * Kept DOM-free so the rail's rendering rules are testable without mounting the SFC.
 */

export function railGroupNameId(projectId: string): string {
  return `rail-group-${projectId}`;
}

export function railGroupEntriesId(projectId: string): string {
  return `rail-entries-${projectId}`;
}

export function toggleRailGroup(collapsed: ReadonlySet<string>, projectId: string): Set<string> {
  const next = new Set(collapsed);
  if (next.has(projectId)) next.delete(projectId);
  else next.add(projectId);
  return next;
}

export function relativeRailTime(value: string, now: number = Date.now()): string {
  const elapsed = now - Date.parse(value);
  if (!Number.isFinite(elapsed)) return "";
  const minutes = Math.round(elapsed / 60_000);
  if (Math.abs(minutes) < 1) return "now";
  if (Math.abs(minutes) < 60) return `${Math.abs(minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return `${Math.abs(hours)}h`;
  const days = Math.round(hours / 24);
  return `${Math.abs(days)}d`;
}
