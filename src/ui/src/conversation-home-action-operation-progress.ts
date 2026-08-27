import {
  HOST_ACTION_KIND_VALUES,
  type HostActionKind,
  isConversationHostActionKind,
} from "../../actions/host-action-contract.js";
import { isPublicOperationPhaseStateValid } from "../../actions/public-operation-semantics.js";
import { ACTION_DOMAIN } from "./conversation-home-action-boundary-shared.js";
import type { HomeActionOperation } from "./conversation-home-types.js";

function actionTypeMatchesDomain(
  actionType: HostActionKind,
  domain: HomeActionOperation["domain"],
): boolean {
  const conversation = isConversationHostActionKind(actionType);
  return domain === ACTION_DOMAIN.CONVERSATION ? conversation : !conversation;
}

export function latestProgressMatchesSharedProducer(
  operation: Pick<HomeActionOperation, "domain" | "state">,
  progress: HomeActionOperation["progress"][number],
): boolean {
  return HOST_ACTION_KIND_VALUES.some(
    (actionType) =>
      actionTypeMatchesDomain(actionType, operation.domain) &&
      isPublicOperationPhaseStateValid({
        actionType,
        phase: progress.phase,
        phaseSequence: progress.sequence,
        state: operation.state,
      }),
  );
}
