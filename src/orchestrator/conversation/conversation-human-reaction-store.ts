import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestHex,
  digestV1,
  privateFileBytes,
} from "../../durability/index.js";
import type { ProcessLock } from "../../durability/index.js";
import type {
  ConversationInteractionEntryV1,
  ConversationInteractionFoldV1,
  ConversationInteractionHeadV1,
  ConversationReactionOperationV1,
  PublicMessageLocatorV1,
  ReactionEmojiV1,
} from "./conversation-interaction-types.js";
import {
  assertConversationReactionOperationV1,
  reactionOperationDigest,
  sameCanonicalInteraction,
} from "./conversation-interaction-validation.js";

const MAX_OBJECT_BYTES = 2 * 1024 * 1024;
const MAX_BINDINGS = 16_384;
const BINDING_FILE = /^[0-9a-f]{64}\.json$/;

interface HumanReactionRequestBindingV1 {
  schema_version: "1.0";
  root_session_id: string;
  actor_public_id: string;
  idempotency_key: string;
  request_mode: "add" | "remove" | "toggle-self";
  target: PublicMessageLocatorV1;
  emoji: ReactionEmojiV1;
  operation: ConversationReactionOperationV1;
}

export interface HumanReactionInputV1 {
  root_session_id: string;
  actor_public_id: string;
  idempotency_key: string;
  target: PublicMessageLocatorV1;
  emoji: ReactionEmojiV1;
  created_at: string;
}

export interface HumanReactionStoreHostV1 {
  idempotencyRoot: string;
  withLock<T>(operation: string, run: (lock: ProcessLock) => T): T;
  readFold(rootSessionId: string): ConversationInteractionFoldV1;
  readHead(rootSessionId: string): ConversationInteractionHeadV1;
  append(
    rootSessionId: string,
    prior: ConversationInteractionHeadV1,
    entry: ConversationInteractionEntryV1,
    lock: ProcessLock,
  ): ConversationInteractionHeadV1;
  afterRequestBinding?(): void;
  afterReactionAppend?(): void;
}

function activeKey(input: {
  target: PublicMessageLocatorV1;
  actor_public_id: string;
  emoji: ReactionEmojiV1;
}): string {
  return `${input.target.target_event_id}\0${input.actor_public_id}\0${input.emoji}`;
}

function activeReactions(
  operations: readonly ConversationReactionOperationV1[],
): Map<string, ConversationReactionOperationV1> {
  const active = new Map<string, ConversationReactionOperationV1>();
  for (const operation of operations) {
    const key = activeKey(operation);
    if (operation.operation === "add") active.set(key, operation);
    else active.delete(key);
  }
  return active;
}

function latestRemove(
  operations: readonly ConversationReactionOperationV1[],
  input: HumanReactionInputV1,
): ConversationReactionOperationV1 | undefined {
  for (let index = operations.length - 1; index >= 0; index -= 1) {
    const item = operations[index];
    if (item && activeKey(item) === activeKey(input) && item.operation === "remove") return item;
  }
  return undefined;
}

function idempotencyFilename(input: {
  root_session_id: string;
  actor_public_id: string;
  idempotency_key: string;
}): string {
  return `${digestHex(
    digestV1("VF-CONVERSATION-REACTION-IDEMPOTENCY-KEY\0v1\0", {
      root_session_id: input.root_session_id,
      actor_public_id: input.actor_public_id,
      idempotency_key: input.idempotency_key,
    }),
  )}.json`;
}

function idempotencyPath(host: HumanReactionStoreHostV1, input: HumanReactionInputV1): string {
  return join(host.idempotencyRoot, idempotencyFilename(input));
}

function decodeBinding(bytes: Buffer): HumanReactionRequestBindingV1 {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !canonicalJsonBytes(value).equals(bytes) ||
    Object.keys(value).length !== 8
  )
    throw new Error("reaction idempotency binding is corrupt");
  const row = value as unknown as HumanReactionRequestBindingV1;
  assertConversationReactionOperationV1(row.operation);
  if (
    row.schema_version !== "1.0" ||
    typeof row.idempotency_key !== "string" ||
    row.idempotency_key.length < 1 ||
    Buffer.byteLength(row.idempotency_key, "utf8") > 200 ||
    !["add", "remove", "toggle-self"].includes(row.request_mode) ||
    row.operation.root_session_id !== row.root_session_id ||
    row.operation.actor_public_id !== row.actor_public_id ||
    row.operation.actor_kind !== "human" ||
    row.operation.emoji !== row.emoji ||
    !sameCanonicalInteraction(row.operation.target, row.target) ||
    (row.request_mode !== "toggle-self" && row.operation.operation !== row.request_mode)
  )
    throw new Error("reaction idempotency binding is corrupt");
  return structuredClone(row);
}

function readBinding(
  host: HumanReactionStoreHostV1,
  input: HumanReactionInputV1,
  mode: "add" | "remove" | "toggle-self",
): ConversationReactionOperationV1 | null {
  const bytes = privateFileBytes(idempotencyPath(host, input), MAX_OBJECT_BYTES);
  if (bytes === null) return null;
  const row = decodeBinding(bytes);
  if (
    row.schema_version !== "1.0" ||
    row.root_session_id !== input.root_session_id ||
    row.actor_public_id !== input.actor_public_id ||
    row.idempotency_key !== input.idempotency_key ||
    row.request_mode !== mode ||
    row.emoji !== input.emoji ||
    !sameCanonicalInteraction(row.target, input.target)
  )
    throw new Error("reaction idempotency binding conflict");
  if (
    row.operation.root_session_id !== input.root_session_id ||
    row.operation.actor_public_id !== input.actor_public_id ||
    row.operation.actor_kind !== "human" ||
    row.operation.emoji !== input.emoji ||
    !sameCanonicalInteraction(row.operation.target, input.target) ||
    (mode !== "toggle-self" && row.operation.operation !== mode)
  )
    throw new Error("reaction idempotency binding conflict");
  return structuredClone(row.operation);
}

/** Completes every request-first reaction WAL before another same-root interaction can append. */
export function recoverPendingHumanReactionsV1(
  host: HumanReactionStoreHostV1,
  rootSessionId: string,
  lock: ProcessLock,
): void {
  const names = readdirSync(host.idempotencyRoot).sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  if (names.length > MAX_BINDINGS || names.some((name) => !BINDING_FILE.test(name)))
    throw new Error("reaction idempotency binding inventory is corrupt");
  for (const name of names) {
    const bytes = privateFileBytes(join(host.idempotencyRoot, name), MAX_OBJECT_BYTES);
    if (!bytes) throw new Error("reaction idempotency binding disappeared");
    const binding = decodeBinding(bytes);
    if (idempotencyFilename(binding) !== name)
      throw new Error("reaction idempotency storage key changed");
    if (binding.root_session_id !== rootSessionId) continue;
    const fold = host.readFold(rootSessionId);
    const durable = fold.reactions.find(
      (item) => item.operation_id === binding.operation.operation_id,
    );
    if (durable) {
      if (!sameCanonicalInteraction(durable, binding.operation))
        throw new Error("reaction idempotency operation changed");
      continue;
    }
    const head = host.readHead(rootSessionId);
    if (binding.operation.prior_interaction_head_digest !== head.content_digest)
      throw new Error("reaction idempotency operation cannot be recovered");
    host.append(
      rootSessionId,
      head,
      { kind: "reaction-operation", operation: binding.operation },
      lock,
    );
  }
}

function bindRequest(
  host: HumanReactionStoreHostV1,
  input: HumanReactionInputV1,
  mode: "add" | "remove" | "toggle-self",
  operation: ConversationReactionOperationV1,
  lock: ProcessLock,
): void {
  const binding = {
    schema_version: "1.0",
    root_session_id: input.root_session_id,
    actor_public_id: input.actor_public_id,
    idempotency_key: input.idempotency_key,
    request_mode: mode,
    target: structuredClone(input.target),
    emoji: input.emoji,
    operation: structuredClone(operation),
  };
  createOrVerifyPrivateFile(idempotencyPath(host, input), canonicalJsonBytes(binding), {
    lock,
    maxBytes: MAX_OBJECT_BYTES,
  });
}

function commitLocked(
  host: HumanReactionStoreHostV1,
  input: HumanReactionInputV1,
  operationKind: "add" | "remove",
  mode: "add" | "remove" | "toggle-self",
  lock: ProcessLock,
  fold: ConversationInteractionFoldV1,
): ConversationReactionOperationV1 {
  const active = activeReactions(fold.reactions);
  const activeReaction = active.get(activeKey(input));
  if (operationKind === "add" && activeReaction) {
    bindRequest(host, input, mode, activeReaction, lock);
    return activeReaction;
  }
  if (operationKind === "remove" && !activeReaction) {
    const priorRemove = latestRemove(fold.reactions, input);
    if (!priorRemove) throw new Error("reaction remove lacks an active owned reaction");
    bindRequest(host, input, mode, priorRemove, lock);
    return priorRemove;
  }
  const head = host.readHead(input.root_session_id);
  const operationId = `vf-reaction-${digestHex(
    digestV1("VF-CONVERSATION-REACTION-TRANSITION-ID\0v1\0", {
      root_session_id: input.root_session_id,
      actor_public_id: input.actor_public_id,
      operation: operationKind,
      target: input.target,
      emoji: input.emoji,
      prior_interaction_head_digest: head.content_digest,
    }),
  )}`;
  const preimage = {
    schema_version: "1.0" as const,
    operation_id: operationId,
    root_session_id: input.root_session_id,
    actor_public_id: input.actor_public_id,
    actor_kind: "human" as const,
    operation: operationKind,
    target: structuredClone(input.target),
    emoji: input.emoji,
    prior_interaction_head_digest: head.content_digest,
    created_at: input.created_at,
  };
  const operation = { ...preimage, operation_digest: reactionOperationDigest(preimage) };
  bindRequest(host, input, mode, operation, lock);
  host.afterRequestBinding?.();
  host.append(input.root_session_id, head, { kind: "reaction-operation", operation }, lock);
  host.afterReactionAppend?.();
  return operation;
}

export function commitHumanReactionV1(
  host: HumanReactionStoreHostV1,
  input: HumanReactionInputV1,
  mode: "add" | "remove" | "toggle-self",
): ConversationReactionOperationV1 {
  return host.withLock(`human-reaction:${input.idempotency_key}`, (lock) => {
    recoverPendingHumanReactionsV1(host, input.root_session_id, lock);
    const fold = host.readFold(input.root_session_id);
    const bound = readBinding(host, input, mode);
    if (bound) {
      const durable = fold.reactions.find((item) => item.operation_id === bound.operation_id);
      if (durable) {
        if (!sameCanonicalInteraction(durable, bound))
          throw new Error("reaction idempotency operation changed");
        return durable;
      }
      const head = host.readHead(input.root_session_id);
      if (bound.prior_interaction_head_digest !== head.content_digest)
        throw new Error("reaction idempotency operation cannot be recovered");
      host.append(
        input.root_session_id,
        head,
        { kind: "reaction-operation", operation: bound },
        lock,
      );
      host.afterReactionAppend?.();
      return bound;
    }
    const operation =
      mode === "toggle-self"
        ? activeReactions(fold.reactions).has(activeKey(input))
          ? "remove"
          : "add"
        : mode;
    return commitLocked(host, input, operation, mode, lock, fold);
  });
}
