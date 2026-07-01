// All HTTP helpers. Token read once from <meta name="vf-token"> (injected by server).
import type { VibeSettings, WorkflowState } from "./types.js";

const CSRF = document.querySelector<HTMLMetaElement>('meta[name="vf-token"]')?.content ?? "";

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
  if (method !== "GET") headers["x-vibeflow-token"] = CSRF;
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
  },
  skills: () =>
    req<{ skills: string[]; needs: unknown }>("GET", "/api/skills").then((r) => r.skills),
  attachments: () =>
    req<{ attachments: unknown[] }>("GET", "/api/attachments").then((r) => r.attachments),
  logsRecent: (since = 0, limit = 200) =>
    req<{ events: unknown[] }>("GET", `/api/logs/recent?since=${since}&limit=${limit}`).then(
      (r) => r.events,
    ),
  detect: (repoPath: string) => req<unknown>("POST", "/api/detect", { path: repoPath }),
  init: (payload: unknown) => req<unknown>("POST", "/api/init", payload),
  dispatch: (payload?: unknown) => req<unknown>("POST", "/api/dispatch", payload ?? {}),
  units: (payload: unknown) => req<unknown>("POST", "/api/units", payload),
  orchestrate: (payload?: unknown) => req<unknown>("POST", "/api/orchestrate", payload ?? {}),
  preflight: () => req<unknown>("POST", "/api/preflight", {}),
  verify: (signal?: AbortSignal) => req<unknown>("POST", "/api/verify", {}, signal),
  upload: async (file: File) => {
    const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: {
        "x-vibeflow-token": CSRF,
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
};
