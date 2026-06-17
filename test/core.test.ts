import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readVersion } from "../src/core.js";

describe("core.readVersion (test seam)", () => {
  test("readVersion: existsSync throws → returns '0.0.0' (line 19-20)", () => {
    // Inject a throwing existsSync → the try block throws → catch fires → fallback.
    const result = readVersion({
      existsSync: () => {
        throw new Error("disk on fire");
      },
    });
    expect(result).toBe("0.0.0");
  });

  test("readVersion: readFileSync throws → returns '0.0.0' (line 19-20)", () => {
    const result = readVersion({
      existsSync: () => true,
      readFileSync: () => {
        throw new Error("read failure");
      },
    });
    expect(result).toBe("0.0.0");
  });

  test("readVersion: JSON.parse throws → returns '0.0.0' (line 19-20)", () => {
    const result = readVersion({
      existsSync: () => true,
      readFileSync: () => "not json {",
    });
    expect(result).toBe("0.0.0");
  });

  test("readVersion: no package.json found → returns '0.0.0'", () => {
    const result = readVersion({ existsSync: () => false });
    expect(result).toBe("0.0.0");
  });

  test("readVersion: returns version when found", () => {
    const result = readVersion({
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ version: "9.9.9" }),
    });
    expect(result).toBe("9.9.9");
  });
});

import {
  chmodSync,
  existsSync,
  writeFileSync as fsWriteFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSafe } from "../src/core.js";

describe("core.writeFileSafe (atomic writeFileSafe)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vf-wfs-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("writeFileSafe: creates the target file with content + trailing newline", () => {
    const target = join(dir, "state.json");
    writeFileSafe(target, '{"a":1}');
    expect(readFileSync(target, "utf8")).toBe('{"a":1}\n');
  });

  test("writeFileSafe: does not double the trailing newline if content already ends with one", () => {
    const target = join(dir, "state.json");
    writeFileSafe(target, '{"a":1}\n');
    expect(readFileSync(target, "utf8")).toBe('{"a":1}\n');
  });

  test("writeFileSafe: atomic — leaves no half-written file when previous content existed", () => {
    const target = join(dir, "state.json");
    writeFileSafe(target, '{"v":1}\n');
    writeFileSafe(target, '{"v":2}\n');
    expect(readFileSync(target, "utf8")).toBe('{"v":2}\n');
  });

  test("writeFileSafe: atomic — no .tmp-* files left behind after a successful write", () => {
    const target = join(dir, "nested", "state.json");
    writeFileSafe(target, '{"a":1}');
    const leftover = readdirSync(join(dir, "nested")).filter((f) => f.includes(".tmp-"));
    expect(leftover).toEqual([]);
  });

  test("writeFileSafe: creates missing parent directories recursively", () => {
    const target = join(dir, "a", "b", "c", "state.json");
    writeFileSafe(target, '{"x":42}');
    expect(readFileSync(target, "utf8")).toBe('{"x":42}\n');
  });

  test("writeFileSafe: corrupted in-flight .tmp-* does NOT corrupt the target (SIGKILL simulation)", () => {
    // Simulate a crashed previous write: the .tmp-* file is half-written garbage.
    // The new write should overwrite the .tmp-* and rename — never touching the previous
    // target content.
    const target = join(dir, "state.json");
    writeFileSafe(target, '{"previous":true}\n');
    // Plant a corrupted tmp file from a prior crash
    const orphan = `${target}.tmp-${process.pid}-${Date.now() - 1}`;
    fsWriteFileSync(orphan, "{ half-written garbage");
    // A subsequent successful write must NOT have left the target empty.
    writeFileSafe(target, '{"new":true}\n');
    expect(readFileSync(target, "utf8")).toBe('{"new":true}\n');
  });

  test("writeFileSafe: SIGKILL during writeFileSync leaves the previous target intact (atomic)", () => {
    // This is the regression test for the original bug: a SIGKILL between the open-truncate and
    // the final write used to leave the target file EMPTY (0 bytes). With the temp+rename fix,
    // the target is never truncated until the rename, so a mid-write crash preserves the prior
    // content on disk.
    const target = join(dir, "state.json");
    writeFileSafe(target, '{"previous":true}\n');
    // Now simulate a SIGKILL on the *next* write by having writeFileSync throw on the tmp file.
    // The previous target content must remain intact.
    expect(() =>
      writeFileSafe(target, '{"new":true}', {
        writeFileSync: () => {
          throw new Error("SIGKILL: process killed mid-write");
        },
      }),
    ).toThrow("SIGKILL");
    // The previous target is preserved — NOT truncated to 0 bytes (the original bug).
    expect(readFileSync(target, "utf8")).toBe('{"previous":true}\n');
  });

  test("writeFileSafe: created file has 0o600 permissions (CWE-732, POSIX only)", () => {
    // SECURITY: writeFileSafe writes to a temp file then renames. The
    // temp file is created with the process umask (typically 0o644,
    // world-readable). The renamed target inherits the temp's mode.
    // For files that may contain secrets (settings, evidence, API
    // tokens) the file MUST be 0o600 (owner read/write only) to
    // prevent other local users on a multi-user system from reading
    // them. POSIX-only assertion; on Windows the chmod call is a
    // best-effort no-op so we skip.
    if (process.platform === "win32") return;
    const target = join(dir, "settings.json");
    writeFileSafe(target, '{"apiKey":"secret"}');
    const mode = statSync(target).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("writeFileSafe: 0o600 applies to NESTED target too (no inheritance from parent dir)", () => {
    // The CWE-732 fix must chmod the temp file BEFORE the rename
    // regardless of how deep the target lives in the tree. A
    // regression that only chmods the parent dir (or skips on
    // nested paths) would fail this test.
    if (process.platform === "win32") return;
    const target = join(dir, "a", "b", "c", "secret.json");
    writeFileSafe(target, '{"x":1}');
    const mode = statSync(target).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("writeFileSafe: 0o600 applies even when previous file had looser permissions (overwrite)", () => {
    // A pre-existing target file may have been created with default
    // permissions before this fix landed. The new write must tighten
    // the mode to 0o600, not leave it at 0o644.
    if (process.platform === "win32") return;
    const target = join(dir, "settings.json");
    fsWriteFileSync(target, '{"old":true}\n');
    chmodSync(target, 0o644);
    expect(statSync(target).mode & 0o777).toBe(0o644);
    writeFileSafe(target, '{"new":true}');
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  test("writeFileSafe: renameSync failure throws but tmp is left for inspection", () => {
    // If rename fails (e.g., target is on a read-only mount), the caller sees the error and
    // the tmp file remains on disk for debugging — the target is never touched.
    const target = join(dir, "state.json");
    fsWriteFileSync(target, '{"previous":true}\n');
    expect(() =>
      writeFileSafe(target, '{"new":true}', {
        renameSync: () => {
          throw new Error("EROFS: read-only filesystem");
        },
      }),
    ).toThrow("EROFS");
    // The previous target is intact.
    expect(readFileSync(target, "utf8")).toBe('{"previous":true}\n');
  });
});
