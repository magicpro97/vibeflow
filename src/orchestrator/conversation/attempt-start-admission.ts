import type { MaterializedAgentBinding } from "../../agents/binding.js";
import type {
  AttemptHandle,
  EngineSessionAdapter,
  EngineSessionRequest,
} from "../../dispatch/session-types.js";
import type { AttemptConversationAuthority } from "./attempt-runtime-types.js";
import type { RegisteredOperation } from "./operation-registry.js";
import type {
  InitialRevisionLaneAuthority,
  InitialRevisionLaneTokenV1,
} from "./revision-initial-lane-authority.js";
import type { PolicyAttemptRequest } from "./types.js";

export function prepareInitialRevisionLane(
  authority: InitialRevisionLaneAuthority | undefined,
  live: AttemptConversationAuthority,
  request: PolicyAttemptRequest,
  binding: MaterializedAgentBinding,
): InitialRevisionLaneTokenV1 | null | undefined {
  return authority?.prepare({
    operation_id: live.operationId,
    conversation_id: live.manifest.conversation_id,
    participant_id: request.participantId,
    binding,
    purpose: request.purpose,
  });
}

export function startAndAdmitAttempt(input: {
  adapter: EngineSessionAdapter;
  request: EngineSessionRequest;
  operation: RegisteredOperation;
  revisionLane: InitialRevisionLaneTokenV1 | null | undefined;
  revisionLanes: InitialRevisionLaneAuthority | undefined;
}): AttemptHandle {
  let handle: AttemptHandle;
  try {
    handle = input.adapter.start(input.request);
  } catch (error) {
    if (input.revisionLane)
      input.revisionLanes?.startFailed(input.revisionLane, input.adapter.startAuthority);
    throw error;
  }
  try {
    if (input.revisionLane) input.revisionLanes?.attach(input.revisionLane, handle);
    input.operation.addAttempt(handle);
    return handle;
  } catch (error) {
    if (input.revisionLane)
      input.revisionLanes?.effectUnknown(input.revisionLane, handle, input.adapter.startAuthority);
    void handle.terminate("attempt admission failed").catch(() => undefined);
    throw error;
  }
}
