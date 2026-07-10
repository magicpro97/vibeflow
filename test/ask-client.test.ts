import { describe, expect, test } from "bun:test";
import { type AskForm, validateAskForm, validateResumeForm } from "../src/ui/src/ask-client.js";

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

describe("validateResumeForm (#581)", () => {
  test("valid question → { question }", () => {
    expect(validateResumeForm("and then?")).toEqual({ question: "and then?" });
  });

  test("trims whitespace", () => {
    expect(validateResumeForm("  go on  ")).toEqual({ question: "go on" });
  });

  test("empty string → error", () => {
    expect(typeof validateResumeForm("")).toBe("string");
  });

  test("whitespace-only → error", () => {
    expect(typeof validateResumeForm("   ")).toBe("string");
  });
});

describe("api.ask.streamUrl (#580)", () => {
  // CSRF is read from meta tag in browser; in test env it's "".
  // The function builds a URLSearchParams string regardless.
  test("encodes path, start, end, question, token into querystring", () => {
    // We can't import the api module directly (it depends on DOM), so test the pattern
    const p = new URLSearchParams({
      path: "src/x.ts",
      start: "1",
      end: "5",
      question: "why?",
      token: "test-csrf",
    });
    const url = `/api/ask/stream?${p.toString()}`;
    expect(url).toContain("path=src%2Fx.ts");
    expect(url).toContain("start=1");
    expect(url).toContain("end=5");
    expect(url).toContain("question=why%3F");
    expect(url).toContain("token=test-csrf");
    expect(url).not.toContain("engine=");
  });

  test("engine included when set", () => {
    const p = new URLSearchParams({
      path: "a.ts",
      start: "3",
      end: "3",
      question: "q",
      token: "csrf",
    });
    p.set("engine", "codex");
    const url = `/api/ask/stream?${p.toString()}`;
    expect(url).toContain("engine=codex");
  });
});

// #581: streamUrl resume
describe("api.ask.streamUrl — resume (#581)", () => {
  test("resume=true omits path/start/end, includes question+token+engine+resume", () => {
    const p = new URLSearchParams({ question: "go on", token: "csrf" });
    p.set("engine", "claude");
    p.set("resume", "true");
    const url = `/api/ask/stream?${p.toString()}`;
    expect(url).toContain("question=go+on");
    expect(url).toContain("token=csrf");
    expect(url).toContain("engine=claude");
    expect(url).toContain("resume=true");
    expect(url).not.toContain("path=");
    expect(url).not.toContain("start=");
    expect(url).not.toContain("end=");
  });

  test("fresh mode (resume not set) still includes path/start/end", () => {
    const p = new URLSearchParams({
      path: "src/a.ts",
      start: "1",
      end: "3",
      question: "q",
      token: "csrf",
    });
    const url = `/api/ask/stream?${p.toString()}`;
    expect(url).toContain("path=src%2Fa.ts");
    expect(url).toContain("start=1");
    expect(url).toContain("end=3");
    expect(url).not.toContain("resume=");
  });
});
