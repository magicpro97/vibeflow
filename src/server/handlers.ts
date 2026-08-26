import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { skillForFile } from "../commands.js";
import { type Attachment, CTX_DIR, ENGINES, type Engine, readState, writeState } from "../core.js";
import type { LogEvent } from "../logbus.js";
import {
  type EngineReadiness,
  type PreflightOpts,
  anyReady,
  preflightAll,
  preflightAllAsync,
} from "../preflight.js";
import { type ProjectProfile, scanRepo } from "../scanner.js";
import { type VibeSettings, readSettings, writeSettings } from "../settings.js";
import { TOOLS, TOOL_ORDER } from "../tools/index.js";

export const ATTACH_CAP = 50 * 1024 * 1024;

export function attachDir(repo: string): string {
  return join(repo, CTX_DIR, "attachments");
}

/** Extensions VibeFlow can process — anything else is rejected at upload. */
const ALLOWED_ATTACH_EXTS = new Set([
  "md",
  "markdown",
  "txt",
  "log", // agent context files
  "doc",
  "docx",
  "xls",
  "xlsx",
  "csv",
  "tsv",
  "ppt",
  "pptx",
  "pdf",
  "json",
  "yaml",
  "yml",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
]);

export function safeAttachName(raw: string): string | null {
  const base = basename(String(raw || "").trim());
  if (!base || base === "." || base === "..") return null;
  if (base.startsWith(".")) return null;
  if (/[\\/\0]/.test(base)) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control bytes in filenames
  if (/[\u0000-\u001f]/.test(base)) return null;
  if (base.length > 200) return null;
  const ext = base.split(".").pop()?.toLowerCase() ?? "";
  if (!ALLOWED_ATTACH_EXTS.has(ext)) return null;
  return base;
}

export function listAttachments(repo: string): Attachment[] {
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

export function syncAttachments(repo: string): Attachment[] {
  const items = listAttachments(repo);
  const state = readState(repo);
  if (state) {
    state.attachments = items;
    writeState(repo, state);
  }
  return items;
}

export function requestedEngines(payload: Record<string, unknown>): Engine[] {
  const raw = payload.engines;
  if (!Array.isArray(raw)) return [...ENGINES];
  const want = new Set(raw.filter((e): e is string => typeof e === "string"));
  const picked = ENGINES.filter((e) => want.has(e));
  return picked.length ? picked : [...ENGINES];
}

export async function runPreflight(payload: Record<string, unknown>): Promise<{
  ok: boolean;
  readiness: EngineReadiness[];
  anyReady: boolean;
}> {
  const opts: PreflightOpts = { probe: payload.probe !== false };
  const readiness = opts.probe
    ? await preflightAllAsync(requestedEngines(payload), opts)
    : preflightAll(requestedEngines(payload), opts);
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

export interface ToolView {
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

export function applySettings(repo: string, payload: Record<string, unknown>): VibeSettings {
  // Pass full payload to writeSettings — it handles tools, memory, toolPriority,
  // failureProtection, hooks, lspServers via its coerce/merge logic.
  // ponytail: was only saving tools before, silently dropping everything else
  return writeSettings(repo, payload as Partial<VibeSettings>);
}

// Test seam: exported so unit tests can exercise the small/large file
// paths (line 177-188) without going through the SSE handler.
export function replayFromLog(
  filePath: string,
  since: number,
  limit: number,
  runId?: string,
): LogEvent[] {
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
        if (runId !== undefined && ev.runId !== runId) continue;
        events.push(ev);
        if (events.length >= limit) break;
      }
    } catch {
      /* skip malformed lines */
    }
  }
  return events;
}
