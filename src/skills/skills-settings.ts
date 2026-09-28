import { ENGINES, type Engine } from "../core/types.js";

/** Skills resolution and mirroring policy, as stored in `SETTINGS.json`. */
export interface SkillsConfig {
  /** Resolve skills per task instead of mirroring everything. */
  autoResolve: boolean;
  /** `pointer` writes a small reference file; `full` mirrors the skill bodies. */
  mirrorMode: "pointer" | "full";
  /** Target engines to mirror skills into. Default: all ENGINES. */
  targetEngines: Engine[];
}

/** Default baseline. `readSettings` always returns a fresh copy, never this object. */
export const DEFAULT_SKILLS_CONFIG: SkillsConfig = {
  autoResolve: true,
  mirrorMode: "pointer",
  targetEngines: [...ENGINES],
};

/**
 * Validate skills resolution and mirroring policy.
 *
 * `base` is the block being updated, and it is what a field the payload does NOT name is filled
 * from. Starting from the defaults instead rewrote unmentioned fields: a partial
 * `{skills:{autoResolve:true}}` through `POST /api/settings` reset mirrorMode and targetEngines,
 * which the client never sent. The read path passes nothing and still means "defaults for absent".
 */
export function coerceSkillsConfig(
  raw: unknown,
  base: SkillsConfig = DEFAULT_SKILLS_CONFIG,
): SkillsConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const out: SkillsConfig = { ...base, targetEngines: [...base.targetEngines] };
  if (typeof obj.autoResolve === "boolean") out.autoResolve = obj.autoResolve;
  if (obj.mirrorMode === "pointer" || obj.mirrorMode === "full") out.mirrorMode = obj.mirrorMode;
  if (Array.isArray(obj.targetEngines)) {
    const wanted = obj.targetEngines.filter(
      (e): e is Engine => typeof e === "string" && (ENGINES as readonly string[]).includes(e),
    );
    if (wanted.length > 0) out.targetEngines = wanted;
  }
  return out;
}

/** Write path: replace-on-write, and fill unmentioned fields from the STORED block. */
export function mergeSkillsConfig(
  merged: { skills?: SkillsConfig },
  next: { skills?: SkillsConfig },
  current: { skills?: SkillsConfig },
): void {
  const cfg =
    "skills" in next
      ? coerceSkillsConfig(next.skills, current.skills ?? DEFAULT_SKILLS_CONFIG)
      : current.skills;
  if (cfg) merged.skills = cfg;
}
