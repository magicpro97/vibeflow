import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CTX_DIR, type WorkflowState, c, cwd, readState } from "./core.js";
import { type LogEvent, getLogbus } from "./logbus.js";
import { scanRepo } from "./scanner.js";
import { listAttachments, replayFromLog, settingsView } from "./server/handlers.js";
import { handleMutationRoute } from "./server/routes.js";
import { discoverSkills } from "./skills/registry.js";
import { resolveSkillNeeds } from "./skills/resolver.js";

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
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'";

export function startServer(port = 0): Promise<{
  server: { stop: () => void };
  url: string;
}> {
  const token = randomUUID();

  const shellV2Enabled = process.env.VIBEFLOW_UI_V2 === "1";
  const shellHtmlSrc = shellV2Enabled ? "./ui/shell-v2.html" : "./ui/shell.html";
  const shellHtml = readFileSync(new URL(shellHtmlSrc, import.meta.url), "utf8");
  const sectionsHtml = readFileSync(new URL("./ui/sections.html", import.meta.url), "utf8");
  const pkgJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: string;
  };
  const versionVal = pkgJson.version || "0.0.0";
  // v1 embeds sections.html; v2 is self-contained
  const pageHtml = shellV2Enabled
    ? shellHtml
    : shellHtml.replace("<!-- SECTIONS -->", sectionsHtml);
  const cachedHtml = pageHtml.replace(/__CSRF__/g, token).replace(/__VERSION__/g, versionVal);

  let activeRepo = cwd();

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
      if (method === "GET" && (path === "/" || path.startsWith("/index"))) {
        return new Response(cachedHtml, {
          headers: {
            "content-type": "text/html; charset=utf-8",
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

      // --- GET /api/phases ---
      // Returns the marker list (markers carry status+timestamps).
      // Wiring a live PhaseTracker snapshot is possible but heavy:
      // the tracker only exists during an active orchestrateUnits()
      // call and is not thread-safe to share across requests.
      if (method === "GET" && path === "/api/phases") {
        const pm = await import("./orchestrator/marker.js");
        return Response.json({ markers: pm.listMarkers() });
      }

      // --- GET /api/attachments ---
      if (method === "GET" && path === "/api/attachments") {
        return Response.json({ attachments: listAttachments(activeRepo) });
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
        return Response.json({ skills: discoverSkills(activeRepo), needs });
      }

      // --- GET /api/settings ---
      if (method === "GET" && path === "/api/settings") {
        return Response.json(settingsView(activeRepo));
      }

      // --- SSE: /api/logs/stream ---
      if (method === "GET" && path === "/api/logs/stream") {
        const bus = getLogbus();
        let cleanup: (() => void) | undefined;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(": vibeflow-logs-1\\n\\n"));
              if (!bus) {
                controller.enqueue(
                  new TextEncoder().encode(
                    ": no logbus instance found — log events will appear when the CLI starts\\n\\n",
                  ),
                );
              } else {
                try {
                  const caught = replayFromLog(bus.currentFile(), 0, 1000);
                  for (const ev of caught) {
                    controller.enqueue(
                      new TextEncoder().encode(`event: log\\ndata: ${JSON.stringify(ev)}\\n\\n`),
                    );
                  }
                } catch {
                  /* best-effort catch-up */
                }
              }

              // 25s heartbeat to keep the SSE connection alive across
              // proxies. If the client disconnected, controller.enqueue
              // throws — wrapped in a no-op handler to keep the interval
              // alive without crashing the process.
              const safeEnqueue = (chunk: Uint8Array) => {
                try {
                  controller.enqueue(chunk);
                } catch {
                  /* client gone */
                }
              };
              const heartbeat = setInterval(
                () => safeEnqueue(new TextEncoder().encode(": keepalive\\n\\n")),
                25_000,
              );

              const unsub = bus?.subscribe((ev: LogEvent) => {
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

      // --- GET /api/logs/recent ---
      if (method === "GET" && path === "/api/logs/recent") {
        const bus = getLogbus();
        if (!bus) {
          return Response.json({ error: "no logbus instance" }, { status: 404 });
        }
        const since = Math.max(0, Number(url.searchParams.get("since") ?? "0"));
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? "100")));
        return Response.json({
          events: replayFromLog(bus.currentFile(), since, limit),
        });
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
                  controller.enqueue(new TextEncoder().encode(`data: ${json}\\n\\n`));
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
                            `event: stream\\ndata: ${JSON.stringify({ unit: u.name, lines: slice.split("\\n").filter(Boolean) })}\\n\\n`,
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

      // --- Write surface: CSRF + loopback guard ---
      const isWrite =
        (method === "POST" &&
          (path === "/api/init" ||
            path === "/api/dispatch" ||
            path === "/api/detect" ||
            path === "/api/units" ||
            path === "/api/orchestrate" ||
            path === "/api/discover" ||
            path === "/api/preflight" ||
            path === "/api/settings" ||
            path === "/api/verify" ||
            path === "/api/upload")) ||
        (method === "DELETE" && path === "/api/upload");

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
          // Each whitelisted /api/* write route above returns
          // before reaching this point. If we got here, the path
          // was in `isWrite` but no inner handler matched. That
          // would mean a future contributor added a new entry to
          // isWrite without an inner if/else — kept as a safety
          // net so the request doesn't fall through to the
          // /assets/* 404 handler.
          return Response.json({ error: "not found" }, { status: 404 });
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 400 });
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
        const file = Bun.file(fileUrl);
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
