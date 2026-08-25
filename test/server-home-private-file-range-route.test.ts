import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHomePrivateFileRangeRoute } from "../src/server/home-private-file-range-route.js";

test("home private file range route stages an exact repo-relative excerpt", async () => {
  const repo = await mkdtemp(join(tmpdir(), "vf-home-private-range-"));
  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src/example.ts"), "one\r\ntwo\nthree", { mode: 0o600 });
    const staged: Array<Record<string, unknown>> = [];
    const response = await handleHomePrivateFileRangeRoute(
      {
        createId: () =>
          "vf-file-range-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        stage: (input) => {
          staged.push(input as unknown as Record<string, unknown>);
          return {
            schema_version: "1.0",
            handoff_id: input.handoff_id,
            handoff_record_digest:
              "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            repo_relative_path: input.repo_relative_path,
            start_line: input.start_line,
            end_line: input.end_line,
            line_count: input.end_line - input.start_line + 1,
            staged_at: input.staged_at,
            expires_at: "2026-08-25T00:10:00.000Z",
          };
        },
      },
      repo,
      new Request("http://vf.test/api/home/private-file-range-handoffs", {
        method: "POST",
        body: JSON.stringify({ path: "src/example.ts", start_line: 1, end_line: 2 }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBe(202);
    expect(staged).toEqual([
      {
        handoff_id:
          "vf-file-range-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        repo_relative_path: "src/example.ts",
        start_line: 1,
        end_line: 2,
        content: "one\r\ntwo\n",
        staged_at: expect.any(String),
      },
    ]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("home private file range route rejects traversal before staging", async () => {
  const repo = await mkdtemp(join(tmpdir(), "vf-home-private-range-"));
  try {
    const response = await handleHomePrivateFileRangeRoute(
      {
        createId: () =>
          "vf-file-range-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        stage: () => {
          throw new Error("stage should not be called");
        },
      },
      repo,
      new Request("http://vf.test/api/home/private-file-range-handoffs", {
        method: "POST",
        body: JSON.stringify({ path: "../outside.txt", start_line: 1, end_line: 2 }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBe(403);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("home private file range route rejects non-canonical aliases and symlinks", async () => {
  const repo = await mkdtemp(join(tmpdir(), "vf-home-private-range-"));
  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src/example.ts"), "one\n", { mode: 0o600 });
    symlinkSync(join(repo, "src/example.ts"), join(repo, "src/link.ts"));
    const authority = {
      createId: () =>
        "vf-file-range-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      stage: () => {
        throw new Error("stage should not be called");
      },
    };
    for (const path of [
      "./src/example.ts",
      "src/../src/example.ts",
      "src//example.ts",
      "src/link.ts",
    ]) {
      const response = await handleHomePrivateFileRangeRoute(
        authority,
        repo,
        new Request("http://vf.test/api/home/private-file-range-handoffs", {
          method: "POST",
          body: JSON.stringify({ path, start_line: 1, end_line: 1 }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(response.status).toBe(403);
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("home private file range route rejects invalid UTF-8 and bounds bytes while reading", async () => {
  const repo = await mkdtemp(join(tmpdir(), "vf-home-private-range-"));
  try {
    writeFileSync(join(repo, "invalid.txt"), Buffer.from([0xc3, 0x28]), { mode: 0o600 });
    writeFileSync(join(repo, "large.txt"), Buffer.alloc(1024 * 1024 + 1, 0x61), { mode: 0o600 });
    const authority = {
      createId: () =>
        "vf-file-range-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      stage: () => {
        throw new Error("stage should not be called");
      },
    };
    const request = (path: string) =>
      new Request("http://vf.test/api/home/private-file-range-handoffs", {
        method: "POST",
        body: JSON.stringify({ path, start_line: 1, end_line: 1 }),
        headers: { "content-type": "application/json" },
      });
    expect(
      (await handleHomePrivateFileRangeRoute(authority, repo, request("invalid.txt"))).status,
    ).toBe(422);
    expect(
      (await handleHomePrivateFileRangeRoute(authority, repo, request("large.txt"))).status,
    ).toBe(413);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
