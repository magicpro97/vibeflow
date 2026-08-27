import { ENGINE_COORDINATION_WORKSPACE_ACCESS } from "../../dispatch/session-contract.js";
import type { EngineCoordinationWorkspaceBindingV1 } from "../../dispatch/session-types.js";
import { digestV1 } from "../../durability/index.js";
import {
  CONVERSATION_COORDINATION_LANE,
  CONVERSATION_COORDINATION_PHASE,
  type ConversationCoordinationLaneV1,
} from "./conversation-coordination-contract.js";
import type { ConversationCoordinationStateV1 } from "./conversation-coordination-fold.js";
import type { CoordinationTaskContractV1 } from "./conversation-coordination-records.js";

export type ConversationCoordinationAttemptWorkspaceV1 =
  | {
      workspace_key: string;
      access: typeof ENGINE_COORDINATION_WORKSPACE_ACCESS.EXECUTOR;
      task: {
        task_id: string;
        contract_digest: string;
        scope: readonly string[];
        forbidden: readonly string[];
        verify_oracles: readonly string[];
      };
    }
  | {
      workspace_key: string;
      access: typeof ENGINE_COORDINATION_WORKSPACE_ACCESS.REVIEW;
    };

export function coordinationTaskContractDigest(task: CoordinationTaskContractV1): string {
  return digestV1("VF-CONVERSATION-COORDINATION-TASK\0v1\0", task);
}

export function executorCoordinationWorkspace(
  workspaceKey: string,
  task: CoordinationTaskContractV1,
): ConversationCoordinationAttemptWorkspaceV1 {
  return Object.freeze({
    workspace_key: workspaceKey,
    access: ENGINE_COORDINATION_WORKSPACE_ACCESS.EXECUTOR,
    task: Object.freeze({
      task_id: task.task_id,
      contract_digest: coordinationTaskContractDigest(task),
      scope: Object.freeze([...task.scope]),
      forbidden: Object.freeze([...task.forbidden]),
      verify_oracles: Object.freeze([...task.verify_oracles]),
    }),
  });
}

export function reviewCoordinationWorkspace(
  workspaceKey: string,
): ConversationCoordinationAttemptWorkspaceV1 {
  return Object.freeze({
    workspace_key: workspaceKey,
    access: ENGINE_COORDINATION_WORKSPACE_ACCESS.REVIEW,
  });
}

export function coordinationWorkspaceForTurn(
  workspaceKey: string,
  state: ConversationCoordinationStateV1,
  lane: ConversationCoordinationLaneV1,
): ConversationCoordinationAttemptWorkspaceV1 | undefined {
  if (
    lane === CONVERSATION_COORDINATION_LANE.COORDINATOR &&
    state.phase === CONVERSATION_COORDINATION_PHASE.COORDINATOR_REVIEWING
  )
    return state.last_completion ? reviewCoordinationWorkspace(workspaceKey) : undefined;
  return lane === CONVERSATION_COORDINATION_LANE.EXECUTOR && state.active_task
    ? executorCoordinationWorkspace(workspaceKey, state.active_task)
    : undefined;
}

export function projectEngineCoordinationWorkspace(
  workflowId: string,
  workspace: ConversationCoordinationAttemptWorkspaceV1,
): EngineCoordinationWorkspaceBindingV1 {
  return Object.freeze({ ...workspace, workflow_id: workflowId });
}
