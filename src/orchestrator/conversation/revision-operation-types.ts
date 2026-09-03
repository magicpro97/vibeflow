import type { ActionApprovalV1, ActionProposalV1 } from "../../actions/index.js";
import type { MaterializedAgentBinding } from "../../agents/binding.js";
import type { BindingAuthoritySnapshot } from "./artifact-validation.js";
import type { ConversationQueuedMessageDeliveryAuthorityV1 } from "./conversation-message-queue-trace-authority.js";
import type { ContextHandoffV1 } from "./handoff-types.js";
import type { LineageActionPlanBindingV1 } from "./lineage-action-authority.js";
import type { PublishedRevisionTransitionInputV1 } from "./lineage-published-transition.js";
import type { RevisionReservationRecordV1 } from "./lineage-reservation.js";
import type {
  RevisionOperationV1,
  RevisionPreparationPlanV1,
} from "./lineage-revision-operation.js";
import type { ConversationManifest, MessageRequest } from "./types.js";

export interface PreparedConversationRevisionV1 {
  operation: RevisionOperationV1;
  revisionPlan: RevisionPreparationPlanV1;
  reservation: RevisionReservationRecordV1;
  actionPlan: LineageActionPlanBindingV1;
  proposal: ActionProposalV1;
  approval: ActionApprovalV1;
  manifest: ConversationManifest;
  bindings: MaterializedAgentBinding[];
  bindingAuthorities: BindingAuthoritySnapshot[];
  manifestRecordDigest: string;
  handoff: ContextHandoffV1;
  sharedPrompt: string;
  request: (MessageRequest & { target_participants: "all" | string[] }) | null;
  messageKey: string;
  runtimeOperationId: string;
  queueDelivery: ConversationQueuedMessageDeliveryAuthorityV1 | null;
  priorPublished: readonly PublishedRevisionTransitionInputV1[];
}
