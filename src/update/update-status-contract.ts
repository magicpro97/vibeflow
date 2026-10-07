// src/update/update-status-contract.ts
//
// Browser-safe wire contract for the update surface, shared by the server
// routes (src/server/routes-update.ts) and the SPA client (src/ui) so the
// response DTO and the run-action vocabulary cannot drift. Dependency-neutral
// by construction: the only import is src/settings-update.ts (no node:*), which
// lets the UI bundle import it across the src/ui boundary.

import type { UpdateManagerId, UpdateMode } from "../settings-update.js";

export const UPDATE_RUN_ACTION = Object.freeze({
  UPDATE: "update",
  ROLLBACK: "rollback",
} as const);
export type UpdateRunAction = (typeof UPDATE_RUN_ACTION)[keyof typeof UPDATE_RUN_ACTION];

export interface UpdateStatusView {
  ok: true;
  installed: string;
  latest: string | null;
  mode: UpdateMode;
  manager: UpdateManagerId;
  upgrade_available: boolean;
  stale_servers: { base: string; pid: number; version: string }[];
  rollback: { version: string } | null;
}
