import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canaryForUnit, discoverCanaries, isCanaryFile } from "../src/canary.js";

test("isCanaryFile: matches *.canary.test.ts", () => {
  expect(isCanaryFile("test/foo.canary.test.ts")).toBe(true);
  expect(isCanaryFile("test/foo.test.ts")).toBe(false);
  expect(isCanaryFile("test/foo.canary.test.tsx")).toBe(true);
  expect(isCanaryFile("test/foo.canary.test.js")).toBe(true);
  expect(isCanaryFile("test/foo.canary.spec.ts")).toBe(false);
});

test("discoverCanaries: finds canary files in a dir (injected lister)", () => {
  const files = discoverCanaries("/repo", {
    lister: () => ["test/a.canary.test.ts", "test/b.test.ts", "test/c.canary.test.ts"],
  });
  expect(files).toEqual(["test/a.canary.test.ts", "test/c.canary.test.ts"]);
});

test("discoverCanaries: default lister walks test/ on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "vf-canary-"));
  try {
    mkdirSync(join(dir, "test", "sub"), { recursive: true });
    writeFileSync(join(dir, "test", "a.canary.test.ts"), "// canary-scope: src/a.ts\n");
    writeFileSync(join(dir, "test", "b.test.ts"), "");
    writeFileSync(join(dir, "test", "sub", "c.canary.test.ts"), "");
    const found = discoverCanaries(dir);
    expect(found).toContain(join("test", "a.canary.test.ts"));
    expect(found).toContain(join("test", "sub", "c.canary.test.ts"));
    expect(found).not.toContain(join("test", "b.test.ts"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverCanaries: default lister returns [] when test/ absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "vf-canary-"));
  try {
    expect(discoverCanaries(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("canaryForUnit: matches canary whose scope overlaps the unit scope", () => {
  const match = canaryForUnit(
    { name: "feature-x", scope: ["src/feature/x.ts"] } as never,
    ["test/feature/x.canary.test.ts"],
    { readCanaryScope: () => ["src/feature/x.ts"] },
  );
  expect(match).toBe("test/feature/x.canary.test.ts");
});

test("canaryForUnit: no overlap → null", () => {
  const match = canaryForUnit(
    { name: "feature-y", scope: ["src/y.ts"] } as never,
    ["test/x.canary.test.ts"],
    { readCanaryScope: () => ["src/x.ts"] },
  );
  expect(match).toBeNull();
});

test("canaryForUnit: unit with no scope → null", () => {
  const match = canaryForUnit({ name: "z" } as never, ["test/x.canary.test.ts"], {
    readCanaryScope: () => ["src/x.ts"],
  });
  expect(match).toBeNull();
});

test("canaryForUnit: default scope reader parses `// canary-scope:` header", () => {
  const dir = mkdtempSync(join(tmpdir(), "vf-canary-"));
  try {
    const file = join(dir, "x.canary.test.ts");
    writeFileSync(file, "// canary-scope: src/x.ts, src/y.ts\nimport ...");
    const match = canaryForUnit({ name: "x", scope: ["src/y.ts"] } as never, [file]);
    expect(match).toBe(file);
    // A file with no header → no scope → no match.
    const bare = join(dir, "bare.canary.test.ts");
    writeFileSync(bare, "no header here");
    expect(canaryForUnit({ name: "x", scope: ["src/x.ts"] } as never, [bare])).toBeNull();
    // A missing file → [] scope → no match.
    expect(
      canaryForUnit({ name: "x", scope: ["src/x.ts"] } as never, [join(dir, "gone.ts")]),
    ).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
