// src/settings-update.ts
//
// `update` settings block: how a running `vf ui` reacts to a newer release.
//   notify (default) — print the update line only; `vf update` applies on request
//   auto             — a running `vf ui` spawns `vf update` itself
// manager picks the global package manager used by `vf update`.
//
// The two vocabularies are frozen runtime authorities (single-runtime-authority
// rule): `src/update/update-apply.ts` re-uses UPDATE_MANAGER_ID as its manager
// authority, so settings validation can never drift from the CLI.

export const UPDATE_MODE = Object.freeze({
  NOTIFY: "notify",
  AUTO: "auto",
} as const);
export type UpdateMode = (typeof UPDATE_MODE)[keyof typeof UPDATE_MODE];

export const UPDATE_MANAGER_ID = Object.freeze({
  NPM: "npm",
  BUN: "bun",
  PNPM: "pnpm",
} as const);
export type UpdateManagerId = (typeof UPDATE_MANAGER_ID)[keyof typeof UPDATE_MANAGER_ID];

export interface UpdateSettings {
  mode: UpdateMode;
  manager: UpdateManagerId;
}

export const UPDATE_DEFAULTS: UpdateSettings = Object.freeze({
  mode: UPDATE_MODE.NOTIFY,
  manager: UPDATE_MANAGER_ID.NPM,
});

/** Validate a stored block; garbage fields fall back field-by-field. */
export function coerceUpdateSettings(value: unknown): UpdateSettings {
  const next: UpdateSettings = { ...UPDATE_DEFAULTS };
  if (!value || typeof value !== "object" || Array.isArray(value)) return next;
  const record = value as { mode?: unknown; manager?: unknown };
  if (record.mode === UPDATE_MODE.AUTO || record.mode === UPDATE_MODE.NOTIFY)
    next.mode = record.mode;
  if (
    record.manager === UPDATE_MANAGER_ID.NPM ||
    record.manager === UPDATE_MANAGER_ID.BUN ||
    record.manager === UPDATE_MANAGER_ID.PNPM
  )
    next.manager = record.manager;
  return next;
}
