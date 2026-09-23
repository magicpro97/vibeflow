import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseAdvisoryLock, tryAdvisoryLock } from "../../src/durability/native.js";

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

  test("tryAdvisoryLock constructs the kernel lock provider on first use", () => {
    const onWindows = platformDescriptor.value === "win32";
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
    const lockPath = join(tmpdir(), "vf-provider-construction.lock");
    if (onWindows) {
      // A path nobody else holds: the provider must grant the lock.
      expect(tryAdvisoryLock(999_998, lockPath)).toBe(true);
      releaseAdvisoryLock(999_998);
    } else {
      // Off Windows the lazy construction runs and fails on the FFI load rather than
      // silently reporting the lock as unavailable.
      expect(() => tryAdvisoryLock(999_998, lockPath)).toThrow();
    }
  });
});
