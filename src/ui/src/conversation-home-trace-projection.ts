import type { HomeActionOperation, HomeTimelineItem } from "./conversation-home-types.js";

export interface RenderedHomeTraceEntry {
  id: string;
  type: string;
  seq: number;
  at: string;
  revisionOrdinal: number;
  publicSessionRef: string | null;
  correlation: {
    workflowId: string;
    runId: string;
    turnId: string;
    operationId: string;
    attemptId: string;
  };
  evidence: string[];
  operations: HomeActionOperation[];
}

const stringReferences = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Projects the public timeline DTO into a deliberately non-raw evidence inspector. */
export function projectHomeTrace(source: readonly HomeTimelineItem[]): RenderedHomeTraceEntry[] {
  return source.flatMap((item) => {
    if (item.kind !== "conversation-event") return [];
    const record = item.event;
    const payload = record.event.payload as Record<string, unknown>;
    const evidence = new Set([
      ...stringReferences(record.evidence_refs),
      ...stringReferences(payload.evidence),
      ...stringReferences(payload.final_evidence),
      ...stringReferences(payload.provenance_refs),
    ]);
    return [
      {
        id: record.event_id,
        type: record.event.type.replaceAll("_", " "),
        seq: record.seq,
        at: record.ts,
        revisionOrdinal: item.revision_ordinal,
        publicSessionRef: record.public_session_ref,
        correlation: {
          workflowId: record.workflow_id,
          runId: record.run_id,
          turnId: record.turn_id,
          operationId: record.operation_id,
          attemptId: record.attempt_id,
        },
        evidence: [...evidence].sort((left, right) => left.localeCompare(right)),
        operations: item.action_operations.items,
      },
    ];
  });
}
