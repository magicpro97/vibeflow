import {
  CONVERSATION_TRACE_EVENT_KIND,
  type ConversationReconciliationStatusV1,
} from "../../orchestrator/conversation/conversation-public-wire-contract.js";
import type { ConversationTraceRecord } from "./conversation-types.js";

export function collectTraceSessions(records: readonly ConversationTraceRecord[]) {
  const sessions = new Map<
    string,
    {
      public_session_ref: string;
      status: ConversationReconciliationStatusV1;
      imported_turn_count: number;
      imported_tool_count: number;
      completeness_reason: string;
      provenance_refs: string[];
      evidence_refs: string[];
    }
  >();
  for (const record of records) {
    if (record.event.type !== CONVERSATION_TRACE_EVENT_KIND.NATIVE_HISTORY_RECONCILED) continue;
    sessions.set(record.event.payload.public_session_ref, {
      public_session_ref: record.event.payload.public_session_ref,
      status: record.event.payload.status,
      imported_turn_count: record.event.payload.imported_turn_count,
      imported_tool_count: record.event.payload.imported_tool_count,
      completeness_reason: record.event.payload.completeness_reason,
      provenance_refs: [...record.event.payload.provenance_refs],
      evidence_refs: [...record.event.payload.evidence_refs],
    });
  }
  return sessions;
}
