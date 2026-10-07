// Thin HTTP client for the update routes (Task: server/routes-update.ts).
import { req } from "./api.js";
import type { UpdateStatusView } from "./update-banner-model.js";

export const fetchUpdateStatus = (): Promise<UpdateStatusView> =>
  req<UpdateStatusView>("GET", "/api/update/status");

export const runUpdate = (action: "update" | "rollback"): Promise<{ ok: boolean; started: boolean }> =>
  req<{ ok: boolean; started: boolean }>("POST", "/api/update/run", { action });
