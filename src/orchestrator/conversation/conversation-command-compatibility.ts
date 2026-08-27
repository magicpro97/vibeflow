import { randomBytes } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { digestV1 } from "../../durability/index.js";
import type { PublicStoredTraceEvent } from "../trace/types.js";
import type { ConversationBootstrap } from "./bootstrap.js";
import {
  type ConversationAskCompatibilityRequestV1,
  ConversationAskCompatibilityV1,
} from "./conversation-ask-compatibility.js";
import {
  CONVERSATION_COMMAND_RESULT_STATUS,
  CONVERSATION_COMMAND_STATUS_BY_TERMINAL_LIFECYCLE,
  CONVERSATION_LEGACY_RESULT_LIFECYCLE,
  type ConversationCommandResultStatus,
} from "./conversation-command-result-contract.js";
import { ConversationHomeCreateBrokerV1 } from "./conversation-home-create-authority.js";
import {
  CONVERSATION_MESSAGE_QUEUE_EVENT_KIND,
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
  CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE,
} from "./conversation-message-queue-contract.js";
import {
  CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
  CONVERSATION_PRIVATE_CONTEXT_SOURCE_KIND,
} from "./conversation-private-context-broker-wire.js";
import {
  CONVERSATION_TERMINAL_LIFECYCLES,
  CONVERSATION_TRACE_EVENT_KIND,
  isConversationTerminalLifecycle,
} from "./conversation-public-wire-contract.js";

export interface ObservedConversationResultV1 {
  conversation_id: string;
  conversationId: string;
  child_conversation_id?: string;
  childConversationId?: string;
  root_session_id?: string;
  rootSessionId?: string;
  queue_item_id?: string;
  queueItemId?: string;
  revision_id?: string;
  revisionId?: string;
  artifact_refs?: string[];
  artifactRefs?: string[];
  status: ConversationCommandResultStatus;
  output: string;
  events: PublicStoredTraceEvent[];
}

export interface DurableQueuedConversationMessageV1 {
  conversation_id: string;
  principal_digest: string;
  idempotency_key: string;
  content: string;
  private_file_range?: {
    repo_relative_path: string;
    start_line: number;
    end_line: number;
  };
}

const WAIT_MS = 5;
const WAIT_TIMEOUT_MS = 300_000;
const STABLE_COMPATIBILITY_LIFECYCLES = Object.freeze([
  ...CONVERSATION_TERMINAL_LIFECYCLES,
  CONVERSATION_LEGACY_RESULT_LIFECYCLE.AWAITING_APPROVAL,
]);
type StableCompatibilityLifecycle = (typeof STABLE_COMPATIBILITY_LIFECYCLES)[number];
const isStableCompatibilityLifecycle = (value: string): value is StableCompatibilityLifecycle =>
  STABLE_COMPATIBILITY_LIFECYCLES.some((candidate) => candidate === value);

function lifecycleStatus(value: StableCompatibilityLifecycle): ConversationCommandResultStatus {
  if (isConversationTerminalLifecycle(value))
    return CONVERSATION_COMMAND_STATUS_BY_TERMINAL_LIFECYCLE[value];
  return CONVERSATION_COMMAND_RESULT_STATUS.AWAITING_APPROVAL;
}

function observe(
  bootstrap: ConversationBootstrap,
  conversationId: string,
  onDelta?: (chunk: string) => void,
  afterSeq = 0,
) {
  const events: PublicStoredTraceEvent[] = [];
  let output = "";
  let lastSeq = afterSeq;
  const listener = (event: PublicStoredTraceEvent) => {
    if (event.seq <= lastSeq) return;
    lastSeq = event.seq;
    events.push(event);
    if (event.event.type !== CONVERSATION_TRACE_EVENT_KIND.AGENT_RESPONSE_DELTA) return;
    const delta = String(event.event.payload.content_delta ?? "");
    if (!delta) return;
    output += delta;
    onDelta?.(delta);
  };
  const unsubscribe = bootstrap.service.subscribe(conversationId, listener, afterSeq);
  const replayReady: Promise<void> =
    unsubscribe && "replayReady" in unsubscribe
      ? ((unsubscribe.replayReady as Promise<void> | undefined) ?? Promise.resolve())
      : Promise.resolve();
  return { events, output: () => output, replayReady, unsubscribe };
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

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForTerminal(
  bootstrap: ConversationBootstrap,
  conversationId: string,
  onDelta?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<ObservedConversationResultV1> {
  throwIfAborted(signal);
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  const stream = observe(bootstrap, conversationId, onDelta);
  try {
    while (true) {
      const snapshot = await abortable(bootstrap.service.snapshot(conversationId), signal);
      if (!snapshot) throw new Error("conversation not found");
      if (!isStableCompatibilityLifecycle(snapshot.lifecycle)) {
        if (Date.now() >= deadline)
          throw new Error("timed out waiting for conversation to reach a terminal lifecycle");
        await pause(WAIT_MS, signal);
        continue;
      }
      await abortable(stream.replayReady, signal);
      return {
        conversation_id: conversationId,
        conversationId,
        status: lifecycleStatus(snapshot.lifecycle),
        output: stream.output(),
        events: stream.events,
      };
    }
  } finally {
    stream.unsubscribe?.();
  }
}

function askCompatibility(bootstrap: ConversationBootstrap) {
  return new ConversationAskCompatibilityV1({
    privateContext: bootstrap.authorities.privateContextBroker,
    homeCreate: new ConversationHomeCreateBrokerV1(
      bootstrap.authorities.artifactStore.rootPath(),
      bootstrap.authorities.homeAuthorities.now,
      bootstrap.authorities.privateContextBroker,
    ),
    startAllocated: (input) => bootstrap.service.startAllocated(input),
    queue: bootstrap.authorities.messageQueue,
  });
}

function deliveredChildConversation(
  bootstrap: ConversationBootstrap,
  rootSessionId: string,
  queueItemId: string,
): string | null {
  const events = bootstrap.authorities.messageQueue
    .storeAuthority(rootSessionId)
    .journal.readEvents();
  let event = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const candidate = events[index];
    if (candidate?.payload.item.queue_item_id !== queueItemId) continue;
    event = candidate;
    break;
  }
  if (!event) return null;
  if (event.payload.kind === CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.STALE) {
    const detail = event.payload.item.stale_reason ?? "unknown";
    throw new Error(`queued conversation message became stale (${detail})`);
  }
  return event.payload.kind === CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.DELIVERED
    ? event.payload.delivery_proof.successor_authority.conversation_id
    : null;
}

async function waitForQueuedConversation(
  bootstrap: ConversationBootstrap,
  rootSessionId: string,
  queueItemId: string,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (true) {
    const child = deliveredChildConversation(bootstrap, rootSessionId, queueItemId);
    if (child) return child;
    if (Date.now() >= deadline)
      throw new Error("timed out waiting for queued conversation delivery");
    await pause(WAIT_MS, signal);
  }
}

export function durableCliPrincipalDigest(scope: string): string {
  return digestV1("VF-CLI-CONVERSATION-COMPATIBILITY-PRINCIPAL\0v1\0", {
    schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
    scope,
  });
}

export function durableCliIdempotencyKey(prefix: string, request: unknown): string {
  void request;
  return `${prefix}.${randomBytes(16).toString("hex")}`;
}

export function repoRelativePrivateRange(
  repoRoot: string,
  path: string,
  startLine: number,
  endLine: number,
): { repo_relative_path: string; start_line: number; end_line: number } | string {
  const target = resolve(repoRoot, path);
  const selected = relative(resolve(repoRoot), target);
  if (!selected || selected.startsWith("..") || isAbsolute(selected))
    return `path escapes repo: ${path}`;
  return {
    repo_relative_path: selected.split(sep).join("/"),
    start_line: startLine,
    end_line: endLine,
  };
}

export async function executeDurableAskV1(
  bootstrap: ConversationBootstrap,
  input: {
    principal_digest: string;
    idempotency_key: string;
    request: ConversationAskCompatibilityRequestV1;
  },
  onDelta?: (chunk: string) => void,
  options: { signal?: AbortSignal } = {},
): Promise<ObservedConversationResultV1> {
  const result = await abortable(askCompatibility(bootstrap).submit(input), options.signal);
  if (result.kind === "created")
    return waitForTerminal(bootstrap, result.conversation_id, onDelta, options.signal);
  const childConversationId = await waitForQueuedConversation(
    bootstrap,
    result.root_session_id,
    result.queue_item_id,
    options.signal,
  );
  const observed = await waitForTerminal(bootstrap, childConversationId, onDelta, options.signal);
  return {
    ...observed,
    child_conversation_id: childConversationId,
    childConversationId,
    root_session_id: result.root_session_id,
    rootSessionId: result.root_session_id,
    queue_item_id: result.queue_item_id,
    queueItemId: result.queue_item_id,
  };
}

export async function executeDurableQueuedConversationMessageV1(
  bootstrap: ConversationBootstrap,
  input: DurableQueuedConversationMessageV1,
  onDelta?: (chunk: string) => void,
  options: { signal?: AbortSignal } = {},
): Promise<ObservedConversationResultV1> {
  throwIfAborted(options.signal);
  const resolved = bootstrap.authorities.messageQueue.resolveCommittedConversation(
    input.conversation_id,
  );
  const rootSessionId = resolved.root_session_id;
  if (input.private_file_range) {
    bootstrap.authorities.privateContextBroker.stageMessage({
      root_session_id: rootSessionId,
      principal_digest: input.principal_digest,
      resolve_authority: () => bootstrap.authorities.messageQueue.resolveAuthority(rootSessionId),
      request: {
        schema_version: CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
        enqueue_idempotency_key: input.idempotency_key,
        source_kind: CONVERSATION_PRIVATE_CONTEXT_SOURCE_KIND.PRIVATE_FILE_RANGE,
        repo_relative_path: input.private_file_range.repo_relative_path,
        start_line: input.private_file_range.start_line,
        end_line: input.private_file_range.end_line,
      },
    });
  }
  const authority = bootstrap.authorities.messageQueue.assertRoot(rootSessionId);
  const admitted = input.private_file_range
    ? bootstrap.authorities.messageQueue.enqueue({
        root_session_id: rootSessionId,
        principal_digest: input.principal_digest,
        request: {
          schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
          idempotency_key: input.idempotency_key,
          expected_authority_digest: authority.authority_digest,
          client_instance_id: `compatibility-${input.idempotency_key}`.slice(0, 128),
          client_order: 1,
          content: input.content,
          target_participants: CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL,
          quote_refs: [],
          private_context_present: true,
        },
      })
    : bootstrap.authorities.messageQueue.enqueueCompatibility(
        input.conversation_id,
        input.principal_digest,
        input.idempotency_key,
        { content: input.content },
      );
  const childConversationId = await waitForQueuedConversation(
    bootstrap,
    rootSessionId,
    admitted.item.queue_item_id,
    options.signal,
  );
  const observed = await waitForTerminal(bootstrap, childConversationId, onDelta, options.signal);
  return {
    ...observed,
    child_conversation_id: childConversationId,
    childConversationId,
    root_session_id: rootSessionId,
    rootSessionId,
    queue_item_id: admitted.item.queue_item_id,
    queueItemId: admitted.item.queue_item_id,
  };
}
