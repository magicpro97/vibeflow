// One participant's activity feed for the Home agent drawer: that participant's items in
// original timeline order, `user` rows excluded. Attribution reuses the shared cursor walk
// in agent-presence.ts (assistant rows set the cursor from a non-"human" `publicAuthorId`;
// following tool / tool-group rows belong to it).
import type { RenderedHomeTimelineItem } from "../conversation-home-projection.js";
import { attributeItemsToParticipants } from "./agent-presence.js";

export interface AgentActivityEntry {
  readonly item: RenderedHomeTimelineItem;
  readonly at: string | null;
}

export function buildAgentActivity(
  items: readonly RenderedHomeTimelineItem[],
  participantId: string,
): AgentActivityEntry[] {
  const indexes = attributeItemsToParticipants(items).get(participantId) ?? [];
  return indexes.flatMap((index) => {
    const entry = items[index];
    return entry ? [{ item: entry, at: entry.at }] : [];
  });
}
