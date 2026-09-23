import { afterEach, describe, expect, test } from "bun:test";
import { releaseAdvisoryLock } from "../../src/durability/native.js";

/**
 * The win32 arm of releaseAdvisoryLock is a dispatch into native-windows-ops. Reaching it needs
 * only process.platform, not Windows: an fd that never took a lock is rejected by the map
 * lookup before any FFI is touched, which is exactly the branch CI never executed.
 */
const platformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
) as PropertyDescriptor;

describe("releaseAdvisoryLock on win32", () => {
  afterEach(() => {
    Object.defineProperty(process, "platform", platformDescriptor);
  });

  test("refuses an fd that never took a Windows kernel lock", () => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
    expect(() => releaseAdvisoryLock(999_999)).toThrow("Windows kernel lock not found for fd");
  });
});
