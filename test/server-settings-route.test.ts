import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSettingsRoute } from "../src/server/routes-settings.js";
import { readSettings } from "../src/settings.js";

const roots: string[] = [];

function repo(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `vf-settings-${label}-`));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("handleSettingsRoute", () => {
  test("refuses the payloads that need preview approval before writing anything", async () => {
    for (const payload of [{ envPolicy: {} }, { hooks: {} }]) {
      const res = handleSettingsRoute(repo("policy"), payload);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("policy changes require preview approval");
    }
  });

  test("writes when the client's expected repo IS the active repo", async () => {
    const active = repo("match");
    const res = handleSettingsRoute(active, {
      expectRepo: active,
      typesafe: { enabled: true },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; typesafe: { enabled: boolean } };
    expect(body.ok).toBe(true);
    // The response is the same redacted view the panel re-seeds from, so it must already
    // reflect what was written rather than the values the client sent.
    expect(body.typesafe.enabled).toBe(true);
    expect(readSettings(active).typesafe?.enabled).toBe(true);
  });

  test("refuses a save whose expected repo is not the active repo, and writes nothing", async () => {
    // The race this exists for: another client POSTed /api/detect between this tab's load and its
    // save, so the process-global active repo is now B while the form still describes A. The old
    // guard compared two client-side mirrors and could not see it.
    const active = repo("active");
    const described = repo("described");
    const res = handleSettingsRoute(active, {
      expectRepo: described,
      typesafe: { enabled: true },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("active repository changed");
    // Neither repo was touched: a refused save must not half-apply.
    expect(readSettings(active).typesafe?.enabled).toBeUndefined();
    expect(readSettings(described).typesafe?.enabled).toBeUndefined();
  });

  test("an absent or non-string expectRepo stays allowed, so the other panels keep working", async () => {
    for (const payload of [
      { typesafe: { enabled: true } },
      { expectRepo: 42, typesafe: { enabled: true } },
    ]) {
      const active = repo("absent");
      const res = handleSettingsRoute(active, payload);
      expect(res.status).toBe(200);
      expect(readSettings(active).typesafe?.enabled).toBe(true);
    }
  });
});
