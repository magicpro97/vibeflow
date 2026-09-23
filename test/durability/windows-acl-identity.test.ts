/**
 * Windows ACL verdict identity, the DACL write that cannot be diverted, and the pre-#807 upgrade
 * path (issues #811, #817).
 *
 * The first group runs against the real Win32 DACL and the real FileIdInfo, because the claims it
 * makes — "an inherited descriptor is migrated, not rejected", "a substituted object is neither
 * accepted nor repaired", "the write lands on the object the ACL layer opened" — are claims about
 * what Windows actually does. icacls/PowerShell only ever set up a fixture here; nothing is asserted
 * from their output.
 *
 * The seam tests for the same gate on any platform live in windows-acl-ops.test.ts.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { native } from "../../src/durability/native-runtime.js";
import { repairWindowsLeafAcl } from "../../src/durability/native-windows-ops.js";
import {
  closePinnedDirectory,
  openPinnedDescendant,
  openPrivateDirectory,
} from "../../src/durability/native.js";
import { ensurePrivateDirectory } from "../../src/durability/path.js";
import {
  hasPrivateMode,
  isNotGroupOrWorldWritable,
} from "../../src/durability/posix-fs-semantics.js";
import {
  WINDOWS_AUTHORITY_PATH_KIND,
  descriptorIdentity,
  windowsEnsurePrivateAcl,
  windowsHasNoForeignWrite,
  windowsVerifyPathAcl,
} from "../../src/durability/windows-acl-ops.js";
import {
  type WindowsPrivateAuthority,
  createWindowsPrivateAuthority,
} from "../../src/durability/windows-private-authority.js";

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
      const identity = descriptorIdentity(fd);
      // Owner-only first, so the verdicts below are decided by identity alone and not by the DACL.
      expect(windowsEnsurePrivateAcl(file, FILE, { identity })).toBe(true);
      expect(windowsVerifyPathAcl(file, FILE, { identity })).toBe(true);
      // Another object's identity is not this file's, even on the same volume.
      const other = descriptorIdentity(fs.openSync(dir, fs.constants.O_RDONLY));
      expect(other).not.toEqual(identity);
      expect(windowsVerifyPathAcl(file, FILE, { identity: other })).toBe(false);
      expect(
        windowsVerifyPathAcl(file, FILE, { identity: { dev: identity.dev, ino: other.ino } }),
      ).toBe(false);
    } finally {
      fs.closeSync(fd);
      cleanup();
    }
  });

  it("carries the identity as the exact bigint pair, which is not the Number-typed one above 2^53", () => {
    if (!isWindows) return;
    const { file, cleanup } = scratch();
    const fd = fs.openSync(file, fs.constants.O_RDONLY);
    try {
      const exact = descriptorIdentity(fd);
      const big = fs.fstatSync(fd, { bigint: true });
      expect(exact).toEqual({ dev: big.dev, ino: big.ino });
      // The identity the verdict is bound to is exact: a neighbour id on the same volume is not it,
      // however close it sits.
      expect(
        windowsVerifyPathAcl(file, FILE, { identity: { dev: exact.dev, ino: exact.ino + 1n } }),
      ).toBe(false);
      // What rounding costs, where the volume's file ids reach past 2^53 (NTFS ids need 57 bits):
      // the Number-typed ino is then *not* the id FILE_ID_INFO reports, so a comparison against it
      // is a comparison against a rounded value.
      if (big.ino > 2n ** 53n) expect(fs.fstatSync(fd).ino).not.toBe(Number(big.ino));
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
      expect(hasPrivateMode(fs.fstatSync(fd), 0o7777, 0o600, file, fd)).toBe(true);
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
    const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      // A container inherited from an earlier install is accepted as it stands — the standard
      // descriptor grants nothing past the root-equivalent principals and the owner, which is what
      // POSIX 0755 grants — and it keeps that descriptor rather than being rewritten.
      expect(isNotGroupOrWorldWritable(fs.fstatSync(fd), dir, fd)).toBe(true);
      expect(windowsVerifyPathAcl(dir, DIRECTORY)).toBe(false);
      // The same path under the owner-only rule, which is what the durable data paths take, is
      // repaired in place instead of rejected.
      expect(hasPrivateMode(fs.fstatSync(fd), 0o777, 0o700, dir, fd)).toBe(true);
      expect(windowsVerifyPathAcl(dir, DIRECTORY)).toBe(true);
    } finally {
      fs.closeSync(fd);
      cleanup();
    }
  });

  it("refuses to accept or repair a substituted object", () => {
    if (!isWindows) return;
    const { dir, file, cleanup } = scratch();
    const decoy = join(dir, "decoy.bin");
    fs.writeFileSync(decoy, "decoy");
    try {
      const measured = fs.openSync(file, fs.constants.O_RDONLY);
      const identity = descriptorIdentity(measured);
      fs.closeSync(measured);
      // Both objects start from the inherited descriptor, so either one would be accepted — and
      // rewritten — if the verdict were not bound to the object the caller measured.
      expect(windowsVerifyPathAcl(file, FILE)).toBe(false);
      expect(windowsVerifyPathAcl(decoy, FILE)).toBe(false);
      fs.renameSync(file, join(dir, "moved.bin"));
      fs.renameSync(decoy, file);
      const substitute = fs.openSync(file, fs.constants.O_RDONLY);
      const substituteIdentity = descriptorIdentity(substitute);
      fs.closeSync(substitute);
      expect(substituteIdentity.ino).not.toBe(identity.ino);
      // Asked about the object the caller measured — which is no longer the one at the path: refused,
      // and the substitute keeps the descriptor it arrived with.
      const surrogate = fs.openSync(join(dir, "moved.bin"), fs.constants.O_RDONLY);
      try {
        expect(hasPrivateMode(fs.fstatSync(surrogate), 0o7777, 0o600, file, surrogate)).toBe(false);
      } finally {
        fs.closeSync(surrogate);
      }
      expect(windowsVerifyPathAcl(file, FILE, { identity })).toBe(false);
      expect(windowsVerifyPathAcl(file, FILE)).toBe(false);
      // The refusal is about identity, not about the substitute being unacceptable: asked about the
      // object that really is at the path, the same check migrates it.
      expect(windowsEnsurePrivateAcl(file, FILE, { identity: substituteIdentity })).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("writes the DACL through the handle it verified, never through the name", () => {
    if (!isWindows) return;
    const { dir, cleanup } = scratch();
    const leaf = join(dir, "leaf");
    const substitute = join(dir, "substitute");
    const moved = join(dir, "moved-leaf");
    fs.mkdirSync(leaf);
    fs.mkdirSync(substitute);
    const leafFd = fs.openSync(leaf, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      // Both directories carry the inherited descriptor, so either one would be accepted — and
      // rewritten — if the write were by path.
      expect(windowsVerifyPathAcl(leaf, DIRECTORY)).toBe(false);
      expect(windowsVerifyPathAcl(substitute, DIRECTORY)).toBe(false);
      const real = createWindowsPrivateAuthority();
      const diverting: WindowsPrivateAuthority = {
        ...real,
        // The writer wins its race at the exact moment the descriptor is about to be written: the
        // name the ACL layer opened no longer refers to the object it opened.
        migrateHandle(handle, kind) {
          fs.renameSync(leaf, moved);
          fs.renameSync(substitute, leaf);
          real.migrateHandle(handle, kind);
        },
      };
      expect(repairWindowsLeafAcl(leaf, leafFd, { authority: diverting })).toBe(true);
      // The descriptor landed on the object the handle referred to, and the replacement at the name
      // kept the one it arrived with.
      expect(windowsVerifyPathAcl(moved, DIRECTORY)).toBe(true);
      expect(windowsVerifyPathAcl(leaf, DIRECTORY)).toBe(false);
      expect(windowsHasNoForeignWrite(leaf, DIRECTORY)).toBe(true);
    } finally {
      fs.closeSync(leafFd);
      cleanup();
    }
  });

  it("refuses to repair a leaf that was replaced after it was opened", () => {
    if (!isWindows) return;
    const { dir, cleanup } = scratch();
    const leaf = join(dir, "leaf");
    const substitute = join(dir, "substitute");
    const moved = join(dir, "moved-leaf");
    fs.mkdirSync(leaf);
    fs.mkdirSync(substitute);
    const leafFd = fs.openSync(leaf, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      // The walk opened `leaf`; the writer replaces it before the ACL layer gets to the name.
      fs.renameSync(leaf, moved);
      fs.renameSync(substitute, leaf);
      // The write is refused, not redirected: it is at the wrong object for the identity this call
      // was made with, so nothing is written anywhere.
      expect(repairWindowsLeafAcl(leaf, leafFd)).toBe(false);
      expect(windowsVerifyPathAcl(leaf, DIRECTORY)).toBe(false);
      expect(windowsHasNoForeignWrite(leaf, DIRECTORY)).toBe(true);
      expect(windowsVerifyPathAcl(moved, DIRECTORY)).toBe(false);
      expect(windowsHasNoForeignWrite(moved, DIRECTORY)).toBe(true);
      // Bound to the leaf that really is at the name, the same call migrates it: the refusal was
      // about identity, not about the ACL machinery being unable to act.
      const substituteFd = fs.openSync(leaf, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      try {
        expect(repairWindowsLeafAcl(leaf, substituteFd)).toBe(true);
      } finally {
        fs.closeSync(substituteFd);
      }
      expect(windowsVerifyPathAcl(leaf, DIRECTORY)).toBe(true);
    } finally {
      fs.closeSync(leafFd);
      cleanup();
    }
  });

  it("makes the walk refuse a leaf swapped for a junction instead of repairing the substitute", () => {
    if (!isWindows) return;
    const dir = fs.mkdtempSync(join(tmpdir(), "vf-acl-leaf-swap-"));
    const leaf = join(dir, "leaf");
    const replaced = join(dir, "replaced");
    const elsewhere = join(dir, "elsewhere");
    fs.mkdirSync(elsewhere);
    ensurePrivateDirectory(dir);
    const base = openPrivateDirectory(dir, false);
    const api = native();
    const realOpenat = api.openat;
    let opened = 0;
    try {
      // A writer able to replace a leaf swaps the directory the walk just created for a junction to
      // a directory of its choosing, before the walk reopens the name. The repair is bound to the
      // identity of the object the walk holds, so it refuses the substitute and the walk fails
      // closed — nothing is pinned and the substitute keeps the DACL it arrived with.
      api.openat = (directoryFd, name, flags, modeType, mode) => {
        if (name === "leaf" && opened++ === 1) {
          fs.renameSync(leaf, replaced);
          fs.symlinkSync(elsewhere, leaf, "junction");
        }
        return realOpenat(directoryFd, name, flags, modeType, mode);
      };
      expect(() => openPinnedDescendant(base, leaf, true)).toThrow(/fchmodat/);
      expect(windowsVerifyPathAcl(elsewhere, DIRECTORY)).toBe(false);
      expect(windowsHasNoForeignWrite(elsewhere, DIRECTORY)).toBe(true);
      expect(fs.existsSync(replaced)).toBe(true);
      // Bound to the object the descriptor really refers to, the same repair does act: the refusal
      // was about identity, not about the ACL machinery being unable to write.
      const targetFd = fs.openSync(elsewhere, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      try {
        expect(repairWindowsLeafAcl(elsewhere, targetFd)).toBe(true);
        expect(windowsVerifyPathAcl(elsewhere, DIRECTORY)).toBe(true);
      } finally {
        fs.closeSync(targetFd);
      }
    } finally {
      api.openat = realOpenat;
      closePinnedDirectory(base);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
