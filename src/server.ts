import { randomUUID } from "node:crypto";
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import {
  applyDispatch,
  applyIntake,
  detectRepo,
  mutateUnits,
  orchestrate,
  resolveRepo,
  skillForFile,
} from "./commands.js";
import {
  type Attachment,
  CTX_DIR,
  ENGINES,
  type Engine,
  type WorkflowState,
  c,
  cwd,
  readState,
  writeState,
} from "./core.js";
import { lookupDocsHttp, searchSkillsHttp } from "./discovery/context7.js";
import { type LogEvent, getLogbus } from "./logbus.js";
import { type EngineReadiness, type PreflightOpts, anyReady, preflightAll } from "./preflight.js";
import { type ProjectProfile, scanRepo } from "./scanner.js";
import { type VibeSettings, readSettings, writeSettings } from "./settings.js";
import { discoverSkills } from "./skills/registry.js";
import { resolveSkillNeeds } from "./skills/resolver.js";
import { TOOLS, TOOL_ORDER } from "./tools/index.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const ASSETS_DIR = new URL("./assets/", import.meta.url);
const ASSET_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
};
const ATTACH_CAP = 50 * 1024 * 1024;
const CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'";

function attachDir(repo: string): string {
  return join(repo, CTX_DIR, "attachments");
}

function safeAttachName(raw: string): string | null {
  const base = basename(String(raw || "").trim());
  if (!base || base === "." || base === "..") return null;
  if (base.startsWith(".")) return null;
  if (/[\\/\0]/.test(base)) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control bytes in filenames
  if (/[\u0000-\u001f]/.test(base)) return null;
  if (base.length > 200) return null;
  return base;
}

function listAttachments(repo: string): Attachment[] {
  const dir = attachDir(repo);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => !n.startsWith("."))
    .map((n) => {
      let size = 0;
      try {
        size = statSync(join(dir, n)).size;
      } catch {
        /* ignore */
      }
      return {
        name: n,
        size,
        type: n.split(".").pop()?.toLowerCase() ?? "",
        skill: skillForFile(n),
      };
    });
}

function syncAttachments(repo: string): Attachment[] {
  const items = listAttachments(repo);
  const state = readState(repo);
  if (state) {
    state.attachments = items;
    writeState(repo, state);
  }
  return items;
}

function requestedEngines(payload: Record<string, unknown>): Engine[] {
  const raw = payload.engines;
  if (!Array.isArray(raw)) return [...ENGINES];
  const want = new Set(raw.filter((e): e is string => typeof e === "string"));
  const picked = ENGINES.filter((e) => want.has(e));
  return picked.length ? picked : [...ENGINES];
}

function runPreflight(payload: Record<string, unknown>): {
  ok: boolean;
  readiness: EngineReadiness[];
  anyReady: boolean;
} {
  const opts: PreflightOpts = { probe: payload.probe !== false };
  const readiness = preflightAll(requestedEngines(payload), opts);
  return { ok: true, readiness, anyReady: anyReady(readiness) };
}

// Test seam: exported so unit tests can exercise the FS-catch
// fallback at line 125-126 by injecting a throwing scanRepo.
export function repoLanguages(
  repo: string,
  inject: { scanRepo?: (base: string) => ProjectProfile } = {},
): string[] {
  const scan = inject.scanRepo ?? scanRepo;
  try {
    return scan(repo).languages;
  } catch {
    return [];
  }
}

interface ToolView {
  name: string;
  title: string;
  description: string;
  installed: boolean;
  plan: string[];
  command: string;
}

// Test seam: exported so unit tests can exercise the FS-catch
// fallback at line 145-146 by injecting a throwing scanRepo.
export function toolViews(
  repo: string,
  inject: { scanRepo?: (base: string) => ProjectProfile } = {},
): ToolView[] {
  const languages = repoLanguages(repo, inject);
  return TOOL_ORDER.map((name) => {
    const tool = TOOLS[name];
    const plan = tool.installPlan({ workspace: repo, languages });
    return {
      name,
      title: tool.title,
      description: tool.description,
      installed: tool.detect(),
      plan: plan.steps.map((s) => `${s.cmd} ${s.args.join(" ")}`),
      command: `vf tools install ${name} --yes`,
    };
  });
}

// Test seam: exported so unit tests can exercise the catch
// fallback at line 175-176 by injecting a throwing scanRepo.
export function settingsView(
  repo: string,
  inject: { scanRepo?: (base: string) => ProjectProfile } = {},
): {
  settings: VibeSettings;
  tools: ToolView[];
} {
  return { settings: readSettings(repo), tools: toolViews(repo, inject) };
}

function applySettings(repo: string, payload: Record<string, unknown>): VibeSettings {
  const raw = (payload.tools ?? {}) as Record<string, unknown>;
  const tools = { ...readSettings(repo).tools };
  if (typeof raw.codegraph === "boolean") tools.codegraph = raw.codegraph;
  if (typeof raw.lsp === "boolean") tools.lsp = raw.lsp;
  return writeSettings(repo, { tools });
}

// Test seam: exported so unit tests can exercise the small/large file
// paths (line 177-188) without going through the SSE handler.
export function replayFromLog(filePath: string, since: number, limit: number): LogEvent[] {
  if (!existsSync(filePath)) return [];
  const st = statSync(filePath);
  if (st.size === 0) return [];

  const MAX_READ = 2 * 1024 * 1024;
  let raw: string;

  if (st.size > MAX_READ) {
    const buf = Buffer.alloc(MAX_READ);
    const fd = openSync(filePath, "r");
    try {
      readSync(fd, buf, 0, MAX_READ, st.size - MAX_READ);
    } finally {
      closeSync(fd);
    }
    raw = buf.toString("utf8");
    const firstNl = raw.indexOf("\n");
    if (firstNl >= 0) raw = raw.slice(firstNl + 1);
  } else {
    raw = readFileSync(filePath, "utf8");
  }

  const events: LogEvent[] = [];
  for (const line of raw.split("\n").filter(Boolean)) {
    try {
      const ev = JSON.parse(line) as LogEvent;
      if (typeof ev.seq === "number" && ev.seq >= since) {
        events.push(ev);
        if (events.length >= limit) break;
      }
    } catch {
      /* skip malformed lines */
    }
  }
  return events;
}

export function startServer(port = 0): Promise<{
  server: { stop: () => void };
  url: string;
}> {
  const token = randomUUID();

  const shellHtml = readFileSync(new URL("./ui/shell.html", import.meta.url), "utf8");
  const sectionsHtml = readFileSync(new URL("./ui/sections.html", import.meta.url), "utf8");
  const pkgJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: string;
  };
  const versionVal = pkgJson.version || "0.0.0";
  const pageHtml = shellHtml.replace("<!-- SECTIONS -->", sectionsHtml);
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
            path === "/api/upload")) ||
        (method === "DELETE" && path === "/api/upload");

      if (isWrite) {
        if (!guarded(req)) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        try {
          // File upload (raw binary, not JSON)
          if (method === "POST" && path === "/api/upload") {
            const safe = safeAttachName(url.searchParams.get("name") || "");
            if (!safe) {
              return Response.json({ error: "invalid filename" }, { status: 400 });
            }
            const dir = attachDir(activeRepo);
            mkdirSync(dir, { recursive: true });
            const dest = join(dir, safe);
            // safeAttachName() strips path separators via basename, so
            // dest is always under dir. No need to re-verify.
            const blob = await req.blob();
            if (blob.size > ATTACH_CAP) {
              return Response.json({ error: "file too large" }, { status: 400 });
            }
            await Bun.write(dest, blob);
            const att: Attachment = {
              name: safe,
              size: blob.size,
              type: safe.split(".").pop()?.toLowerCase() ?? "",
              skill: skillForFile(safe),
            };
            const attachments = syncAttachments(activeRepo);
            return Response.json({ ok: true, attachment: att, attachments });
          }

          if (method === "DELETE" && path === "/api/upload") {
            const safe = safeAttachName(url.searchParams.get("name") || "");
            if (!safe) {
              return Response.json({ error: "invalid filename" }, { status: 400 });
            }
            const target = join(attachDir(activeRepo), safe);
            if (existsSync(target)) unlinkSync(target);
            const attachments = syncAttachments(activeRepo);
            return Response.json({ ok: true, attachments });
          }

          const payload = (await req.json()) as Record<string, unknown>;

          if (path === "/api/detect") {
            const det = detectRepo(typeof payload.path === "string" ? payload.path : undefined);
            activeRepo = det.repo;
            return Response.json({
              ok: true,
              ...det,
              state: readState(activeRepo),
            });
          }

          if (path === "/api/init") {
            if (typeof payload.repoPath === "string") activeRepo = resolveRepo(payload.repoPath);
            const { files, state } = applyIntake(payload, {
              useAi: payload.useAi === true,
              base: activeRepo,
            });
            return Response.json({ ok: true, files, state });
          }

          if (path === "/api/dispatch") {
            const result = applyDispatch(String(payload.engine ?? ""), activeRepo);
            if (!result) {
              return Response.json({ error: "invalid engine" }, { status: 400 });
            }
            return Response.json({ ok: true, ...result });
          }

          if (path === "/api/orchestrate") {
            const engine = typeof payload.engine === "string" ? payload.engine : "claude";
            await orchestrate({ engine, dry: true }, activeRepo);
            return Response.json({ ok: true, state: readState(activeRepo) });
          }

          if (path === "/api/discover") {
            const kind = payload.kind === "skills" ? "skills" : "docs";
            const query = String(payload.query ?? "").trim();
            if (!query) {
              return Response.json({ error: "query required" }, { status: 400 });
            }
            const outcome =
              kind === "docs"
                ? await lookupDocsHttp(query, {
                    approved: payload.approved === true,
                  })
                : await searchSkillsHttp(query, {
                    approved: payload.approved === true,
                  });
            return Response.json({ ...outcome });
          }

          if (path === "/api/units") {
            const action = String(payload.action ?? "");
            if (action !== "add" && action !== "update" && action !== "delete") {
              return Response.json({ error: "invalid action" }, { status: 400 });
            }
            const unit = (payload.unit ?? {}) as { name?: string };
            const state = mutateUnits(activeRepo, action, unit);
            if (!state) {
              return Response.json({ error: "no workflow or unit not found" }, { status: 400 });
            }
            return Response.json({ ok: true, state });
          }

          if (path === "/api/preflight") {
            return Response.json(runPreflight(payload));
          }

          // biome-ignore format: keep compact so `}` is not a standalone line (bun:coverage gap)
          if (path === "/api/settings") { applySettings(activeRepo, payload); return Response.json({ ok: true, ...settingsView(activeRepo) }); }
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
