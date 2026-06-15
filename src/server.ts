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
  if (/[\\\/\0]/.test(base)) return null;
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

// ---------------------------------------------------------------------------
// Pure-function route handlers (testable without Bun.serve)
// ---------------------------------------------------------------------------

/** Shared context passed to every route handler. */
export interface ServerCtx {
  activeRepo: string;
  token: string;
  cachedHtml: string;
  /** Per-request bus lookup so tests can swap the global logbus. */
  bus: ReturnType<typeof getLogbus>;
}

/** Build the initial context for a server. */
export function makeCtx(activeRepo: string, token: string, cachedHtml: string): ServerCtx {
  return { activeRepo, token, cachedHtml, bus: getLogbus() };
}

function isLoopback(host: string): boolean {
  return LOOPBACK.has(host.replace(/:\d+$/, ""));
}

/** Mirrors the in-server `guarded()` function for tests. */
export function isGuarded(req: Request, token: string): boolean {
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
}

const NOT_FOUND_TEXT = new Response("not found", { status: 404 });

/** GET / and /index* → HTML shell */
export async function handleIndexRoute(req: Request, ctx: ServerCtx): Promise<Response> {
  return new Response(ctx.cachedHtml, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
    },
  });
}

/** GET /state → WorkflowState JSON */
export async function handleStateRoute(req: Request, ctx: ServerCtx): Promise<Response> {
  return Response.json(readState(ctx.activeRepo));
}

/** GET /api/markers */
export async function handleMarkersRoute(req: Request, _ctx: ServerCtx): Promise<Response> {
  const m = await import("./orchestrator/marker.js");
  return Response.json({ markers: m.listMarkers() });
}

/** GET /api/attachments */
export async function handleAttachmentsRoute(req: Request, ctx: ServerCtx): Promise<Response> {
  return Response.json({ attachments: listAttachments(ctx.activeRepo) });
}

/** GET /api/skills */
export async function handleSkillsRoute(req: Request, ctx: ServerCtx): Promise<Response> {
  const state = readState(ctx.activeRepo);
  const needs = resolveSkillNeeds({
    repo: ctx.activeRepo,
    attachments: (state?.attachments ?? []).map((a) => a.name),
    task: state?.goal,
    profile: scanRepo(ctx.activeRepo),
  });
  return Response.json({ skills: discoverSkills(ctx.activeRepo), needs });
}

/** GET /api/settings */
export async function handleSettingsGetRoute(req: Request, ctx: ServerCtx): Promise<Response> {
  return Response.json(settingsView(ctx.activeRepo));
}

/**
 * GET /api/logs/stream → SSE
 * Returns null to indicate the route didn't match (caller should 404).
 * The bus param may be null to force the "no logbus" branch in tests.
 */
export function handleLogsStreamRoute(
  req: Request,
  ctx: ServerCtx,
  bus: ReturnType<typeof getLogbus> | null = ctx.bus,
): Response {
  let cleanup: (() => void) | undefined;
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(": vibeflow-logs-1\n\n"));
        if (!bus) {
          controller.enqueue(
            new TextEncoder().encode(
              ": no logbus instance found — log events will appear when the CLI starts\n\n",
            ),
          );
        } else {
          try {
            const caught = replayFromLog(bus.currentFile(), 0, 1000);
            for (const ev of caught) {
              controller.enqueue(
                new TextEncoder().encode(`event: log\ndata: ${JSON.stringify(ev)}\n\n`),
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
          () => safeEnqueue(new TextEncoder().encode(": keepalive\n\n")),
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

/** GET /api/logs/recent */
export async function handleLogsRecentRoute(
  req: Request,
  ctx: ServerCtx,
  bus: ReturnType<typeof getLogbus> | null = ctx.bus,
): Promise<Response> {
  if (!bus) {
    return Response.json({ error: "no logbus instance" }, { status: 404 });
  }
  const url = new URL(req.url);
  const since = Math.max(0, Number(url.searchParams.get("since") ?? "0"));
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? "100")));
  return Response.json({
    events: replayFromLog(bus.currentFile(), since, limit),
  });
}

/** GET /events (deprecated SSE) */
export function handleEventsRoute(req: Request, ctx: ServerCtx): Response {
  let last = "";
  const streamPositions = new Map<string, number>();
  return new Response(
    new ReadableStream({
      start(controller) {
        const tick = () => {
          const state: WorkflowState | null = readState(ctx.activeRepo);
          const json = JSON.stringify(state);
          if (json !== last) {
            last = json;
            controller.enqueue(new TextEncoder().encode(`data: ${json}\n\n`));
          }
          if (state) {
            for (const u of state.work_units ?? []) {
              try {
                const span = join(ctx.activeRepo, CTX_DIR, "workunits", u.name, "stream.log");
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

/** POST /api/upload — write a file attachment. */
export async function handleUploadPostRoute(
  req: Request,
  ctx: ServerCtx,
): Promise<Response> {
  const url = new URL(req.url);
  const safe = safeAttachName(url.searchParams.get("name") || "");
  if (!safe) {
    return Response.json({ error: "invalid filename" }, { status: 400 });
  }
  const dir = attachDir(ctx.activeRepo);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, safe);
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
  const attachments = syncAttachments(ctx.activeRepo);
  return Response.json({ ok: true, attachment: att, attachments });
}

/** DELETE /api/upload — remove an attachment. */
export async function handleUploadDeleteRoute(
  req: Request,
  ctx: ServerCtx,
): Promise<Response> {
  const url = new URL(req.url);
  const safe = safeAttachName(url.searchParams.get("name") || "");
  if (!safe) {
    return Response.json({ error: "invalid filename" }, { status: 400 });
  }
  const target = join(attachDir(ctx.activeRepo), safe);
  if (existsSync(target)) unlinkSync(target);
  const attachments = syncAttachments(ctx.activeRepo);
  return Response.json({ ok: true, attachments });
}

/** JSON write-route dispatcher. Returns null when the path doesn't match. */
export async function handleWriteJsonRoute(
  path: string,
  payload: Record<string, unknown>,
  ctx: ServerCtx,
): Promise<Response | null> {
  if (path === "/api/detect") {
    const det = detectRepo(typeof payload.path === "string" ? payload.path : undefined);
    ctx.activeRepo = det.repo;
    return Response.json({
      ok: true,
      ...det,
      state: readState(ctx.activeRepo),
    });
  }

  if (path === "/api/init") {
    if (typeof payload.repoPath === "string") ctx.activeRepo = resolveRepo(payload.repoPath);
    const { files, state } = applyIntake(payload, {
      useAi: payload.useAi === true,
      base: ctx.activeRepo,
    });
    return Response.json({ ok: true, files, state });
  }

  if (path === "/api/dispatch") {
    const result = applyDispatch(String(payload.engine ?? ""), ctx.activeRepo);
    if (!result) {
      return Response.json({ error: "invalid engine" }, { status: 400 });
    }
    return Response.json({ ok: true, ...result });
  }

  if (path === "/api/orchestrate") {
    const engine = typeof payload.engine === "string" ? payload.engine : "claude";
    await orchestrate({ engine, dry: true }, ctx.activeRepo);
    return Response.json({ ok: true, state: readState(ctx.activeRepo) });
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
    const state = mutateUnits(ctx.activeRepo, action, unit);
    if (!state) {
      return Response.json({ error: "no workflow or unit not found" }, { status: 400 });
    }
    return Response.json({ ok: true, state });
  }

  if (path === "/api/preflight") {
    return Response.json(runPreflight(payload));
  }

  if (path === "/api/settings") {
    applySettings(ctx.activeRepo, payload);
    return Response.json({ ok: true, ...settingsView(ctx.activeRepo) });
  }

  return null;
}

/** Static-asset handler. */
export async function handleAssetRoute(
  req: Request,
  _ctx: ServerCtx,
  assetsDir: URL = ASSETS_DIR,
  assetTypes: Record<string, string> = ASSET_TYPES,
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const rel = path.slice("/assets/".length);
  if (!rel || rel.includes("..") || rel.includes("\\0"))
    return new Response("not found", { status: 404 });
  const fileUrl = new URL(rel, assetsDir);
  if (!fileUrl.href.startsWith(assetsDir.href))
    return new Response("not found", { status: 404 });
  const ext = rel.slice(rel.lastIndexOf("."));
  const type = assetTypes[ext];
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

/**
 * Single dispatch entry-point used by both `startServer()` and unit tests.
 * Returns a `Response` for any incoming request.
 *
 * Optional `overrides` allow tests to swap the bus or asset directory.
 */
export async function handleRequest(
  req: Request,
  ctx: ServerCtx,
  overrides: {
    bus?: ReturnType<typeof getLogbus> | null;
    assetsDir?: URL;
    assetTypes?: Record<string, string>;
  } = {},
): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;
  const path = url.pathname;

  // --- GET / (HTML page) ---
  if (method === "GET" && (path === "/" || path.startsWith("/index"))) {
    return handleIndexRoute(req, ctx);
  }

  // --- GET /state ---
  if (method === "GET" && path === "/state") {
    return handleStateRoute(req, ctx);
  }

  // --- GET /api/markers ---
  if (method === "GET" && path === "/api/markers") {
    return handleMarkersRoute(req, ctx);
  }

  // --- GET /api/attachments ---
  if (method === "GET" && path === "/api/attachments") {
    return handleAttachmentsRoute(req, ctx);
  }

  // --- GET /api/skills ---
  if (method === "GET" && path === "/api/skills") {
    return handleSkillsRoute(req, ctx);
  }

  // --- GET /api/settings ---
  if (method === "GET" && path === "/api/settings") {
    return handleSettingsGetRoute(req, ctx);
  }

  // --- SSE: /api/logs/stream ---
  if (method === "GET" && path === "/api/logs/stream") {
    return handleLogsStreamRoute(req, ctx, overrides.bus ?? ctx.bus);
  }

  // --- GET /api/logs/recent ---
  if (method === "GET" && path === "/api/logs/recent") {
    return handleLogsRecentRoute(req, ctx, overrides.bus ?? ctx.bus);
  }

  // --- GET /events (deprecated SSE) ---
  if (method === "GET" && path === "/events") {
    return handleEventsRoute(req, ctx);
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
    if (!isGuarded(req, ctx.token)) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    try {
      // File upload (raw binary, not JSON)
      if (method === "POST" && path === "/api/upload") {
        return await handleUploadPostRoute(req, ctx);
      }

      if (method === "DELETE" && path === "/api/upload") {
        return await handleUploadDeleteRoute(req, ctx);
      }

      const payload = (await req.json()) as Record<string, unknown>;
      const result = await handleWriteJsonRoute(path, payload, ctx);
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
    return handleAssetRoute(req, ctx, overrides.assetsDir, overrides.assetTypes);
  }

  return NOT_FOUND_TEXT;
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

  const ctx: ServerCtx = makeCtx(cwd(), token, cachedHtml);

  const server = Bun.serve({
    port: port === 0 ? 0 : port,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req: Request): Promise<Response> {
      // Rebuild ctx with the latest global bus on every request so test
      // overrides of setLogbusForTests(...) are picked up.
      const live: ServerCtx = { ...ctx, bus: getLogbus() };
      return handleRequest(req, live);
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
