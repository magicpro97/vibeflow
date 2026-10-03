// src/ui/src/settings-form-helpers.ts
//
// Helpers for the settings dialog's dirty-check bookkeeping. They live here rather than inside
// SettingsPanel.vue for one measured reason: the panel sits at the 400-line cap (docs/
// CODING_CONVENTIONS.md), and the round-43 review found the file at 407 after the System One
// block landed. Extracting the two normalize steps is the smallest change that puts the panel
// back under it without touching what it renders.
//
// The invariant both helpers protect: `form` and `original` must carry the SAME projection of
// the stored settings, because `isDirty` is a `JSON.stringify` comparison. One side carrying a
// field the other dropped makes the dialog permanently dirty, which re-arms the discard prompt
// for a form with no unsaved edits.
import type { VibeSettings } from "./types-settings.js";

/**
 * The settings the generic panel MANAGES: everything except the System One block it never edits.
 * Typing `form`/`original` as this projection is what makes the guarantee real — a `VibeSettings`
 * ref would let a future call site read `form.value.typesafe` (runtime `undefined`) or re-inject
 * the block, defeating the projection the save path depends on.
 */
export type ManagedSettings = Omit<VibeSettings, "typesafe">;

/**
 * Drop the System One block. This panel has no System One UI and `mergeTypesafeSettings` is
 * replace-on-write on mere key presence, so a form carrying a stale copy rewrites the judge when
 * ANY other setting is saved.
 *
 * Both sides need it, which is the bug this function exists for: `POST /api/settings` answers
 * with the full `settingsView()`, so re-seeding `original` from a save response reintroduced the
 * block the form deliberately lacks. `isDirty` then compared "has typesafe" against "has not" and
 * stayed true for the rest of the session.
 */
export function withoutTypesafe(settings: VibeSettings): Omit<VibeSettings, "typesafe"> {
  const { typesafe: _dropped, ...managed } = settings;
  return managed;
}

/**
 * Coerce the two optional blocks the dialog edits to their shipped shape on BOTH sides of the
 * dirty check. Without it `v-model` binds `undefined`, and the baseline disagrees with the form
 * the moment either editor is touched.
 *
 * Its parameter and return are `ManagedSettings`, NOT a generic over `Omit<VibeSettings,
 * "typesafe">`: `Omit` is not a closed constraint, so `T extends Omit<...>` accepted a FULL
 * `VibeSettings` and re-asserted a `typesafe` block the projection provably lacks - letting a later
 * call site read `form.value.typesafe!.enabled` at runtime `undefined`. A concrete type with no
 * `VibeSettings` cast inside makes that write impossible to spell.
 */
export function coerceEditableDefaults(value: ManagedSettings): ManagedSettings {
  // Returns a NEW object: the parameter may be the API cache (or an object aliased into the form),
  // and writing into it here would refill the baseline the caller's `clone` exists to protect -
  // making `form` and `original` share nested `envPolicy`/`curator` objects, which defeats the
  // `JSON.stringify` dirty check in BOTH directions. Pure, so no caller can alias its way in.
  return {
    ...value,
    envPolicy: value.envPolicy ?? {},
    curator: value.curator ?? {
      enabled: false,
      observeMode: true,
      schedule: "0 9 * * 1",
      severityThreshold: "medium",
    },
  };
}
