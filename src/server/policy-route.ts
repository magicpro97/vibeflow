import {
  POLICY_RELAXATION_CONFIRMATION,
  PolicyPreviewStore,
  validatePolicyCandidate,
} from "../policy-preview.js";
import { type VibeSettings, readSettings, writeSettings } from "../settings.js";
import { appendSkillAudit } from "../skills/audit-log.js";

export const policyPreviews = new PolicyPreviewStore();

export async function handlePolicyRoute(
  repo: string,
  path: string,
  req: Request,
): Promise<Response | null> {
  const deps = { read: readSettings, write: writeSettings };
  if (path === "/api/settings/preview") return previewPolicy(repo, req, deps);
  if (path === "/api/settings/apply") return applyPolicy(repo, await readJson(req), deps);
  return null;
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

function invalidJson(): Response {
  return Response.json({ error: "invalid JSON body" }, { status: 400 });
}

export interface PolicyRouteDeps {
  read: (repo: string) => VibeSettings;
  write: (repo: string, candidate: Partial<VibeSettings>) => VibeSettings;
  audit?: typeof appendSkillAudit;
}

export async function previewPolicy(
  repo: string,
  req: Request,
  deps: PolicyRouteDeps,
): Promise<Response> {
  const payload = await readJson(req);
  if (!payload) return invalidJson();
  const candidate = validatePolicyCandidate(payload);
  if (!candidate) return Response.json({ error: "invalid policy payload" }, { status: 400 });
  const preview = policyPreviews.create(repo, deps.read(repo), candidate);
  return Response.json({
    id: preview.id,
    diff: preview.diff,
    relaxation: preview.relaxation,
  });
}

export function applyPolicy(
  repo: string,
  payload: Record<string, unknown> | null,
  deps: PolicyRouteDeps,
): Response {
  if (!payload) return invalidJson();
  const previewId = typeof payload.previewId === "string" ? payload.previewId : "";
  const confirmationText =
    typeof payload.confirmationText === "string" ? payload.confirmationText : "";
  // #692: the apply payload may carry non-policy settings so policy + regular
  // edits land in ONE server write. Never accept a raw policy candidate: policy
  // must come from the opaque preview's stored candidate.
  const rawSettings = payload.settings;
  if (
    rawSettings !== undefined &&
    (typeof rawSettings !== "object" || rawSettings === null || Array.isArray(rawSettings))
  )
    return Response.json({ error: "invalid non-policy settings payload" }, { status: 400 });
  const nonPolicy = (rawSettings ?? {}) as Record<string, unknown>;
  if ("envPolicy" in nonPolicy || "hooks" in nonPolicy)
    return Response.json({ error: "policy changes require preview approval" }, { status: 400 });
  // This route applies a POLICY preview: envPolicy and hooks. Everything else rides along in
  // `nonPolicy`, which made `/api/settings/apply` a second writer of the System One block - the
  // preview that authorises the request owns no such field, and the audit-failure rollback below
  // then restored a snapshot that had been read before the smuggle. Refuse it here; the routes that
  // do own the block are `/api/settings` and the CLI, and the UI's policy path never sends one.
  if ("typesafe" in nonPolicy)
    return Response.json(
      { error: "use /api/settings to change System One settings" },
      { status: 400 },
    );
  const current = deps.read(repo);
  const preview = policyPreviews.consume(previewId, repo, current, confirmationText);
  if (!preview)
    return Response.json(
      { error: "invalid, stale, or already used policy preview" },
      { status: 400 },
    );
  const audit = deps.audit ?? appendSkillAudit;
  let next: VibeSettings;
  try {
    next = deps.write(repo, { ...preview.candidate, ...nonPolicy });
  } catch {
    return Response.json({ error: "settings write failed" }, { status: 500 });
  }
  if (next === undefined) return Response.json({ error: "settings write failed" }, { status: 500 });
  if (
    !audit(
      {
        actor: "human",
        action: "policy",
        skillName: null,
        oldStatus: null,
        newStatus: null,
        evidence: [preview.id],
        reason: preview.relaxation ? POLICY_RELAXATION_CONFIRMATION : "policy change",
      },
      { repo },
    )
  ) {
    try {
      // A faithful restore of the pre-write snapshot, which `current` is: it was read before the
      // apply. Naming the repo is what the choke point needs - the previous version STRIPPED the
      // block instead, so a System One write that arrived with the request survived a write this
      // route reports as failed. Every other piggy-backed field was restored; the block was not.
      deps.write(repo, {
        ...current,
        envPolicy: current.envPolicy,
        hooks: current.hooks,
        expectRepo: repo,
      } as Partial<VibeSettings>);
    } catch {
      return Response.json({ error: "policy audit failed; rollback failed" }, { status: 500 });
    }
    return Response.json({ error: "policy audit failed" }, { status: 500 });
  }
  return Response.json({ ok: true });
}
