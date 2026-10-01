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
 * Generic over the input so the RETURN TYPE preserves whatever the caller passed in: called on the
 * `withoutTypesafe` projection, it must not re-assert a `typesafe` block the object provably lacks
 * (that would let a future call site read `form.value.typesafe!.enabled` at runtime `undefined`).
 */
export function coerceEditableDefaults<T extends Omit<VibeSettings, "typesafe">>(value: T): T {
  const out = value as VibeSettings;
  if (!out.envPolicy) out.envPolicy = {};
  if (!out.curator) {
    out.curator = {
      enabled: false,
      observeMode: true,
      schedule: "0 9 * * 1",
      severityThreshold: "medium",
    };
  }
  return out as T;
}
