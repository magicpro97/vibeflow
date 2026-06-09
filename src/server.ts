import { randomUUID } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
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
import { type EngineReadiness, type PreflightOpts, anyReady, preflightAll } from "./preflight.js";
import { scanRepo } from "./scanner.js";
import { type VibeSettings, readSettings, writeSettings } from "./settings.js";
import { discoverSkills } from "./skills/registry.js";
import { resolveSkillNeeds } from "./skills/resolver.js";
import { TOOLS, TOOL_ORDER } from "./tools/index.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const pageHtml = readFileSync(new URL("./server.html", import.meta.url), "utf8");

/** Exact host/origin match — guards against DNS-rebinding and cross-origin writes. */
function hostAllowed(req: IncomingMessage): boolean {
  const host = (req.headers.host || "").replace(/:\d+$/, "");
  return LOOPBACK.has(host);
}
function originAllowed(req: IncomingMessage): boolean {
  const o = req.headers.origin || req.headers.referer;
  if (!o) return true; // same-origin fetch may omit Origin; token + host still apply
  try {
    return LOOPBACK.has(new URL(o).hostname);
  } catch {
    return false;
  }
}

function readJsonBody(req: IncomingMessage, cap = 65536): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      try {
        resolve(body ? (JSON.parse(body) as Record<string, unknown>) : {});
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

const ATTACH_CAP = 50 * 1024 * 1024; // 50 MB per file

function attachDir(repo: string): string {
  return join(repo, CTX_DIR, "attachments");
}

/**
 * Sanitize an upload name to a single safe path segment within the attachments dir.
 * Rejects path separators, traversal, control/null bytes, dotfiles, and over-long names.
 */
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

/** Mirror the on-disk attachment list into the saved ledger so the dashboard reflects it. */
function syncAttachments(repo: string): Attachment[] {
  const items = listAttachments(repo);
  const state = readState(repo);
  if (state) {
    state.attachments = items;
    writeState(repo, state);
  }
  return items;
}

/** Stream a raw request body to a capped, sanitized file under the attachments dir. */
function saveUpload(req: IncomingMessage, repo: string, rawName: string): Promise<Attachment> {
  return new Promise((resolvePromise, reject) => {
    const safe = safeAttachName(rawName);
    if (!safe) {
      reject(new Error("invalid filename"));
      return;
    }
    const dir = attachDir(repo);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, safe);
    // Defense in depth: ensure the resolved path stays inside the attachments dir.
    if (!resolve(dest).startsWith(resolve(dir) + sep)) {
      reject(new Error("invalid path"));
      return;
    }
    let size = 0;
    let aborted = false;
    const out = createWriteStream(dest);
    const fail = (msg: string) => {
      if (aborted) return;
      aborted = true;
      out.destroy();
      try {
        unlinkSync(dest);
      } catch {
        /* ignore */
      }
      reject(new Error(msg));
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > ATTACH_CAP) {
        fail("file too large");
        req.destroy();
        return;
      }
      out.write(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      out.end(() =>
        resolvePromise({
          name: safe,
          size,
          type: safe.split(".").pop()?.toLowerCase() ?? "",
          skill: skillForFile(safe),
        }),
      );
    });
    req.on("error", () => fail("upload error"));
    out.on("error", () => fail("write error"));
  });
}

/** Read the engine list a preflight request asks about; default to all known engines. */
function requestedEngines(payload: Record<string, unknown>): Engine[] {
  const raw = payload.engines;
  if (!Array.isArray(raw)) return [...ENGINES];
  const want = new Set(raw.filter((e): e is string => typeof e === "string"));
  const picked = ENGINES.filter((e) => want.has(e));
  return picked.length ? picked : [...ENGINES];
}

/**
 * Run the readiness check for the requested engines. Probing spawns real engines locally
 * (acceptable on the loopback server, off the hot path — only on explicit request). The
 * client may pass `probe:false` for a fast presence/auth pass with no engine spawn.
 */
function runPreflight(payload: Record<string, unknown>): {
  ok: boolean;
  readiness: EngineReadiness[];
  anyReady: boolean;
} {
  const opts: PreflightOpts = { probe: payload.probe !== false };
  const readiness = preflightAll(requestedEngines(payload), opts);
  return { ok: true, readiness, anyReady: anyReady(readiness) };
}

/** Languages detected in the active repo, used to build per-tool install plans. */
function repoLanguages(repo: string): string[] {
  try {
    return scanRepo(repo).languages;
  } catch {
    return [];
  }
}

/** One optional tool's view: current install state + the plan text (commands the user runs). */
interface ToolView {
  name: string;
  title: string;
  description: string;
  installed: boolean;
  plan: string[];
  command: string;
}

/** Build the optional-tools view (codegraph + lsp). Pure: detection only, no installs. */
function toolViews(repo: string): ToolView[] {
  const languages = repoLanguages(repo);
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

/** GET /api/settings payload: persisted settings + the optional-tools view. */
function settingsView(repo: string): {
  settings: VibeSettings;
  tools: ToolView[];
} {
  return { settings: readSettings(repo), tools: toolViews(repo) };
}

/** Apply a settings toggle from the browser (codegraph/lsp only); never installs software. */
function applySettings(repo: string, payload: Record<string, unknown>): VibeSettings {
  const raw = (payload.tools ?? {}) as Record<string, unknown>;
  const tools = { ...readSettings(repo).tools };
  if (typeof raw.codegraph === "boolean") tools.codegraph = raw.codegraph;
  if (typeof raw.lsp === "boolean") tools.lsp = raw.lsp;
  return writeSettings(repo, { tools });
}

export function startServer(port = 0): Promise<{ server: Server; url: string }> {
  // Per-process CSRF token: embedded in the page, required on every write request.
  const token = randomUUID();
  const html = pageHtml.replace(/__CSRF__/g, token);
  // Single active repo for this server; updated by POST /api/detect (default: cwd).
  let activeRepo = cwd();

  const guarded = (req: IncomingMessage): boolean =>
    hostAllowed(req) && originAllowed(req) && req.headers["x-vibeflow-token"] === token;

  const server = createServer(async (req, res) => {
    const method = req.method || "GET";
    const fullUrl = req.url || "/";
    const url = fullUrl.split("?")[0] || "/";
    const query = new URLSearchParams(fullUrl.split("?")[1] || "");

    if (method === "GET" && (url === "/" || url.startsWith("/index"))) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
        "x-content-type-options": "nosniff",
      });
      res.end(html);
      return;
    }
    if (method === "GET" && url === "/state") {
      sendJson(res, 200, readState(activeRepo));
      return;
    }
    if (method === "GET" && url === "/api/attachments") {
      sendJson(res, 200, { attachments: listAttachments(activeRepo) });
      return;
    }
    if (method === "GET" && url === "/api/skills") {
      const state = readState(activeRepo);
      const needs = resolveSkillNeeds({
        repo: activeRepo,
        attachments: (state?.attachments ?? []).map((a) => a.name),
        task: state?.goal,
        profile: scanRepo(activeRepo),
      });
      sendJson(res, 200, { skills: discoverSkills(activeRepo), needs });
      return;
    }
    if (method === "GET" && url === "/api/settings") {
      sendJson(res, 200, settingsView(activeRepo));
      return;
    }
    if (method === "GET" && url === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      let last = "";
      const tick = () => {
        const state: WorkflowState | null = readState(activeRepo);
        const json = JSON.stringify(state);
        if (json !== last) {
          last = json;
          res.write(`data: ${json}\n\n`);
        }
      };
      tick();
      const timer = setInterval(tick, 1000);
      req.on("close", () => clearInterval(timer));
      return;
    }

    // --- Write surface: all guarded by CSRF token + loopback Host/Origin ---
    const isWrite =
      (method === "POST" &&
        (url === "/api/init" ||
          url === "/api/dispatch" ||
          url === "/api/detect" ||
          url === "/api/units" ||
          url === "/api/orchestrate" ||
          url === "/api/discover" ||
          url === "/api/preflight" ||
          url === "/api/settings" ||
          url === "/api/upload")) ||
      (method === "DELETE" && url === "/api/upload");
    if (isWrite) {
      if (!guarded(req)) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }
      try {
        // Raw binary upload — streamed, not JSON-parsed.
        if (method === "POST" && url === "/api/upload") {
          const att = await saveUpload(req, activeRepo, query.get("name") || "");
          const attachments = syncAttachments(activeRepo);
          sendJson(res, 200, { ok: true, attachment: att, attachments });
          return;
        }
        if (method === "DELETE" && url === "/api/upload") {
          const safe = safeAttachName(query.get("name") || "");
          if (!safe) {
            sendJson(res, 400, { error: "invalid filename" });
            return;
          }
          const target = join(attachDir(activeRepo), safe);
          if (existsSync(target)) unlinkSync(target);
          const attachments = syncAttachments(activeRepo);
          sendJson(res, 200, { ok: true, attachments });
          return;
        }

        const payload = await readJsonBody(req);
        if (url === "/api/detect") {
          const det = detectRepo(typeof payload.path === "string" ? payload.path : undefined);
          activeRepo = det.repo;
          sendJson(res, 200, {
            ok: true,
            ...det,
            state: readState(activeRepo),
          });
        } else if (url === "/api/init") {
          if (typeof payload.repoPath === "string") activeRepo = resolveRepo(payload.repoPath);
          // useAi:false — a browser request must never shell out to $VIBEFLOW_AI.
          const { files, state } = applyIntake(payload, {
            useAi: false,
            base: activeRepo,
          });
          sendJson(res, 200, { ok: true, files, state });
        } else if (url === "/api/dispatch") {
          const result = applyDispatch(String(payload.engine ?? ""), activeRepo);
          if (!result) {
            sendJson(res, 400, { error: "invalid engine" });
            return;
          }
          sendJson(res, 200, { ok: true, ...result });
        } else if (url === "/api/orchestrate") {
          // Browser-initiated orchestration is always dry (prompts only) — it must never
          // shell out to a real engine or $VIBEFLOW_AI from a web request.
          const engine = typeof payload.engine === "string" ? payload.engine : "claude";
          await orchestrate({ engine, dry: true }, activeRepo);
          sendJson(res, 200, { ok: true, state: readState(activeRepo) });
        } else if (url === "/api/discover") {
          const kind = payload.kind === "skills" ? "skills" : "docs";
          const query = String(payload.query ?? "").trim();
          const approved = payload.approved === true;
          if (!query) {
            sendJson(res, 400, { error: "query required" });
            return;
          }
          const outcome =
            kind === "docs"
              ? await lookupDocsHttp(query, { approved })
              : await searchSkillsHttp(query, { approved });
          sendJson(res, 200, { ...outcome });
        } else if (url === "/api/units") {
          const action = String(payload.action ?? "");
          if (action !== "add" && action !== "update" && action !== "delete") {
            sendJson(res, 400, { error: "invalid action" });
            return;
          }
          const unit = (payload.unit ?? {}) as { name?: string };
          const state = mutateUnits(activeRepo, action, unit);
          if (!state) {
            sendJson(res, 400, { error: "no workflow or unit not found" });
            return;
          }
          sendJson(res, 200, { ok: true, state });
        } else if (url === "/api/preflight") {
          sendJson(res, 200, runPreflight(payload));
        } else if (url === "/api/settings") {
          applySettings(activeRepo, payload);
          sendJson(res, 200, { ok: true, ...settingsView(activeRepo) });
        }
      } catch (err) {
        sendJson(res, 400, { error: (err as Error).message });
      }
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });
  const nextPort = () => 41000 + Math.floor(Math.random() * 20000);

  return new Promise((resolvePromise, reject) => {
    let attempts = 0;
    const listen = (targetPort: number) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off("error", onError);
        if (port === 0 && err.code === "EADDRINUSE" && attempts < 20) {
          attempts++;
          listen(nextPort());
          return;
        }
        reject(err);
      };
      server.once("error", onError);
      // Bind to loopback only — never expose publicly (SECURITY_MODEL).
      server.listen(targetPort, "127.0.0.1", () => {
        server.off("error", onError);
        const addr = server.address();
        const boundPort = typeof addr === "object" && addr ? addr.port : targetPort;
        const url = `http://127.0.0.1:${boundPort}`;
        console.log(`${c.cyan("VibeFlow UI")} → ${c.bold(url)}  ${c.dim("(Ctrl+C to stop)")}`);
        resolvePromise({ server, url });
      });
    };
    listen(port === 0 ? nextPort() : port);
  });
}
