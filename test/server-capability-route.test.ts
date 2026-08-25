import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityRuntimeError } from "../src/capabilities/operations/errors.js";
import { StaleCapabilityCursorErrorV1 } from "../src/capabilities/query/cursor.js";
import type {
  CapabilityDetailRequestV1,
  CapabilityQueryRequestV1,
} from "../src/capabilities/query/types.js";
import {
  activateProjectCapabilityAuthorityForVfInit,
  activateUserCapabilityAuthorityForTrustedInstall,
} from "../src/capabilities/source/index.js";
import type {
  CapabilityBrowserDetailResponseV1,
  CapabilityQueryResponseV1,
} from "../src/capabilities/wire/query.js";
import { canonicalJsonBytes } from "../src/durability/index.js";
import { startServer } from "../src/server.js";
import {
  type CapabilityRouteAuthorityV1,
  handleCapabilityRoute,
} from "../src/server/capability-route.js";

const queryResponse: CapabilityQueryResponseV1 = {
  schema_version: "1.0",
  items: [],
  next_cursor: null,
  source_watermark: `sha256:${"1".repeat(64)}`,
};

function authority(
  input: {
    authenticated?: boolean;
    query?: (request: CapabilityQueryRequestV1) => CapabilityQueryResponseV1;
    detail?: (request: CapabilityDetailRequestV1) => CapabilityBrowserDetailResponseV1;
  } = {},
): CapabilityRouteAuthorityV1 {
  return {
    sessions: { authorize: () => input.authenticated ?? true },
    capabilities: {
      query: input.query ?? (() => queryResponse),
      detail:
        input.detail ??
        (() => {
          throw new CapabilityRuntimeError("missing", "package-not-found");
        }),
    },
  };
}

describe("capability browser HTTP route", () => {
  test("startServer composes the lazy production scope router and preserves auth/no-store", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-capability-server-"));
    const projectRoot = join(root, "project");
    const userHomeRoot = join(root, "home");
    const userVibeflowRoot = join(userHomeRoot, ".vibeflow");
    mkdirSync(join(projectRoot, ".vibeflow"), { recursive: true });
    mkdirSync(userVibeflowRoot, { recursive: true });
    const settings = canonicalJsonBytes({ schema_version: "1.0", authority: null });
    writeFileSync(join(projectRoot, ".vibeflow", "SETTINGS.json"), settings);
    writeFileSync(join(userVibeflowRoot, "SETTINGS.json"), settings);
    activateProjectCapabilityAuthorityForVfInit(projectRoot);
    activateUserCapabilityAuthorityForTrustedInstall(userVibeflowRoot);
    const started = await startServer(0, {
      repoDir: projectRoot,
      capability: { userHomeRoot, userVibeflowRoot },
    });
    try {
      const denied = await fetch(`${started.url}/api/capabilities?view=list&scope=project`);
      expect(denied.status).toBe(401);
      expect(denied.headers.get("cache-control")).toBe("no-store");
      const html = await (await fetch(started.url)).text();
      const token = html.match(/name="vf-token" content="([^"]+)"/)?.[1];
      expect(token).toBeString();
      const response = await fetch(`${started.url}/api/capabilities?view=list&scope=project`, {
        headers: { "x-vibeflow-token": token as string },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ schema_version: "1.0", items: [] });
      for (const path of ["/api/capabilities/%", "/api/capabilities/acme.pkg/nested"]) {
        const malformed = await fetch(`${started.url}${path}?scope=project`, {
          headers: { "x-vibeflow-token": token as string },
        });
        expect(malformed.status).toBe(400);
        expect(malformed.headers.get("cache-control")).toBe("no-store");
      }
    } finally {
      await started.server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("startServer remains available while an unactivated capability namespace fails zero-write", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-capability-server-unactivated-"));
    const projectRoot = join(root, "project");
    const userHomeRoot = join(root, "home");
    const userVibeflowRoot = join(userHomeRoot, ".vibeflow");
    mkdirSync(join(projectRoot, ".vibeflow"), { recursive: true });
    mkdirSync(userVibeflowRoot, { recursive: true });
    const before = JSON.stringify(
      [projectRoot, userHomeRoot].map((path) =>
        [...new Bun.Glob("**/*").scanSync({ cwd: path, onlyFiles: true })].sort(),
      ),
    );
    const started = await startServer(0, {
      repoDir: projectRoot,
      capability: { userHomeRoot, userVibeflowRoot },
    });
    try {
      const html = await (await fetch(started.url)).text();
      const token = html.match(/name="vf-token" content="([^"]+)"/)?.[1] as string;
      const response = await fetch(`${started.url}/api/capabilities?view=list&scope=project`, {
        headers: { "x-vibeflow-token": token },
      });
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(
        JSON.stringify(
          [projectRoot, userHomeRoot].map((path) =>
            [...new Bun.Glob("**/*").scanSync({ cwd: path, onlyFiles: true })].sort(),
          ),
        ),
      ).toBe(before);
    } finally {
      await started.server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("authenticates before parsing and rejects all non-GET mutation paths with no-store", async () => {
    let called = false;
    const denied = await handleCapabilityRoute(
      authority({
        authenticated: false,
        query: () => {
          called = true;
          return queryResponse;
        },
      }),
      new Request("http://vf.local/api/capabilities?view=bad&scope=bad"),
      new URL("http://vf.local/api/capabilities?view=bad&scope=bad"),
    );
    expect(denied.status).toBe(401);
    expect(denied.headers.get("cache-control")).toBe("no-store");
    expect(called).toBeFalse();

    const post = await handleCapabilityRoute(
      authority(),
      new Request("http://vf.local/api/capabilities", { method: "POST" }),
      new URL("http://vf.local/api/capabilities"),
    );
    expect(post.status).toBe(404);
    expect(post.headers.get("cache-control")).toBe("no-store");
  });

  test("forwards one normalized bounded query and rejects duplicate, unknown, or invalid filters", async () => {
    const seen: CapabilityQueryRequestV1[] = [];
    const route = authority({
      query: (request) => {
        seen.push(request);
        return queryResponse;
      },
    });
    const url = new URL(
      "http://vf.local/api/capabilities?view=search&scope=project&q=%20Review%20&package_id=acme.reviewer&status=absent,ready&engine=codex,opencode&cursor=abc&limit=25",
    );
    const response = await handleCapabilityRoute(route, new Request(url.href), url);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(seen).toEqual([
      {
        view: "search",
        scope: "project",
        query: " Review ",
        package_id: "acme.reviewer",
        engines: ["codex", "opencode"],
        statuses: ["absent", "ready"],
        cursor: "abc",
        limit: 25,
      },
    ]);
    for (const invalid of [
      "?view=list&view=status&scope=project",
      "?view=list&scope=project&unknown=x",
      "?view=list&scope=project&limit=201",
      "?view=list&scope=project&engine=codex,codex",
      "?view=list&scope=project&status=made-up",
    ]) {
      const invalidUrl = new URL(`http://vf.local/api/capabilities${invalid}`);
      const rejected = await handleCapabilityRoute(route, new Request(invalidUrl.href), invalidUrl);
      expect(rejected.status).toBe(400);
      expect(rejected.headers.get("cache-control")).toBe("no-store");
    }
    expect(seen).toHaveLength(1);
  });

  test("returns typed stale cursor details and maps integrity/recovery/service failures honestly", async () => {
    const stale = authority({
      query: () => {
        throw new StaleCapabilityCursorErrorV1("restart", "watermark");
      },
    });
    const url = new URL("http://vf.local/api/capabilities?view=list&scope=user");
    const response = await handleCapabilityRoute(stale, new Request(url.href), url);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "stale_capability_cursor",
        details: { restart_cursor: "restart", source_watermark: "watermark" },
      },
    });
    for (const [error, status, code] of [
      [new CapabilityRuntimeError("corrupt", "integrity-failure"), 423, "authority_corrupt"],
      [new CapabilityRuntimeError("recovery", "scope-needs-recovery"), 423, "scope_needs_recovery"],
      [new Error("offline"), 503, "service_unavailable"],
    ] as const) {
      const failed = await handleCapabilityRoute(
        authority({
          query: () => {
            throw error;
          },
        }),
        new Request(url.href),
        url,
      );
      expect(failed.status).toBe(status);
      expect(((await failed.json()) as { error: { code: string } }).error.code).toBe(code);
      expect(failed.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("forwards exact detail selectors and never invents input state", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const content = "b".repeat(64);
    let seen: CapabilityDetailRequestV1 | null = null;
    const detail = {
      schema_version: "1.0",
      item: { package_id: "acme.reviewer" },
      package_pin_digest: digest,
      content_sha256: content,
      manifest_digest: digest,
      inputs: [],
      input_schema_digest: digest,
      source_watermark: digest,
    } as unknown as CapabilityBrowserDetailResponseV1;
    const url = new URL(
      `http://vf.local/api/capabilities/acme.reviewer?scope=project&package_pin_digest=${digest}&version=1.2.3&content_sha256=${content}`,
    );
    const response = await handleCapabilityRoute(
      authority({
        detail: (request) => {
          seen = request;
          return detail;
        },
      }),
      new Request(url.href),
      url,
      "acme.reviewer",
    );
    expect(response.status).toBe(200);
    expect(seen as CapabilityDetailRequestV1 | null).toEqual({
      scope: "project",
      package_id: "acme.reviewer",
      package_pin_digest: digest,
      version: "1.2.3",
      content_sha256: content,
    });
    expect(await response.json()).toEqual(detail);

    const missing = await handleCapabilityRoute(
      authority(),
      new Request("http://vf.local/api/capabilities/acme.missing?scope=user"),
      new URL("http://vf.local/api/capabilities/acme.missing?scope=user"),
      "acme.missing",
    );
    expect(missing.status).toBe(404);
  });
});
