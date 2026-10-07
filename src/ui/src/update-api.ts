import type { UpdateRunAction, UpdateStatusView } from "../../update/update-status-contract.js";
// Thin HTTP client for the update routes (server/routes-update.ts).
import { req } from "./api.js";

export const fetchUpdateStatus = (): Promise<UpdateStatusView> =>
  req<UpdateStatusView>("GET", "/api/update/status");

export const runUpdate = (action: UpdateRunAction): Promise<{ ok: boolean; started: boolean }> =>
  req<{ ok: boolean; started: boolean }>("POST", "/api/update/run", { action });
