import { describe, expect, test } from "bun:test";
import { type AskForm, validateAskForm } from "../src/ui/src/ask-client.js";

function form(over: Partial<AskForm> = {}): AskForm {
  return { path: "src/x.ts", start: "5", end: "12", question: "why?", engine: "", ...over };
}

describe("validateAskForm (#562 Web-UI)", () => {
  test("valid form → payload with range + question", () => {
    expect(validateAskForm(form())).toEqual({
      path: "src/x.ts",
      start: 5,
      end: 12,
      question: "why?",
    });
  });

  test("empty end defaults to start (single line)", () => {
    expect(validateAskForm(form({ start: "7", end: "" }))).toEqual({
      path: "src/x.ts",
      start: 7,
      end: 7,
      question: "why?",
    });
  });

  test("engine included only when set", () => {
    const p = validateAskForm(form({ engine: "codex" }));
    expect(p).toEqual({ path: "src/x.ts", start: 5, end: 12, question: "why?", engine: "codex" });
  });

  test("trims path and question", () => {
    const p = validateAskForm(form({ path: "  a.ts  ", question: "  q  " }));
    expect(p).toMatchObject({ path: "a.ts", question: "q" });
  });

  test.each([
    ["missing path", form({ path: "  " })],
    ["missing question", form({ question: "" })],
    ["zero start", form({ start: "0" })],
    ["non-numeric start", form({ start: "abc" })],
    ["end before start", form({ start: "10", end: "5" })],
    ["non-numeric end", form({ start: "3", end: "xyz" })],
  ])("rejects %s with an error string", (_label, f) => {
    expect(typeof validateAskForm(f)).toBe("string");
  });
});
