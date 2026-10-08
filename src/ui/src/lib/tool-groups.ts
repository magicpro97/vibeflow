// Status vocabulary: the published wire contract is the single authority — a
// handwritten copy here would drift silently when the protocol evolves.
import {
  CONVERSATION_TOOL_ACTION_STATUSES,
  type ConversationToolActionStatusV1,
} from "../../../orchestrator/conversation/conversation-public-wire-contract.js";
// Tool-call grouping for the Home transcript (Orca 1.4.196 "grouped activity rows" port).
import type { RenderedHomeTimelineItem } from "../conversation-home-projection.js";

export interface ToolGroupEntry {
  id: string;
  tool: string;
  action: string;
  status: ConversationToolActionStatusV1;
  at: string | null;
}

/** Narrow an unknown tool-action status to the published statuses. */
export function toolActionStatus(value: unknown): ConversationToolActionStatusV1 {
  return (CONVERSATION_TOOL_ACTION_STATUSES as readonly unknown[]).includes(value)
    ? (value as ConversationToolActionStatusV1)
    : "started";
}

/** Build the single-event tool row; `tool` carries the structured entry for later grouping. */
export function toolActionItem(
  id: string,
  tool: ToolGroupEntry,
  revisionOrdinal: number,
  operations: RenderedHomeTimelineItem["operations"] = [],
): RenderedHomeTimelineItem {
  return {
    id,
    kind: "tool",
    title: `${tool.tool} · ${tool.status}`,
    body: tool.action,
    at: tool.at,
    anchorKey: null,
    sourceKey: null,
    sourceEventIds: [],
    conversationId: null,
    revisionId: null,
    publicSessionRef: null,
    publicAuthorId: null,
    messageRef: null,
    revisionOrdinal,
    complete: true,
    evidence: [],
    quoteRefs: [],
    reactions: [],
    diagnosticCode: null,
    operations,
    tool,
  };
}

export function toolGroupSummary(entries: readonly ToolGroupEntry[]): string {
  const running = entries.filter((entry) => entry.status === "started").length;
  const failed = entries.filter((entry) => entry.status === "failed").length;
  const completed = entries.length - running - failed;
  const parts = [`${entries.length} tool action${entries.length === 1 ? "" : "s"}`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (running > 0) parts.push(`${running} running`);
  if (failed === 0 && running === 0) parts.push(`${completed} completed`);
  return parts.join(" · ");
}

export function toolGroupDetail(entries: readonly ToolGroupEntry[]): string {
  const names = [...new Set(entries.map((entry) => entry.tool))];
  return names.length > 4 ? `${names.slice(0, 4).join(", ")} …` : names.join(", ");
}

/** Merge runs of consecutive `tool` items into `tool-group` items; everything else passes through. */
export function groupToolItems(
  items: readonly RenderedHomeTimelineItem[],
): RenderedHomeTimelineItem[] {
  const output: RenderedHomeTimelineItem[] = [];
  let seed: RenderedHomeTimelineItem | null = null;
  let entries: ToolGroupEntry[] = [];
  let operations: RenderedHomeTimelineItem["operations"] = [];
  const flush = () => {
    if (!seed) return;
    if (entries.length === 1) {
      output.push(seed);
    } else {
      output.push({
        ...seed,
        id: `tool-group:${seed.id}`,
        kind: "tool-group",
        title: toolGroupSummary(entries),
        body: toolGroupDetail(entries),
        tools: entries,
        // The grouped row stands in for every member on the timeline, so it must
        // carry the union of their durable actions — not just the first item's.
        operations,
      });
    }
    seed = null;
    entries = [];
    operations = [];
  };
  for (const item of items) {
    if (item.kind === "tool" && item.tool) {
      if (!seed) seed = item;
      entries.push(item.tool);
      operations = [...operations, ...item.operations];
      continue;
    }
    flush();
    output.push(item);
  }
  flush();
  return output;
}
