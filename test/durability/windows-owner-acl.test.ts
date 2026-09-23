/**
 * Windows owner-only ACL enforcement (issue #807).
 *
 * These cover the three states that matter at the trust boundary and that a mode-bit check cannot
 * see on Windows: a freshly created path carrying inherited ACEs, the same path after migration,
 * and a genuinely permissive DACL that must be rejected rather than waved through.
 *
 * Gated to win32 with an early return, matching the existing platform-gated tests in this repo.
 */
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasPrivateMode,
  isNotGroupOrWorldWritable,
} from "../../src/durability/posix-fs-semantics.js";
import {
  WINDOWS_AUTHORITY_PATH_KIND,
  windowsApplyOwnerAcl,
  windowsEnsurePrivateAcl,
  windowsHasNoForeignWrite,
  windowsVerifyPathAcl,
} from "../../src/durability/windows-acl-ops.js";

const isWindows = process.platform === "win32";

function scratch(): { dir: string; file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(join(tmpdir(), "vf-acl-test-"));
  const file = join(dir, "record.bin");
  fs.writeFileSync(file, "payload");
  return {
    dir,
    file,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort: a leftover scratch dir must not fail the suite */
      }
    },
  };
}

describe("windows owner-only ACL", () => {
  it("rejects a fresh path that still carries inherited ACEs", () => {
    if (!isWindows) return;
    const { dir, file, cleanup } = scratch();
    try {
      // A path created normally inherits SYSTEM/Administrators/owner from its parent.
      expect(windowsVerifyPathAcl(file, WINDOWS_AUTHORITY_PATH_KIND.FILE)).toBe(false);
      expect(windowsVerifyPathAcl(dir, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("repairs a directory whose DACL was synthesised the way a standard host hands one down", () => {
    if (!isWindows) return;
    const { dir, cleanup } = scratch();
    try {
      // The strongest form of the standard shape: inheritance stripped and only the two
      // root-equivalent grants a profile directory propagates — no ACE for the owner and no
      // SE_DACL_PROTECTED. Verification must repair it in place rather than reject it (#803).
      execFileSync(
        "icacls",
        [
          dir,
          "/inheritance:r",
          "/grant",
          "*S-1-5-18:(OI)(CI)F",
          "/grant",
          "*S-1-5-32-544:(OI)(CI)F",
        ],
        { stdio: "ignore" },
      );
      expect(windowsVerifyPathAcl(dir, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY)).toBe(false);
      expect(windowsEnsurePrivateAcl(dir, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY)).toBe(true);
      expect(windowsVerifyPathAcl(dir, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("accepts a path after migration to owner-only", () => {
    if (!isWindows) return;
    const { dir, file, cleanup } = scratch();
    try {
      windowsApplyOwnerAcl(file, WINDOWS_AUTHORITY_PATH_KIND.FILE);
      windowsApplyOwnerAcl(dir, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY);
      expect(windowsVerifyPathAcl(file, WINDOWS_AUTHORITY_PATH_KIND.FILE)).toBe(true);
      expect(windowsVerifyPathAcl(dir, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("rejects a genuinely permissive DACL", () => {
    if (!isWindows) return;
    const { file, cleanup } = scratch();
    try {
      windowsApplyOwnerAcl(file, WINDOWS_AUTHORITY_PATH_KIND.FILE);
      expect(windowsVerifyPathAcl(file, WINDOWS_AUTHORITY_PATH_KIND.FILE)).toBe(true);
      // S-1-1-0 is Everyone: full control for world is exactly what the policy must catch.
      execFileSync("icacls", [file, "/grant", "*S-1-1-0:(F)"], { stdio: "ignore" });
      expect(windowsVerifyPathAcl(file, WINDOWS_AUTHORITY_PATH_KIND.FILE)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("reports false for a missing path instead of throwing", () => {
    if (!isWindows) return;
    const { dir, cleanup } = scratch();
    try {
      expect(windowsVerifyPathAcl(join(dir, "absent"), WINDOWS_AUTHORITY_PATH_KIND.FILE)).toBe(
        false,
      );
    } finally {
      cleanup();
    }
  });
});

describe("windowsHasNoForeignWrite (the group/other-write rule)", () => {
  it("accepts a container that only carries the standard inherited DACL", () => {
    if (!isWindows) return;
    const { dir, cleanup } = scratch();
    try {
      // The `.vibeflow` case: SYSTEM, Administrators and the owner inherit full control and
      // nothing else is granted. POSIX accepts the equivalent 0755 directory.
      expect(windowsHasNoForeignWrite(dir, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("accepts a directory that has been migrated to owner-only", () => {
    if (!isWindows) return;
    const { dir, cleanup } = scratch();
    try {
      windowsApplyOwnerAcl(dir, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY);
      expect(windowsHasNoForeignWrite(dir, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("rejects a directory that grants Everyone write", () => {
    if (!isWindows) return;
    const { dir, cleanup } = scratch();
    try {
      execFileSync("icacls", [dir, "/grant", "*S-1-1-0:(M)"], { stdio: "ignore" });
      expect(windowsHasNoForeignWrite(dir, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("still accepts a read-only grant to Everyone", () => {
    if (!isWindows) return;
    const { dir, cleanup } = scratch();
    try {
      // Read/execute for other principals must not trip the rule: POSIX 0755 allows exactly this.
      execFileSync("icacls", [dir, "/grant", "*S-1-1-0:(RX)"], { stdio: "ignore" });
      expect(windowsHasNoForeignWrite(dir, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("reports false for a missing path", () => {
    if (!isWindows) return;
    const { dir, cleanup } = scratch();
    try {
      expect(windowsHasNoForeignWrite(join(dir, "absent"), WINDOWS_AUTHORITY_PATH_KIND.FILE)).toBe(
        false,
      );
    } finally {
      cleanup();
    }
  });

  it("is wired into isNotGroupOrWorldWritable, which repairs rather than rejects", () => {
    if (!isWindows) return;
    const { dir, cleanup } = scratch();
    try {
      // Inherited-only container passes, which is what unblocked vf init on a pre-existing
      // .vibeflow.
      expect(isNotGroupOrWorldWritable(fs.statSync(dir), dir)).toBe(true);
      execFileSync("icacls", [dir, "/grant", "*S-1-1-0:(M)"], { stdio: "ignore" });
      // A foreign write is repaired in place instead of reported: the caller is about to use this
      // directory as a trust boundary, and rejecting it is what left existing installs unusable.
      expect(isNotGroupOrWorldWritable(fs.statSync(dir), dir)).toBe(true);
      expect(windowsHasNoForeignWrite(dir, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY)).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("posix-fs-semantics on windows consults the ACL", () => {
  it("is not vacuous: a path with inherited ACEs is migrated before hasPrivateMode answers", () => {
    if (!isWindows) return;
    const { file, cleanup } = scratch();
    try {
      // Inherited ACEs used to answer vacuously true, and rejecting them outright blocked existing
      // installs; the ACL is now migrated first, and the answer reflects the migrated DACL.
      expect(hasPrivateMode(fs.statSync(file), 0o7777, 0o600, file)).toBe(true);
      expect(windowsVerifyPathAcl(file, WINDOWS_AUTHORITY_PATH_KIND.FILE)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("checks directories with the foreign-write policy, not the owner-only one", () => {
    if (!isWindows) return;
    const { dir, cleanup } = scratch();
    try {
      // An inherited DACL has no foreign write right, so it satisfies this rule even though it
      // would fail the stricter owner-only check hasPrivateMode applies.
      expect(isNotGroupOrWorldWritable(fs.statSync(dir), dir)).toBe(true);
      expect(windowsVerifyPathAcl(dir, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY)).toBe(false);
      windowsApplyOwnerAcl(dir, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY);
      expect(isNotGroupOrWorldWritable(fs.statSync(dir), dir)).toBe(true);
      expect(windowsVerifyPathAcl(dir, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("consults the ACL machinery whenever the platform reads as win32", () => {
    // The Windows branch must run on CI too, or the only code path that decides privacy on
    // Windows is exercised exclusively on a developer machine. The path is absent, so the answer
    // is "no privacy" whether the host can reach the Win32 security calls or not.
    const original = process.platform;
    const absent = join(tmpdir(), "vf-fs-semantics-absent", "record.bin");
    const stat = { mode: 0o666, isDirectory: () => false } as fs.Stats;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      expect(hasPrivateMode(stat, 0o7777, 0o600, absent)).toBe(false);
      expect(isNotGroupOrWorldWritable(stat, absent)).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });

  it("still uses mode bits off windows", () => {
    if (isWindows) return;
    const { file, dir, cleanup } = scratch();
    try {
      fs.chmodSync(file, 0o600);
      expect(hasPrivateMode(fs.statSync(file), 0o777, 0o600, file)).toBe(true);
      fs.chmodSync(file, 0o644);
      expect(hasPrivateMode(fs.statSync(file), 0o777, 0o600, file)).toBe(false);
      fs.chmodSync(dir, 0o700);
      expect(isNotGroupOrWorldWritable(fs.statSync(dir), dir)).toBe(true);
    } finally {
      cleanup();
    }
  });
});
