import {
  CONVERSATION_INTERACTION_LIMITS,
  CONVERSATION_REACTION_EMOJI,
} from "../../orchestrator/conversation/conversation-interaction-contract.js";
import type {
  HomeCanonicalMessageReference,
  HomeCanonicalQuoteReference,
  HomeQuoteReference,
  HomeReactionEmoji,
  HomeReactionSummary,
} from "./conversation-home-types.js";

export const HOME_QUOTE_LIMIT = CONVERSATION_INTERACTION_LIMITS.maxQuotes;

export const HOME_REACTION_OPTIONS = Object.freeze([
  Object.freeze({ emoji: CONVERSATION_REACTION_EMOJI.APPROVE, label: "Approve" }),
  Object.freeze({ emoji: CONVERSATION_REACTION_EMOJI.NEEDS_CHANGES, label: "Needs changes" }),
  Object.freeze({ emoji: CONVERSATION_REACTION_EMOJI.APPRECIATE, label: "Appreciate" }),
  Object.freeze({ emoji: CONVERSATION_REACTION_EMOJI.CELEBRATE, label: "Celebrate" }),
  Object.freeze({ emoji: CONVERSATION_REACTION_EMOJI.WATCHING, label: "Watching" }),
  Object.freeze({ emoji: CONVERSATION_REACTION_EMOJI.QUESTION, label: "Question" }),
  Object.freeze({ emoji: CONVERSATION_REACTION_EMOJI.CONFIRMED, label: "Confirmed" }),
  Object.freeze({ emoji: CONVERSATION_REACTION_EMOJI.URGENT, label: "Urgent" }),
] as const satisfies readonly { emoji: HomeReactionEmoji; label: string }[]);

export const HOME_QUOTE_STATUS = Object.freeze({
  READY: "ready",
  MISSING: "missing",
  STALE: "stale",
  FOREIGN: "foreign",
} as const);
export type HomeQuoteStatus = (typeof HOME_QUOTE_STATUS)[keyof typeof HOME_QUOTE_STATUS];

export interface HomeVisibleQuoteSource {
  source_key: string;
  root_session_id: string | null;
  author: string;
  excerpt: string;
  target_event_id: string | null;
  content_digest: string | null;
}

export function homeTimelineMessageDomId(sourceKey: string): string {
  return `home-message-${encodeURIComponent(sourceKey)}`;
}

export function sameHomeQuoteRef(
  left: Pick<HomeQuoteReference, "root_session_id" | "source_key">,
  right: Pick<HomeQuoteReference, "root_session_id" | "source_key">,
): boolean {
  return left.root_session_id === right.root_session_id && left.source_key === right.source_key;
}

export function toggleHomeQuoteReference(
  current: readonly HomeQuoteReference[],
  reference: HomeQuoteReference,
): { next: HomeQuoteReference[]; error: string } {
  const existingIndex = current.findIndex((item) => sameHomeQuoteRef(item, reference));
  if (existingIndex >= 0)
    return {
      next: current.filter((_, index) => index !== existingIndex),
      error: "",
    };
  if (current.length >= HOME_QUOTE_LIMIT)
    return {
      next: [...current],
      error: `Home can quote up to ${HOME_QUOTE_LIMIT} visible messages at once.`,
    };
  return { next: [...current, reference], error: "" };
}

export function moveHomeQuoteReference(
  current: readonly HomeQuoteReference[],
  index: number,
  direction: -1 | 1,
): HomeQuoteReference[] {
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return [...current];
  const next = [...current];
  const [selected] = next.splice(index, 1);
  if (!selected) return [...current];
  next.splice(nextIndex, 0, selected);
  return next;
}

export function resolveHomeQuoteStatus(
  reference: HomeQuoteReference,
  activeRootId: string | null,
  visible: HomeVisibleQuoteSource | null,
): { status: HomeQuoteStatus; message: string } {
  if (!activeRootId || activeRootId !== reference.root_session_id)
    return {
      status: HOME_QUOTE_STATUS.FOREIGN,
      message:
        "This quote belongs to a different conversation rail. Remove it or return to that session.",
    };
  if (!visible)
    return {
      status: HOME_QUOTE_STATUS.MISSING,
      message:
        "This quote is not loaded in the visible timeline right now. Load the relevant history or remove it.",
    };
  if (visible.author !== reference.author || visible.excerpt !== reference.excerpt)
    return {
      status: HOME_QUOTE_STATUS.STALE,
      message:
        "This quote no longer matches the visible source message. Re-select it from the timeline.",
    };
  if (
    visible.target_event_id !== reference.target_event_id ||
    visible.content_digest !== reference.content_digest
  )
    return {
      status: HOME_QUOTE_STATUS.STALE,
      message:
        "This quote no longer matches the immutable public locator. Re-select it from the timeline.",
    };
  if (
    !reference.target_event_id ||
    !reference.content_digest ||
    !visible.target_event_id ||
    !visible.content_digest
  )
    return {
      status: HOME_QUOTE_STATUS.MISSING,
      message:
        "This quote preview is still waiting on a typed public locator. Refresh the conversation or remove it.",
    };
  return { status: HOME_QUOTE_STATUS.READY, message: "Ready to send." };
}

export function homeReactionLabel(emoji: HomeReactionEmoji): string {
  return HOME_REACTION_OPTIONS.find((item) => item.emoji === emoji)?.label ?? emoji;
}

export function homeReactionSummaryTitle(summary: HomeReactionSummary): string {
  if (!summary.actor_public_ids.length) return `${summary.label} · ${summary.count}`;
  return `${summary.label} · ${summary.count} · ${summary.actor_public_ids.join(", ")}`;
}

export function toHomeCanonicalMessageReference(
  reference: Pick<
    HomeQuoteReference,
    | "root_session_id"
    | "conversation_id"
    | "revision_id"
    | "target_event_id"
    | "target_kind"
    | "content_digest"
  >,
): HomeCanonicalMessageReference | null {
  if (!reference.target_event_id || !reference.target_kind || !reference.content_digest)
    return null;
  return {
    root_session_id: reference.root_session_id,
    conversation_id: reference.conversation_id,
    revision_id: reference.revision_id,
    target_event_id: reference.target_event_id,
    target_kind: reference.target_kind,
    content_digest: reference.content_digest,
  };
}

export function toHomeCanonicalQuoteReference(
  reference: Pick<
    HomeQuoteReference,
    | "root_session_id"
    | "conversation_id"
    | "revision_id"
    | "target_event_id"
    | "target_kind"
    | "content_digest"
    | "author_public_id"
  >,
): HomeCanonicalQuoteReference | null {
  const message = toHomeCanonicalMessageReference(reference);
  if (!message) return null;
  return {
    ...message,
    author_public_id: reference.author_public_id,
  };
}
