// size-waiver: #462 — hook pending-hooks plumbing adds ~38 lines above cap
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CTX_DIR, type WorkflowState, c, cwd, readState } from "./core.js";
import { type LogEvent, getLogbus, matchesUnitFilter } from "./logbus.js";
import { scanRepo } from "./scanner.js";
import { askStreamResponse } from "./server/ask-route.js";
import { handleFileRoute } from "./server/file-route.js";
import { listAttachments, replayFromLog, settingsView } from "./server/handlers.js";
import {
  clearPending,
  getPending,
  listPending,
  onPendingResolved,
  registerPending,
} from "./server/pending-hooks.js";
import { handleMutationRoute, handleProjectsRoute } from "./server/routes.js";
import { discoverSkills } from "./skills/registry.js";
import { resolveSkillNeeds } from "./skills/resolver.js";
import { validateSkillRoots } from "./skills/validator.js";

// Re-export the 4 test seams so the 5 importers don't change
export { repoLanguages, toolViews, settingsView, replayFromLog } from "./server/handlers.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const ASSETS_DIR = new URL("./assets/", import.meta.url);
const ASSET_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
};
const CSP =
  // script-src 'self': Vite bundles all JS externally — no inline scripts needed.
  // style-src 'unsafe-inline': UnoCSS injects atomic utility styles at runtime.
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; connect-src 'self'";

export function startServer(
  port = 0,
  _opts: { uiHtmlPath?: URL } = {},
): Promise<{
  server: { stop: () => void };
  url: string;
}> {
  const token = randomUUID();

  const uiHtmlPath = _opts.uiHtmlPath ?? new URL("../dist/ui/index.html", import.meta.url);
  const pkgJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: string;
  };
  const versionVal = (pkgJson.version || "0.0.0").replace(/[^0-9a-zA-Z.\-+]/g, "");
  // ponytail: read HTML per-request so a `vite build` hot-reload doesn't serve stale asset hashes
  const serveHtml = () => {
    let raw: string;
    try {
      raw = readFileSync(uiHtmlPath, "utf8");
    } catch {
      // dist/ui not built — minimal shell with CSRF token so csrfToken() tests work pre-build
      return `<!doctype html><html><head><meta name="vf-token" content="${token}" /><meta name="vf-version" content="${versionVal}" /></head><body><pre>UI not built. Run: bun run build</pre></body></html>`;
    }
    return raw.replaceAll("__CSRF__", token).replaceAll("__VERSION__", versionVal);
  };

  let activeRepo = cwd();
  clearPending(); // discard orphaned hooks from previous server instance

  const isLoopback = (host: string): boolean => LOOPBACK.has(host.replace(/:\d+$/, ""));

  const guarded = (req: Request): boolean => {
    if (!isLoopback(req.headers.get("host") ?? "")) return false;
    const o = req.headers.get("origin") || req.headers.get("referer");
    if (o) {
      try {
        if (!isLoopback(new URL(o).hostname)) return false;
      } catch {
        return false;
      }
    }
    return req.headers.get("x-vibeflow-token") === token;
  };

  const server = Bun.serve({
    port: port === 0 ? 0 : port,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const method = req.method;
      const path = url.pathname;

      // --- GET / (HTML page) ---
      if (method === "GET" && (path === "/" || path === "/index.html")) {
        return new Response(serveHtml(), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            // no-cache: revalidate on every navigation so new asset hashes are picked up
            "cache-control": "no-cache",
            "content-security-policy": CSP,
            "x-content-type-options": "nosniff",
          },
        });
      }

      // --- GET /state ---
      if (method === "GET" && path === "/state") {
        return Response.json(readState(activeRepo));
      }

      // --- GET /api/markers ---
      if (method === "GET" && path === "/api/markers") {
        const m = await import("./orchestrator/marker.js");
        return Response.json({ markers: m.listMarkers() });
      }

      // --- GET /api/units/:name/timeline — token+loopback guarded (#557) ---
      if (method === "GET" && path.startsWith("/api/units/") && path.endsWith("/timeline")) {
        if (!guarded(req)) return Response.json({ error: "forbidden" }, { status: 403 });
        let name: string;
        try {
          name = decodeURIComponent(path.slice("/api/units/".length, -"/timeline".length));
        } catch {
          // malformed percent-encoding (e.g. `%ZZ`, a lone `%`) → clean 400, never a 500 crash
          return Response.json({ error: "bad name" }, { status: 400 });
        }
        // Reject slug-unsafe names: separators/NUL/`..` (traversal) + `:` (Windows ADS) + overlong
        // (symmetry with the 200-char cap on /api/units). A unit name is a plain slug.
        if (!name || name.length > 200 || /[\\/:\0]/.test(name) || name.includes(".."))
          return Response.json({ error: "bad name" }, { status: 400 });
        const { readTimeline } = await import("./orchestrator/timeline.js");
        return Response.json({ ok: true, timeline: readTimeline(name) });
      }

      // --- GET /api/phases ---
      // ponytail: PhaseTracker snapshot is per-orchestrateUnits() call; markers are the stable proxy
      if (method === "GET" && path === "/api/phases") {
        const pm = await import("./orchestrator/marker.js");
        return Response.json({ markers: pm.listMarkers() });
      }

      // --- GET /api/attachments ---
      if (method === "GET" && path === "/api/attachments") {
        return Response.json({ ok: true, attachments: listAttachments(activeRepo) });
      }

      // --- GET /api/skills ---
      if (method === "GET" && path === "/api/skills") {
        const state = readState(activeRepo);
        const needs = resolveSkillNeeds({
          repo: activeRepo,
          attachments: (state?.attachments ?? []).map((a) => a.name),
          task: state?.goal,
          profile: scanRepo(activeRepo),
        });
        const validation = validateSkillRoots(activeRepo);
        return Response.json({
          ok: true,
          skills: discoverSkills(activeRepo),
          needs,
          validation: { errors: validation.errors, warnings: validation.warnings },
        });
      }

      // --- GET /api/settings ---
      if (method === "GET" && path === "/api/settings") {
        return Response.json({ ok: true, ...settingsView(activeRepo) });
      }

      // --- GET /api/file — token+loopback guarded, sandboxed to activeRepo (#558) ---
      if (method === "GET" && path === "/api/file") {
        if (!guarded(req)) return Response.json({ error: "forbidden" }, { status: 403 });
        return handleFileRoute(activeRepo, url.searchParams.get("path") ?? "");
      }

      // --- GET /api/projects* and /api/hook/pending ---
      if (method === "GET" && (path.startsWith("/api/projects") || path === "/api/hook/pending")) {
        const r = handleProjectsRoute(path, url);
        if (r) return r;
      }

      // --- GET /api/hook/response/:id — long-poll, blocks until approve ---
      if (method === "GET" && path.startsWith("/api/hook/response/")) {
        const id = path.slice("/api/hook/response/".length);
        return new Response(
          new ReadableStream({
            start(controller) {
              const enc = new TextEncoder();
              if (!getPending(id)) {
                controller.enqueue(enc.encode(JSON.stringify({ decision: "block" })));
                controller.close();
                return;
              }
              onPendingResolved(id, (decision) => {
                controller.enqueue(enc.encode(JSON.stringify({ decision })));
                controller.close();
              });
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }

      // --- SSE: /api/logs/stream ---
      if (method === "GET" && path === "/api/logs/stream") {
        const bus = getLogbus();
        // #525: scope this stream to one unit; empty `?unit=` means no filter.
        const unitFilter = url.searchParams.get("unit") || undefined;
        let cleanup: (() => void) | undefined;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(": vibeflow-logs-1\n\n"));
              if (!bus) {
                controller.enqueue(
                  new TextEncoder().encode(
                    ": no logbus instance found — log events will appear when the CLI starts\\n\\n",
                  ),
                );
              } else {
                try {
                  // replay from session start seq so stale logs from previous sessions are skipped
                  let startSeq = 0;
                  try {
                    const seqFile = join(activeRepo, CTX_DIR, "logs", "session-start-seq");
                    startSeq = Number(readFileSync(seqFile, "utf8").trim()) || 0;
                  } catch {
                    /* file may not exist yet */
                  }
                  const caught = replayFromLog(bus.currentFile(), startSeq, 1000);
                  for (const ev of caught) {
                    if (!matchesUnitFilter(ev, unitFilter)) continue;
                    controller.enqueue(
                      new TextEncoder().encode(`event: log\ndata: ${JSON.stringify(ev)}\n\n`),
                    );
                  }
                } catch {
                  /* best-effort catch-up */
                }
              }

              // 25s heartbeat — keeps SSE alive across proxies; enqueue errors on disconnect are swallowed
              const safeEnqueue = (chunk: Uint8Array) => {
                try {
                  controller.enqueue(chunk);
                } catch {
                  /* client gone */
                }
              };
              const heartbeat = setInterval(
                () => safeEnqueue(new TextEncoder().encode(": keepalive\n\n")),
                25_000,
              );

              const unsub = bus?.subscribe((ev: LogEvent) => {
                if (!matchesUnitFilter(ev, unitFilter)) return;
                safeEnqueue(
                  new TextEncoder().encode(`event: log\ndata: ${JSON.stringify(ev)}\n\n`),
                );
              });

              cleanup = () => {
                clearInterval(heartbeat);
                if (unsub) unsub();
              };

              req.signal.addEventListener("abort", cleanup);
            },
            cancel() {
              cleanup?.();
            },
          }),
          {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              "x-accel-buffering": "no",
            },
          },
        );
      }

      // --- SSE: /api/ask/stream (#580) — token-by-token engine answer streaming ---
      if (method === "GET" && path === "/api/ask/stream") {
        if (!isLoopback(req.headers.get("host") ?? "") || url.searchParams.get("token") !== token)
          return Response.json({ error: "forbidden" }, { status: 403 });
        const body = {
          path: url.searchParams.get("path") ?? "",
          start: Number(url.searchParams.get("start")),
          end: Number(url.searchParams.get("end")),
          question: url.searchParams.get("question") ?? "",
          engine: url.searchParams.get("engine") ?? undefined,
          resume: url.searchParams.get("resume") === "true",
        };
        return await askStreamResponse(activeRepo, body);
      }

      // --- GET /api/logs/session --- returns session start seq (to skip stale logs)
      // cli.ts writes session-start-seq to activeRepo/.vibeflow/logs/ on startup
      if (method === "GET" && path === "/api/logs/session") {
        try {
          const seqFile = join(activeRepo, CTX_DIR, "logs", "session-start-seq");
          const seq = Number(readFileSync(seqFile, "utf8").trim()) || 0;
          return Response.json({ sessionStartSeq: seq });
        } catch {
          return Response.json({ sessionStartSeq: 0 });
        }
      }

      // --- GET /api/logs/recent ---
      if (method === "GET" && path === "/api/logs/recent") {
        const bus = getLogbus();
        if (!bus) return Response.json({ error: "no logbus instance" }, { status: 404 });
        const since = Math.max(0, Number(url.searchParams.get("since") ?? "0"));
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? "100")));
        return Response.json({ events: replayFromLog(bus.currentFile(), since, limit) });
      }

      // --- GET /events (deprecated SSE) ---
      if (method === "GET" && path === "/events") {
        let last = "";
        const streamPositions = new Map<string, number>();
        return new Response(
          new ReadableStream({
            start(controller) {
              const tick = () => {
                const state: WorkflowState | null = readState(activeRepo);
                const json = JSON.stringify(state);
                if (json !== last) {
                  last = json;
                  controller.enqueue(new TextEncoder().encode(`data: ${json}\n\n`));
                }
                if (state) {
                  for (const u of state.work_units ?? []) {
                    try {
                      const span = join(activeRepo, CTX_DIR, "workunits", u.name, "stream.log");
                      const st = statSync(span, { throwIfNoEntry: false });
                      if (!st || !st.isFile()) continue;
                      const prev = streamPositions.get(u.name) ?? 0;
                      if (st.size <= prev) continue;
                      const raw = readFileSync(span, "utf8");
                      streamPositions.set(u.name, st.size);
                      if (raw) {
                        const slice = raw.slice(prev);
                        if (!slice.trim()) continue;
                        controller.enqueue(
                          new TextEncoder().encode(
                            `event: stream\ndata: ${JSON.stringify({ unit: u.name, lines: slice.split("\n").filter(Boolean) })}\n\n`,
                          ),
                        );
                      }
                    } catch {
                      /* streaming is best-effort */
                    }
                  }
                }
              };
              tick();
              const timer = setInterval(tick, 1000);
              req.signal.addEventListener("abort", () => clearInterval(timer));
            },
            cancel() {},
          }),
          {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
            },
          },
        );
      }

      // --- POST /api/hook/pending — CLI loopback only (no CSRF; hook subprocess can't hold token) ---
      if (
        method === "POST" &&
        path === "/api/hook/pending" &&
        isLoopback(req.headers.get("host") ?? "")
      ) {
        const body = (await req.json()) as { id?: string; input?: unknown; result?: unknown };
        if (typeof body.id !== "string" || !body.id)
          return Response.json({ error: "id required" }, { status: 400 });
        registerPending(
          body.id,
          body.input as import("./core/types.js").HookInput,
          body.result as import("./core/types.js").HookResult,
        );
        return Response.json({ ok: true });
      }

      // --- Write surface: CSRF + loopback guard ---
      const isWrite =
        (method === "POST" &&
          (path === "/api/init" ||
            path === "/api/dispatch" ||
            path === "/api/detect" ||
            path === "/api/units" ||
            path === "/api/orchestrate" ||
            path === "/api/discover" ||
            path === "/api/ask" ||
            path === "/api/preflight" ||
            path === "/api/settings" ||
            path === "/api/verify" ||
            path === "/api/hook/approve" ||
            path.startsWith("/api/guidance/") ||
            path === "/api/upload")) ||
        (method === "DELETE" && path === "/api/upload") ||
        (method === "DELETE" && (path === "/api/state" || path === "/api/projects"));

      if (isWrite) {
        if (!guarded(req)) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        try {
          const result = await handleMutationRoute(
            {
              getActiveRepo: () => activeRepo,
              setActiveRepo: (r) => {
                activeRepo = r;
              },
            },
            method,
            path,
            req,
            url,
          );
          if (result) return result;
          // ponytail: safety net — path in isWrite but no inner handler matched
          return Response.json({ error: "not found" }, { status: 404 });
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 400 });
        }
      }

      // --- GET /ui/* (Vite build assets — hashed filenames, immutable cache) ---
      if (method === "GET" && path.startsWith("/ui/")) {
        const rel = path.slice("/ui/".length);
        if (!rel || rel.includes("..") || rel.includes("\0"))
          return new Response("not found", { status: 404 });
        const UI_DIST = new URL("../dist/ui/", import.meta.url);
        const fileUrl = new URL(rel, UI_DIST);
        if (!fileUrl.href.startsWith(UI_DIST.href))
          return new Response("not found", { status: 404 });
        const ext = rel.slice(rel.lastIndexOf("."));
        const type = ASSET_TYPES[ext] ?? "application/octet-stream";
        try {
          const data = readFileSync(fileUrl.pathname);
          return new Response(data, {
            headers: {
              "content-type": type,
              "cache-control": "public, max-age=31536000, immutable",
              "x-content-type-options": "nosniff",
            },
          });
        } catch {
          return new Response("not found", { status: 404 });
        }
      }

      // --- GET /assets/* (static files) ---
      if (method === "GET" && path.startsWith("/assets/")) {
        const rel = path.slice("/assets/".length);
        if (!rel || rel.includes("..") || rel.includes("\\0"))
          return new Response("not found", { status: 404 });
        const fileUrl = new URL(rel, ASSETS_DIR);
        if (!fileUrl.href.startsWith(ASSETS_DIR.href))
          return new Response("not found", { status: 404 });
        const ext = rel.slice(rel.lastIndexOf("."));
        const type = ASSET_TYPES[ext];
        if (!type) return new Response("not found", { status: 404 });
        const file = Bun.file(fileUrl.pathname);
        const ok = await file.exists();
        if (!ok) return new Response("not found", { status: 404 });
        return new Response(file, {
          headers: {
            "content-type": type,
            "x-content-type-options": "nosniff",
            "cache-control": "no-cache",
          },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  console.log(
    `${c.cyan("VibeFlow UI")} → ${c.bold(`http://127.0.0.1:${server.port}`)}  ${c.dim("(Ctrl+C to stop)")}`,
  );
  return Promise.resolve({
    server: { stop: () => server.stop() },
    url: `http://127.0.0.1:${server.port}`,
  });
}
