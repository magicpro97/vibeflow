import { isCapabilityHostActionKind } from "./host-action-contract.js";
import { ACTION_ROOT_LOCATOR_KIND } from "./protocol-contract.js";
import { isPublicOperationPhase } from "./public-operation-contract.js";
import type { PublicOperationProgressV1 } from "./public-operation-dto.js";
import {
  expectedOperationStatus,
  isPublicOperationPhaseOwned,
  terminalStateForPhase,
} from "./public-operation-semantics.js";
import type { ActionAuthoritySnapshotV1 } from "./types.js";

export { expectedOperationStatus, isPublicOperationPhaseOwned, terminalStateForPhase };

export function isOperationPhase(value: unknown): value is PublicOperationProgressV1["phase"] {
  return isPublicOperationPhase(value);
}

export function assertPhaseOwner(
  snapshot: ActionAuthoritySnapshotV1,
  phase: PublicOperationProgressV1["phase"],
  index: number,
): void {
  const actionType = snapshot.proposal.action.type;
  if (
    snapshot.proposal.action_root_locator.kind === ACTION_ROOT_LOCATOR_KIND.CAPABILITY &&
    isCapabilityHostActionKind(actionType)
  )
    throw new Error("standalone capability WAL has no public phase");
  if (!isPublicOperationPhaseOwned({ actionType, phase, phaseSequence: index }))
    throw new Error(
      index === 0
        ? "operation phase zero does not match its action owner"
        : "operation phase does not match its action owner",
    );
}
