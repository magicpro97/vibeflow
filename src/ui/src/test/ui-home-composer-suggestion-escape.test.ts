const { describe, expect, test } = await import(String("bun:test"));
import { ref } from "vue";
import { useHomeComposerSuggestionEscape } from "../composables/useHomeComposerSuggestionEscape.js";

function harness(options: { draft?: string; suggestions?: number; withTextarea?: boolean } = {}) {
  const draft = ref(options.draft ?? "");
  const element = {
    value: options.draft ?? "",
    setSelectionRange: (_start: number, _end: number) => {},
  };
  const textarea = ref<HTMLTextAreaElement | null>(
    options.withTextarea === false ? null : (element as unknown as HTMLTextAreaElement),
  );
  const suggestionDraftSnapshot = ref("");
  const pendingEscapeDraft = ref<string | null>(null);
  const suggestionsDismissed = ref(false);
  const resizeCalls: number[] = [];
  const draftWrites: number[] = [];
  const handler = useHomeComposerSuggestionEscape({
    readDraft: () => draft.value,
    writeDraft: (value) => {
      draftWrites.push(1);
      draft.value = value;
    },
    textarea,
    visibleSuggestionCount: () => options.suggestions ?? 2,
    suggestionDraftSnapshot,
    pendingEscapeDraft,
    suggestionsDismissed,
    resize: () => {
      resizeCalls.push(1);
    },
  });
  return {
    handler,
    draft,
    element,
    textarea,
    suggestionDraftSnapshot,
    pendingEscapeDraft,
    suggestionsDismissed,
    resizeCalls,
    draftWrites,
  };
}

function keyEvent(key: string) {
  const calls: string[] = [];
  return {
    event: {
      key,
      preventDefault: () => calls.push("preventDefault"),
      stopPropagation: () => calls.push("stopPropagation"),
    } as unknown as KeyboardEvent,
    calls,
  };
}

describe("composer suggestion escape", () => {
  test("ignores keys that are not Escape and lists with no suggestions", () => {
    const a = harness();
    expect(a.handler.dismissSuggestionsWithEscape(keyEvent("Enter").event)).toBe(false);
    expect(a.suggestionsDismissed.value).toBe(false);
    const b = harness({ suggestions: 0 });
    expect(b.handler.dismissSuggestionsWithEscape(keyEvent("Escape").event)).toBe(false);
    expect(b.pendingEscapeDraft.value).toBeNull();
  });

  test("Escape preserves the snapshot draft, marks dismissal, and stops the event", () => {
    const h = harness({ draft: "current draft" });
    h.suggestionDraftSnapshot.value = "snapshot draft";
    const { event, calls } = keyEvent("Escape");
    expect(h.handler.dismissSuggestionsWithEscape(event)).toBe(true);
    expect(h.suggestionsDismissed.value).toBe(true);
    expect(h.pendingEscapeDraft.value).toBe("snapshot draft");
    expect(h.draft.value).toBe("snapshot draft");
    expect(h.element.value).toBe("snapshot draft");
    expect(h.resizeCalls).toHaveLength(1);
    expect(calls).toEqual(["preventDefault", "stopPropagation"]);
  });

  test("falls back to the live draft when the snapshot is empty", () => {
    const h = harness({ draft: "typed now" });
    expect(h.handler.dismissSuggestionsWithEscape(keyEvent("Escape").event)).toBe(true);
    expect(h.pendingEscapeDraft.value).toBe("typed now");
    expect(h.draft.value).toBe("typed now");
  });

  test("restores the preserved draft on the next Escape and clears the pending state", () => {
    const h = harness({ draft: "sent later" });
    h.pendingEscapeDraft.value = "preserved";
    h.draft.value = "changed";
    h.element.value = "changed";
    const { event, calls } = keyEvent("Escape");
    h.handler.restoreDismissedDraft(event);
    expect(h.draft.value).toBe("preserved");
    expect(h.element.value).toBe("preserved");
    expect(h.pendingEscapeDraft.value).toBeNull();
    expect(calls).toEqual(["preventDefault", "stopPropagation"]);
  });

  test("a restore with nothing pending or a non-Escape key is a no-op", () => {
    const h = harness({ draft: "keep" });
    h.handler.restoreDismissedDraft(keyEvent("Escape").event);
    expect(h.draft.value).toBe("keep");
    const restore = keyEvent("Enter");
    h.pendingEscapeDraft.value = "ignored";
    h.handler.restoreDismissedDraft(restore.event);
    expect(restore.calls).toEqual([]);
    expect(h.pendingEscapeDraft.value).toBe("ignored");
  });

  test("a missing textarea still writes the draft without resizing", () => {
    const h = harness({ draft: "no element", withTextarea: false });
    h.pendingEscapeDraft.value = "restored";
    h.draft.value = "differs";
    h.handler.restoreDismissedDraft(keyEvent("Escape").event);
    expect(h.draft.value).toBe("restored");
    expect(h.resizeCalls).toHaveLength(0);
  });

  test("an element already holding the draft is left untouched", () => {
    const h = harness({ draft: "same" });
    h.pendingEscapeDraft.value = "same";
    h.handler.restoreDismissedDraft(keyEvent("Escape").event);
    expect(h.resizeCalls).toHaveLength(0);
  });

  test("writes the draft only when it differs from the preserved value", () => {
    const h = harness({ draft: "same" });
    h.pendingEscapeDraft.value = "same";
    h.handler.restoreDismissedDraft(keyEvent("Escape").event);
    expect(h.draftWrites).toHaveLength(0);
    h.pendingEscapeDraft.value = "later";
    h.handler.restoreDismissedDraft(keyEvent("Escape").event);
    expect(h.draftWrites).toHaveLength(1);
    expect(h.draft.value).toBe("later");
  });
});
