import { ConversationHomeApiError } from "./conversation-home-api.js";
import type { HomeTimelineItem } from "./conversation-home-types.js";

export function mergeHomePage<T>(
  current: readonly T[],
  incoming: readonly T[],
  keyOf: (item: T) => string,
): T[] {
  const merged = new Map<string, T>();
  for (const item of current) merged.set(keyOf(item), item);
  for (const item of incoming) merged.set(keyOf(item), item);
  return [...merged.values()];
}

export function staleHomeCursor(error: unknown): string | null {
  if (!(error instanceof ConversationHomeApiError)) return null;
  return [
    "stale_catalog_cursor",
    "stale_pending_proposal_cursor",
    "stale_timeline_cursor",
    "stale_capability_cursor",
  ].includes(error.publicError.code)
    ? error.publicError.code
    : null;
}

export function homeTimelineItemKey(item: HomeTimelineItem): string {
  if (item.kind === "revision-boundary") return `boundary:${item.boundary_id}`;
  if (item.kind === "conversation-start") return `start:${item.anchor_id}`;
  return `event:${item.event.event_id}`;
}
