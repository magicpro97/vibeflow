import { describe, expect, test } from "bun:test";
import { lanExposureWarning } from "../../src/commands/lan-warning.js";

describe("lanExposureWarning (#561: LAN-exposure warning)", () => {
  test("0.0.0.0 → warning string", () => {
    const w = lanExposureWarning("0.0.0.0");
    expect(w).toContain("exposed to LAN");
    expect(w).toContain("token required");
  });

  test("loopback 127.0.0.1 → null", () => {
    expect(lanExposureWarning("127.0.0.1")).toBeNull();
  });

  test("undefined host (default) → null", () => {
    expect(lanExposureWarning(undefined)).toBeNull();
  });
});
