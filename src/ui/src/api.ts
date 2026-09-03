// All HTTP helpers. Token read once from <meta name="vf-token"> (injected by server).
import type { HookConfirmationDecision } from "../../core/hook-contract.js";
import {
  UI_HOOK_ROUTE,
  UI_LAN_EVENT_SOURCE_TOKEN_QUERY,
  UI_LAN_TOKEN_HEADER,
} from "../../core/ui-cli-contract.js";
import { type LogEvent, decodeLogEvent } from "../../logbus/types.js";
import { readUiPageToken } from "./browser-ui-token.js";
import type {
  DashboardSelection,
  DomainImpact,
  DomainsView,
  RegistryPreview,
  RegistryViewEntry,
  SafeSkill,
  TimelineEntry,
  VibeSettings,
  WorkflowDashboardItem,
  WorkflowState,
} from "./types.js";
const decodeLogEvents = (values: unknown[]): LogEvent[] =>
  values.map(decodeLogEvent).filter((event): event is LogEvent => event !== null);
const CSRF = readUiPageToken();

/** Warn once in console if CSRF token is missing — all write requests will 403 */
if (!CSRF) {
  console.warn("[vibeflow] vf-token meta tag not found — write requests will fail with 403");
}

async function req<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  // Always send the CSRF token — required by GET /api/file (#558) and harmless
  // on other GETs (they don't check it). Write routes have always needed it.
  headers[UI_LAN_TOKEN_HEADER] = CSRF;
  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!res.ok) {
    // Try to extract server-sent error message for user-visible errors
    let detail = "";
    try {
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        const json = (await res.json()) as { error?: string; message?: string };
        detail = json.error ?? json.message ?? "";
      }
    } catch (_e) {
      // body unreadable — fall through to generic message
    }
    // Prefer server's error message; fall back to a terse status-only string
    throw new Error(detail || `Server error ${res.status}`);
  }
  try {
    return res.json() as Promise<T>;
  } catch {
    throw new Error("Server returned an unexpected response. Try again.");
  }
}

export const api = {
  state: () => req<WorkflowState>("GET", "/state"),
  settings: {
    // Server returns { settings: VibeSettings, tools: ToolView[] } — unwrap here
    get: () => req<{ settings: VibeSettings }>("GET", "/api/settings").then((r) => r.settings),
    set: (s: Partial<VibeSettings>) =>
      req<{ settings: VibeSettings }>("POST", "/api/settings", s).then((r) => r.settings),
    previewPolicy: (s: Pick<VibeSettings, "envPolicy" | "hooks">) =>
      req<import("./types.js").PolicyPreview>("POST", "/api/settings/preview", s),
    applyPolicy: (previewId: string, confirmationText: string, settings?: Partial<VibeSettings>) =>
      req<{ ok: boolean }>("POST", "/api/settings/apply", {
        previewId,
        confirmationText,
        ...(settings ? { settings } : {}),
      }).then(() => api.settings.get()),
  },
  skills: () => req<{ skills: SafeSkill[] }>("GET", "/api/skills").then((r) => r.skills),
  // #689: recent curator findings (severity-badged, sanitized).
  curator: () =>
    req<{
      ok: boolean;
      findings: import("./types.js").CuratorFindingView[];
      counts: import("./types.js").CuratorCounts;
      total: number;
    }>("GET", "/api/skills/curator").then((r) => ({
      findings: r.findings,
      counts: r.counts,
      total: r.total,
    })),
  curatorSetup: {
    preview: () =>
      req<import("./types.js").CuratorSetupPreview>("POST", "/api/curator/setup/preview", {}),
    apply: (previewId: string, currentHash: string, confirmationText: string) =>
      req<{ ok: boolean }>("POST", "/api/curator/setup/apply", {
        previewId,
        currentHash,
        confirmationText,
      }),
  },
  // #688: registry read + inert preview (read-only, never executes).
  registries: {
    list: () =>
      req<{ registries: RegistryViewEntry[] }>("GET", "/api/skills/registries").then(
        (r) => r.registries,
      ),
    preview: (registry: string) =>
      req<RegistryPreview>("POST", "/api/skills/registries/preview", {
        action: "update",
        registry,
      }),
  },
  releases: {
    list: () =>
      req<{ ok: boolean; proposals: import("./types.js").ReleaseProposalSummary[] }>(
        "GET",
        "/api/skills/registries/releases",
      ).then((r) => r.proposals),
    get: (id: string) =>
      req<{ ok: boolean; proposal: import("./types.js").ReleaseProposalDetail }>(
        "GET",
        `/api/skills/registries/releases/${encodeURIComponent(id)}`,
      ).then((r) => r.proposal),
  },
  // #682: pending skill acquisition cards + explicit approve/reject decisions.
  // The waiting /api/orchestrate request owns installation; this only resolves
  // the in-memory broker. GET is guarded/read-only, POST needs the CSRF token.
  acquisitions: {
    pending: () =>
      req<import("./types.js").AcquisitionPendingResponse>(
        "GET",
        "/api/skills/acquisitions/pending",
      ).then((r) => r.pending),
    decision: (id: string, decision: import("./types.js").AcquisitionDecision) =>
      req<import("./types.js").AcquisitionDecisionResponse>(
        "POST",
        "/api/skills/acquisitions/decision",
        { id, decision },
      ),
  },
  // #691: read-only Domain & Facts view + affected-skill impact resolution.
  domains: {
    view: () => req<DomainsView>("GET", "/api/domains").then((r) => r.roots),
    impact: (query: string) =>
      req<DomainImpact>("GET", `/api/domains/impact?q=${encodeURIComponent(query)}`),
  },
  attachments: () =>
    req<{ attachments: unknown[] }>("GET", "/api/attachments").then((r) => r.attachments),
  logsRecent: (since = 0, limit = 200) =>
    req<{ events: unknown[] }>("GET", `/api/logs/recent?since=${since}&limit=${limit}`).then((r) =>
      decodeLogEvents(r.events),
    ),
  detect: (repoPath: string) => req<unknown>("POST", "/api/detect", { path: repoPath }),
  init: (payload: unknown) => req<unknown>("POST", "/api/init", payload),
  dispatch: (payload?: unknown) => req<unknown>("POST", "/api/dispatch", payload ?? {}),
  units: (payload: unknown) => req<unknown>("POST", "/api/units", payload),
  orchestrate: (payload?: unknown) => req<unknown>("POST", "/api/orchestrate", payload ?? {}),
  preflight: () => req<unknown>("POST", "/api/preflight", {}),
  verify: (signal?: AbortSignal) => req<unknown>("POST", "/api/verify", {}, signal),
  // #526: drop a pre-dispatch steering note for a QUEUED unit (fire-and-forget).
  guidance: (unit: string, note: string) =>
    req<{ ok: boolean }>("POST", `/api/guidance/${encodeURIComponent(unit)}`, { note }),
  upload: async (file: File) => {
    const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: {
        [UI_LAN_TOKEN_HEADER]: CSRF,
        "content-type": file.type || "application/octet-stream",
      },
      body: file,
    });
    if (!res.ok) {
      let detail = "";
      try {
        const json = await res.json();
        detail = (json as { error?: string }).error ?? "";
      } catch {}
      throw new Error(detail || `Upload failed (${res.status})`);
    }
    try {
      return res.json() as Promise<{ ok: boolean; attachment: unknown; attachments: unknown[] }>;
    } catch {
      throw new Error("Upload response was invalid. Try again.");
    }
  },
  clearState: () => req<{ ok: boolean }>("DELETE", "/api/state"),
  deleteAttachment: (name: string) =>
    req<{ ok: boolean; attachments: unknown[] }>(
      "DELETE",
      `/api/upload?name=${encodeURIComponent(name)}`,
    ),
  discover: (payload: unknown) => req<unknown>("POST", "/api/discover", payload),
  projects: {
    list: () =>
      req<{ projects: import("./types.js").ProjectEntry[] }>("GET", "/api/projects").then(
        (r) => r.projects,
      ),
    state: (path: string) =>
      req<{ state: import("./types.js").WorkflowState }>(
        "GET",
        `/api/projects/state?path=${encodeURIComponent(path)}`,
      ).then((r) => r.state),
    logs: (path: string, since = 0, limit = 200) =>
      req<{ events: unknown[] }>(
        "GET",
        `/api/projects/logs?path=${encodeURIComponent(path)}&since=${since}&limit=${limit}`,
      ).then((r) => decodeLogEvents(r.events)),
    delete: (path: string) =>
      req<{ ok: boolean }>("DELETE", `/api/projects?path=${encodeURIComponent(path)}`),
  },
  hook: {
    pending: () => req<{ pending: unknown[] }>("GET", UI_HOOK_ROUTE.PENDING),
    approve: (id: string, decision: HookConfirmationDecision) =>
      req<{ ok: boolean }>("POST", UI_HOOK_ROUTE.APPROVE, { id, decision }),
  },
  // #558: read a repo file for `file:line` evidence (token-guarded, sandboxed server-side).
  readFile: (path: string, line?: number) =>
    req<{ ok: boolean; content?: string; reason?: string; path?: string }>(
      "GET",
      `/api/file?path=${encodeURIComponent(path)}${line ? `&line=${line}` : ""}`,
    ),
  // #557: a unit's append-only status-transition ledger (token-guarded, name-sanitized).
  unitTimeline: (name: string) =>
    req<{ ok: boolean; timeline: TimelineEntry[] }>(
      "GET",
      `/api/units/${encodeURIComponent(name)}/timeline`,
    ),
  // #640: dashboard API
  dashboard: {
    workflows: () => req<{ workflows: WorkflowDashboardItem[] }>("GET", "/api/dashboard/workflows"),
    // #641: diff preview
    diff: (sel: DashboardSelection, signal?: AbortSignal) => {
      const p = new URLSearchParams({ repoPath: sel.repoPath, workflowId: sel.workflowId });
      if (sel.unit) p.set("unit", sel.unit);
      return req<import("./types.js").DiffResponse>(
        "GET",
        `/api/dashboard/diff?${p}`,
        undefined,
        signal,
      );
    },
    logs: (sel: DashboardSelection, since = 0, limit = 200, includeWorkflowEvents = true) => {
      const p = new URLSearchParams({
        repoPath: sel.repoPath,
        workflowId: sel.workflowId,
        since: String(since),
        limit: String(Math.min(limit, 1000)),
        includeWorkflowEvents: String(includeWorkflowEvents),
      });
      if (sel.unit) p.set("unit", sel.unit);
      return req<{ events: unknown[] }>("GET", `/api/dashboard/logs?${p}`).then((response) => ({
        events: decodeLogEvents(response.events),
      }));
    },
    streamUrl: (sel: DashboardSelection & { since?: number; runId?: string }) => {
      const p = new URLSearchParams({ repoPath: sel.repoPath, workflowId: sel.workflowId });
      if (sel.unit) p.set("unit", sel.unit);
      if (sel.since && sel.since > 0) p.set("since", String(sel.since));
      if (sel.runId) p.set("runId", sel.runId);
      p.set(UI_LAN_EVENT_SOURCE_TOKEN_QUERY, CSRF);
      return `/api/dashboard/logs/stream?${p.toString()}`;
    },
  },
  // ── Plan Review API ──
  planReview: {
    get: (repoPath: string, workflowId: string) =>
      req<{
        revision: import("./types.js").PlanRevision;
        revisions: import("./types.js").PlanRevision[];
      }>(
        "GET",
        `/api/plan-review?repoPath=${encodeURIComponent(repoPath)}&workflowId=${encodeURIComponent(workflowId)}`,
      ),
    create: (payload: {
      repoPath: string;
      workflowId: string;
      markdown: string;
      createdBy: { type: "user" | "agent"; id: string; name: string };
    }) =>
      req<{ revision: import("./types.js").PlanRevision }>(
        "POST",
        "/api/plan-review/revisions",
        payload,
      ).then((r) => r.revision),
    comments: {
      list: (repoPath: string, workflowId: string, revisionId: string) =>
        req<{ comments: import("./types.js").PlanComment[] }>(
          "GET",
          `/api/plan-review/comments?repoPath=${encodeURIComponent(repoPath)}&workflowId=${encodeURIComponent(workflowId)}&revisionId=${encodeURIComponent(revisionId)}`,
        ).then((r) => r.comments),
      create: (payload: {
        repoPath: string;
        workflowId: string;
        revisionId: string;
        parentId?: string;
        anchor?: import("./types.js").PlanCommentAnchor;
        body: string;
        createdBy: { type: "user" | "agent"; id: string; name: string };
      }) =>
        req<{ comment: import("./types.js").PlanComment }>(
          "POST",
          "/api/plan-review/comments",
          payload,
        ).then((r) => r.comment),
      update: (id: string, body: string, repoPath: string, workflowId: string) =>
        req<{ comment: import("./types.js").PlanComment }>(
          "POST",
          `/api/plan-review/comments/${encodeURIComponent(id)}`,
          { body, repoPath, workflowId },
        ).then((r) => r.comment),
      submit: (id: string, repoPath: string, workflowId: string) =>
        req<{ comment: import("./types.js").PlanComment }>(
          "POST",
          `/api/plan-review/comments/${encodeURIComponent(id)}/submit`,
          { repoPath, workflowId },
        ).then((r) => r.comment),
      delete: (id: string, repoPath: string, workflowId: string) =>
        req<{ ok: boolean }>(
          "DELETE",
          `/api/plan-review/comments/${encodeURIComponent(id)}?repoPath=${encodeURIComponent(repoPath)}&workflowId=${encodeURIComponent(workflowId)}`,
        ),
    },
  },
};
