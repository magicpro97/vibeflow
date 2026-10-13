# SETTINGS.json layer map + audit findings

Read this before answering "how do settings work / where is X configured / is it
guaranteed across projects" — and before editing any settings write path.
Verify claims against `src/`, never against docs prose (see Stale doc, below).

## The actual layers — TWO settings tiers, not three

| Layer | Path | What it really is |
|---|---|---|
| Project | `<repo>/.vibeflow/SETTINGS.json` | THE settings store. `readSettings`/`writeSettings` (`src/settings.ts`) read/write only this. Missing file → `DEFAULT_SETTINGS` copy; corrupt file → defaults PLUS a one-time stderr warning per path (settings-audit fix: `corruptWarned` set + `inject.warn` seam in `readSettings` — on a base without `corruptWarned` the revert is still silent, and a base predating the fix can be healed by porting that block). |
| User | `~/.vibeflow/SETTINGS.json` | NOT a VibeSettings tier. `vf init` seeds `{schema_version:"1.0"}` if absent; consumed by the capability-authority bootstrap (`policySettingsPath` user scope, authority mutations). No VibeSettings reader exists for it. |
| UI | `POST /api/settings` | `routes-settings.ts` → `applySettings(activeRepo, payload)` → `writeSettings`. Writes ONE repo: the server's process-global active repo. |

- `.vibeflow/.gitignore` contains `!SETTINGS.json` → the file is SHARED/committed,
  not per-machine. Machine-path gate scans it like any tracked file.
- Seeding: `init-apply.ts` writes `writeSettings(base, {})` ONLY when the file is
  absent (first init) — re-init never clobbers user edits. `-` (dry) skips it.
- Storage semantics: `writeSettings` = field-by-field merge + `updatedAt` stamp;
  `hooks`/`envPolicy`/`mcpServers`/`typesafe`/`eval` are REPLACE-on-write (key
  presence hands a complete block; a partial block is a deliberate opt-out —
  never "fix" that into a deep merge).
- Durability: `writeFileSafe` = atomic tmp+rename, tmp chmod 0o600. NOTE:
  `assertInsideBase` guards `readState` + init-apply restore paths — it does NOT
  guard settings writes; don't cite it as the settings-write guard.

## UI guard (structural, not per-caller opt-in)

- payload has `hooks`/`envPolicy` → 400 (policy changes need preview approval).
- `typesafe` present but not an object → 400; `typesafe` without `expectRepo` →
  400; `expectRepo` !== activeRepo → 409 (multi-tab repo switch race).
- Enforced AGAIN in `writeSettings` via `assertTypesafeWriteAllowed` → CLI paths
  cannot bypass it. `expectRepo` is compared, never persisted.
- Other blocks intentionally need no `expectRepo` (last-write-wins accepted,
  documented in the route's header comment). Don't "harden" them without the
  product decision.

## Known gaps (audited — open fix candidates)

- **Corrupt JSON: warn-once landed.** `readSettings` now reports
  `vf: <path> is not valid JSON — using default settings` ONCE per path per
  process (default sink stderr; `inject.warn` = test seam; the sink call is
  try-guarded so the read never throws). The writeSettings merge path surfaces
  it too — the next write replaces the corrupt bytes with defaults+merge (now
  visible at the moment it happens). Check `corruptWarned` in `src/settings.ts`:
  if absent, your base predates the fix and corrupt files revert silently.
- **No schema_version / migration for the project file — STILL OPEN.**
  Compat = `coerce()` forward-merge; unknown fields are dropped silently. The
  user-scope file's `schema_version:"1.0"` is unrelated. Either document
  coerce() as the migration policy (done in the GENERATED_FILES rewrite) or
  add a version + drop-warning.
- **Stale doc: FIXED.** `docs/GENERATED_FILES.md` now states first-init-only
  seeding, the coerce() forward-merge policy, and the user-scope file's role
  (if a checkout still says "written on every vf init", that base predates the
  fix). Note the `no-tracked-machine-path` gate SKIPS `.json` — review
  `.vibeflow/SETTINGS.json` diffs by hand.

## Audit procedure (how this map was built)

1. `git grep -n 'SETTINGS.json' origin/main -- src/` → enumerate every writer,
   reader, and path helper; read each hit's context before classifying.
2. For UI behaviour read `routes-settings.ts` top-to-bottom — its header comment
   documents the multi-client race the guard exists for; the guards are in code,
   not docs.
3. Probe assertions live where cheap (route tests: hooks/envPolicy 400, expectRepo
   409/400 cases are all unit-covered).
