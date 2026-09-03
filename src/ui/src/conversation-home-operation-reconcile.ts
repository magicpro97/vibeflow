import type { Ref } from "vue";
import { watchHomeOperation } from "./conversation-home-operation-stream.js";
import type { HomeOperationStreamAuthority } from "./conversation-home-operation-stream.js";
import type { ActivationResourceRegistry, ActivationToken } from "./conversation-home-state.js";
import type { HomeActionView } from "./conversation-home-types.js";

export interface HomeOperationBindingContext {
  readonly token: ActivationToken;
  readonly streams: ActivationResourceRegistry<EventSource>;
  readonly conversationId: () => string | null;
  readonly pendingActions: Ref<HomeActionView[]>;
  readonly reload: () => Promise<void>;
  readonly invalidUpdate: () => void;
}

export function bindHomeOperationStream(
  context: HomeOperationBindingContext,
  view: HomeActionView,
  authority?: HomeOperationStreamAuthority,
): boolean {
  const conversationId = context.conversationId();
  if (!context.token.isCurrent() || !conversationId) return false;
  const currentView = context.pendingActions.value.find(
    (item) => item.proposal.proposal_id === view.proposal.proposal_id,
  );
  if (!currentView) return false;
  watchHomeOperation(
    {
      token: context.token,
      conversationId,
      view: currentView,
      streams: context.streams,
      operationFor: (proposalId) =>
        context.pendingActions.value.find((item) => item.proposal.proposal_id === proposalId)
          ?.operation,
      reload: context.reload,
      invalidUpdate: context.invalidUpdate,
    },
    authority,
  );
  return true;
}

export function createHomeOperationReconciler(authority?: HomeOperationStreamAuthority) {
  let current: HomeOperationBindingContext | null = null;
  return Object.freeze({
    bind(context: HomeOperationBindingContext): void {
      current = context;
      context.token.addCleanup(() => {
        if (current === context) current = null;
      });
    },
    reconcile(view: HomeActionView): boolean {
      return current ? bindHomeOperationStream(current, view, authority) : false;
    },
  });
}
