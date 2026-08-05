// #693: server route for the curator CI setup wizard. Two endpoints:
//   POST /api/curator/setup/preview — read-only: opaque preview id + exact unified
//     diff between the on-disk target and the curated workflow. Never writes.
//   POST /api/curator/setup/apply — requires the opaque preview id, the CURRENT
//     file hash (stale-guard: rejects if the target changed since preview), and the
//     exact confirmation phrase "CREATE CURATOR WORKFLOW". Writes the exact
//     workflow via atomic writeFileSafe and records local-only audit evidence
//     (preview id, never file content or secrets).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileSafe } from "../core.js";
import {
  CURATOR_SETUP_CONFIRMATION,
  CURATOR_SETUP_TARGET,
  CuratorSetupStore,
  buildCuratorWorkflow,
  curatorContentHash,
  unifiedDiff,
} from "../curator-setup.js";
import { type SkillAuditEvent, appendSkillAudit } from "../skills/audit-log.js";
import { handlePolicyRoute } from "./policy-route.js";

export const curatorSetupPreviews = new CuratorSetupStore();

export async function handleCuratorSetupRoute(
  repo: string,
  path: string,
  req: Request,
): Promise<Response | null> {
  if (path === "/api/settings/preview" || path === "/api/settings/apply")
    return handlePolicyRoute(repo, path, req);
  if (path === "/api/curator/setup/preview") return previewCuratorSetup(repo, req);
  if (path === "/api/curator/setup/apply") return applyCuratorSetup(repo, await readJson(req));
  return null;
}

export interface CuratorSetupRouteDeps {
  read: (repo: string, rel: string) => string;
  write: (repo: string, rel: string, content: string) => boolean;
  audit: (event: SkillAuditEvent, deps?: { repo?: string }) => boolean;
  now: () => number;
}

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function curatorSetupDeps(): CuratorSetupRouteDeps {
  return {
    read: (repo, rel) => {
      const p = join(repo, rel);
      if (!existsSync(p)) return "";
      return readFileSync(p, "utf8");
    },
    write: (repo, rel, content) => {
      try {
        writeFileSafe(join(repo, rel), content);
        return true;
      } catch {
        return false;
      }
    },
    audit: appendSkillAudit,
    now: Date.now,
  };
}

function invalidJson(): Response {
  return Response.json({ error: "invalid JSON body" }, { status: 400 });
}

export async function previewCuratorSetup(
  repo: string,
  reqOrBody: Request | Record<string, unknown>,
  deps?: Pick<CuratorSetupRouteDeps, "read" | "now">,
): Promise<Response> {
  let payload: unknown;
  if (reqOrBody instanceof Request) {
    payload = await readJson(reqOrBody);
    if (!payload) return invalidJson();
  } else {
    payload = reqOrBody;
  }
  const d = deps ?? curatorSetupDeps();
  try {
    const current = d.read(repo, CURATOR_SETUP_TARGET);
    const preview = curatorSetupPreviews.create(repo, current);
    const diff = unifiedDiff(current, buildCuratorWorkflow());
    return Response.json({
      id: preview.id,
      target: preview.target,
      existing: current.length > 0,
      currentHash: preview.currentHash,
      diff,
      confirmation: CURATOR_SETUP_CONFIRMATION,
    });
  } catch {
    return Response.json({ error: "curator setup preview failed" }, { status: 500 });
  }
}

export function applyCuratorSetup(
  repo: string,
  payload: Record<string, unknown> | null,
  deps?: CuratorSetupRouteDeps,
): Response {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return invalidJson();
  if ("target" in payload && payload.target !== CURATOR_SETUP_TARGET) {
    return Response.json(
      { error: "target is server-controlled; do not send a target" },
      { status: 400 },
    );
  }
  const previewId = typeof payload.previewId === "string" ? payload.previewId : "";
  const currentHash = typeof payload.currentHash === "string" ? payload.currentHash : "";
  const confirmationText =
    typeof payload.confirmationText === "string" ? payload.confirmationText : "";
  if (!previewId || !currentHash)
    return Response.json({ error: "previewId and currentHash required" }, { status: 400 });
  if (confirmationText !== CURATOR_SETUP_CONFIRMATION) {
    return Response.json(
      { error: `confirmation must be exactly: ${CURATOR_SETUP_CONFIRMATION}` },
      { status: 400 },
    );
  }
  const d = deps ?? curatorSetupDeps();
  let current = "";
  try {
    current = d.read(repo, CURATOR_SETUP_TARGET);
  } catch {
    return Response.json({ error: "failed to read target" }, { status: 500 });
  }
  if (curatorContentHash(current) !== currentHash) {
    return Response.json(
      { error: "target file changed since preview — re-preview before applying" },
      { status: 409 },
    );
  }
  const preview = curatorSetupPreviews.consume(previewId, repo, current, confirmationText);
  if (!preview) {
    return Response.json(
      { error: "invalid, stale, or already used curator setup preview" },
      { status: 400 },
    );
  }
  if (!d.write(repo, preview.target, preview.content)) {
    return Response.json({ error: "workflow write failed" }, { status: 500 });
  }
  const audit = d.audit ?? appendSkillAudit;
  const event: SkillAuditEvent = {
    actor: "human",
    action: "curator-setup",
    skillName: null,
    oldStatus: null,
    newStatus: null,
    evidence: [`preview:${preview.id}`, `target:${preview.target}`, `hash:${preview.currentHash}`],
    reason: `curator CI workflow ${preview.target}`,
  };
  if (!audit(event, { repo })) {
    // Rollback to the pre-apply content on audit failure.
    if (!d.write(repo, preview.target, preview.current)) {
      return Response.json({ error: "audit failed; rollback failed" }, { status: 500 });
    }
    return Response.json({ error: "audit failed; rolled back" }, { status: 409 });
  }
  return Response.json({ ok: true });
}
