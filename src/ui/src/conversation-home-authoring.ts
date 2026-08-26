import type {
  HomeCanonicalMessageReference,
  HomeCanonicalQuoteReference,
  HomeQuoteReference,
  HomeReactionEmoji,
  HomeReactionSummary,
} from "./conversation-home-types.js";

export const HOME_QUOTE_LIMIT = 8;

export const HOME_REACTION_OPTIONS: Array<{ emoji: HomeReactionEmoji; label: string }> = [
  { emoji: "👍", label: "Approve" },
  { emoji: "👎", label: "Needs changes" },
  { emoji: "❤️", label: "Appreciate" },
  { emoji: "🎉", label: "Celebrate" },
  { emoji: "👀", label: "Watching" },
  { emoji: "🤔", label: "Question" },
  { emoji: "✅", label: "Confirmed" },
  { emoji: "❗", label: "Urgent" },
];

export type HomeQuoteStatus = "ready" | "missing" | "stale" | "foreign";

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
      status: "foreign",
      message:
        "This quote belongs to a different conversation rail. Remove it or return to that session.",
    };
  if (!visible)
    return {
      status: "missing",
      message:
        "This quote is not loaded in the visible timeline right now. Load the relevant history or remove it.",
    };
  if (visible.author !== reference.author || visible.excerpt !== reference.excerpt)
    return {
      status: "stale",
      message:
        "This quote no longer matches the visible source message. Re-select it from the timeline.",
    };
  if (
    visible.target_event_id !== reference.target_event_id ||
    visible.content_digest !== reference.content_digest
  )
    return {
      status: "stale",
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
      status: "missing",
      message:
        "This quote preview is still waiting on a typed public locator. Refresh the conversation or remove it.",
    };
  return { status: "ready", message: "Ready to send." };
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
