import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import type { BrowserHostActionRequestV1 } from "../../actions/index.js";
import type { TraceCorrelation } from "../trace/types.js";

export type CompactionCandidate = Extract<
  BrowserHostActionRequestV1,
  { type: typeof HOST_ACTION_KIND.CONTEXT_COMPACT }
>;

export function isCompaction(
  candidate: BrowserHostActionRequestV1,
): candidate is CompactionCandidate {
  return candidate.type === HOST_ACTION_KIND.CONTEXT_COMPACT;
}

export function compactionCorrelation(
  proposalId: string,
  operationId: string,
  manifest: {
    workflow_id: string;
    conversation_id: string;
    revision_id: string;
    run_id: string;
  },
): TraceCorrelation {
  const suffix = proposalId.slice("vf-proposal-".length, "vf-proposal-".length + 32);
  return {
    workflow_id: manifest.workflow_id,
    conversation_id: manifest.conversation_id,
    revision_id: manifest.revision_id,
    run_id: manifest.run_id,
    turn_id: `compaction-turn-${suffix}`,
    operation_id: operationId,
    attempt_id: `compaction-attempt-${suffix}`,
  };
}
