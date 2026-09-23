import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WIN32_FD_PATHS } from "../../src/durability/native-runtime.js";
import {
  closePinnedDirectory,
  closeTrackedFd,
  openPrivateDirectory,
  tryOpenAt,
} from "../../src/durability/native.js";

/**
 * tryOpenAt registers a Windows directory fd so the *at() shims can resolve it back to a path.
 * Callers that asked for a FILE and got a directory used to close the fd with a bare
 * fs.closeSync, leaving the mapping behind — and fd numbers are recycled, so a later relative
 * operation could resolve through a stale directory path.
 *
 * closeTrackedFd is the fix: every fd that came out of tryOpenAt goes back through it.
 */
describe("tryOpenAt registry lifetime", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const pin = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "vf-registry-")));
    roots.push(root);
    return { root, directory: openPrivateDirectory(root, true) };
  };

  test("closeTrackedFd drops the registration a directory open installed", () => {
    const { root, directory } = pin();
    try {
      mkdirSync(join(root, "child"));
      const fd = tryOpenAt(directory, "child", fs.constants.O_RDONLY);
      expect(fd).not.toBeNull();
      const opened = fd as number;
      if (process.platform === "win32")
        expect(WIN32_FD_PATHS.get(opened)).toBe(join(root, "child"));

      closeTrackedFd(opened);
      // The registry must be empty for this number whatever the platform: a leftover entry is
      // what lets a recycled fd resolve through a directory it no longer refers to.
      expect(WIN32_FD_PATHS.has(opened)).toBe(false);
    } finally {
      closePinnedDirectory(directory);
    }
  });

  test("a file open leaves no registration to leak in the first place", () => {
    const { root, directory } = pin();
    try {
      writeFileSync(join(root, "afile"), "x");
      const fd = tryOpenAt(directory, "afile", fs.constants.O_RDONLY);
      expect(fd).not.toBeNull();
      const opened = fd as number;
      // A file fd is never a valid *at() base, so it must never be registered.
      expect(WIN32_FD_PATHS.has(opened)).toBe(false);
      closeTrackedFd(opened);
    } finally {
      closePinnedDirectory(directory);
    }
  });

  test("a recycled fd number cannot answer with the previous owner's path", () => {
    const { root, directory } = pin();
    try {
      mkdirSync(join(root, "first"));
      mkdirSync(join(root, "second"));

      const first = tryOpenAt(directory, "first", fs.constants.O_RDONLY) as number;
      closeTrackedFd(first);

      // The OS commonly hands the same number straight back; whether it does or not, no entry
      // from the closed fd may survive to describe the new one.
      const second = tryOpenAt(directory, "second", fs.constants.O_RDONLY) as number;
      try {
        if (process.platform === "win32") {
          expect(WIN32_FD_PATHS.get(second)).toBe(join(root, "second"));
        }
        expect(WIN32_FD_PATHS.get(second) ?? join(root, "second")).not.toBe(join(root, "first"));
      } finally {
        closeTrackedFd(second);
      }
    } finally {
      closePinnedDirectory(directory);
    }
  });
});
