import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  applyDispatch,
  applyIntake,
  detectRepo,
  mutateUnits,
  orchestrate,
  resolveRepo,
  skillForFile,
} from "../commands.js";
import { collectVerifyReportAsync } from "../commands/tools-detect.js";
import { type Attachment, CTX_DIR, readState, statePath } from "../core.js";
import { lookupDocsHttp, searchSkillsHttp } from "../discovery/context7.js";
import { type ProjectEntry, readRegistry, upsertRegistry } from "../registry.js";
import {
  ATTACH_CAP,
  applySettings,
  attachDir,
  replayFromLog,
  runPreflight,
  safeAttachName,
  settingsView,
  syncAttachments,
} from "./handlers.js";

export interface RouteCtx {
  getActiveRepo: () => string;
  setActiveRepo: (repo: string) => void;
}

export async function handleMutationRoute(
  ctx: RouteCtx,
  method: string,
  path: string,
  req: Request,
  url: URL,
): Promise<Response | null> {
  // File upload (raw binary, not JSON)
  if (method === "POST" && path === "/api/upload") {
    const safe = safeAttachName(url.searchParams.get("name") || "");
    if (!safe) {
      return Response.json({ error: "invalid filename" }, { status: 400 });
    }
    const dir = attachDir(ctx.getActiveRepo());
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, safe);
    // safeAttachName() strips path separators via basename, so
    // dest is always under dir. No need to re-verify.
    const blob = await req.blob();
    if (blob.size > ATTACH_CAP) {
      return Response.json({ error: "file too large" }, { status: 400 });
    }
    await Bun.write(dest, Buffer.from(await blob.arrayBuffer()));
    const att: Attachment = {
      name: safe,
      size: blob.size,
      type: safe.split(".").pop()?.toLowerCase() ?? "",
      skill: skillForFile(safe),
    };
    const attachments = syncAttachments(ctx.getActiveRepo());
    return Response.json({ ok: true, attachment: att, attachments });
  }

  if (method === "DELETE" && path === "/api/upload") {
    const safe = safeAttachName(url.searchParams.get("name") || "");
    if (!safe) {
      return Response.json({ error: "invalid filename" }, { status: 400 });
    }
    const target = join(attachDir(ctx.getActiveRepo()), safe);
    if (existsSync(target)) unlinkSync(target);
    const attachments = syncAttachments(ctx.getActiveRepo());
    return Response.json({ ok: true, attachments });
  }

  if (method === "DELETE" && path === "/api/state") {
    const p = statePath(ctx.getActiveRepo());
    if (existsSync(p)) unlinkSync(p);
    return Response.json({ ok: true });
  }

  const payload = (await req.json()) as Record<string, unknown>;

  if (path === "/api/detect") {
    const rawPath = typeof payload.path === "string" ? payload.path.trim() : "";
    // Validate: if a path was supplied, it must exist and be a directory.
    // resolveRepo() silently falls back to cwd() for non-existent paths — that
    // would make detect appear to succeed with the wrong repo, so we catch it here.
    if (rawPath) {
      const abs = isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath);
      let valid = false;
      try {
        valid = statSync(abs).isDirectory();
      } catch {
        /* path does not exist */
      }
      if (!valid) {
        return Response.json(
          { error: `path not found or not a directory: ${rawPath}` },
          { status: 400 },
        );
      }
    }
    const det = detectRepo(rawPath || undefined);
    ctx.setActiveRepo(det.repo);
    return Response.json({
      ok: true,
      ...det,
      state: readState(ctx.getActiveRepo()),
    });
  }

  if (path === "/api/init") {
    // Validate required fields + size limits before passing to applyIntake
    const goal = payload.goal;
    if (typeof goal !== "string" || !goal.trim()) {
      return Response.json({ error: "goal is required" }, { status: 400 });
    }
    if (goal.trim() === "__CLEAR__") {
      return Response.json({ error: "reserved goal value" }, { status: 400 });
    }
    if (goal.length > 10_000) {
      return Response.json({ error: "goal too long (max 10,000 chars)" }, { status: 400 });
    }
    // Clamp successCriteria to 100 items — prevents unbounded state file growth
    // Also filter empty/whitespace-only entries; coerce non-arrays to []
    if (!Array.isArray(payload.successCriteria)) {
      payload.successCriteria = []; // reject non-arrays silently
    } else {
      payload.successCriteria = (payload.successCriteria as unknown[])
        .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
        .slice(0, 100);
    }
    if (typeof payload.repoPath === "string" && payload.repoPath.trim()) {
      ctx.setActiveRepo(resolveRepo(payload.repoPath));
    }
    const { files, state } = applyIntake(payload, {
      useAi: payload.useAi === true,
      base: ctx.getActiveRepo(),
    });
    upsertRegistry({
      path: ctx.getActiveRepo(),
      name: "",
      lastUsed: Date.now(),
      goal: String(payload.goal ?? "")
        .trim()
        .slice(0, 500),
      totals: {
        units: state.totals?.units ?? 0,
        done: state.totals?.done ?? 0,
        tokens: state.totals?.tokens ?? 0,
        cost_usd: state.totals?.cost_usd ?? 0,
      },
    } satisfies ProjectEntry);
    return Response.json({ ok: true, files, state });
  }

  if (path === "/api/dispatch") {
    const engineArg = String(payload.engine ?? "");
    // Give a precise error before applyDispatch collapses all null cases to one
    if (!readState(ctx.getActiveRepo())) {
      return Response.json({ error: "no workflow state — run init first" }, { status: 400 });
    }
    const result = applyDispatch(engineArg, ctx.getActiveRepo());
    if (!result) {
      return Response.json({ error: "invalid engine" }, { status: 400 });
    }
    return Response.json({ ok: true, ...result });
  }

  if (path === "/api/orchestrate") {
    if (!readState(ctx.getActiveRepo())) {
      return Response.json({ error: "no workflow state — run init first" }, { status: 400 });
    }
    const engine = typeof payload.engine === "string" ? payload.engine : "claude";
    // dry defaults to true (read-only preview) for backward compat.
    // Web UI passes dry:false to actually run; that also sets yes:true for cli mode.
    const dry = payload.dry !== false;
    const yes = !dry; // yes:true enables cli mode in resolveMode()
    await orchestrate({ engine, dry, yes }, ctx.getActiveRepo());
    return Response.json({ ok: true, state: readState(ctx.getActiveRepo()) });
  }

  if (path === "/api/discover") {
    const rawKind = payload.kind;
    if (rawKind !== "skills" && rawKind !== "docs") {
      return Response.json({ error: 'kind must be "skills" or "docs"' }, { status: 400 });
    }
    const kind = rawKind;
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
    const name = (unit.name ?? "").trim();
    if (!name) {
      return Response.json({ error: "unit name is required" }, { status: 400 });
    }
    if (name.length > 200) {
      return Response.json({ error: "unit name too long (max 200 chars)" }, { status: 400 });
    }
    // Guard against unbounded state file growth
    if (action === "add") {
      const currentState = await import("../core.js").then((m) => m.readState(ctx.getActiveRepo()));
      if (currentState && (currentState.work_units?.length ?? 0) >= 200) {
        return Response.json({ error: "too many work units (max 200)" }, { status: 400 });
      }
    }
    const state = mutateUnits(ctx.getActiveRepo(), action, unit);
    if (!state) {
      let errMsg: string;
      if (action === "add") {
        errMsg = !readState(ctx.getActiveRepo())
          ? "no workflow state — run init first"
          : "unit name already exists";
      } else {
        errMsg = "unit not found";
      }
      return Response.json({ error: errMsg }, { status: 400 });
    }
    return Response.json({ ok: true, state });
  }

  if (path === "/api/preflight") {
    return Response.json(runPreflight(payload));
  }

  // biome-ignore format: keep compact so `}` is not a standalone line (bun:coverage gap)
  if (path === "/api/settings") { applySettings(ctx.getActiveRepo(), payload); return Response.json({ ok: true, ...settingsView(ctx.getActiveRepo()) }); }

  // POST /api/verify — runs collectVerifyReportAsync (B1 seam, non-blocking so Bun.serve
  // keeps serving SSE/state while gates run)
  if (path === "/api/verify") {
    const report = await collectVerifyReportAsync(ctx.getActiveRepo());
    const gates = report.toolchain.map((g) => ({ label: g.label, pass: g.pass }));
    return Response.json({ ok: report.ok, gates, policy: report.policy });
  }

  return null;
}

/** Handle read-only /api/projects/* routes. Returns null if path not matched. */
export function handleProjectsRoute(path: string, url: URL): Response | null {
  if (path === "/api/projects") {
    return Response.json({ projects: readRegistry() });
  }
  if (path === "/api/projects/state") {
    const repoPath = url.searchParams.get("path") ?? "";
    if (!repoPath) return Response.json({ error: "path required" }, { status: 400 });
    const s = readState(repoPath);
    if (!s) return Response.json({ error: "no state" }, { status: 404 });
    return Response.json({ state: s });
  }
  if (path === "/api/projects/logs") {
    const repoPath = url.searchParams.get("path") ?? "";
    const since = Number(url.searchParams.get("since") ?? 0);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 500);
    if (!repoPath) return Response.json({ error: "path required" }, { status: 400 });
    const logFile = join(repoPath, CTX_DIR, "logs", "current.log");
    try {
      const events = replayFromLog(logFile, since, limit);
      return Response.json({ events });
    } catch {
      return Response.json({ events: [] });
    }
  }
  // fallback
  return null;
}
