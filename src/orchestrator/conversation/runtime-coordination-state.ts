import { canonicalJsonBytes } from "../../durability/index.js";
import type { TraceStore } from "../trace/store.js";
import type { ConversationArtifactStore, ConversationDurableRecord } from "./artifact-store.js";
import {
  CONVERSATION_COORDINATION_DIRECTIVE_KIND,
  CONVERSATION_COORDINATION_PHASE,
  CONVERSATION_COORDINATION_TOOL,
} from "./conversation-coordination-contract.js";
import {
  type ConversationCoordinationStateV1,
  emptyConversationCoordinationState,
  foldConversationCoordinationRecords,
} from "./conversation-coordination-fold.js";
import type {
  ConversationCoordinationRecordV1,
  StoredConversationCoordinationRecordV1,
} from "./conversation-coordination-records.js";
import { assertConversationCoordinationRecord } from "./conversation-coordination-validation.js";
import {
  CONVERSATION_ARTIFACT_TYPE,
  CONVERSATION_TOOL_ACTION_STATUS,
  CONVERSATION_TRACE_EVENT_KIND,
} from "./conversation-public-wire-contract.js";

interface RuntimeCoordinationStateInput {
  artifactStore: ConversationArtifactStore;
  traceStore: TraceStore;
  conversationId: string;
  revisionId: string;
}

interface CoordinationLineageNode {
  conversationId: string;
  revisionId: string;
  record: NonNullable<ReturnType<ConversationArtifactStore["readRecord"]>>;
}

const DIRECTIVE_KINDS = new Set<string>(Object.values(CONVERSATION_COORDINATION_DIRECTIVE_KIND));

const fail = (message: string): never => {
  throw new Error(`invalid coordination authority: ${message}`);
};
const terminalEpoch = (state: ConversationCoordinationStateV1): boolean =>
  state.phase === CONVERSATION_COORDINATION_PHASE.COMPLETED ||
  state.phase === CONVERSATION_COORDINATION_PHASE.TERMINATED;

function currentCoordinationEpoch(
  committed: readonly StoredConversationCoordinationRecordV1[],
  pending: readonly StoredConversationCoordinationRecordV1[],
  revisionId: string,
): ConversationCoordinationStateV1 {
  const epochs: StoredConversationCoordinationRecordV1[][] = [];
  for (const stored of committed) {
    const current = epochs.at(-1);
    if (!current || current[0]?.record.epoch_id !== stored.record.epoch_id) {
      if (current) {
        const prior = foldConversationCoordinationRecords(current);
        if (!terminalEpoch(prior)) fail("epoch changed before finalization");
      }
      epochs.push([stored]);
    } else current.push(stored);
  }
  for (const prior of epochs.slice(0, -1)) {
    if (!terminalEpoch(foldConversationCoordinationRecords(prior)))
      fail("non-terminal prior epoch");
  }
  const latest = epochs.at(-1) ?? [];
  const latestState = foldConversationCoordinationRecords(latest);
  const orphan = pending[0];
  if (pending.length > 1) fail("multiple pending records");
  if (orphan && orphan.record.epoch_id !== latestState.epoch_id) {
    if (
      !terminalEpoch(latestState) ||
      orphan.record.revision_id !== revisionId ||
      orphan.record.step !== 1 ||
      orphan.record.previous_ref !== null
    )
      fail("pending epoch transition");
    return foldConversationCoordinationRecords([], [orphan]);
  }
  if (orphan) return foldConversationCoordinationRecords(latest, [orphan]);
  const terminal = latest.at(-1)?.record;
  return terminalEpoch(latestState) && terminal?.revision_id !== revisionId
    ? emptyConversationCoordinationState()
    : latestState;
}

function decodeRecord(
  bytes: Uint8Array,
  artifactRef: string,
): StoredConversationCoordinationRecordV1 {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
    assertConversationCoordinationRecord(value);
  } catch {
    return fail("artifact record");
  }
  if (!Buffer.from(canonicalJsonBytes(value)).equals(Buffer.from(bytes)))
    fail("non-canonical artifact record");
  return Object.freeze({
    artifact_ref: artifactRef,
    record: value as ConversationCoordinationRecordV1,
  });
}

function coordinationLineage(
  store: ConversationArtifactStore,
  conversationId: string,
  revisionId: string,
): CoordinationLineageNode[] {
  const reversed: CoordinationLineageNode[] = [];
  const visited = new Set<string>();
  let cursorId: string | null = conversationId;
  let cursorRevision: string | null = revisionId;
  while (cursorId && cursorRevision) {
    if (visited.has(cursorId) || visited.size >= 64) fail("conversation lineage");
    visited.add(cursorId);
    const record: ConversationDurableRecord =
      store.readRecord(cursorId) ?? fail("conversation manifest missing");
    if (record.manifest.revision_id !== cursorRevision) fail("conversation revision lineage");
    reversed.push({ conversationId: cursorId, revisionId: cursorRevision, record });
    const parentId: string | null = record.manifest.parent_conversation_id;
    const parentRevision: string | null = record.manifest.parent_revision_id;
    if ((parentId === null) !== (parentRevision === null)) fail("conversation parent lineage");
    cursorId = parentId;
    cursorRevision = parentRevision;
  }
  return reversed.reverse();
}

/** Rebuilds the coordination state only from immutable artifacts committed by canonical trace events. */
export async function readRuntimeConversationCoordinationState(
  input: RuntimeCoordinationStateInput,
): Promise<ConversationCoordinationStateV1> {
  const lineage = coordinationLineage(input.artifactStore, input.conversationId, input.revisionId);
  const matching = new Map<string, StoredConversationCoordinationRecordV1>();
  for (const node of lineage) {
    for (const entry of node.record.artifacts) {
      if (entry.artifact_type !== CONVERSATION_ARTIFACT_TYPE.COORDINATION) continue;
      const bytes =
        input.artifactStore.readArtifactRef(node.conversationId, entry.ref) ??
        fail("artifact content missing");
      const stored = decodeRecord(bytes, entry.ref);
      if (stored.record.revision_id !== node.revisionId) fail("artifact revision binding");
      if (matching.has(entry.ref)) fail("duplicate artifact reference");
      matching.set(entry.ref, stored);
    }
  }

  const committed: StoredConversationCoordinationRecordV1[] = [];
  const committedRefs = new Set<string>();
  for (const node of lineage) {
    const trace = await input.traceStore.readConversation(node.conversationId);
    for (const { stored_event: event } of trace) {
      if (
        event.event.type !== CONVERSATION_TRACE_EVENT_KIND.TOOL_ACTION ||
        event.event.payload.tool !== CONVERSATION_COORDINATION_TOOL
      )
        continue;
      if (event.revision_id !== node.revisionId) fail("commit revision binding");
      const payload = event.event.payload;
      const outputRef = payload.output_ref;
      if (
        payload.status !== CONVERSATION_TOOL_ACTION_STATUS.COMPLETED ||
        outputRef === null ||
        !DIRECTIVE_KINDS.has(payload.action)
      )
        return fail("commit event");
      const stored = matching.get(outputRef) ?? fail("commit artifact reference");
      if (
        stored.record.operation_id !== event.operation_id ||
        stored.record.directive.kind !== payload.action ||
        stored.record.previous_ref !== payload.input_ref ||
        committedRefs.has(outputRef)
      )
        fail("commit binding");
      committedRefs.add(outputRef);
      committed.push(stored);
    }
  }

  const pending = [...matching.values()].filter(
    ({ artifact_ref: artifactRef }) => !committedRefs.has(artifactRef),
  );
  return currentCoordinationEpoch(committed, pending, input.revisionId);
}
