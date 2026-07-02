import { describe, expect, test } from "bun:test";
import { generateSpecFirstTests } from "../src/commands/orchestrate.js";
import { scoreRisk } from "../src/hooks/risk.js";

describe("generateSpecFirstTests (ADR-002)", () => {
  test("returns null when spec is empty", async () => {
    const fakeLLM = async () => "irrelevant";
    expect(await generateSpecFirstTests({ unitName: "u1", spec: "", llmFn: fakeLLM })).toBeNull();
  });

  test("returns null when spec is whitespace-only", async () => {
    const fakeLLM = async () => "irrelevant";
    expect(
      await generateSpecFirstTests({ unitName: "u1", spec: "   ", llmFn: fakeLLM }),
    ).toBeNull();
  });

  test("calls llmFn with prompt containing spec text", async () => {
    let capturedPrompt = "";
    const fakeLLM = async (prompt: string) => {
      capturedPrompt = prompt;
      return "test('should work', () => { expect(1).toBe(1); });";
    };
    await generateSpecFirstTests({
      unitName: "add-feature",
      spec: "fn() converts input string to uppercase",
      llmFn: fakeLLM,
    });
    expect(capturedPrompt).toContain("fn() converts input string to uppercase");
    expect(capturedPrompt).toContain("add-feature");
  });

  test("prompt does NOT contain implementation — only spec and unit name", async () => {
    let capturedPrompt = "";
    const fakeLLM = async (prompt: string) => {
      capturedPrompt = prompt;
      return "test('stub', () => {});";
    };
    await generateSpecFirstTests({
      unitName: "u1",
      spec: "function returns 42",
      llmFn: fakeLLM,
    });
    // Must NOT ask llmFn to write implementation code — only tests
    expect(capturedPrompt).not.toContain("write the code");
    expect(capturedPrompt).not.toContain("implement the function");
    expect(capturedPrompt).toContain("test");
  });

  test("returns LLM output as-is", async () => {
    const stub = "test('empty input', () => { expect(fn('')).toBe(''); });";
    const fakeLLM = async () => stub;
    const result = await generateSpecFirstTests({
      unitName: "u1",
      spec: "fn() uppercase",
      llmFn: fakeLLM,
    });
    expect(result).toBe(stub);
  });
});

describe("spec-first file protection (ADR-002)", () => {
  test("writing to *.spec-first.* file returns critical risk", () => {
    const r = scoreRisk({
      event: "pre-write",
      files: ["test/add-feature.spec-first.test.ts"],
      workspace: "/repo",
    });
    expect(r.risk).toBe("critical");
    expect(r.reasons.some((s: string) => s.includes("spec-first"))).toBe(true);
  });

  test("writing to normal test file is NOT blocked by spec-first rule", () => {
    const r = scoreRisk({
      event: "pre-write",
      files: ["test/add-feature.test.ts"],
      workspace: "/repo",
    });
    expect(r.reasons.some((s: string) => s.includes("spec-first"))).toBe(false);
  });
});
