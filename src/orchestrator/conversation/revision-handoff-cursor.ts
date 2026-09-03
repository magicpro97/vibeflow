import { createHash } from "node:crypto";
import { canonicalJsonBytes } from "../../durability/index.js";
import { REACTION_EMOJIS } from "./conversation-interaction-types.js";
import {
  assertPublicMessageLocatorV1,
  assertPublicQuoteReferenceV1,
} from "./conversation-interaction-validation.js";
import { CONVERSATION_PUBLIC_ARTIFACT_DELIVERY } from "./conversation-public-wire-contract.js";
import { MAX_CANONICAL_HANDOFF_BYTES } from "./handoff-limits.js";
import type { ContextHandoffV1, PromptArtifactSelectionV1 } from "./handoff-types.js";
import { assertContextHandoffV1 } from "./handoff-validation.js";
import {
  REVISION_INTERACTION_CURSOR_MEDIA_TYPE,
  REVISION_QUOTE_GRAPH_MEDIA_TYPE,
  REVISION_QUOTE_GRAPH_PROFILE,
} from "./revision-handoff-contract.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const GRAPH_ID = /^vf-public-quote-graph-([0-9a-f]{64})$/;
const CURSOR_ID = /^vf-ic-([0-9a-f]{64})$/;
const CURSOR_TEXT = /^(0|[1-9][0-9]*):([0-9a-f]{64})$/;

export interface RevisionHandoffInteractionCursorV1 {
  interaction_sequence: number;
  interaction_head_digest: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertQuoteGraph(value: unknown): asserts value is {
  root_session_id: string;
  interaction_head_sequence: number | null;
  interaction_head_digest: string | null;
} {
  if (
    !record(value) ||
    !exactKeys(value, [
      "interaction_head_digest",
      "interaction_head_sequence",
      "occurrences",
      "profile",
      "reaction_projections",
      "root_session_id",
      "schema_version",
    ]) ||
    value.schema_version !== "1.0" ||
    value.profile !== REVISION_QUOTE_GRAPH_PROFILE ||
    typeof value.root_session_id !== "string" ||
    value.root_session_id.length === 0 ||
    !Array.isArray(value.occurrences) ||
    !Array.isArray(value.reaction_projections) ||
    (value.interaction_head_sequence === null) !== (value.interaction_head_digest === null) ||
    (value.interaction_head_sequence !== null &&
      (!Number.isSafeInteger(value.interaction_head_sequence) ||
        (value.interaction_head_sequence as number) < 0 ||
        typeof value.interaction_head_digest !== "string" ||
        !DIGEST.test(value.interaction_head_digest)))
  )
    throw new Error("invalid revision handoff interaction cursor");

  let priorReaction: { target_event_id: string; emoji: string } | null = null;
  for (const reaction of value.reaction_projections) {
    if (
      !record(reaction) ||
      !exactKeys(reaction, [
        "actor_public_ids",
        "count",
        "emoji",
        "reacted_by_recipient",
        "target",
      ]) ||
      !REACTION_EMOJIS.includes(reaction.emoji as (typeof REACTION_EMOJIS)[number]) ||
      !Number.isSafeInteger(reaction.count) ||
      (reaction.count as number) < 1 ||
      reaction.reacted_by_recipient !== false ||
      !Array.isArray(reaction.actor_public_ids) ||
      reaction.actor_public_ids.length !== reaction.count ||
      reaction.actor_public_ids.some(
        (actor, index, actors) =>
          typeof actor !== "string" ||
          actor.length === 0 ||
          (index > 0 &&
            Buffer.compare(Buffer.from(actors[index - 1] as string), Buffer.from(actor)) >= 0),
      )
    )
      throw new Error("invalid revision handoff reaction projection");
    assertPublicMessageLocatorV1(reaction.target);
    const target = reaction.target as { root_session_id: string; target_event_id: string };
    if (target.root_session_id !== value.root_session_id)
      throw new Error("revision handoff reaction root changed");
    const current = { target_event_id: target.target_event_id, emoji: reaction.emoji as string };
    if (
      priorReaction &&
      (Buffer.compare(
        Buffer.from(priorReaction.target_event_id),
        Buffer.from(current.target_event_id),
      ) > 0 ||
        (priorReaction.target_event_id === current.target_event_id &&
          Buffer.compare(Buffer.from(priorReaction.emoji), Buffer.from(current.emoji)) >= 0))
    )
      throw new Error("revision handoff reactions are not canonical");
    priorReaction = current;
  }

  const seenSources = new Set<string>();
  const targetsBySource = new Map<string, Set<string>>();
  let currentSource: string | null = null;
  let nextOrder = 1;
  for (const occurrence of value.occurrences) {
    if (
      !record(occurrence) ||
      !exactKeys(occurrence, ["quote_order", "quoting_message_id", "target"]) ||
      typeof occurrence.quoting_message_id !== "string" ||
      occurrence.quoting_message_id.length === 0 ||
      !Number.isSafeInteger(occurrence.quote_order) ||
      (occurrence.quote_order as number) < 1 ||
      (occurrence.quote_order as number) > 8
    )
      throw new Error("invalid revision quote occurrence");
    assertPublicQuoteReferenceV1(occurrence.target);
    if (occurrence.quoting_message_id !== currentSource) {
      if (seenSources.has(occurrence.quoting_message_id))
        throw new Error("revision quote occurrences are not grouped");
      seenSources.add(occurrence.quoting_message_id);
      currentSource = occurrence.quoting_message_id;
      nextOrder = 1;
    }
    if (occurrence.quote_order !== nextOrder)
      throw new Error("revision quote occurrence order changed");
    nextOrder += 1;
    let targets = targetsBySource.get(occurrence.quoting_message_id);
    if (!targets) {
      targets = new Set<string>();
      targetsBySource.set(occurrence.quoting_message_id, targets);
    }
    const target = occurrence.target as { target_event_id: string; content_digest: string };
    const targetKey = `${target.target_event_id}\0${target.content_digest}`;
    if (targets.has(targetKey)) throw new Error("duplicate revision quote target");
    targets.add(targetKey);
  }
}

function revisionContextSelection(handoff: ContextHandoffV1): PromptArtifactSelectionV1 | null {
  const selections = handoff.prompt_projection.artifacts.filter(
    ({ artifact }) =>
      artifact.media_type === REVISION_QUOTE_GRAPH_MEDIA_TYPE ||
      artifact.media_type === REVISION_INTERACTION_CURSOR_MEDIA_TYPE,
  );
  if (selections.length === 0) return null;
  if (selections.length !== 1) throw new Error("ambiguous revision context cursor");
  return selections[0] ?? null;
}

export function revisionHandoffInteractionCursor(input: {
  handoff: ContextHandoffV1;
  root_session_id: string;
  prompt_projection_digest: string;
}): RevisionHandoffInteractionCursorV1 | null {
  assertContextHandoffV1(input.handoff);
  if (input.handoff.prompt_projection_digest !== input.prompt_projection_digest)
    throw new Error("revision handoff prompt authority changed");
  const selection = revisionContextSelection(input.handoff);
  if (!selection) return null;
  if (selection.delivery !== CONVERSATION_PUBLIC_ARTIFACT_DELIVERY.INLINE_PUBLIC_TEXT)
    throw new Error("revision context cursor is not inline");
  const bytes = Buffer.from(selection.public_text, "utf8");
  const expectedId =
    selection.artifact.media_type === REVISION_QUOTE_GRAPH_MEDIA_TYPE ? GRAPH_ID : CURSOR_ID;
  const id = expectedId.exec(selection.artifact.artifact_id);
  const contentSha = createHash("sha256").update(bytes).digest("hex");
  if (
    bytes.byteLength > MAX_CANONICAL_HANDOFF_BYTES ||
    bytes.byteLength !== selection.artifact.byte_length ||
    contentSha !== selection.artifact.content_sha256 ||
    id?.[1] !== contentSha
  )
    throw new Error("revision context cursor content address changed");
  if (selection.artifact.media_type === REVISION_INTERACTION_CURSOR_MEDIA_TYPE) {
    const match = CURSOR_TEXT.exec(selection.public_text);
    const sequence = Number(match?.[1]);
    if (!match || !Number.isSafeInteger(sequence))
      throw new Error("revision interaction cursor encoding changed");
    return {
      interaction_sequence: sequence,
      interaction_head_digest: `sha256:${match[2]}`,
    };
  }
  let graph: unknown;
  try {
    graph = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error("revision quote graph is not JSON", { cause: error });
  }
  if (!canonicalJsonBytes(graph, { maxBytes: MAX_CANONICAL_HANDOFF_BYTES }).equals(bytes))
    throw new Error("revision quote graph is not canonical");
  assertQuoteGraph(graph);
  if (graph.root_session_id !== input.root_session_id)
    throw new Error("revision quote graph root changed");
  return graph.interaction_head_sequence === null || graph.interaction_head_digest === null
    ? null
    : {
        interaction_sequence: graph.interaction_head_sequence,
        interaction_head_digest: graph.interaction_head_digest,
      };
}
