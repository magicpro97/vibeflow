const { describe, expect, test } = await import(String("bun:test"));
import { renderComposerHighlight } from "../home-composer-highlight.js";

describe("home composer highlight", () => {
  test("plain text stays untouched", () => {
    expect(renderComposerHighlight("build the home page")).toBe("build the home page");
  });
  test("escapes html in plain text", () => {
    expect(renderComposerHighlight("a <b>& c")).toBe("a &lt;b&gt;&amp; c");
  });
  test("agent mention becomes a chip", () => {
    expect(renderComposerHighlight("+web_ui@codex now")).toBe(
      '<span class="home-composer-chip home-composer-chip--agent">+web_ui@codex</span> now',
    );
  });
  test("remove mention becomes a chip", () => {
    expect(renderComposerHighlight("drop -@participant-1 after")).toBe(
      'drop <span class="home-composer-chip home-composer-chip--remove">-@participant-1</span> after',
    );
  });
  test("plain mention becomes a chip", () => {
    expect(renderComposerHighlight("ask @participant-2")).toBe(
      'ask <span class="home-composer-chip home-composer-chip--mention">@participant-2</span>',
    );
  });
  test("chip token adjacent to punctuation keeps punctuation outside", () => {
    expect(renderComposerHighlight("+web_ui@codex, ok")).toBe(
      '<span class="home-composer-chip home-composer-chip--agent">+web_ui@codex</span>, ok',
    );
  });
  test("no chip for bare + or @ alone", () => {
    expect(renderComposerHighlight("+ @")).toBe("+ @");
  });
  test("no chip for a plus without engine target", () => {
    expect(renderComposerHighlight("+ something")).toBe("+ something");
  });
  test("multiple chips in one draft", () => {
    expect(renderComposerHighlight("+web_ui@codex then @participant-9 done")).toBe(
      '<span class="home-composer-chip home-composer-chip--agent">+web_ui@codex</span> then <span class="home-composer-chip home-composer-chip--mention">@participant-9</span> done',
    );
  });
});
