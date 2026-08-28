import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOwnedRuntimeRoot,
  createWindowsOwnedRuntimeRoot,
  defaultOwnedSupervisorLaunchRuntime,
} from "../src/dispatch/owned-process-launch-runtime.js";
import { RUNTIME_PLATFORM } from "../src/durability/process-identity-contract.js";

describe("Windows owned runtime authority", () => {
  test("validates and atomically delegates private directory creation", () => {
    const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "vf-win-runtime-direct-")));
    const target = join(parent, "runtime");
    const calls: string[] = [];
    const verified: string[] = [];
    try {
      createWindowsOwnedRuntimeRoot(target, {
        validate: (path) => calls.push(`validate:${path}`),
        runtime: {
          enforceLocalWindowsPath: false,
          kernelLocks: { tryAcquire: () => null },
          rename: () => {},
          verifyPrivatePath: (path) => {
            if (path === parent) throw new Error("public temp parent must remain allowed");
            verified.push(path);
          },
        },
      });
      expect(calls).toEqual([`validate:${target}`]);
      expect(verified).toContain(target);
      expect(existsSync(target)).toBe(true);
      expect(() =>
        createWindowsOwnedRuntimeRoot(target, {
          validate: () => {},
          runtime: {
            enforceLocalWindowsPath: false,
            kernelLocks: { tryAcquire: () => null },
            rename: () => {},
          },
        }),
      ).toThrow();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("uses the Windows private creator instead of POSIX mode bits", () => {
    const parent = mkdtempSync(join(tmpdir(), "vf-win-runtime-authority-"));
    const created: string[] = [];
    try {
      const runtime = {
        ...defaultOwnedSupervisorLaunchRuntime(),
        platform: RUNTIME_PLATFORM.WINDOWS,
        tmpdir: () => parent,
        createWindowsPrivateDirectory: (path: string) => {
          created.push(path);
          mkdirSync(path);
        },
      };
      const root = createOwnedRuntimeRoot(runtime, "00000000-0000-4000-8000-0000000000ab");
      expect(created).toEqual([root.path]);
      root.cleanup();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
