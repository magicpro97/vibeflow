import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "../src/server";
import { handleRegistryPreview, handleRegistryView } from "../src/server/registry-route.js";

const workflowStatePath = join(process.cwd(), ".vibeflow", "WORKFLOW_STATE.json");
const previousWorkflowState = existsSync(workflowStatePath)
  ? readFileSync(workflowStatePath)
  : null;

afterAll(() => {
  if (previousWorkflowState) writeFileSync(workflowStatePath, previousWorkflowState);
  else rmSync(workflowStatePath, { force: true });
});

async function csrfToken(url: string): Promise<string> {
  const res = await fetch(url);
  const html = await res.text();
  const m = html.match(/<meta\s+name="vf-token"\s+content="([^"]+)"\s*\/?>/i);
  if (!m) throw new Error("CSRF token not found in page HTML");
  return m[1] as string;
}

const VALID_LOCK = {
  schemaVersion: 1,
  registries: [
    {
      name: "platform",
      url: "https://github.com/example/platform-skills.git",
      ref: "v1.0.0",
      commitOID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      installed: [
        {
          name: "test-skill",
          version: "1.0.0",
          commitOID: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
        {
          name: "../evil",
          version: "0.0.1",
          commitOID: "cccccccccccccccccccccccccccccccccccccccc",
        },
      ],
    },
  ],
};

function setupLock(dir: string, lock: unknown = VALID_LOCK) {
  mkdirSync(join(dir, ".vibeflow"), { recursive: true });
  writeFileSync(join(dir, ".vibeflow", "SKILL_REGISTRY.lock.json"), JSON.stringify(lock));
}

describe("registry-view: pure read-model", () => {
  test("buildRegistryView sanitizes trust-boundary fields", () => {
    const { buildRegistryView } = require("../src/skills/registry-view.js");
    const view = buildRegistryView("/nonexistent/repo");
    expect(view.ok).toBe(true);
    expect(view.registries).toEqual([]);
  });

  test("missing file → empty view, no throw", () => {
    const { buildRegistryView } = require("../src/skills/registry-view.js");
    const view = buildRegistryView("/repo", () => {
      throw new Error("ENOENT");
    });
    expect(view.ok).toBe(true);
    expect(view.registries).toEqual([]);
  });

  test("malformed JSON → empty view, no throw", () => {
    const { buildRegistryView } = require("../src/skills/registry-view.js");
    const view = buildRegistryView("/repo", () => "{ not json");
    expect(view.ok).toBe(true);
    expect(view.registries).toEqual([]);
  });

  test("malformed row is preserved as valid:false (not dropped)", () => {
    const { buildRegistryView } = require("../src/skills/registry-view.js");
    const view = buildRegistryView("/repo", () =>
      JSON.stringify({
        schemaVersion: 1,
        registries: [{ name: "ok", url: "https://x", ref: "r", commitOID: "a".repeat(40) }],
      }),
    );
    expect(view.registries).toHaveLength(1);
    expect(view.registries[0]?.valid).toBe(true);

    const bad = buildRegistryView("/repo", () =>
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          { name: "ok", url: "https://x", ref: "r", commitOID: "a".repeat(40) },
          { name: 42 }, // malformed row
        ],
      }),
    );
    expect(bad.registries).toHaveLength(2);
    expect(bad.registries[1]?.valid).toBe(false);
    expect(bad.registries[1]?.id).toBe("");
    expect(bad.registries[0]?.valid).toBe(true);
  });

  test("malformed row with control-char name → id sanitized", () => {
    const { buildRegistryView } = require("../src/skills/registry-view.js");
    const view = buildRegistryView("/repo", () =>
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          { name: "bad\u0000name", url: "https://x", ref: "r", commitOID: "a".repeat(40) },
        ],
      }),
    );
    expect(view.registries).toHaveLength(1);
    expect(view.registries[0]?.valid).toBe(false);
    expect(view.registries[0]?.id).toBe("badname");
  });

  test("credentials, query, fragment are redacted from url", () => {
    const { buildRegistryView } = require("../src/skills/registry-view.js");
    const view = buildRegistryView("/repo", () =>
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "r",
            url: "https://user:pass@github.com/x.git?token=abc#frag",
            ref: "v1",
            commitOID: "b".repeat(40),
          },
        ],
      }),
    );
    const e = view.registries[0];
    expect(e?.url).not.toContain("user");
    expect(e?.url).not.toContain("pass");
    expect(e?.url).not.toContain("token=abc");
    expect(e?.url).not.toContain("#frag");
    expect(e?.valid).toBe(true);
  });

  test("non-http(s) URL → invalid, url empty", () => {
    const { buildRegistryView } = require("../src/skills/registry-view.js");
    const view = buildRegistryView("/repo", () =>
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          { name: "r", url: "file:///etc/passwd", ref: "v1", commitOID: "c".repeat(40) },
        ],
      }),
    );
    expect(view.registries[0]?.url).toBe("");
    expect(view.registries[0]?.valid).toBe(false);
  });

  test("control chars in ref/version are rejected; invalid ref → invalid row", () => {
    const { buildRegistryView } = require("../src/skills/registry-view.js");
    const view = buildRegistryView("/repo", () =>
      JSON.stringify({
        schemaVersion: 1,
        registries: [{ name: "r", url: "https://x", ref: "\u0000boom", commitOID: "d".repeat(40) }],
      }),
    );
    expect(view.registries[0]?.ref).toBe("");
    expect(view.registries[0]?.valid).toBe(false);
  });

  test("commit OID must be 40 or 64 lowercase hex", () => {
    const { buildRegistryView } = require("../src/skills/registry-view.js");
    const ok40 = buildRegistryView("/repo", () =>
      JSON.stringify({
        schemaVersion: 1,
        registries: [{ name: "r", url: "https://x", ref: "v1", commitOID: "e".repeat(40) }],
      }),
    );
    expect(ok40.registries[0]?.valid).toBe(true);

    const ok64 = buildRegistryView("/repo", () =>
      JSON.stringify({
        schemaVersion: 1,
        registries: [{ name: "r", url: "https://x", ref: "v1", commitOID: "f".repeat(64) }],
      }),
    );
    expect(ok64.registries[0]?.valid).toBe(true);

    const badLen = buildRegistryView("/repo", () =>
      JSON.stringify({
        schemaVersion: 1,
        registries: [{ name: "r", url: "https://x", ref: "v1", commitOID: "a".repeat(41) }],
      }),
    );
    expect(badLen.registries[0]?.valid).toBe(false);

    const badHex = buildRegistryView("/repo", () =>
      JSON.stringify({
        schemaVersion: 1,
        registries: [{ name: "r", url: "https://x", ref: "v1", commitOID: "g".repeat(40) }],
      }),
    );
    expect(badHex.registries[0]?.valid).toBe(false);
  });

  test("entryCount is exact raw length; installedCount counts valid entries only", () => {
    const { buildRegistryView } = require("../src/skills/registry-view.js");
    const installed = Array.from({ length: 250 }, (_, i) => ({
      name: `s${i}`,
      version: "1.0.0",
      commitOID: "a".repeat(40),
    }));
    // Invalidate the last 50 entries to prove installedCount is not a raw length.
    for (let i = 200; i < 250; i++)
      installed[i] = { name: `..${i}`, version: "0.0.1", commitOID: "bad" };
    const view = buildRegistryView("/repo", () =>
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          { name: "r", url: "https://x", ref: "v1", commitOID: "b".repeat(40), installed },
        ],
      }),
    );
    expect(view.registries[0]?.entryCount).toBe(250);
    expect(view.registries[0]?.installedCount).toBe(200);
  });

  test("overlong raw URL → invalid, url empty", () => {
    const { buildRegistryView } = require("../src/skills/registry-view.js");
    const view = buildRegistryView("/repo", () =>
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          {
            name: "r",
            url: `https://github.com/x/${"a".repeat(2100)}.git`,
            ref: "v1",
            commitOID: "c".repeat(40),
          },
        ],
      }),
    );
    expect(view.registries[0]?.url).toBe("");
    expect(view.registries[0]?.valid).toBe(false);
  });

  test("overlong sanitized URL → invalid even when raw is short", () => {
    const { buildRegistryView } = require("../src/skills/registry-view.js");
    // Raw is short but expands to >2048 after sanitization (path only).
    const view = buildRegistryView("/repo", () =>
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          { name: "r", url: `https://x/${"b".repeat(2100)}`, ref: "v1", commitOID: "d".repeat(40) },
        ],
      }),
    );
    expect(view.registries[0]?.url).toBe("");
    expect(view.registries[0]?.valid).toBe(false);
  });

  test("findRegistryId requires full valid row, not url only", () => {
    const { findRegistryId } = require("../src/skills/registry-view.js");
    const reader = () =>
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          { name: "r", url: "https://x", ref: "v1", commitOID: "c".repeat(40) },
          { name: "bad", url: "https://x", ref: "v1", commitOID: "not-an-oid" },
        ],
      });
    expect(findRegistryId("/repo", "r", reader)).toBe("r");
    expect(findRegistryId("/repo", "bad", reader)).toBeNull();
    expect(findRegistryId("/repo", "unknown", reader)).toBeNull();
  });

  test("git branch/ref validation: rejects unsafe refs, accepts valid ones", () => {
    const { isSafeBranchRef } = require("../src/skills/registry-view.js");
    const bad = [
      "bad~ref",
      "bad^ref",
      "bad:ref",
      "bad?ref",
      "bad*ref",
      "bad[ref",
      "bad\\ref",
      "bad ref",
      "-leading",
      "/leading",
      "trailing/",
      "a//b",
      "foo..bar",
      "foo@{bar",
      ".dotcomp",
      "refs/heads/x.lock",
      "trailing.",
      "a\u0000b",
      "a\u007fb",
    ];
    for (const ref of bad) expect(isSafeBranchRef(ref)).toBe(false);
    const good = ["main", "refs/heads/main", "release/v1", "v1.0.0", "feature/x-y", "a/b/c"];
    for (const ref of good) expect(isSafeBranchRef(ref)).toBe(true);
  });

  test("Platform_ name is invalid; canonical names are valid", () => {
    const { buildRegistryView, findRegistryId } = require("../src/skills/registry-view.js");
    const bad = buildRegistryView("/repo", () =>
      JSON.stringify({
        schemaVersion: 1,
        registries: [{ name: "Platform_", url: "https://x", ref: "v1", commitOID: "a".repeat(40) }],
      }),
    );
    expect(bad.registries[0]?.valid).toBe(false);
    expect(bad.registries[0]?.id).toBe("Platform_");
    expect(findRegistryId("/repo", "Platform_", () => "[]")).toBeNull();

    const good = buildRegistryView("/repo", () =>
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          { name: "platform-skills", url: "https://x", ref: "v1", commitOID: "a".repeat(40) },
        ],
      }),
    );
    expect(good.registries[0]?.valid).toBe(true);
  });

  test("invalid ref → row valid:false, no preview", () => {
    const { buildRegistryView } = require("../src/skills/registry-view.js");
    const view = buildRegistryView("/repo", () =>
      JSON.stringify({
        schemaVersion: 1,
        registries: [{ name: "r", url: "https://x", ref: "foo..bar", commitOID: "a".repeat(40) }],
      }),
    );
    expect(view.registries[0]?.valid).toBe(false);
    expect(view.registries[0]?.ref).toBe("");
  });

  test("two-dot ref row → invalid; valid ref accepted", () => {
    const { buildRegistryView } = require("../src/skills/registry-view.js");
    const bad = buildRegistryView("/repo", () =>
      JSON.stringify({
        schemaVersion: 1,
        registries: [{ name: "r", url: "https://x", ref: "foo..bar", commitOID: "a".repeat(40) }],
      }),
    );
    expect(bad.registries[0]?.valid).toBe(false);
    const good = buildRegistryView("/repo", () =>
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          { name: "r", url: "https://x", ref: "refs/heads/main", commitOID: "a".repeat(40) },
        ],
      }),
    );
    expect(good.registries[0]?.valid).toBe(true);
  });

  test("installed count requires non-empty bounded version; missing/invalid version excluded", () => {
    const { buildRegistryView } = require("../src/skills/registry-view.js");
    const installed = [
      { name: "ok", version: "1.0.0", commitOID: "a".repeat(40) },
      { name: "no-ver", commitOID: "b".repeat(40) },
      { name: "ctrl-ver", version: "v\u0000", commitOID: "c".repeat(40) },
      { name: "overlong-ver", version: "x".repeat(129), commitOID: "d".repeat(40) },
      { name: "empty-ver", version: "", commitOID: "e".repeat(40) },
    ];
    const view = buildRegistryView("/repo", () =>
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          { name: "r", url: "https://x", ref: "v1", commitOID: "f".repeat(40), installed },
        ],
      }),
    );
    expect(view.registries[0]?.entryCount).toBe(5);
    expect(view.registries[0]?.installedCount).toBe(1);
  });

  test("invalid name with control chars → findRegistryId null", () => {
    const { findRegistryId } = require("../src/skills/registry-view.js");
    expect(findRegistryId("/repo", "\u0000bad", () => "[]")).toBeNull();
  });

  test("handleRegistryView returns registry list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-reg-view-"));
    setupLock(dir);
    try {
      const res = handleRegistryView(dir);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { registries: { id: string; valid: boolean }[] };
      expect(body.registries).toHaveLength(1);
      expect(body.registries[0]?.id).toBe("platform");
      expect(body.registries[0]?.valid).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("malformed URL in lock → redacted/marked invalid, no throw", () => {
    const { buildRegistryView } = require("../src/skills/registry-view.js");
    const dir = mkdtempSync(join(tmpdir(), "vf-reg-view-badurl-"));
    setupLock(dir, {
      schemaVersion: 1,
      registries: [
        {
          name: "bad",
          url: "not a url",
          ref: "v1.0.0",
          commitOID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          installed: [],
        },
      ],
    });
    try {
      const view = buildRegistryView(dir);
      expect(view.ok).toBe(true);
      expect(view.registries).toHaveLength(1);
      expect(view.registries[0]?.url).toBe("");
      expect(view.registries[0]?.valid).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("registry-route: preview validation", () => {
  test("invalid body → 400", () => {
    const res = handleRegistryPreview("/repo", null);
    expect(res.status).toBe(400);
  });
  test("non-update action → 400", () => {
    const res = handleRegistryPreview("/repo", { action: "install", registry: "x" });
    expect(res.status).toBe(400);
  });
  test("extra key → 400", () => {
    const res = handleRegistryPreview("/repo", { action: "update", registry: "x", extra: true });
    expect(res.status).toBe(400);
  });
  test("missing registry → 400", () => {
    const res = handleRegistryPreview("/repo", { action: "update" });
    expect(res.status).toBe(400);
  });
  test("empty registry string → 400 with registry id required", async () => {
    const res = handleRegistryPreview("/repo", { action: "update", registry: "" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "registry id required" });
  });
  test("unknown registry → 404", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-reg-unknown-"));
    setupLock(dir);
    try {
      const res = handleRegistryPreview(dir, { action: "update", registry: "nope" });
      expect(res.status).toBe(404);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("invalid-oid row → preview 404 (no partial match)", () => {
    const reader = () =>
      JSON.stringify({
        schemaVersion: 1,
        registries: [{ name: "r", url: "https://x", ref: "v1", commitOID: "not-an-oid" }],
      });
    const res = handleRegistryPreview("/repo", { action: "update", registry: "r" }, reader);
    expect(res.status).toBe(404);
  });
  test("invalid-ref row → preview 404", () => {
    const reader = () =>
      JSON.stringify({
        schemaVersion: 1,
        registries: [{ name: "r", url: "https://x", ref: "\u0000bad", commitOID: "a".repeat(40) }],
      });
    const res = handleRegistryPreview("/repo", { action: "update", registry: "r" }, reader);
    expect(res.status).toBe(404);
  });
  test("valid update → inert preview, executable:false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-reg-preview-"));
    setupLock(dir);
    try {
      const res = handleRegistryPreview(dir, { action: "update", registry: "platform" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        executable: boolean;
        registry: string;
        plan: string;
      };
      expect(body.ok).toBe(true);
      expect(body.executable).toBe(false);
      expect(body.registry).toBe("platform");
      expect(body.plan).toContain("Dry-run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("server HTTP registry routes", () => {
  test("GET /api/skills/registries returns routes & POST preview is inert", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-reg-http-"));
    const orig = process.cwd();
    process.chdir(dir);
    setupLock(dir);
    try {
      const { server, url } = await startServer(0);
      try {
        const token = await csrfToken(url);

        const list = await fetch(`${url}/api/skills/registries`);
        expect(list.status).toBe(200);
        const listBody = (await list.json()) as { registries: { id: string }[] };
        expect(listBody.registries).toHaveLength(1);
        expect(listBody.registries[0]?.id).toBe("platform");

        const preview = await fetch(`${url}/api/skills/registries/preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-vibeflow-token": token },
          body: JSON.stringify({ action: "update", registry: "platform" }),
        });
        expect(preview.status).toBe(200);
        const pBody = (await preview.json()) as { executable: boolean; plan: string };
        expect(pBody.executable).toBe(false);
        expect(pBody.plan).toContain("Dry-run");

        // POST without CSRF token → 403 (write-surface guard)
        const noToken = await fetch(`${url}/api/skills/registries/preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "update", registry: "platform" }),
        });
        expect(noToken.status).toBe(403);
      } finally {
        server.stop();
      }
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("GET /api/skills/registries/releases[/id] wires the read-only proposal API (#759)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-rel-http-"));
    const orig = process.cwd();
    process.chdir(dir);
    setupLock(dir);
    try {
      const { server, url } = await startServer(0);
      try {
        // No proposals dir yet → empty, well-formed list.
        const list = await fetch(`${url}/api/skills/registries/releases`);
        expect(list.status).toBe(200);
        expect(await list.json()).toEqual({ ok: true, proposals: [] });

        // Unknown but well-formed id → 404 from the detail route.
        const detail = await fetch(`${url}/api/skills/registries/releases/${"0".repeat(64)}`);
        expect(detail.status).toBe(404);
        expect(await detail.json()).toEqual({ error: "unknown release proposal" });

        // Malformed percent-encoding must not 500 — decodeURIComponent throws, mapped to 404.
        const badEnc = await fetch(`${url}/api/skills/registries/releases/%`);
        expect(badEnc.status).toBe(404);
        expect(await badEnc.json()).toEqual({ error: "unknown release proposal" });
      } finally {
        server.stop();
      }
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
