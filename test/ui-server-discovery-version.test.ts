import { describe, expect, test } from "bun:test";
import { createUiServerDiscovery, resolveUiServerDiscovery } from "../src/core/ui-cli-contract.js";

const base = {
  schema_version: "1.0" as const,
  port: 7799,
  pid: 1234,
  started_at: 1_700_000_000_000,
  hook_origin: "http://127.0.0.1:7799",
};

describe("ui server discovery app_version", () => {
  test("writer includes a valid app_version", () => {
    const record = createUiServerDiscovery(
      7799,
      1234,
      1_700_000_000_000,
      base.hook_origin,
      "0.20.1",
    );
    expect(record.app_version).toBe("0.20.1");
  });

  test("writer omits app_version when not provided", () => {
    const record = createUiServerDiscovery(7799, 1234, 1_700_000_000_000, base.hook_origin);
    expect("app_version" in record).toBe(false);
  });

  test("writer rejects an invalid app_version", () => {
    expect(() =>
      createUiServerDiscovery(7799, 1234, 1_700_000_000_000, base.hook_origin, "0.1.0\u001b[31m"),
    ).toThrow("invalid UI server discovery");
  });

  test("resolver keeps a valid app_version", () => {
    expect(resolveUiServerDiscovery({ ...base, app_version: "1.2.3-rc.1" })?.app_version).toBe(
      "1.2.3-rc.1",
    );
  });

  test("resolver drops a poisoned app_version without losing the record", () => {
    const resolved = resolveUiServerDiscovery({ ...base, app_version: "0.1.0\u001b[31m" });
    expect(resolved?.port).toBe(7799);
    expect(resolved?.app_version).toBeUndefined();
  });

  test("resolver keeps the v1 pid", () => {
    expect(resolveUiServerDiscovery(base)?.pid).toBe(1234);
  });

  test("legacy record without schema_version still resolves", () => {
    expect(resolveUiServerDiscovery({ port: 7000 })?.port).toBe(7000);
  });

  test("record without app_version still resolves", () => {
    expect(resolveUiServerDiscovery(base)?.app_version).toBeUndefined();
  });
});
