const { describe, expect, test } = await import(String("bun:test"));
import {
  chipLabelFor,
  findComposerMentions,
  nextMentionToken,
  parseComposerHighlight,
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
