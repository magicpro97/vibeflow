import type { PublicStoredTraceEvent } from "../trace/types.js";
import type { ConversationBootstrap } from "./bootstrap.js";
import type { ObservedConversationResultV1 } from "./conversation-command-compatibility.js";
import { ConversationHomeCreateBrokerV1 } from "./conversation-home-create-authority.js";
import type { ConversationCreateParticipant, ConversationInvocationOptions } from "./types.js";

export interface DurableConversationCreateV1 {
  principal_digest: string;
  idempotency_key: string;
  request: {
    topic: string;
    policy?: string;
    participants?: ConversationCreateParticipant[];
    max_rounds?: number;
  };
  options?: ConversationInvocationOptions;
}

function abortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function observe(
  bootstrap: ConversationBootstrap,
  conversationId: string,
  onDelta?: (chunk: string) => void,
) {
  const events: PublicStoredTraceEvent[] = [];
  let output = "";
  let lastSeq = 0;
  const listener = (event: PublicStoredTraceEvent) => {
    if (event.seq <= lastSeq) return;
    lastSeq = event.seq;
    events.push(event);
    if (event.event.type !== "agent_response_delta") return;
    const delta = String(event.event.payload.content_delta ?? "");
    if (!delta) return;
    output += delta;
    onDelta?.(delta);
  };
  const unsubscribe = bootstrap.service.subscribe(conversationId, listener, 0);
  const replayReady: Promise<void> =
    unsubscribe && "replayReady" in unsubscribe
      ? ((unsubscribe.replayReady as Promise<void> | undefined) ?? Promise.resolve())
      : Promise.resolve();
  return { events, output: () => output, replayReady, unsubscribe };
}

export async function executeDurableConversationCreateV1(
  bootstrap: ConversationBootstrap,
  input: DurableConversationCreateV1,
  onDelta?: (chunk: string) => void,
  options: { signal?: AbortSignal } = {},
): Promise<ObservedConversationResultV1> {
  throwIfAborted(options.signal);
  const prepared = new ConversationHomeCreateBrokerV1(
    bootstrap.authorities.artifactStore.rootPath(),
    bootstrap.authorities.homeAuthorities.now,
    bootstrap.authorities.privateContextBroker,
  ).prepare({
    principal_digest: input.principal_digest,
    request: {
      schema_version: "1.0",
      idempotency_key: input.idempotency_key,
      topic: input.request.topic,
      ...(input.request.policy === undefined ? {} : { policy: input.request.policy }),
      ...(input.request.participants === undefined
        ? {}
        : { participants: structuredClone(input.request.participants) }),
      ...(input.request.max_rounds === undefined ? {} : { max_rounds: input.request.max_rounds }),
      private_context_present: false,
    },
  });
  const started = await abortable(
    bootstrap.service.startAllocated(
      {
        allocation: prepared.allocation,
        created_at: prepared.created_at,
        private_context_consumed: prepared.private_context_consumed,
        initial_context_record_digest: prepared.initial_context_record_digest,
        request: {
          topic: input.request.topic,
          ...(input.request.policy === undefined ? {} : { policy: input.request.policy }),
          ...(input.request.participants === undefined
            ? {}
            : { participants: structuredClone(input.request.participants) }),
          ...(input.request.max_rounds === undefined
            ? {}
            : { max_rounds: input.request.max_rounds }),
        },
        before_publish: (digest) => prepared.beforePublish(digest),
      },
      input.options,
    ),
    options.signal,
  );
  const stream = observe(bootstrap, started.conversation_id, onDelta);
  try {
    const completed = await abortable(started.completion, options.signal);
    await abortable(stream.replayReady, options.signal);
    return {
      conversation_id: completed.conversation_id,
      conversationId: completed.conversation_id,
      revision_id: completed.revision_id,
      revisionId: completed.revision_id,
      artifact_refs: [...completed.result.artifact_refs],
      artifactRefs: [...completed.result.artifact_refs],
      status: completed.result.status,
      output: stream.output(),
      events: stream.events,
    };
  } finally {
    stream.unsubscribe?.();
  }
}
