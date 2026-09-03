import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WindowsKernelLockProvider } from "../src/dispatch/owned-process-record-windows-native.js";
import { createWindowsRecordRuntime } from "../src/dispatch/owned-process-record-windows-storage.js";
import type { WindowsRecordRuntime } from "../src/dispatch/owned-process-record-windows.js";
import { reserveWindowsAttemptEvidence } from "../src/dispatch/windows-attempt-evidence.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "vf-win-evidence-")));
  roots.push(root);
  return root;
}

function runtime(rename = renameSync): Partial<WindowsRecordRuntime> {
  const kernelLocks: WindowsKernelLockProvider = {
    tryAcquire: () => ({ assertHeld: () => {}, release: () => {} }),
  };
  return {
    kernelLocks,
    rename: (source, target, options) => {
      if (!options.replace && existsSync(target))
        throw Object.assign(new Error("target exists"), { code: "EEXIST" });
      rename(source, target);
    },
    identity: () => "win32:1",
    ownerAlive: () => false,
    enforceLocalWindowsPath: false,
  };
}

describe("Windows attempt evidence authority", () => {
  test("reserves, privately publishes, and idempotently finalizes evidence", () => {
    const root = join(temporaryRoot(), "authority");
    const reservation = reserveWindowsAttemptEvidence(root, "attempt", runtime());
    expect(JSON.parse(readFileSync(reservation.internalRef, "utf8"))).toMatchObject({
      attempt_id: "attempt",
      state: "pending",
    });
    expect(() => reserveWindowsAttemptEvidence(root, "attempt", runtime())).toThrow(
      "already exists",
    );
    reservation.finalize({ attempt_id: "attempt", ok: true });
    reservation.finalize({ attempt_id: "attempt", ok: false });
    expect(JSON.parse(readFileSync(reservation.internalRef, "utf8"))).toEqual({
      attempt_id: "attempt",
      ok: true,
    });
    expect(readdirSync(root).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    expect(() => reserveWindowsAttemptEvidence(root, "../escape", runtime())).toThrow(
      "unsafe Windows storage name",
    );
  });

  test("preserves publication failure and removes its private temporary", () => {
    const root = join(temporaryRoot(), "authority");
    const reservation = reserveWindowsAttemptEvidence(
      root,
      "failed",
      runtime(() => {
        throw new Error("publication primary");
      }),
    );
    expect(() => reservation.finalize({ attempt_id: "failed" })).toThrow("publication primary");
    expect(readdirSync(root).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  test("keeps publication and failure cleanup inside the same directory lease", () => {
    const root = join(temporaryRoot(), "authority");
    let depth = 0;
    let renameDepth = 0;
    let unlinkDepth = 0;
    const base = createWindowsRecordRuntime(runtime());
    const pathAuthority = {
      ...base.pathAuthority,
      withVerifiedDirectory<T>(path: string, expectedIdentity: string, operation: () => T): T {
        return base.pathAuthority.withVerifiedDirectory(path, expectedIdentity, () => {
          depth += 1;
          try {
            return operation();
          } finally {
            depth -= 1;
          }
        });
      },
    };
    const seams = {
      ...runtime(() => {
        renameDepth = depth;
        throw new Error("leased publication primary");
      }),
      pathAuthority,
      files: {
        ...fs,
        unlinkSync(path: fs.PathLike) {
          unlinkDepth = depth;
          return fs.unlinkSync(path);
        },
      },
    };
    const reservation = reserveWindowsAttemptEvidence(root, "leased", seams);
    expect(() => reservation.finalize({ attempt_id: "leased" })).toThrow(
      "leased publication primary",
    );
    expect(renameDepth).toBeGreaterThan(0);
    expect(unlinkDepth).toBeGreaterThan(0);
    expect(depth).toBe(0);
  });

  test("removes a failed pending write so the same attempt can be retried", () => {
    const root = join(temporaryRoot(), "authority");
    let fail = true;
    let writes = 0;
    const writeSync = ((...args: unknown[]) => {
      if (fail) {
        if (writes++ > 0) throw new Error("injected pending write failure");
        const partial = [...args];
        partial[3] = 1;
        return Reflect.apply(fs.writeSync, fs, partial) as number;
      }
      return Reflect.apply(fs.writeSync, fs, args) as number;
    }) as typeof fs.writeSync;
    const seams = {
      ...runtime(),
      files: {
        ...fs,
        writeSync,
      },
    };
    expect(() => reserveWindowsAttemptEvidence(root, "attempt", seams)).toThrow(
      "injected pending write failure",
    );
    expect(existsSync(join(root, "attempt.json"))).toBe(false);
    fail = false;
    expect(() => reserveWindowsAttemptEvidence(root, "attempt", seams)).not.toThrow();
  });

  test("rejects changed bytes after publication without leaving a temporary", () => {
    const root = join(temporaryRoot(), "authority");
    const reservation = reserveWindowsAttemptEvidence(
      root,
      "corrupt",
      runtime((source, target) => {
        renameSync(source, target);
        writeFileSync(target, "changed after publication");
      }),
    );
    expect(() => reservation.finalize({ attempt_id: "corrupt", ok: true })).toThrow(
      "Windows attempt evidence publication changed",
    );
    expect(readdirSync(root).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });
});
