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
import { createFetchHandler } from "./server-handler.js";

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

// ── startServer ──

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

  // ponytail: pass deps as plain object to avoid complex interface
  const deps = {
    ATTACH_CAP,
    ASSETS_DIR,
    ASSET_TYPES,
    CSP,
    attachDir,
    safeAttachName,
    listAttachments,
    syncAttachments,
    requestedEngines,
    runPreflight,
    replayFromLog,
    settingsView,
    applySettings,
    readState,
    writeState,
    scanRepo,
    discoverSkills,
    resolveSkillNeeds,
    getLogbus,
    detectRepo,
    resolveRepo,
    applyIntake,
    applyDispatch,
    orchestrate,
    mutateUnits,
    lookupDocsHttp,
    searchSkillsHttp,
    skillForFile,
    existsSync,
    mkdirSync,
    createWriteStream,
  };

  const server = Bun.serve({
    port: port === 0 ? 0 : port,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req: Request): Promise<Response> {
      const handler = await createFetchHandler(
        {
          activeRepo,
          setActiveRepo: (r) => { activeRepo = r; },
          token,
          cachedHtml,
          isLoopback,
          guarded,
        },
        deps,
      );
      return handler(req);
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
