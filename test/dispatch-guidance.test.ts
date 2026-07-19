import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyGuidance, writeGuidance } from "../src/dispatch/guidance.js";

const REPO = "/repo";

describe("writeGuidance — append pre-dispatch guidance (#526 item 3)", () => {
  test("appends to .vibeflow/guidance/<unit>.md via injected writer (no real FS)", () => {
    const calls: { path: string; content: string }[] = [];
    writeGuidance("my-unit", "focus on edge cases", {
      base: REPO,
      appendFile: (path, content) => calls.push({ path, content }),
    });
    expect(calls).toEqual([
      { path: join(REPO, ".vibeflow", "guidance", "my-unit.md"), content: "focus on edge cases\n" },
    ]);
  });

  test("sanitizes an untrusted unit name (path-traversal defense)", () => {
    const calls: { path: string; content: string }[] = [];
    writeGuidance("../../etc/passwd", "x", {
      base: REPO,
      appendFile: (path, content) => calls.push({ path, content }),
    });
    expect(calls[0]?.path).toBe(join(REPO, ".vibeflow", "guidance", "etc-passwd.md"));
  });

  test("preserves a trailing newline the caller already supplied", () => {
    const calls: { path: string; content: string }[] = [];
    writeGuidance("u", "line\n", {
      base: "/r",
      appendFile: (p, c) => calls.push({ path: p, content: c }),
    });
    expect(calls[0]?.content).toBe("line\n");
  });
});

describe("applyGuidance — prepend + clear before dispatch (#526 item 3)", () => {
  test("guidance present → prepended to the prompt, then the file is cleared", () => {
    let cleared = "";
    const prompt = applyGuidance("u1", "ORIGINAL PROMPT", {
      base: REPO,
      readGuidance: (path) => {
        expect(path).toBe(join(REPO, ".vibeflow", "guidance", "u1.md"));
        return "STEER: use the new API";
      },
      clearGuidance: (path) => {
        cleared = path;
      },
    });
    expect(prompt).toBe("STEER: use the new API\n\nORIGINAL PROMPT");
    expect(cleared).toBe(join(REPO, ".vibeflow", "guidance", "u1.md"));
  });

  test("guidance absent → prompt UNCHANGED, nothing cleared (back-compat)", () => {
    let cleared = false;
    const prompt = applyGuidance("u1", "ORIGINAL PROMPT", {
      base: REPO,
      readGuidance: () => undefined,
      clearGuidance: () => {
        cleared = true;
      },
    });
    expect(prompt).toBe("ORIGINAL PROMPT");
    expect(cleared).toBe(false);
  });

  test("sanitizes the unit name when resolving the guidance path", () => {
    const seen: string[] = [];
    applyGuidance("../evil", "p", {
      base: REPO,
      readGuidance: (path) => {
        seen.push(path);
        return undefined;
      },
    });
    expect(seen[0]).toBe(join(REPO, ".vibeflow", "guidance", "evil.md"));
  });
});

describe("guidance default FS seams (real tmpdir round-trip)", () => {
  test("writeGuidance → applyGuidance reads, prepends, and deletes the real file", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-guidance-"));
    try {
      writeGuidance("u1", "STEER NOTE", { base: dir });
      const file = join(dir, ".vibeflow", "guidance", "u1.md");
      expect(readFileSync(file, "utf8")).toBe("STEER NOTE\n");
      const prompt = applyGuidance("u1", "BODY", { base: dir });
      expect(prompt).toBe("STEER NOTE\n\nBODY");
      // file consumed exactly once
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("applyGuidance with no file present → prompt unchanged (default reader)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-guidance-none-"));
    try {
      expect(applyGuidance("absent", "BODY", { base: dir })).toBe("BODY");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
