import { describe, expect, test } from "bun:test";
import { engineReason } from "../src/ui/src/lib/engine-reason.js";

describe("engineReason (#458 engine readiness reason)", () => {
  test('no-binary -> "not installed"', () => {
    expect(engineReason("no-binary")).toBe("not installed");
  });

  test('no-auth -> "not authenticated"', () => {
    expect(engineReason("no-auth")).toBe("not authenticated");
  });

  test('probe-failed -> "installed but not responding"', () => {
    expect(engineReason("probe-failed")).toBe("installed but not responding");
  });

  test('unknown -> "status unknown"', () => {
    expect(engineReason("unknown")).toBe("status unknown");
  });

  test('ready -> "unavailable" (ready engines show no reason row)', () => {
    expect(engineReason("ready")).toBe("unavailable");
  });

  test('undefined -> "unavailable"', () => {
    expect(engineReason(undefined)).toBe("unavailable");
  });
});
