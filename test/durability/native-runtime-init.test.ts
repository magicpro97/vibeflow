import { afterAll, describe, expect, test } from "bun:test";
import {
  errnoIs,
  errnoValue,
  initializeNativeRuntime,
} from "../../src/durability/native-runtime.js";

/**
 * initializeNativeRuntime picks a different loader per platform, so a single-platform CI run
 * leaves most of its branches unexecuted — including the Windows errno table, which is the
 * thing that makes errnoIs("ENOENT") answer correctly for the *at() shims.
 *
 * The function takes the platform as an argument, so every branch is reachable anywhere. It
 * also writes module-global state (the errno reader and errno table), so this file must put
 * the real runtime back afterwards or every later durability test in the same process
 * misreads its syscall errors.
 */
const realRuntime = { disabled: false, platform: process.platform, isBun: true };

describe("initializeNativeRuntime", () => {
  afterAll(() => {
    initializeNativeRuntime(realRuntime);
  });

  test("reports the disabled runtime without loading anything", () => {
    const result = initializeNativeRuntime({ disabled: true, platform: "linux", isBun: true });
    expect(result.bindings).toBeNull();
    expect(result.unavailableReason).toBe("native durability was disabled by the runtime");
  });

  test("win32 installs the fs shims together with a complete errno table", () => {
    const result = initializeNativeRuntime({ disabled: false, platform: "win32", isBun: true });
    expect(result.bindings).not.toBeNull();
    // fcntl is absent on the Windows shims: callers must take their no-fcntl path.
    expect(result.bindings?.fcntl).toBeNull();

    // The codes the durability callers branch on.
    expect(errnoValue("ENOENT")).toBe(2);
    expect(errnoValue("EEXIST")).toBe(17);
    expect(errnoValue("EACCES")).toBe(13);
    expect(errnoValue("EAGAIN")).toBe(11);
    expect(errnoValue("EWOULDBLOCK")).toBe(11);

    // Extending rather than replacing os.constants.errno is load-bearing: dropping the rest of
    // the table would make classifySyscallError misread ENOSYS/ENOTSUP as 0.
    expect(errnoValue("ENOSYS")).toBeGreaterThan(0);
  });

  test("win32 errno reads flow through the shim errno, not koffi", () => {
    const bindings = initializeNativeRuntime({
      disabled: false,
      platform: "win32",
      isBun: true,
    }).bindings;
    // unlinkat on an unregistered fd records ENOENT; errnoIs must observe that value.
    expect(bindings?.unlinkat(999_999, "nothing", 0)).toBe(-1);
    expect(errnoIs("ENOENT")).toBe(true);
    expect(errnoIs("EEXIST")).toBe(false);
  });

  test("an unsupported platform is reported by name rather than crashing", () => {
    const result = initializeNativeRuntime({ disabled: false, platform: "aix", isBun: true });
    expect(result.bindings).toBeNull();
    expect(result.unavailableReason).toBe("native durability is unsupported on aix");
  });

  test("a loader failure is captured as the unavailable reason", () => {
    // None of these reach a loader: each must fail closed with a reason naming the platform
    // instead of throwing out of initialization.
    for (const platform of ["sunos", "freebsd", "android"]) {
      const result = initializeNativeRuntime({ disabled: false, platform, isBun: false });
      expect(result.bindings).toBeNull();
      expect(result.unavailableReason).toContain(platform);
    }
  });
});
