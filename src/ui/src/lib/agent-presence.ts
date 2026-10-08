// Per-agent presence rows for the Home agent panel ("who is working now" panel).
//
// Only assistant rows carry `publicAuthorId`; tool / tool-group rows follow a cursor of
// the latest non-"human" author. Status: idle → failed (last item failed tool / tool-group
// whose LAST entry failed) → working (a `started` tool signal, or last item incomplete) →
// complete. `startedAt` is the nearest preceding user/boundary row; when null, `elapsedMs`
// is null (no clock). v1 limit (R1): interleaved concurrent agents mis-attribute stray tool
// events.
import { homeParticipantDisplayLabel } from "../conversation-home-participant-label.js";
import type { RenderedHomeTimelineItem } from "../conversation-home-projection.js";
import type { HomeParticipant } from "../conversation-home-types.js";
import { turnElapsedMs, turnStartAt } from "./turn-timing.js";

export const AGENT_PRESENCE_STATUS = Object.freeze({
  IDLE: "idle",
  WORKING: "working",
  FAILED: "failed",
  COMPLETE: "complete",
} as const);
export type AgentPresenceStatus = (typeof AGENT_PRESENCE_STATUS)[keyof typeof AGENT_PRESENCE_STATUS];

export interface AgentPresenceRow {
  readonly participantId: string;
  readonly label: string;
  readonly engine: string | null;
  readonly model: string | null;
  readonly status: AgentPresenceStatus;
  readonly latestAction: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly elapsedMs: number | null;
  readonly lastItemIndex: number;
}

/** Panel sort order: working first, complete last; ties break by label ascending. */
const STATUS_RANK = {
  [AGENT_PRESENCE_STATUS.WORKING]: 0,
  [AGENT_PRESENCE_STATUS.FAILED]: 1,
  [AGENT_PRESENCE_STATUS.IDLE]: 2,
  [AGENT_PRESENCE_STATUS.COMPLETE]: 3,
} satisfies Record<AgentPresenceStatus, number>;

/** Max characters kept from a latest-action body, ellipsis included. */
const LATEST_ACTION_MAX = 140;

interface PresenceSignal {
  readonly lastIndex: number;
  readonly at: string | null;
  readonly body: string;
  readonly complete: boolean;
  readonly failed: boolean;
  readonly started: boolean;
}

const truncateLatestAction = (body: string): string =>
  body.length <= LATEST_ACTION_MAX ? body : `${body.slice(0, LATEST_ACTION_MAX - 1)}…`;

export function buildAgentPresence(
  items: readonly RenderedHomeTimelineItem[],
  participants: readonly HomeParticipant[],
): AgentPresenceRow[] {
  const signals = new Map<string, PresenceSignal>();
  let currentAuthor: string | null = null;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item) continue;
    const author = item.publicAuthorId;
    if (typeof author === "string" && author !== "human") currentAuthor = author;
    if (item.kind !== "assistant" && item.kind !== "tool" && item.kind !== "tool-group") continue;
    if (!currentAuthor) continue;
    // Tool-group status counts as its LAST member (a tool row is a single-entry group);
    // `started` is true for a started tool, or a group with ANY started member.
    const member = item.kind === "tool" ? item.tool : item.tools?.[item.tools.length - 1];
    const started =
      item.kind === "tool"
        ? item.tool?.status === "started"
        : (item.tools?.some((entry) => entry.status === "started") ?? false);
    signals.set(currentAuthor, {
      lastIndex: index,
      at: item.at,
      body: item.body,
      complete: item.complete,
      failed: member?.status === "failed",
      started,
    });
  }
  const nowMs = Date.now();
  const rows = participants.map((participant): AgentPresenceRow => {
    const signal = signals.get(participant.participant_id);
    const status: AgentPresenceStatus = signal
      ? signal.failed
        ? AGENT_PRESENCE_STATUS.FAILED
        : signal.started || !signal.complete
          ? AGENT_PRESENCE_STATUS.WORKING
          : AGENT_PRESENCE_STATUS.COMPLETE
      : AGENT_PRESENCE_STATUS.IDLE;
    const startedAt = signal ? turnStartAt(items, signal.lastIndex) : null;
    const finishedAt = status === AGENT_PRESENCE_STATUS.COMPLETE && signal ? signal.at : null;
    return {
      participantId: participant.participant_id,
      label: homeParticipantDisplayLabel({
        participantId: participant.participant_id,
        roleRef: participant.role_ref,
        engine: participant.engine,
      }),
      engine: participant.engine,
      model: participant.model,
      status,
      latestAction: signal ? truncateLatestAction(signal.body) : null,
      startedAt,
      finishedAt,
      elapsedMs: turnElapsedMs({ startedAt, finishedAt }, nowMs),
      lastItemIndex: signal ? signal.lastIndex : -1,
    };
  });
  return rows.sort(
    (left, right) =>
      STATUS_RANK[left.status] - STATUS_RANK[right.status] ||
      left.label.localeCompare(right.label),
  );
}

/** Live clock: `working` rows tick; everything else returns the frozen `elapsedMs`. */
export function liveElapsedMs(row: AgentPresenceRow, nowMs: number): number | null {
  if (row.status !== AGENT_PRESENCE_STATUS.WORKING) return row.elapsedMs;
  return turnElapsedMs({ startedAt: row.startedAt, finishedAt: null }, nowMs);
}
