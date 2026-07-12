import { describe, expect, test } from "bun:test";
import { parseResources } from "../../src/commands/dispatch-resources.js";

describe("parseResources (#523: engine cost/tokens for the progress footer)", () => {
  test("undefined raw → undefined", () => {
    expect(parseResources(undefined)).toBeUndefined();
  });

  test("non-JSON raw → undefined (best-effort)", () => {
    expect(parseResources("not json")).toBeUndefined();
  });

  test("envelope with cost only → cost_usd, no tokens", () => {
    const r = parseResources(JSON.stringify({ total_cost_usd: 0.42 }));
    expect(r).toEqual({ cost_usd: 0.42 });
  });

  test("envelope with usage tokens → summed tokens", () => {
    const r = parseResources(JSON.stringify({ usage: { input_tokens: 100, output_tokens: 50 } }));
    expect(r).toEqual({ tokens: 150 });
  });

  test("envelope with both cost and tokens", () => {
    const r = parseResources(
      JSON.stringify({ total_cost_usd: 1.5, usage: { input_tokens: 10, output_tokens: 5 } }),
    );
    expect(r).toEqual({ cost_usd: 1.5, tokens: 15 });
  });

  test("envelope with neither cost nor tokens → undefined", () => {
    expect(parseResources(JSON.stringify({ type: "result" }))).toBeUndefined();
  });

  test("non-numeric fields are ignored", () => {
    const r = parseResources(
      JSON.stringify({ total_cost_usd: "nope", usage: { input_tokens: "x", output_tokens: 7 } }),
    );
    expect(r).toEqual({ tokens: 7 });
  });
});
