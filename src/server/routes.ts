import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
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
import { type Attachment, readState } from "../core.js";
import { lookupDocsHttp, searchSkillsHttp } from "../discovery/context7.js";
import {
  ATTACH_CAP,
  applySettings,
  attachDir,
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
    await Bun.write(dest, blob);
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

  const payload = (await req.json()) as Record<string, unknown>;

  if (path === "/api/detect") {
    const det = detectRepo(typeof payload.path === "string" ? payload.path : undefined);
    ctx.setActiveRepo(det.repo);
    return Response.json({
      ok: true,
      ...det,
      state: readState(ctx.getActiveRepo()),
    });
  }

  if (path === "/api/init") {
    if (typeof payload.repoPath === "string") ctx.setActiveRepo(resolveRepo(payload.repoPath));
    const { files, state } = applyIntake(payload, {
      useAi: payload.useAi === true,
      base: ctx.getActiveRepo(),
    });
    return Response.json({ ok: true, files, state });
  }

  if (path === "/api/dispatch") {
    const result = applyDispatch(String(payload.engine ?? ""), ctx.getActiveRepo());
    if (!result) {
      return Response.json({ error: "invalid engine" }, { status: 400 });
    }
    return Response.json({ ok: true, ...result });
  }

  if (path === "/api/orchestrate") {
    const engine = typeof payload.engine === "string" ? payload.engine : "claude";
    await orchestrate({ engine, dry: true }, ctx.getActiveRepo());
    return Response.json({ ok: true, state: readState(ctx.getActiveRepo()) });
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
    const state = mutateUnits(ctx.getActiveRepo(), action, unit);
    if (!state) {
      return Response.json({ error: "no workflow or unit not found" }, { status: 400 });
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
