import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPolicy, handlePolicyRoute, previewPolicy } from "../src/server/policy-route.js";
import { type VibeSettings, readSettings, writeSettings } from "../src/settings.js";
import { DEFAULT_TYPESAFE_SETTINGS } from "../src/typesafe-settings.js";

const current = {
  envPolicy: { deny: ["TOKEN"], allow: ["PATH"] },
  hooks: { templates: ["protect-secrets"], custom: [] },
} as unknown as VibeSettings;
const candidate = {
  envPolicy: { deny: [], allow: ["HOME", "PATH"] },
  hooks: { templates: [], custom: [] },
};

const request = (body: unknown) =>
  new Request("http://localhost", { method: "POST", body: JSON.stringify(body) });

const PREVIEW_KEYS = ["id", "diff", "relaxation"];

describe("policy routes", () => {
  test("preview does not write; apply requires opaque preview and writes once", async () => {
    const writes: unknown[] = [];
    const previewResponse = await previewPolicy("repo", request(candidate), {
      read: () => current,
      write: (_repo, next) => {
        writes.push(next);
        return current;
      },
    });
    const preview = (await previewResponse.json()) as { id: string };
    expect(writes).toEqual([]);
    const invalid = applyPolicy(
      "repo",
      { previewId: preview.id, confirmationText: "wrong" },
      { read: () => current, write: () => current },
    );
    expect(invalid.status).toBe(400);
    const response = applyPolicy(
      "repo",
      { previewId: preview.id, confirmationText: "ALLOW POLICY RELAXATION" },
      {
        read: () => current,
        write: (_repo, next) => {
          writes.push(next);
          return { ...current, ...next };
        },
        audit: () => true,
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(writes).toEqual([candidate]);
  });

  test("audit failure rolls settings back and returns non-2xx", async () => {
    const writes: unknown[] = [];
    const preview = (await (
      await previewPolicy("repo-audit", request(candidate), {
        read: () => current,
        write: () => current,
      })
    ).json()) as { id: string };
    const response = applyPolicy(
      "repo-audit",
      { previewId: preview.id, confirmationText: "ALLOW POLICY RELAXATION" },
      {
        read: () => current,
        write: (_repo, next) => {
          writes.push(next);
          return { ...current, ...next };
        },
        audit: () => false,
      },
    );
    expect(response.status).toBe(500);
    // The restore is the pre-write snapshot, `current` - which was read before the apply - with the
    // repo named so the write is allowed to carry the System One block it holds. Stripping the block
    // instead (the previous behaviour) let a block that arrived with the request survive a write this
    // route reports as failed.
    expect(writes).toEqual([
      candidate,
      { ...current, envPolicy: current.envPolicy, hooks: current.hooks, expectRepo: "repo-audit" },
    ]);
  });

  test("preview returns exactly the public DTO keys, leaking no internal state", async () => {
    const response = await previewPolicy("repo-dto", request(candidate), {
      read: () => current,
      write: () => current,
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual([...PREVIEW_KEYS].sort());
    expect(typeof body.id).toBe("string");
    expect(Array.isArray(body.diff)).toBe(true);
    expect(typeof body.relaxation).toBe("boolean");
    for (const leaked of ["repo", "currentHash", "candidate", "createdAt", "consumed"])
      expect(leaked in body).toBe(false);
  });

  test("malformed JSON body returns 400 for both preview and apply", async () => {
    const malformed = new Request("http://localhost", {
      method: "POST",
      body: "{not-json",
    });
    const previewResponse = await previewPolicy("repo-bad", malformed, {
      read: () => current,
      write: () => current,
    });
    expect(previewResponse.status).toBe(400);
    const applyResponse = await handlePolicyRoute("repo-bad", "/api/settings/apply", malformed);
    expect(applyResponse?.status).toBe(400);
    expect(await applyResponse?.json()).toEqual({ error: "invalid JSON body" });
  });

  test("settings write failure returns 500 and audit never runs", async () => {
    const audited: unknown[] = [];
    const preview = (await (
      await previewPolicy("repo-wfail", request(candidate), {
        read: () => current,
        write: () => current,
      })
    ).json()) as { id: string };
    const response = applyPolicy(
      "repo-wfail",
      { previewId: preview.id, confirmationText: "ALLOW POLICY RELAXATION" },
      {
        read: () => current,
        write: () => {
          throw new Error("disk error");
        },
        audit: () => {
          audited.push("called");
          return true;
        },
      },
    );
    expect(response.status).toBe(500);
    expect(audited).toEqual([]);
  });

  test("apply receives non-policy settings and writes once (merged policy + settings)", async () => {
    const base = { ...current, memory: false, notifications: true } as unknown as VibeSettings;
    const writes: unknown[] = [];
    const preview = (await (
      await previewPolicy("repo-merge", request(candidate), {
        read: () => base,
        write: () => base,
      })
    ).json()) as { id: string };
    const response = applyPolicy(
      "repo-merge",
      {
        previewId: preview.id,
        confirmationText: "ALLOW POLICY RELAXATION",
        settings: { memory: true, notifications: false },
      },
      {
        read: () => base,
        write: (_repo, next) => {
          writes.push(next);
          return { ...base, ...next };
        },
        audit: () => true,
      },
    );
    expect(response.status).toBe(200);
    // Single server write: non-policy settings merged with the approved policy candidate.
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({ ...candidate, memory: true, notifications: false });
  });

  test("apply rejects settings containing policy keys", async () => {
    const preview = (await (
      await previewPolicy("repo-rej", request(candidate), {
        read: () => current,
        write: () => current,
      })
    ).json()) as { id: string };
    const withEnv = applyPolicy(
      "repo-rej",
      {
        previewId: preview.id,
        confirmationText: "ALLOW POLICY RELAXATION",
        settings: { envPolicy: { allow: ["EVIL"] } },
      },
      { read: () => current, write: () => current, audit: () => true },
    );
    expect(withEnv.status).toBe(400);
    const withHooks = applyPolicy(
      "repo-rej",
      {
        previewId: preview.id,
        confirmationText: "ALLOW POLICY RELAXATION",
        settings: { hooks: { templates: [], custom: [] } },
      },
      { read: () => current, write: () => current, audit: () => true },
    );
    expect(withHooks.status).toBe(400);
  });

  test("audit rollback failure still returns a controlled 500", async () => {
    const preview = (
      await previewPolicy("repo-rollback", request(candidate), {
        read: () => current,
        write: () => current,
      })
    ).json();
    const id = ((await preview) as { id: string }).id;
    let writes = 0;
    const response = applyPolicy(
      "repo-rollback",
      { previewId: id, confirmationText: "ALLOW POLICY RELAXATION" },
      {
        read: () => current,
        write: () => {
          writes++;
          if (writes > 1) throw new Error("rollback disk error");
          return current;
        },
        audit: () => false,
      },
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "policy audit failed; rollback failed" });
  });

  test("an audit failure rolls the WHOLE snapshot back, on disk, block included", async () => {
    // Real `writeSettings` on a real repo. The previous version injected a stub `write`, so it pinned
    // the payload shape and never the disk outcome - and the shape it pinned was the bug: the
    // rollback STRIPPED the System One block, so a block that arrived with the request through
    // `nonPolicy` survived a write this route reports as failed, while every other piggy-backed
    // field was restored.
    const target = mkdtempSync(join(tmpdir(), "vf-policy-"));
    try {
      writeSettings(target, {
        expectRepo: target,
        typesafe: { ...DEFAULT_TYPESAFE_SETTINGS, enabled: true },
      });
      const seeded = readSettings(target);
      const deps = { read: readSettings, write: writeSettings, audit: () => false };
      const previewResponse = await previewPolicy(target, request(candidate), deps);
      const preview = (await previewResponse.json()) as { id: string };
      const response = applyPolicy(
        target,
        { previewId: preview.id, confirmationText: "ALLOW POLICY RELAXATION" },
        deps,
      );
      expect(response.status).toBe(500);
      // The write it is reporting as failed must not have changed the judge's configuration: it was
      // read before the apply, so the restore has to put it back exactly as it was.
      expect(readSettings(target).typesafe).toEqual(seeded.typesafe);
      expect(readSettings(target).envPolicy).toEqual(seeded.envPolicy);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("a payload carrying a System One block is refused: this route applies a policy", async () => {
    // `/api/settings/apply` consumes a preview that owns envPolicy/hooks only, so a block arriving
    // alongside it has no authorisation behind it. It used to be written.
    const withBlock = {
      envPolicy: { deny: [], allow: ["HOME", "PATH"] },
      hooks: { templates: [], custom: [] },
    };
    const previewResponse = await previewPolicy("repo-smuggle", request(candidate), {
      read: () => current,
      write: () => current,
    });
    const preview = (await previewResponse.json()) as { id: string };
    const response = applyPolicy(
      "repo-smuggle",
      {
        previewId: preview.id,
        confirmationText: "ALLOW POLICY RELAXATION",
        settings: { typesafe: { enabled: true }, expectRepo: "repo-smuggle" },
      },
      { read: () => current, write: () => current },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("/api/settings");
    void withBlock;
  });
});
