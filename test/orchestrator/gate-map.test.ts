// test/orchestrator/gate-map.test.ts
import { describe, expect, test } from "bun:test";
import { type MeasuredGate, mapGateResult } from "../../src/orchestrator/gate-map.js";

describe("mapGateResult", () => {
  test("undefined (no measurement) → all pending", () => {
    expect(mapGateResult(undefined)).toEqual({
      build: "pending",
      lint: "pending",
      test: "pending",
      review: "pending",
    });
  });

  test("pass → build/lint/test pass, review pending", () => {
    expect(mapGateResult({ pass: true })).toEqual({
      build: "pass",
      lint: "pass",
      test: "pass",
      review: "pending",
    });
  });

  test("test fail → build/lint/test pass, review pending (all gates ran)", () => {
    expect(mapGateResult({ pass: false, failedGate: "test" })).toEqual({
      build: "pass",
      lint: "pass",
      test: "fail",
      review: "pending",
    });
  });

  test("typecheck fail → build fail, lint+test pending (downstream never ran)", () => {
    expect(mapGateResult({ pass: false, failedGate: "typecheck" })).toEqual({
      build: "fail",
      lint: "pending",
      test: "pending",
      review: "pending",
    });
  });

  test("biome fail → build pass, lint fail, test pending (coverage never ran)", () => {
    expect(mapGateResult({ pass: false, failedGate: "biome" })).toEqual({
      build: "pass",
      lint: "fail",
      test: "pending",
      review: "pending",
    });
  });

  test("coverage fail → build+lint pass, test fail (all three ran)", () => {
    expect(mapGateResult({ pass: false, failedGate: "coverage" })).toEqual({
      build: "pass",
      lint: "pass",
      test: "fail",
      review: "pending",
    });
  });

  test("fail with no failedGate (defensive) → build/lint pass, test pending", () => {
    const m: MeasuredGate = { pass: false };
    expect(mapGateResult(m)).toEqual({
      build: "pass",
      lint: "pass",
      test: "pending",
      review: "pending",
    });
  });
});
