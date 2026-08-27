import { describe, expect, spyOn, test } from "bun:test";
import {
  CAPABILITY_RUNTIME_ERROR_CODE,
  CapabilityRuntimeError,
} from "../src/capabilities/operations/errors.js";
import { defaultCapabilityCliWriter, resultError } from "../src/commands/capability/render.js";

describe("capability CLI render guards", () => {
  test("default writer handles an implicit info message without an undefined options sentinel", () => {
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      defaultCapabilityCliWriter("plain capability status");
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith("plain capability status");
    } finally {
      log.mockRestore();
    }
  });

  test("resultError rethrows when a runtime code mutates after the guard check", () => {
    const error = new CapabilityRuntimeError(
      "mutable runtime code",
      CAPABILITY_RUNTIME_ERROR_CODE.FAULT,
    );
    let reads = 0;
    Object.defineProperty(error, "runtime_code", {
      configurable: true,
      get: () => {
        reads += 1;
        return reads <= 2 ? CAPABILITY_RUNTIME_ERROR_CODE.FAULT : ("mutated-runtime-code" as never);
      },
    });

    let caught: unknown;
    try {
      resultError(error);
    } catch (thrown) {
      caught = thrown;
    }

    expect(caught).toBe(error);
    expect(reads).toBeGreaterThanOrEqual(3);
  });
});
