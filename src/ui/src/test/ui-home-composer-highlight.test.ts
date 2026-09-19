const { describe, expect, test } = await import(String("bun:test"));
import {
  chipLabelFor,
  findComposerMentions,
  nextMentionToken,
  parseComposerHighlight,
  removeComposerMention,
  removeComposerMentionAtCaret,
} from "../home-composer-highlight.js";

const AGENTS = new Map([
  ["+web_ui@codex", "Web UI"],
  ["+implementation@codex", "Implementation agent"],
]);
const PARTICIPANTS = new Map([["participant-1", "Coordinator (codex)"]]);

describe("home composer highlight", () => {
  test("plain text stays a single text segment", () => {
    expect(parseComposerHighlight("build the home page")).toEqual([
      { kind: "text", text: "build the home page" },
    ]);
  });
  test("draft text stays raw — Vue escapes it at render time", () => {
    expect(parseComposerHighlight("a <b>& c")).toEqual([{ kind: "text", text: "a <b>& c" }]);
  });
  test("agent mention becomes a labeled amber chip segment", () => {
    expect(parseComposerHighlight("+web_ui@codex now", AGENTS, PARTICIPANTS)).toEqual([
      { kind: "chip-agent", text: "Web UI" },
      { kind: "text", text: " now" },
    ]);
  });
  test("unknown agent token falls back to token without special chars", () => {
    expect(parseComposerHighlight("+custom@claude now", AGENTS, PARTICIPANTS)).toEqual([
      { kind: "chip-agent", text: "custom@claude" },
      { kind: "text", text: " now" },
    ]);
  });
  test("remove mention becomes a labeled red chip segment", () => {
    expect(parseComposerHighlight("drop -@participant-1 after", AGENTS, PARTICIPANTS)).toEqual([
      { kind: "text", text: "drop " },
      { kind: "chip-remove", text: "Coordinator (codex)" },
      { kind: "text", text: " after" },
    ]);
  });
  test("plain mention becomes a labeled blue chip segment", () => {
    expect(parseComposerHighlight("ask @participant-2", AGENTS, PARTICIPANTS)).toEqual([
      { kind: "text", text: "ask " },
      { kind: "chip-mention", text: "participant-2" },
    ]);
  });
  test("no chip for bare + or @ alone", () => {
    expect(parseComposerHighlight("+ @")).toEqual([{ kind: "text", text: "+ @" }]);
  });
  test("no chip for a plus without engine target", () => {
    expect(parseComposerHighlight("+ something")).toEqual([{ kind: "text", text: "+ something" }]);
  });
  test("findComposerMentions lists agent and participant tokens", () => {
    expect(findComposerMentions("+web_ui@codex then @participant-9 done")).toEqual([
      "+web_ui@codex",
      "@participant-9",
    ]);
  });
  test("findComposerMentions is empty for plain text", () => {
    expect(findComposerMentions("just words here")).toEqual([]);
  });
  test("chipLabelFor strips special chars with no known label", () => {
    expect(chipLabelFor("+role@engine", AGENTS, PARTICIPANTS)).toBe("role@engine");
    expect(chipLabelFor("-@participant-1", AGENTS, PARTICIPANTS)).toBe("Coordinator (codex)");
    expect(chipLabelFor("@participant-9", AGENTS, PARTICIPANTS)).toBe("participant-9");
  });
  test("chipLabelFor keeps the agent label while a pick is partially deleted", () => {
    // Backspacing from `+web_ui@codex` must not flash the raw partial token:
    // the chip stays "Web UI" until the token stops matching any agent.
    expect(chipLabelFor("+web_ui@code", AGENTS, PARTICIPANTS)).toBe("Web UI");
    expect(chipLabelFor("+web_ui@c", AGENTS, PARTICIPANTS)).toBe("Web UI");
    expect(chipLabelFor("+web", AGENTS, PARTICIPANTS)).toBe("Web UI");
    expect(chipLabelFor("+web_ui@codex#1", AGENTS, PARTICIPANTS)).toBe("Web UI #1");
    expect(chipLabelFor("+no-such-agent@x", AGENTS, PARTICIPANTS)).toBe("no-such-agent@x");
    expect(chipLabelFor("@participant", AGENTS, PARTICIPANTS)).toBe("Coordinator (codex)");
    expect(parseComposerHighlight("+implementation@c", AGENTS, PARTICIPANTS)).toEqual([
      { kind: "chip-agent", text: "Implementation agent" },
    ]);
  });
  test("removes an agent token and its separator as one unit", () => {
    expect(removeComposerMention("before +web_ui@codex after", "+web_ui@codex")).toBe(
      "before after",
    );
    expect(removeComposerMention("+web_ui@codex after", "+web_ui@codex")).toBe("after");
    expect(removeComposerMention("before +web_ui@codex#2 after", "+web_ui@codex#2")).toBe(
      "before after",
    );
  });
  test("returns draft unchanged when token is absent", () => {
    expect(removeComposerMention("plain text", "+web_ui@codex")).toBe("plain text");
  });
  test("removes complete chip token when caret is beside it", () => {
    const draft = "before +web_ui@codex after";
    const tokenStart = draft.indexOf("+web_ui@codex");
    const tokenEnd = tokenStart + "+web_ui@codex".length;
    expect(removeComposerMentionAtCaret(draft, tokenEnd + 1, "backward")).toEqual({
      draft: "before after",
      caret: tokenStart,
    });
    expect(removeComposerMentionAtCaret(draft, tokenStart, "forward")).toEqual({
      draft: "before after",
      caret: tokenStart,
    });
  });

  test("ignores caret beyond token without a removal", () => {
    const draft = "before +web_ui@codex after";
    expect(removeComposerMentionAtCaret(draft, draft.length, "backward")).toBeNull();
  });
  test("does not remove token when caret follows punctuation", () => {
    const draft = "before +web_ui@codex, after";
    const tokenEnd = draft.indexOf(",");
    expect(removeComposerMentionAtCaret(draft, tokenEnd + 1, "backward")).toBeNull();
  });
  test("removes the token occurrence beside caret when tokens repeat", () => {
    const draft = "before +web_ui@codex middle +web_ui@codex after";
    const tokenStart = draft.lastIndexOf("+web_ui@codex");
    const tokenEnd = tokenStart + "+web_ui@codex".length;
    expect(removeComposerMentionAtCaret(draft, tokenEnd + 1, "backward")).toEqual({
      draft: "before +web_ui@codex middle after",
      caret: tokenStart,
    });
  });
  test("removes token without leaving separator when token is at either edge", () => {
    expect(removeComposerMention("before +web_ui@codex ", "+web_ui@codex")).toBe("before");
    expect(removeComposerMention(" +web_ui@codex after", "+web_ui@codex")).toBe("after");
  });

  test("repeated agent token gets a numeric suffix and labeled chip", () => {
    expect(nextMentionToken("", "+web_ui@codex")).toBe("+web_ui@codex");
    expect(nextMentionToken("+web_ui@codex", "+web_ui@codex")).toBe("+web_ui@codex#2");
    expect(nextMentionToken("+web_ui@codex +web_ui@codex#2", "+web_ui@codex")).toBe(
      "+web_ui@codex#3",
    );
    expect(chipLabelFor("+web_ui@codex#2", AGENTS, PARTICIPANTS)).toBe("Web UI #2");
    expect(
      parseComposerHighlight("+web_ui@codex and +web_ui@codex#2", AGENTS, PARTICIPANTS),
    ).toEqual([
      { kind: "chip-agent", text: "Web UI" },
      { kind: "text", text: " and " },
      { kind: "chip-agent", text: "Web UI #2" },
    ]);
  });
  test("chip text never carries markup — labels render through Vue escaping", () => {
    const hostile = new Map([["+attack@codex", "<img src=x onerror=alert(1)>"]]);
    const segments = parseComposerHighlight("+attack@codex", hostile);
    expect(segments).toEqual([{ kind: "chip-agent", text: "<img src=x onerror=alert(1)>" }]);
  });
});
