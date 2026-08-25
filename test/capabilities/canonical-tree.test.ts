import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base32lowerNoPad, sourcePermissionId } from "../../src/capabilities/canonical/index.js";
import { computePackageTree, readPackageTree } from "../../src/capabilities/source/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "vf-cap-tree-"));
  roots.push(root);
  chmodSync(root, 0o700);
  return root;
};

describe("capability canonical identity", () => {
  test("uses exact lower-base32 digest constructors", () => {
    expect(base32lowerNoPad(Buffer.alloc(32))).toBe("a".repeat(52));
    const digest = `sha256:${"00".repeat(32)}`;
    expect(sourcePermissionId("n", digest)).toBe(`vf.source/n-${"a".repeat(52)}`);
    expect(() => sourcePermissionId("x", digest)).toThrow("invalid source permission tag");
  });

  test("hashes universal package entries with byte-exact framing", () => {
    const tree = computePackageTree([
      { path: "b.bin", bytes: Buffer.from([0, 1]) },
      { path: "a.txt", bytes: Buffer.from("x") },
    ]);
    const u32 = (value: number) => {
      const bytes = Buffer.alloc(4);
      bytes.writeUInt32BE(value);
      return bytes;
    };
    const u64 = (value: number) => {
      const bytes = Buffer.alloc(8);
      bytes.writeBigUInt64BE(BigInt(value));
      return bytes;
    };
    const entries = [
      [Buffer.from("a.txt"), Buffer.from("x")],
      [Buffer.from("b.bin"), Buffer.from([0, 1])],
    ] as const;
    const hash = createHash("sha256").update("VF-CAPABILITY-PACKAGE-TREE\0v1\0").update(u32(2));
    for (const [path, bytes] of entries)
      hash
        .update(u32(path.length))
        .update(path)
        .update(u64(bytes.length))
        .update(createHash("sha256").update(bytes).digest());
    expect(tree.content_sha256).toBe(hash.digest("hex"));
    expect(tree.entries.map((entry) => entry.path)).toEqual(["a.txt", "b.bin"]);
  });

  test("rejects symlinks, hard links, and case-fold collisions", () => {
    const root = temp();
    writeFileSync(join(root, "real"), "x");
    symlinkSync("real", join(root, "link"));
    expect(() => readPackageTree(root)).toThrow("symlink");
    unlinkSync(join(root, "link"));
    linkSync(join(root, "real"), join(root, "hard"));
    expect(() => readPackageTree(root)).toThrow("hard-linked");
    unlinkSync(join(root, "hard"));
    expect(() =>
      computePackageTree([
        { path: "A", bytes: Buffer.from("a") },
        { path: "a", bytes: Buffer.from("b") },
      ]),
    ).toThrow("case-fold-colliding");
  });
});
