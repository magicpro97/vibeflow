import { afterEach, describe, expect, test } from "bun:test";

import { cleanupMarker, createMarker, updateMarker } from "../src/orchestrator/marker";
import { startServer } from "../src/server";

/** Fetch the CSRF token from the HTML page served at `/`. */
async function csrfToken(url: string): Promise<string> {
  const res = await fetch(url);
  const html = await res.text();
  const m = html.match(/<meta\s+name="vf-token"\s+content="([^"]+)"\s*\/?>/i);
  if (!m) throw new Error("CSRF token not found in page HTML");
  return m[1] as string;
}

interface TimelineResp {
  ok?: boolean;
  error?: string;
  timeline?: { status: string; at: number; confidence?: number; evidenceCount?: number }[];
}

const UNIT = `timeline-route-test-${process.pid}`;
const units: string[] = [];
afterEach(() => {
  for (const u of units.splice(0)) {
    try {
      cleanupMarker(u);
    } catch {}
  }
});

const get = (url: string, name: string, token?: string) =>
  fetch(`${url}/api/units/${name}/timeline`, {
    headers: token ? { "x-vibeflow-token": token } : {},
  });

describe("GET /api/units/:name/timeline (#557 status timeline)", () => {
  test("happy read — a seeded unit returns ok:true with its transitions", async () => {
    const { server, url } = await startServer();
    units.push(UNIT);
    createMarker(UNIT);
    updateMarker(UNIT, { status: "running", confidence: 0.5, evidence: ["/tmp/a"] });
    updateMarker(UNIT, { status: "done", confidence: 1 });
    try {
      const token = await csrfToken(url);
      const res = await get(url, UNIT, token);
      expect(res.status).toBe(200);
      const body = (await res.json()) as TimelineResp;
      expect(body.ok).toBe(true);
      expect(body.timeline?.map((e) => e.status)).toEqual(["running", "done"]);
      expect(body.timeline?.[0]?.confidence).toBe(0.5);
      expect(body.timeline?.[0]?.evidenceCount).toBe(1);
    } finally {
      server.stop();
    }
  });

  test("`..` in the name → 400", async () => {
    const { server, url } = await startServer();
    try {
      const token = await csrfToken(url);
      // `..` embedded in a segment survives URL normalization → hits the includes("..") guard
      const res = await get(url, "foo..bar", token);
      expect(res.status).toBe(400);
    } finally {
      server.stop();
    }
  });

  test("a `:` in the name → 400 (Windows ADS guard)", async () => {
    const { server, url } = await startServer();
    try {
      const token = await csrfToken(url);
      const res = await get(url, "C:foo", token);
      expect(res.status).toBe(400);
    } finally {
      server.stop();
    }
  });

  test("an overlong name (> 200 chars) → 400", async () => {
    const { server, url } = await startServer();
    try {
      const token = await csrfToken(url);
      const res = await get(url, "a".repeat(201), token);
      expect(res.status).toBe(400);
    } finally {
      server.stop();
    }
  });

  test("malformed percent-encoding in the name → 400 (not a 500 crash)", async () => {
    const { server, url } = await startServer();
    try {
      const token = await csrfToken(url);
      // `%ZZ` is invalid percent-encoding — decodeURIComponent throws URIError; the route must
      // catch it and return a clean 400 rather than letting a 500 escape the handler.
      const res = await fetch(`${url}/api/units/%ZZ/timeline`, {
        headers: { "x-vibeflow-token": token },
      });
      expect(res.status).toBe(400);
    } finally {
      server.stop();
    }
  });

  test("a slash in the name → 400", async () => {
    const { server, url } = await startServer();
    try {
      const token = await csrfToken(url);
      // encoded slash decodes to a real slash → sanitizer rejects
      const res = await get(url, "foo%2Fbar", token);
      expect(res.status).toBe(400);
    } finally {
      server.stop();
    }
  });

  test("missing token → 403", async () => {
    const { server, url } = await startServer();
    try {
      const res = await get(url, UNIT);
      expect(res.status).toBe(403);
    } finally {
      server.stop();
    }
  });

  test("an unknown unit → 200 with an empty timeline", async () => {
    const { server, url } = await startServer();
    try {
      const token = await csrfToken(url);
      const res = await get(url, `no-such-unit-${process.pid}`, token);
      expect(res.status).toBe(200);
      const body = (await res.json()) as TimelineResp;
      expect(body.ok).toBe(true);
      expect(body.timeline).toEqual([]);
    } finally {
      server.stop();
    }
  });
});
