/**
 * Global project-classification policy: the auto-classify switch and the engine the classifier's
 * last (AI) tier runs on.
 *
 * Follows the feature-scoped settings-block precedent (`skills/curator-settings.ts`): the shape,
 * coercion, and merge live here and `settings.ts` calls in with three lines, so a new block never
 * has to grow the central settings module past the file-size cap.
 *
 * The engine is stored per field and each field is independently optional: `cli: null` means
 * "auto" (the classifier's own default engine), and an absent model/thinking means the engine's
 * default. Storing `null` rather than a guessed engine name is deliberate — a guessed value would
 * silently pin classification to one CLI and keep using it after the user changes their default.
 */
import { type Engine, isAgentEngine } from "./core/agent-contract.js";
import { PROJECT_THINKING_MAX_LENGTH } from "./orchestrator/conversation/project-types.js";

/** The classifier engine override; every field may be unset, which means "use the default". */
export interface ProjectClassificationEngine {
  cli: Engine | null;
  model: string | null;
  thinking: string | null;
}

/** Global project-classification policy. */
export interface ProjectClassificationSettings {
  /** When false the classifier never runs: no suggestion chips, everything stays in Ideas. */
  enabled: boolean;
  engine: ProjectClassificationEngine;
}

export const DEFAULT_PROJECT_CLASSIFICATION_ENGINE: ProjectClassificationEngine = {
  cli: null,
  model: null,
  thinking: null,
};

export const DEFAULT_PROJECT_CLASSIFICATION_SETTINGS: ProjectClassificationSettings = {
  enabled: true,
  engine: { ...DEFAULT_PROJECT_CLASSIFICATION_ENGINE },
};

const bounded = (value: unknown, maximum: number): string | null => {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" || text.length > maximum ? null : text;
};

/** Coerce a stored block over the defaults; absent or garbage yields the defaults. */
export function coerceProjectClassificationSettings(raw: unknown): ProjectClassificationSettings {
  const out: ProjectClassificationSettings = {
    enabled: DEFAULT_PROJECT_CLASSIFICATION_SETTINGS.enabled,
    engine: { ...DEFAULT_PROJECT_CLASSIFICATION_ENGINE },
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const obj = raw as { enabled?: unknown; engine?: unknown };
  if (typeof obj.enabled === "boolean") out.enabled = obj.enabled;
  if (obj.engine && typeof obj.engine === "object" && !Array.isArray(obj.engine)) {
    const engine = obj.engine as { cli?: unknown; model?: unknown; thinking?: unknown };
    out.engine.cli = isAgentEngine(engine.cli) ? engine.cli : null;
    out.engine.model = bounded(engine.model, PROJECT_THINKING_MAX_LENGTH);
    out.engine.thinking = bounded(engine.thinking, PROJECT_THINKING_MAX_LENGTH);
  }
  return out;
}

/** Read-path: materialize the block from a stored document, always into a complete shape. */
export function applyProjectClassificationSettings(
  out: { projectClassification?: ProjectClassificationSettings },
  raw: unknown,
): void {
  out.projectClassification = coerceProjectClassificationSettings(raw);
}

/** Write-path: replace-on-write; keep the prior block when `next` omits it. */
export function mergeProjectClassificationSettings(
  next: { projectClassification?: ProjectClassificationSettings },
  current: ProjectClassificationSettings,
): ProjectClassificationSettings {
  return coerceProjectClassificationSettings(next.projectClassification ?? current);
}
