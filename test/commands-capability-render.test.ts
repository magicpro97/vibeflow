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

  test("resultError rethrows the exact error for a stable unsupported runtime code", () => {
    const error = new CapabilityRuntimeError(
      "unsupported runtime code",
      CAPABILITY_RUNTIME_ERROR_CODE.FAULT,
    );
    Object.defineProperty(error, "runtime_code", {
      configurable: true,
      value: "unsupported-runtime-code",
      writable: false,
    });

    let caught: unknown;
    try {
      resultError(error);
    } catch (thrown) {
      caught = thrown;
    }

    expect(caught).toBe(error);
  });
});
