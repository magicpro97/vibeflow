import {
  ACTION_OPERATION_SSE_EVENT,
  isActionOperationTransition,
} from "../../actions/protocol-contract.js";
import { parsePublicApiErrorBody } from "../../actions/public-error-wire-validation.js";
import { parsePublicOperationEvent } from "../../actions/public-operation-wire-validation.js";
import { compareUtf8Wire, sameWireValue } from "../../actions/public-wire-primitives.js";
import { conversationHomeApi } from "./conversation-home-api.js";
import { terminalHomeOperation } from "./conversation-home-runtime.js";
import type { ActivationResourceRegistry, ActivationToken } from "./conversation-home-state.js";
import type { HomeActionOperation, HomeActionView } from "./conversation-home-types.js";

interface HomeOperationStreamInput {
  token: ActivationToken;
  conversationId: string;
  view: HomeActionView;
  streams: ActivationResourceRegistry<EventSource>;
  operationFor(proposalId: string): HomeActionOperation | undefined;
  reload(): Promise<void>;
  invalidUpdate(): void;
}

export interface HomeOperationStreamAuthority {
  readonly eventSourceConstructor: (new (url: string) => EventSource) | undefined;
  readonly operationEventsUrl: typeof conversationHomeApi.operationEventsUrl;
}

export function captureHomeOperationStreamAuthority(): HomeOperationStreamAuthority {
  return Object.freeze({
    eventSourceConstructor: globalThis.EventSource as
      | (new (
          url: string,
        ) => EventSource)
      | undefined,
    operationEventsUrl: conversationHomeApi.operationEventsUrl,
  });
}

/** Binds one generation-owned SSE stream to one durable proposal. */
export function watchHomeOperation(
  input: HomeOperationStreamInput,
  authority = captureHomeOperationStreamAuthority(),
): void {
  const proposalId = input.view.proposal.proposal_id;
  if (terminalHomeOperation(input.view.operation.state)) {
    input.streams.release(proposalId);
    return;
  }
  if (input.view.operation.operation_id === null) {
    input.streams.release(proposalId);
    return;
  }
  const BrowserEventSource = authority.eventSourceConstructor;
  if (!BrowserEventSource) return;
  input.streams.getOrCreate(proposalId, () => {
    const source = new BrowserEventSource(
      authority.operationEventsUrl(
        input.conversationId,
        proposalId,
        input.view.operation.latest_event_cursor,
      ),
    );
    source.addEventListener(ACTION_OPERATION_SSE_EVENT.OPERATION, (event) => {
      if (!input.token.isCurrent()) return;
      try {
        if (!("data" in event) || typeof event.data !== "string")
          throw new Error("invalid operation event");
        const current = input.operationFor(proposalId);
        if (!current) return;
        if (!current.operation_id) throw new Error("operation stream has no operation identity");
        const update = parsePublicOperationEvent(JSON.parse(event.data), {
          operationId: current.operation_id,
          correlationId: current.correlation_id,
          actionType: input.view.proposal.action_type,
          targets: input.view.proposal.targets,
        });
        if (!("lastEventId" in event) || event.lastEventId !== update.event_cursor)
          throw new Error("operation SSE id does not match its payload cursor");
        if (current.phase_sequence !== null && update.phase_sequence <= current.phase_sequence) {
          const replayTarget =
            update.target === null
              ? null
              : (current.targets.find((target) => target.target_id === update.target?.target_id) ??
                null);
          if (
            update.phase_sequence === current.phase_sequence &&
            update.event_cursor === current.latest_event_cursor &&
            update.state === current.state &&
            update.occurred_at === current.updated_at &&
            sameWireValue(update.progress, current.progress[update.phase_sequence]) &&
            (update.target === null || sameWireValue(update.target, replayTarget)) &&
            sameWireValue(update.error, current.error)
          )
            return;
          throw new Error("non-monotonic operation update");
        }
        const expectedSequence = current.phase_sequence === null ? 0 : current.phase_sequence + 1;
        if (update.phase_sequence !== expectedSequence)
          throw new Error("non-dense operation update");
        if (Date.parse(update.occurred_at) < Date.parse(current.updated_at))
          throw new Error("operation update timestamp regressed");
        if (
          update.state !== current.state &&
          !isActionOperationTransition(current.state, update.state)
        )
          throw new Error("invalid operation state transition");
        current.state = update.state;
        current.phase_sequence = update.phase_sequence;
        current.latest_event_cursor = update.event_cursor;
        current.error = update.error;
        current.updated_at = update.occurred_at;
        if (update.progress) current.progress.push(update.progress);
        if (update.target) {
          const index = current.targets.findIndex(
            (target) => target.target_id === update.target?.target_id,
          );
          if (index >= 0) current.targets[index] = update.target;
          else current.targets.push(update.target);
          current.targets.sort((left, right) => compareUtf8Wire(left.target_id, right.target_id));
        }
        if (terminalHomeOperation(update.state) && update.target === null) {
          input.streams.release(proposalId, source);
          void input.reload();
        }
      } catch {
        input.streams.release(proposalId, source);
        input.invalidUpdate();
        void input.reload().catch(() => undefined);
      }
    });
    source.addEventListener(ACTION_OPERATION_SSE_EVENT.ERROR, (event) => {
      if (!input.token.isCurrent()) return;
      // Native transport errors share this event name but carry no server frame.
      // EventSource owns their reconnect loop; only typed SSE errors invalidate durable state.
      if (!("data" in event) || typeof event.data !== "string") return;
      try {
        parsePublicApiErrorBody(JSON.parse(event.data));
      } catch {
        // Invalid and valid terminal stream errors have the same fail-closed recovery path.
      }
      input.streams.release(proposalId, source);
      input.invalidUpdate();
      void input.reload().catch(() => undefined);
    });
    return source;
  });
}
