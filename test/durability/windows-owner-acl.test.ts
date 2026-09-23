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

describe("posix-fs-semantics on windows consults the ACL", () => {
  it("is not vacuous: a permissive path fails hasPrivateMode", () => {
    if (!isWindows) return;
    const { file, cleanup } = scratch();
    try {
      // Inherited ACEs: must be rejected. Before #807 this returned true unconditionally.
      expect(hasPrivateMode(fs.statSync(file), 0o7777, 0o600, file)).toBe(false);
      windowsApplyOwnerAcl(file, WINDOWS_AUTHORITY_PATH_KIND.FILE);
      expect(hasPrivateMode(fs.statSync(file), 0o7777, 0o600, file)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("checks directories with the directory policy", () => {
    if (!isWindows) return;
    const { dir, cleanup } = scratch();
    try {
      expect(isNotGroupOrWorldWritable(fs.statSync(dir), dir)).toBe(false);
      windowsApplyOwnerAcl(dir, WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY);
      expect(isNotGroupOrWorldWritable(fs.statSync(dir), dir)).toBe(true);
    } finally {
      cleanup();
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
