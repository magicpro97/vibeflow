import type { AttemptRuntimeOptions } from "./attempt-runtime-options.js";
import type { AttemptConversationAuthority } from "./attempt-runtime-types.js";
import type { RevisionPreparationPlanV1 } from "./lineage-revision-operation.js";
import type { RegisteredOperation } from "./operation-registry.js";
import { startInitialRevisionLaneBarrier } from "./revision-initial-lane-runtime.js";

export function startAttemptRevisionBarrier(
  options: AttemptRuntimeOptions,
  live: AttemptConversationAuthority,
  operation: RegisteredOperation,
  plan: RevisionPreparationPlanV1,
  authorityOperationId: string,
): Promise<boolean> {
  if (!options.revisionLanes) throw new Error("revision lane authority is absent");
  return startInitialRevisionLaneBarrier({
    options,
    authority: options.revisionLanes,
    live,
    operation,
    plan,
    authorityOperationId,
  });
}
