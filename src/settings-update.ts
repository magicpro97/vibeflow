// src/settings-update.ts
//
// `update` settings block: how a running `vf ui` reacts to a newer release.
//   notify (default) — print the update line only; `vf update` applies on request
//   auto             — a running `vf ui` spawns `vf update` itself
// manager picks the global package manager used by `vf update`.

export type UpdateMode = "notify" | "auto";
export type UpdateManagerId = "npm" | "bun" | "pnpm";

export interface UpdateSettings {
  mode: UpdateMode;
  manager: UpdateManagerId;
}

export const UPDATE_DEFAULTS: UpdateSettings = Object.freeze({
  mode: "notify",
  manager: "npm",
});

/** Validate a stored block; garbage fields fall back field-by-field. */
export function coerceUpdateSettings(value: unknown): UpdateSettings {
  const next: UpdateSettings = { ...UPDATE_DEFAULTS };
  if (!value || typeof value !== "object" || Array.isArray(value)) return next;
  const record = value as { mode?: unknown; manager?: unknown };
  if (record.mode === "auto" || record.mode === "notify") next.mode = record.mode;
  if (record.manager === "npm" || record.manager === "bun" || record.manager === "pnpm")
    next.manager = record.manager;
  return next;
}
