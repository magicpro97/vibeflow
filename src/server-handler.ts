// ponytail: fetch handler extracted from server.ts (issue #186 split). Deps typed loosely
// since this is internal wiring — pin exact types in server.ts at the call site.
import { join } from "node:path";

// biome-ignore lint/suspicious/noExplicitAny: DI deps for handler extracted from server.ts
type Deps = Record<string, any>;

export interface ServerHandlerCtx {
  activeRepo: string;
  setActiveRepo: (r: string) => void;
  token: string;
  cachedHtml: string;
  isLoopback: (h: string) => boolean;
  guarded: (req: Request) => boolean;
}

export async function createFetchHandler(
  ctx: ServerHandlerCtx,
  d: Deps,
): Promise<(req: Request) => Promise<Response>> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const method = req.method;
    const path = url.pathname;

    const setRepo = (r: string) => ctx.setActiveRepo(r);
    const repo = () => ctx.activeRepo;

    // --- GET / (HTML page) ---
    if (method === "GET" && (path === "/" || path.startsWith("/index"))) {
      return new Response(ctx.cachedHtml, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": d.CSP as string,
          "x-content-type-options": "nosniff",
        },
      });
    }

    // --- GET /state ---
    if (method === "GET" && path === "/state") {
      return Response.json(d.readState(repo()));
    }

    // --- GET /api/markers ---
    if (method === "GET" && path === "/api/markers") {
      const m = await import("./orchestrator/marker.js");
      return Response.json({ markers: m.listMarkers() });
    }

    // --- GET /api/attachments ---
    if (method === "GET" && path === "/api/attachments") {
      return Response.json({ attachments: d.listAttachments(repo()) });
    }

    // --- GET /api/skills ---
    if (method === "GET" && path === "/api/skills") {
      const state = d.readState(repo());
      const needs = d.resolveSkillNeeds({
        repo: repo(),
        attachments: (state?.attachments ?? []).map((a: { name: string }) => a.name),
        task: state?.goal,
        profile: d.scanRepo(repo()),
      });
      return Response.json({ skills: d.discoverSkills(repo()), needs });
    }

    // --- GET /api/settings ---
    if (method === "GET" && path === "/api/settings") {
      return Response.json(d.settingsView(repo()));
    }

    // --- SSE: /api/logs/stream ---
    if (method === "GET" && path === "/api/logs/stream") {
      const bus = d.getLogbus();
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
                const caught = d.replayFromLog(bus.currentFile(), 0, 1000);
                for (const ev of caught) {
                  controller.enqueue(
                    new TextEncoder().encode(`event: log\\ndata: ${JSON.stringify(ev)}\\n\\n`),
                  );
                }
              } catch {
                /* best-effort catch-up */
              }
            }

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

            const unsub = bus?.subscribe((ev: unknown) => {
              safeEnqueue(new TextEncoder().encode(`event: log\ndata: ${JSON.stringify(ev)}\n\n`));
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
      const bus = d.getLogbus();
      if (!bus) return Response.json({ error: "no logbus instance" }, { status: 404 });
      const since = Math.max(0, Number(url.searchParams.get("since") ?? "0"));
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? "100")));
      return Response.json({ events: d.replayFromLog(bus.currentFile(), since, limit) });
    }

    // --- GET /events (deprecated SSE) ---
    if (method === "GET" && path === "/events") {
      return new Response(new ReadableStream({ start() {}, cancel() {} }), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    }

    // --- POST (write routes) ---
    if (method === "POST") {
      if (!ctx.guarded(req)) return Response.json({ error: "forbidden" }, { status: 403 });

      const isWrite =
        path === "/api/detect" ||
        path === "/api/init" ||
        path === "/api/dispatch" ||
        path === "/api/orchestrate" ||
        path === "/api/discover" ||
        path === "/api/units" ||
        path === "/api/preflight" ||
        path === "/api/settings";

      if (!isWrite) {
        if (path === "/api/attachments") {
          const ct = req.headers.get("content-type") ?? "";
          if (!ct.includes("multipart/form-data"))
            return Response.json({ error: "multipart expected" }, { status: 400 });
          const fd = await req.formData();
          const file = fd.get("file") as File | null;
          if (!file || !file.name)
            return Response.json({ error: "file required" }, { status: 400 });
          const safe = d.safeAttachName(file.name);
          if (!safe) return Response.json({ error: "invalid filename" }, { status: 400 });
          if (file.size > (d.ATTACH_CAP as number))
            return Response.json({ error: "file too large" }, { status: 413 });
          const dir = d.attachDir(repo());
          d.mkdirSync(dir, { recursive: true });
          const buf = Buffer.from(await file.arrayBuffer());
          const dst = join(dir, safe);
          const ws = d.createWriteStream(dst);
          await new Promise<void>((res, rej) => {
            ws.write(buf, (err: Error | null) => (err ? rej(err) : (ws.end(), res())));
          });
          const attachments = d.syncAttachments(repo());
          return Response.json({ ok: true, attachments });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      }

      try {
        const payload = (await req.json()) as Record<string, unknown>;

        if (path === "/api/detect") {
          const det = d.detectRepo(typeof payload.path === "string" ? payload.path : undefined);
          setRepo(det.repo);
          return Response.json({ ok: true, ...det, state: d.readState(repo()) });
        }

        if (path === "/api/init") {
          if (typeof payload.repoPath === "string") setRepo(d.resolveRepo(payload.repoPath));
          const { files, state } = d.applyIntake(payload, {
            useAi: payload.useAi === true,
            base: repo(),
          });
          return Response.json({ ok: true, files, state });
        }

        if (path === "/api/dispatch") {
          const result = d.applyDispatch(String(payload.engine ?? ""), repo());
          if (!result) return Response.json({ error: "invalid engine" }, { status: 400 });
          return Response.json({ ok: true, ...result });
        }

        if (path === "/api/orchestrate") {
          await d.orchestrate({ engine: String(payload.engine ?? "claude"), dry: true }, repo());
          return Response.json({ ok: true, state: d.readState(repo()) });
        }

        if (path === "/api/discover") {
          const kind = payload.kind === "skills" ? "skills" : "docs";
          const query = String(payload.query ?? "").trim();
          if (!query) return Response.json({ error: "query required" }, { status: 400 });
          const outcome =
            kind === "docs"
              ? await d.lookupDocsHttp(query, { approved: payload.approved === true })
              : await d.searchSkillsHttp(query, { approved: payload.approved === true });
          return Response.json({ ...outcome });
        }

        if (path === "/api/units") {
          const action = String(payload.action ?? "");
          if (action !== "add" && action !== "update" && action !== "delete") {
            return Response.json({ error: "invalid action" }, { status: 400 });
          }
          const unit = (payload.unit ?? {}) as { name?: string };
          const state = d.mutateUnits(repo(), action, unit);
          if (!state)
            return Response.json({ error: "no workflow or unit not found" }, { status: 400 });
          return Response.json({ ok: true, state });
        }

        if (path === "/api/preflight") {
          return Response.json(d.runPreflight(payload));
        }

        // biome-ignore format: keep compact
        if (path === "/api/settings") { d.applySettings(repo(), payload); return Response.json({ ok: true, ...d.settingsView(repo()) }); }
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
      const fileUrl = new URL(rel, d.ASSETS_DIR as URL);
      if (!fileUrl.href.startsWith((d.ASSETS_DIR as URL).href))
        return new Response("not found", { status: 404 });
      const ext = rel.slice(rel.lastIndexOf("."));
      const types = d.ASSET_TYPES as Record<string, string>;
      const type = types[ext];
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
  };
}
