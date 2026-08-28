import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { WindowsKernelLockProvider } from "../src/dispatch/owned-process-record-windows-native.js";
import { createWindowsRecordRuntime } from "../src/dispatch/owned-process-record-windows-storage.js";
import type { WindowsRecordRuntime } from "../src/dispatch/owned-process-record-windows.js";
import { NativeWindowsAttemptAuthorityStorage } from "../src/dispatch/start-authority-windows.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = realpathSync.native(mkdtempSync(join(tmpdir(), "vf-start-win-")));
  roots.push(value);
  return value;
}

function runtime(): Partial<WindowsRecordRuntime> {
  let held = false;
  const kernelLocks: WindowsKernelLockProvider = {
    tryAcquire: () => {
      if (held) return null;
      held = true;
      let released = false;
      return {
        assertHeld: () => {
          if (released || !held) throw new Error("lost test lock");
        },
        release: () => {
          released = true;
          held = false;
        },
      };
    },
  };
  return {
    kernelLocks,
    rename: (source, target, options) => {
      if (!options.replace && existsSync(target))
        throw Object.assign(new Error("target exists"), { code: "EEXIST" });
      renameSync(source, target);
    },
    identity: () => "win32:1",
    ownerAlive: () => false,
    enforceLocalWindowsPath: false,
  };
}

describe("native Windows attempt start authority storage", () => {
  test("reads evidence and immutably creates or verifies records", () => {
    const authorityRoot = root();
    const storage = new NativeWindowsAttemptAuthorityStorage(authorityRoot, runtime());
    const evidence = join(storage.root, "attempt.json");
    const record = join(storage.root, "start-authority", "record.json");
    writeFileSync(evidence, "evidence");
    expect(storage.read(evidence, 8)?.toString()).toBe("evidence");
    expect(storage.read(join(storage.root, "missing.json"), 8)).toBeNull();
    storage.createOrVerify(record, Buffer.from("record"), 8);
    storage.createOrVerify(record, Buffer.from("record"), 8);
    expect(storage.read(record, 8)?.toString()).toBe("record");
    expect(() => storage.createOrVerify(record, Buffer.from("changed"), 8)).toThrow(
      "immutable Windows attempt authority changed",
    );
    expect(() => storage.read(join(dirname(authorityRoot), "escape"), 8)).toThrow(
      "escapes storage root",
    );
    expect(() =>
      storage.createOrVerify(join(dirname(authorityRoot), "escape"), Buffer.from("x"), 8),
    ).toThrow("escapes storage root");
  });

  test("accepts only an exact immutable winner after a lost create CAS", () => {
    const authorityRoot = root();
    const desired = Buffer.from("winner");
    const seams = runtime();
    const base = createWindowsRecordRuntime(seams);
    let reads = 0;
    const pathAuthority = {
      ...base.pathAuthority,
      readPrivateFile(path: string, maxBytes: number) {
        if (path.endsWith("record.json")) {
          reads += 1;
          if (reads === 2) base.pathAuthority.writePrivateFile(path, desired, maxBytes);
        }
        return base.pathAuthority.readPrivateFile(path, maxBytes);
      },
    };
    const storage = new NativeWindowsAttemptAuthorityStorage(authorityRoot, {
      ...seams,
      pathAuthority,
    });
    const record = join(storage.root, "start-authority", "record.json");
    storage.createOrVerify(record, desired, 16);
    expect(storage.read(record, 16)).toEqual(desired);
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  test("normalizes an exact create-publication race and rejects a different winner", () => {
    const exercise = (winner: Buffer, desired: Buffer) => {
      const authorityRoot = root();
      const seams = runtime();
      const rename = seams.rename;
      let raced = false;
      const storage = new NativeWindowsAttemptAuthorityStorage(authorityRoot, {
        ...seams,
        rename: (source, target, options) => {
          if (!raced && target.endsWith("record.json") && source.endsWith(".stage")) {
            raced = true;
            writeFileSync(target, winner);
            throw Object.assign(new Error("target exists"), { code: "EEXIST" });
          }
          if (!rename) throw new Error("missing rename fixture");
          rename(source, target, options);
        },
      });
      const record = join(storage.root, "start-authority", "record.json");
      return { raced: () => raced, run: () => storage.createOrVerify(record, desired, 16) };
    };
    const exact = exercise(Buffer.from("winner"), Buffer.from("winner"));
    expect(exact.run).not.toThrow();
    expect(exact.raced()).toBe(true);

    const changed = exercise(Buffer.from("changed"), Buffer.from("winner"));
    expect(changed.run).toThrow("Windows CAS publication raced");
    expect(changed.raced()).toBe(true);
  });
});
