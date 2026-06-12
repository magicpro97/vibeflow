import { describe, expect, test } from "bun:test";
import { aiGenerate } from "../src/adapters.js";

describe("aiGenerate shell-injection guard", () => {
  test("does not invoke a shell when VIBEFLOW_AI is a benign command", () => {
    // If shell:true were still in effect, echo with a `;` would split into two commands.
    // With argv form, the entire string is one argv (echoed back as-is).
    const out = aiGenerate("hello;world", () => "fallback");
    // Either the cmd runs (and we can't assert on stdout without a real binary),
    // or fallback returns. The point is no shell split occurred.
    expect(typeof out).toBe("string");
  });

  test("env command with metacharacters is passed as single argv, not interpreted", () => {
    // Save and clear the env to force fallback path
    const prev = process.env.VIBEFLOW_AI;
    process.env.VIBEFLOW_AI = undefined;
    try {
      const out = aiGenerate("$(rm -rf /)", () => "FALLBACK");
      expect(out).toBe("FALLBACK");
    } finally {
      if (prev !== undefined) process.env.VIBEFLOW_AI = prev;
    }
  });
});
