const { describe, expect, test } = await import(String("bun:test"));
import {
  chipLabelFor,
  findComposerMentions,
  nextMentionToken,
  renderComposerHighlight,
} from "../home-composer-highlight.js";

const AGENTS = new Map([
  ["+web_ui@codex", "Web UI"],
  ["+implementation@codex", "Implementation agent"],
]);
const PARTICIPANTS = new Map([["participant-1", "Coordinator (codex)"]]);

describe("home composer highlight", () => {
  test("plain text stays untouched", () => {
    expect(renderComposerHighlight("build the home page")).toBe("build the home page");
  });
  test("escapes html in plain text", () => {
    expect(renderComposerHighlight("a <b>& c")).toBe("a &lt;b&gt;&amp; c");
  });
  test("agent mention becomes a labeled amber chip", () => {
    expect(renderComposerHighlight("+web_ui@codex now", AGENTS, PARTICIPANTS)).toBe(
      '<span class="home-composer-chip home-composer-chip--agent">Web UI</span> now',
    );
  });
  test("unknown agent token falls back to token without special chars", () => {
    expect(renderComposerHighlight("+custom@claude now", AGENTS, PARTICIPANTS)).toBe(
      '<span class="home-composer-chip home-composer-chip--agent">custom@claude</span> now',
    );
  });
  test("remove mention becomes a labeled red chip", () => {
    expect(renderComposerHighlight("drop -@participant-1 after", AGENTS, PARTICIPANTS)).toBe(
      'drop <span class="home-composer-chip home-composer-chip--remove">Coordinator (codex)</span> after',
    );
  });
  test("plain mention becomes a labeled blue chip", () => {
    expect(renderComposerHighlight("ask @participant-2", AGENTS, PARTICIPANTS)).toBe(
      'ask <span class="home-composer-chip home-composer-chip--mention">participant-2</span>',
    );
  });
  test("no chip for bare + or @ alone", () => {
    expect(renderComposerHighlight("+ @")).toBe("+ @");
  });
  test("no chip for a plus without engine target", () => {
    expect(renderComposerHighlight("+ something")).toBe("+ something");
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
    expect(renderComposerHighlight("+web_ui@codex and +web_ui@codex#2", AGENTS, PARTICIPANTS)).toBe(
      '<span class="home-composer-chip home-composer-chip--agent">Web UI</span> and <span class="home-composer-chip home-composer-chip--agent">Web UI #2</span>',
    );
  });
});
