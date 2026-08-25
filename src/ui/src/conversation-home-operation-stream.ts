import { conversationHomeApi } from "./conversation-home-api.js";
import { isHomeActionOperationState, terminalHomeOperation } from "./conversation-home-runtime.js";
import type { ActivationResourceRegistry, ActivationToken } from "./conversation-home-state.js";
import type { HomeActionOperation, HomeActionView } from "./conversation-home-types.js";

type HomeOperationProgress = HomeActionOperation["progress"][number];
type HomeOperationTarget = HomeActionOperation["targets"][number];

interface HomeOperationUpdate {
  state: HomeActionOperation["state"];
  phase_sequence: number;
  progress: HomeOperationProgress | null;
  target: HomeOperationTarget | null;
  event_cursor: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function operationProgress(value: unknown): value is HomeOperationProgress {
  if (!record(value)) return false;
  return (
    typeof value.sequence === "number" &&
    Number.isSafeInteger(value.sequence) &&
    typeof value.phase === "string" &&
    ["pending", "running", "succeeded", "failed", "reversed"].includes(
      typeof value.status === "string" ? value.status : "",
    ) &&
    typeof value.message_code === "string" &&
    typeof value.at === "string"
  );
}

function operationTarget(value: unknown): value is HomeOperationTarget {
  return (
    record(value) &&
    typeof value.target_id === "string" &&
    typeof value.outcome === "string" &&
    typeof value.health === "string"
  );
}

function operationUpdate(source: string): HomeOperationUpdate {
  const value: unknown = JSON.parse(source);
  if (
    !record(value) ||
    !isHomeActionOperationState(value.state) ||
    typeof value.phase_sequence !== "number" ||
    !Number.isSafeInteger(value.phase_sequence) ||
    value.phase_sequence < 0 ||
    (value.progress !== null && !operationProgress(value.progress)) ||
    (value.target !== null && !operationTarget(value.target)) ||
    typeof value.event_cursor !== "string" ||
    !/^vf-operation-event-[0-9a-f]{64}$/.test(value.event_cursor)
  )
    throw new Error("invalid operation update");
  return {
    state: value.state,
    phase_sequence: value.phase_sequence,
    progress: value.progress,
    target: value.target,
    event_cursor: value.event_cursor,
  };
}

interface HomeOperationStreamInput {
  token: ActivationToken;
  conversationId: string;
  view: HomeActionView;
  streams: ActivationResourceRegistry<EventSource>;
  operationFor(proposalId: string): HomeActionOperation | undefined;
  reload(): Promise<void>;
  invalidUpdate(): void;
}

/** Binds one generation-owned SSE stream to one durable proposal. */
export function watchHomeOperation(input: HomeOperationStreamInput): void {
  const proposalId = input.view.proposal.proposal_id;
  if (terminalHomeOperation(input.view.operation.state)) {
    input.streams.release(proposalId);
    return;
  }
  const BrowserEventSource: (new (url: string) => EventSource) | undefined = globalThis.EventSource;
  if (!BrowserEventSource) return;
  input.streams.getOrCreate(proposalId, () => {
    const source = new BrowserEventSource(
      conversationHomeApi.operationEventsUrl(
        input.conversationId,
        proposalId,
        input.view.operation.latest_event_cursor,
      ),
    );
    source.addEventListener("operation", (event) => {
      if (!input.token.isCurrent()) return;
      try {
        if (!("data" in event) || typeof event.data !== "string")
          throw new Error("invalid operation event");
        const update = operationUpdate(event.data);
        const current = input.operationFor(proposalId);
        if (!current) return;
        if (current.phase_sequence !== null && update.phase_sequence <= current.phase_sequence) {
          if (
            update.phase_sequence === current.phase_sequence &&
            update.event_cursor === current.latest_event_cursor &&
            update.state === current.state
          )
            return;
          throw new Error("non-monotonic operation update");
        }
        current.state = update.state;
        current.phase_sequence = update.phase_sequence;
        current.latest_event_cursor = update.event_cursor;
        if (update.progress) current.progress.push(update.progress);
        if (update.target) {
          const index = current.targets.findIndex(
            (target) => target.target_id === update.target?.target_id,
          );
          if (index >= 0) current.targets[index] = update.target;
          else current.targets.push(update.target);
        }
        if (terminalHomeOperation(update.state)) {
          input.streams.release(proposalId, source);
          void input.reload();
        }
      } catch {
        input.streams.release(proposalId, source);
        input.invalidUpdate();
        void input.reload().catch(() => undefined);
      }
    });
    return source;
  });
}
