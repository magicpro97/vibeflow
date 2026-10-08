import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleUpdateRun,
  handleUpdateStatus,
  updateStatusView,
} from "../src/server/routes-update.js";

const roots: string[] = [];
function repo(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `vf-update-${label}-`));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("updateStatusView", () => {
  test("is cache-only and reports servers + rollback from injected state", () => {
    const view = updateStatusView(repo("status"), {
      installed: "0.21.0",
      latest: "0.22.0",
      servers: [{ base: "/repo", pid: 1, port: 2, app_version: "0.20.0" }],
      state: { schema_version: 1, previous_version: "0.20.9", manager: "npm", at: 1 },
    });
    expect(view.upgrade_available).toBe(true);
    expect(view.stale_servers).toEqual([{ base: "/repo", pid: 1, version: "0.20.0" }]);
    expect(view.rollback).toEqual({ version: "0.20.9" });
  });
  test("no cache / no state degrade to nulls, not throws", () => {
    const view = updateStatusView(repo("empty"), {
      installed: "0.21.0",
      latest: null,
      servers: [],
      state: null,
    });
    expect(view.upgrade_available).toBe(false);
    expect(view.rollback).toBeNull();
    expect(view.stale_servers).toEqual([]);
  });
  test("handleUpdateStatus answers the JSON view", async () => {
    const res = handleUpdateStatus(repo("route"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; installed: string };
    expect(body.ok).toBe(true);
    expect(typeof body.installed).toBe("string");
  });
});

describe("handleUpdateRun", () => {
  const post = (body: string): Request =>
    new Request("http://127.0.0.1:7799/api/update/run", { method: "POST", body });
  const postJson = (body: unknown): Request => post(JSON.stringify(body));

  test("refuses when LAN-exposed (before reading the body)", async () => {
    const res = await handleUpdateRun({
      lanExposed: true,
      request: postJson({ action: "update" }),
    });
    expect(res.status).toBe(403);
  });
  test("rejects non-object, unknown-action, and non-JSON bodies before spawning", async () => {
    let spawned = 0;
    for (const body of [null, "x", [1], { action: "nuke" }]) {
      const res = await handleUpdateRun({
        lanExposed: false,
        request: postJson(body),
        spawnUpdate: () => {
          spawned++;
          return true;
        },
      });
      expect(res.status).toBe(400);
    }
    const raw = await handleUpdateRun({
      lanExposed: false,
      request: post("not json"),
      spawnUpdate: () => {
        spawned++;
        return true;
      },
    });
    expect(raw.status).toBe(400);
    expect(spawned).toBe(0);
  });
  test("an oversized body is refused without spawning", async () => {
    let spawned = 0;
    const res = await handleUpdateRun({
      lanExposed: false,
      request: post("x".repeat(70_000)),
      spawnUpdate: () => {
        spawned++;
        return true;
      },
    });
    expect(res.status).toBe(400);
    expect(spawned).toBe(0);
  });
  test("a non-UTF8 body is refused without spawning", async () => {
    let spawned = 0;
    const res = await handleUpdateRun({
      lanExposed: false,
      request: new Request("http://127.0.0.1:7799/api/update/run", {
        method: "POST",
        body: new Uint8Array([0xff, 0xfe]),
      }),
      spawnUpdate: () => {
        spawned++;
        return true;
      },
    });
    expect(res.status).toBe(400);
    expect(spawned).toBe(0);
  });
  test("spawns vf update / vf update --rollback detached and reports started", async () => {
    const calls: string[][] = [];
    for (const [action, expected] of [
      ["update", ["update"]],
      ["rollback", ["update", "--rollback"]],
    ] as const) {
      const res = await handleUpdateRun({
        lanExposed: false,
        request: postJson({ action }),
        spawnUpdate: (args) => {
          calls.push([...args]);
          return true;
        },
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { started: boolean }).started).toBe(true);
      expect(calls.at(-1)).toEqual([...expected]);
    }
  });
  test("a failed spawn answers 500, not a silent ok", async () => {
    const res = await handleUpdateRun({
      lanExposed: false,
      request: postJson({ action: "update" }),
      spawnUpdate: () => false,
    });
    expect(res.status).toBe(500);
  });
  test("passes the authoritative repo cwd through to the spawn seam", async () => {
    let seenCwd: string | undefined;
    const res = await handleUpdateRun({
      lanExposed: false,
      request: postJson({ action: "update" }),
      cwd: "/some/repo",
      spawnUpdate: (_args, cwd) => {
        seenCwd = cwd;
        return true;
      },
    });
    expect(res.status).toBe(200);
    expect(seenCwd).toBe("/some/repo");
  });
});
