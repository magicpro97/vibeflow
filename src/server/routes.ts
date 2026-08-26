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
import { collectVerifyReportAsync, defaultGoalEvalFn } from "../commands/tools-detect.js";
import { type Attachment, CTX_DIR, readState, statePath, writeState } from "../core.js";
import { lookupDocsHttp, searchSkillsHttp } from "../discovery/context7.js";
import { writeGuidance } from "../dispatch/guidance.js";
import { type ProjectEntry, deleteRegistry, readRegistry, upsertRegistry } from "../registry.js";
import {
  type ConversationAskCompatibilityHttpAuthorityV1,
  handleConversationAskCompatibilityRoute,
} from "./conversation-ask-compatibility-route.js";
import { handleCuratorSetupRoute } from "./curator-setup-route.js";
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
import { listPending, resolvePending } from "./pending-hooks.js";
import { requestSkillAcquisitionDecisions } from "./pending-skill-acquisitions.js";
import {
  handlePlanReviewCommentsDelete,
  handlePlanReviewCommentsPost,
  handlePlanReviewPost,
} from "./plan-review.js";
import { handleRegistryPreview } from "./registry-route.js";
import { handleSkillAcquisitionDecision } from "./skill-acquisition-route.js";

export interface RouteCtx {
  getActiveRepo: () => string;
  setActiveRepo: (repo: string) => void;
  orchestrateFn?: typeof orchestrate;
  askCompatibility?: ConversationAskCompatibilityHttpAuthorityV1;
}

const GUIDANCE_NOTE_CAP = 100 * 1024;

export async function handleMutationRoute(
  ctx: RouteCtx,
  method: string,
  path: string,
  req: Request,
  url: URL,
): Promise<Response | null> {
  if (method === "POST" && path === "/api/upload") {
    const safe = safeAttachName(url.searchParams.get("name") || "");
    if (!safe) {
      return Response.json({ error: "invalid filename" }, { status: 400 });
    }
    const dir = attachDir(ctx.getActiveRepo());
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, safe);
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

  if (method === "DELETE" && path === "/api/projects") {
    const rawPath = url.searchParams.get("path") ?? "";
    if (!rawPath) return Response.json({ error: "path required" }, { status: 400 });
    deleteRegistry(rawPath);
    return Response.json({ ok: true });
  }

  if (
    method === "DELETE" &&
    (path === "/api/plan-review/comments" || path.startsWith("/api/plan-review/comments/"))
  ) {
    return handlePlanReviewCommentsDelete(ctx.getActiveRepo(), path, url);
  }

  if (method === "POST") {
    const response = await handleCuratorSetupRoute(ctx.getActiveRepo(), path, req);
    if (response) return response;
  }
  if (method === "POST" && path === "/api/ask")
    return handleConversationAskCompatibilityRoute(ctx.askCompatibility, req, ctx.getActiveRepo());
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
    const { files, state } = await applyIntake(payload, {
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
    // Web dry:false selects a real run; acquisition still uses its injected approver.
    const dry = payload.dry !== false;
    const yes = !dry; // yes:true enables cli mode in resolveMode()
    // Stamp evidence so legacy done units satisfy orchestrate's completeness contract.
    if (!dry) {
      const preState = readState(ctx.getActiveRepo());
      if (preState) {
        const ts = new Date().toISOString();
        let prePatched = false;
        for (const u of preState.work_units) {
          if (u.status === "done" && !u.evidence?.length) {
            u.evidence = [`dispatched via web UI at ${ts}`];
            prePatched = true;
          }
        }
        if (prePatched) writeState(ctx.getActiveRepo(), preState);
      }
    }
    await (ctx.orchestrateFn ?? orchestrate)({ engine, dry, yes }, ctx.getActiveRepo(), {
      acquisitionApprover: (proposals) => requestSkillAcquisitionDecisions(proposals),
    });
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
    return Response.json(await runPreflight(payload));
  }

  if (path === "/api/settings" && ("envPolicy" in payload || "hooks" in payload))
    return Response.json({ error: "policy changes require preview approval" }, { status: 400 });
  // biome-ignore format: keep compact so `}` is not a standalone line (bun:coverage gap)
  if (path === "/api/settings") { applySettings(ctx.getActiveRepo(), payload); return Response.json({ ok: true, ...settingsView(ctx.getActiveRepo()) }); }

  // POST /api/verify — async so the server keeps serving state/SSE while gates run.
  if (path === "/api/verify") {
    const goalEval = url.searchParams.get("goal-eval") === "1";
    const currentState = readState(ctx.getActiveRepo());
    const report = await collectVerifyReportAsync(ctx.getActiveRepo(), {
      coverage: true,
      ...(goalEval && currentState?.goal
        ? { goal: currentState.goal, goalEvalFn: defaultGoalEvalFn }
        : {}),
    });
    const gates = report.toolchain.map((g) => ({ label: g.label, pass: g.pass }));
    return Response.json({ ok: report.ok, gates, policy: report.policy });
  }

  if (path === "/api/hook/approve") {
    const id = typeof payload.id === "string" ? payload.id : "";
    const decision = payload.decision === "allow" ? "allow" : "block";
    if (!id) return Response.json({ error: "id required" }, { status: 400 });
    const ok = resolvePending(id, decision);
    if (!ok) return Response.json({ error: "no such pending hook" }, { status: 404 });
    return Response.json({ ok: true });
  }

  if (path === "/api/skills/acquisitions/decision") {
    return handleSkillAcquisitionDecision(payload);
  }

  if (path === "/api/hook/pending") {
    const id = typeof payload.id === "string" ? payload.id : "";
    if (!id) return Response.json({ error: "id required" }, { status: 400 });
    const { registerPending } = await import("./pending-hooks.js");
    registerPending(
      id,
      payload.input as import("../core/types.js").HookInput,
      payload.result as import("../core/types.js").HookResult,
    );
    return Response.json({ ok: true });
  }

  // POST /api/guidance/:unit — UI drops a steering note for a QUEUED unit.
  // Fire-and-forget: append to .vibeflow/guidance/<unit>.md (consumed once at
  // dispatch). ponytail: steers queued units only, not a running one.
  if (path.startsWith("/api/guidance/")) {
    const unit = decodeURIComponent(path.slice("/api/guidance/".length));
    const note = typeof payload.note === "string" ? payload.note : "";
    if (!unit || !note.trim())
      return Response.json({ error: "unit and note required" }, { status: 400 });
    // Cap note length at the trust boundary (#536): the note is untrusted UI input
    // that appends unbounded to an on-disk file. Loopback + CSRF-guarded so this is
    // low-sev, but every other write surface caps (cf. ATTACH_CAP) — match it. Use
    // BYTE length (not String.length UTF-16 units) so a multibyte payload can't write
    // up to ~3-4x the intended cap to disk.
    if (Buffer.byteLength(note, "utf8") > GUIDANCE_NOTE_CAP)
      return Response.json({ error: "note too large" }, { status: 400 });
    writeGuidance(unit, note, { base: ctx.getActiveRepo() });
    return Response.json({ ok: true });
  }

  if (path === "/api/plan-review/revisions") {
    return handlePlanReviewPost(ctx.getActiveRepo(), payload);
  }

  // #688: inert dry-run preview — read-only, never executes. CSRF-guarded
  // because it is a POST, but the body is validated to `update` only.
  if (path === "/api/skills/registries/preview") {
    return handleRegistryPreview(ctx.getActiveRepo(), payload);
  }

  if (path === "/api/plan-review/comments" || path.startsWith("/api/plan-review/comments/")) {
    return handlePlanReviewCommentsPost(ctx.getActiveRepo(), path, payload);
  }

  return null;
}

export function handleProjectsRoute(path: string, url: URL): Response | null {
  if (path === "/api/projects") {
    return Response.json({ projects: readRegistry() });
  }
  if (path === "/api/hook/pending") {
    return Response.json({ pending: listPending() });
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
    return Response.json({ events: replayFromLog(logFile, since, limit) });
  }
  return null;
}
