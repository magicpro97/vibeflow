const { describe, expect, test } = await import(String("bun:test"));
import { readFileSync } from "node:fs";
import {
  emptyComposerSuggestionHint,
  matchHomeComposerSuggestions,
} from "../home-composer-suggestions.js";

describe("home composer empty suggestion hints", () => {
  test("@ without participants explains how to add one", () => {
    const hint = emptyComposerSuggestionHint("@", []);
    expect(hint).not.toBeNull();
    if (hint) expect(hint).toContain("+Agent");
  });

  test("@ with participants has no empty hint", () => {
    expect(emptyComposerSuggestionHint("@", [participant()])).toBeNull();
  });

  test("rough remove token without participants also hints", () => {
    expect(emptyComposerSuggestionHint("-", [])).not.toBeNull();
    expect(emptyComposerSuggestionHint("-@", [])).not.toBeNull();
  });

  test("plain draft or slash command yields no hint", () => {
    expect(emptyComposerSuggestionHint("build a page", [])).toBeNull();
    expect(emptyComposerSuggestionHint("/install", [])).toBeNull();
  });
});

test("suggestion popover stays above scrollable timeline", () => {
  const composer = readFileSync(new URL("../components/HomeComposer.vue", import.meta.url), "utf8");
  const css = readFileSync(new URL("../home.css", import.meta.url), "utf8");
  expect(composer).toContain('class="home-suggestions"');
  expect(composer).toContain('<Teleport to="body">');
  expect(composer).toContain(':style="suggestionStyle"');
  expect(css).toMatch(/\.home-suggestions\s*\{[\s\S]*?position: fixed;/u);
});

test("private range panel closes from Escape", () => {
  const panel = readFileSync(
    new URL("../components/HomePrivateRangePanel.vue", import.meta.url),
    "utf8",
  );
  expect(panel).toContain('@keydown.esc.stop="closePrivateRangePanel"');
});

describe("home composer suggestion matching", () => {
  test("plus token lists agent suggestions", () => {
    const rows = matchHomeComposerSuggestions("+", [participant()]);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows[0]?.value ?? "").toMatch(/^\+/);
  });

  test("at token lists participants", () => {
    const rows = matchHomeComposerSuggestions("@", [participant()]);
    expect(rows.map((row) => row.value)).toContain("@participant-1 ");
  });

  test("at token without participants is empty", () => {
    expect(matchHomeComposerSuggestions("@", [])).toEqual([]);
  });

  test("slash token lists commands", () => {
    const rows = matchHomeComposerSuggestions("/", []);
    expect(rows.map((row) => row.value)).toContain("/install ");
  });
});

const participant = () =>
  ({
    participant_id: "participant-1",
    role_ref: "implementation@codex",
    engine: "codex",
    model: null,
    status: ["active"],
    lifecycle: "active",
    created_at: "2026-08-25T00:00:00.000Z",
    packages: [],
  }) as never;
