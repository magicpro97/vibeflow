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
  test("refuses when LAN-exposed", async () => {
    const res = handleUpdateRun({ lanExposed: true, body: { action: "update" } });
    expect(res.status).toBe(403);
  });
  test("rejects non-object and unknown-action bodies before spawning", async () => {
    let spawned = 0;
    for (const body of [null, "x", [1], { action: "nuke" }]) {
      const res = handleUpdateRun({
        lanExposed: false,
        body,
        spawnUpdate: () => {
          spawned++;
          return true;
        },
      });
      expect(res.status).toBe(400);
    }
    expect(spawned).toBe(0);
  });
  test("spawns vf update / vf update --rollback detached and reports started", async () => {
    const calls: string[][] = [];
    for (const [action, expected] of [
      ["update", ["update"]],
      ["rollback", ["update", "--rollback"]],
    ] as const) {
      const res = handleUpdateRun({
        lanExposed: false,
        body: { action },
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
    const res = handleUpdateRun({
      lanExposed: false,
      body: { action: "update" },
      spawnUpdate: () => false,
    });
    expect(res.status).toBe(500);
  });
  test("passes the authoritative repo cwd through to the spawn seam", async () => {
    let seenCwd: string | undefined;
    const res = handleUpdateRun({
      lanExposed: false,
      body: { action: "update" },
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
