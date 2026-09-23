/**
 * Windows ACL verdict identity and the pre-#807 upgrade path (issue #811).
 *
 * The first group runs against the real Win32 DACL and the real FileIdInfo, because the two claims
 * it makes — "an inherited descriptor is migrated, not rejected" and "a substituted object is
 * neither accepted nor repaired" — are claims about what Windows actually does. icacls/PowerShell
 * only ever set up a fixture here; nothing is asserted from their output.
 *
 * The seam tests for the same gate on any platform live in windows-acl-ops.test.ts.
 */
import { describe, expect, it } from "bun:test";
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
  windowsHasNoForeignWrite,
  windowsVerifyPathAcl,
} from "../../src/durability/windows-acl-ops.js";

const isWindows = process.platform === "win32";
const FILE = WINDOWS_AUTHORITY_PATH_KIND.FILE;
const DIRECTORY = WINDOWS_AUTHORITY_PATH_KIND.DIRECTORY;

function scratch(): { dir: string; file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(join(tmpdir(), "vf-acl-identity-"));
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

describe("windows acl verdict identity", () => {
  it("reports one identity for a file object through node:fs and through the ACL handle", () => {
    if (!isWindows) return;
    const { dir, file, cleanup } = scratch();
    const fd = fs.openSync(file, fs.constants.O_RDONLY);
    try {
      const stat = fs.fstatSync(fd);
      // Owner-only first, so the verdicts below are decided by identity alone and not by the DACL.
      windowsApplyOwnerAcl(file, FILE);
      expect(windowsVerifyPathAcl(file, FILE, { identity: { dev: stat.dev, ino: stat.ino } })).toBe(
        true,
      );
      // Another object's identity is not this file's, even on the same volume.
      const other = fs.statSync(dir);
      expect(other.ino).not.toBe(stat.ino);
      expect(
        windowsVerifyPathAcl(file, FILE, { identity: { dev: other.dev, ino: other.ino } }),
      ).toBe(false);
      expect(
        windowsVerifyPathAcl(file, FILE, { identity: { dev: stat.dev, ino: other.ino } }),
      ).toBe(false);
    } finally {
      fs.closeSync(fd);
      cleanup();
    }
  });

  it("migrates pre-existing state that carries the inherited DACL instead of rejecting it", () => {
    if (!isWindows) return;
    const { file, cleanup } = scratch();
    const fd = fs.openSync(file, fs.constants.O_RDONLY);
    try {
      // What an install from before #807 left behind: the SYSTEM/Administrators/owner descriptor
      // the parent directory hands down.
      expect(windowsVerifyPathAcl(file, FILE)).toBe(false);
      expect(windowsHasNoForeignWrite(file, FILE)).toBe(true);
      // The durable-state check runs against the descriptor the caller already holds, exactly as
      // trace/path-safety.ts and conversation/catalog-read-safety.ts call it.
      expect(hasPrivateMode(fs.fstatSync(fd), 0o7777, 0o600, file)).toBe(true);
      // Migrated, not merely tolerated: the path now carries the owner-only descriptor...
      expect(windowsVerifyPathAcl(file, FILE)).toBe(true);
      // ...and a DACL repair never touches the data it protects.
      expect(fs.readFileSync(file, "utf8")).toBe("payload");
    } finally {
      fs.closeSync(fd);
      cleanup();
    }
  });

  it("holds containers to the foreign-write policy and data files to the owner-only policy", () => {
    if (!isWindows) return;
    const { dir, cleanup } = scratch();
    try {
      // A container inherited from an earlier install is accepted as it stands — the standard
      // descriptor grants nothing past the root-equivalent principals and the owner, which is what
      // POSIX 0755 grants — and it keeps that descriptor rather than being rewritten.
      expect(isNotGroupOrWorldWritable(fs.statSync(dir), dir)).toBe(true);
      expect(windowsVerifyPathAcl(dir, DIRECTORY)).toBe(false);
      // The same path under the owner-only rule, which is what the durable data paths take, is
      // repaired in place instead of rejected.
      expect(hasPrivateMode(fs.statSync(dir), 0o777, 0o700, dir)).toBe(true);
      expect(windowsVerifyPathAcl(dir, DIRECTORY)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("refuses to accept or repair a substituted object", () => {
    if (!isWindows) return;
    const { dir, file, cleanup } = scratch();
    const decoy = join(dir, "decoy.bin");
    fs.writeFileSync(decoy, "decoy");
    try {
      const fd = fs.openSync(file, fs.constants.O_RDONLY);
      let stat: fs.Stats;
      try {
        stat = fs.fstatSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      // Both objects start from the inherited descriptor, so either one would be accepted — and
      // rewritten — if the verdict were not bound to the object the caller stat'ed.
      expect(windowsVerifyPathAcl(file, FILE)).toBe(false);
      expect(windowsVerifyPathAcl(decoy, FILE)).toBe(false);
      fs.renameSync(file, join(dir, "moved.bin"));
      fs.renameSync(decoy, file);
      const decoyStat = fs.statSync(file);
      expect(decoyStat.ino).not.toBe(stat.ino);
      expect(hasPrivateMode(stat, 0o7777, 0o600, file)).toBe(false);
      // The substitute keeps the descriptor it arrived with: a refused verdict must not repair it.
      expect(windowsVerifyPathAcl(file, FILE)).toBe(false);
      // The refusal is about identity, not about the substitute being unacceptable: asked about the
      // object that really is at the path, the same check migrates it.
      expect(hasPrivateMode(decoyStat, 0o7777, 0o600, file)).toBe(true);
      expect(windowsVerifyPathAcl(file, FILE)).toBe(true);
    } finally {
      cleanup();
    }
  });
});
