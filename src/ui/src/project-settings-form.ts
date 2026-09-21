/**
 * Draft → payload mapping for the project-classification settings panel.
 *
 * Browser-safe (no `node:*`): the panel is bundled into the UI. Two authorities, one draft:
 * the global switch/engine belong to the repo settings document, and a per-project engine
 * override belongs to the project registry entry. Both shapes are built here so the panel
 * stays a view and the mapping stays testable without a DOM.
 */
import { ENGINES, type Engine, isAgentEngine } from "../../core/agent-contract.js";
import {
  PROJECT_THINKING_VALUE_MAX_LENGTH,
  type ProjectRailProject,
} from "./project-rail-group.js";

/** Global classifier engine, as the panel edits it: empty strings mean "not set". */
export interface ProjectEngineDraft {
  cli: string;
  model: string;
  thinking: string;
}

/** The global switch plus the engine the classifier runs on. */
export interface ProjectClassificationDraft {
  autoClassify: boolean;
  engine: ProjectEngineDraft;
}

/** One per-project override row. A row whose every field is blank inherits and persists nothing. */
export interface ProjectEngineRowDraft extends ProjectEngineDraft {
  readonly id: string;
}

/** Engine options for the CLI control; the vocabulary is the closed agent-engine set. */
export const PROJECT_ENGINE_OPTIONS: readonly Engine[] = ENGINES;

/** Thinking suggestions only: the vocabulary is engine-specific, so the input stays free text. */
export const PROJECT_THINKING_SUGGESTIONS: readonly string[] = Object.freeze([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/** The applied shape, mirroring the registry's `ProjectEngineV1` without importing `node:path`. */
export interface ProjectEnginePayload {
  cli: Engine;
  model: string | null;
  thinking: string;
}

/** Blank means "inherit the default", which is distinct from a value of `null`. */
export function isProjectEngineDraftEmpty(draft: ProjectEngineDraft): boolean {
  return draft.cli.trim() === "" && draft.model.trim() === "" && draft.thinking.trim() === "";
}

/**
 * Validate the shared engine fields and materialize the payload.
 *
 * A blank model is the engine default (`null`), not an empty model name — the registry asserts
 * `model: string | null`. Thinking is bounded free text because the effort vocabulary differs
 * per CLI, so this rejects only what the registry would reject.
 */
export function buildProjectEnginePayload(
  draft: ProjectEngineDraft,
): ProjectEnginePayload | string {
  const cli = draft.cli.trim();
  if (!isAgentEngine(cli)) return "Choose a CLI for the engine override.";
  const thinking = draft.thinking.trim();
  if (thinking === "" || thinking.length > PROJECT_THINKING_VALUE_MAX_LENGTH)
    return `Thinking must be 1–${PROJECT_THINKING_VALUE_MAX_LENGTH} characters.`;
  const model = draft.model.trim();
  return { cli, model: model === "" ? null : model, thinking };
}

/**
 * One override row → the registry patch, `null` for "inherit", or a message describing what is
 * missing. A partially filled row is an error rather than a silent default: persisting a `cli`
 * with a blank thinking value would fail the registry's own validation at write time.
 */
export function buildProjectEnginePatch(
  row: ProjectEngineRowDraft,
): { engine: ProjectEnginePayload } | string | null {
  if (isProjectEngineDraftEmpty(row)) return null;
  const payload = buildProjectEnginePayload(row);
  return typeof payload === "string" ? payload : { engine: payload };
}

/**
 * The global block as the settings document stores it (`projectClassification`). Blank means
 * "no preference": `cli: null` is the classifier's own default engine, and a null model/thinking
 * is the engine default. Storing null rather than a guessed engine keeps classification on
 * whatever the user's global default is instead of silently pinning one CLI.
 */
export interface ProjectClassificationPatch {
  projectClassification: {
    enabled: boolean;
    engine: { cli: Engine | null; model: string | null; thinking: string | null };
  };
}

/** The stored block as the settings document holds it — the shape the store reads and writes. */
export type ProjectClassificationSlice = ProjectClassificationPatch["projectClassification"];

/** The whole global fieldset → settings patch, or the first message a field failed with. */
export function buildProjectClassificationPatch(
  draft: ProjectClassificationDraft,
): ProjectClassificationPatch | string {
  const cli = draft.engine.cli.trim();
  if (cli !== "" && !isAgentEngine(cli)) return "Choose a CLI for the classifier engine.";
  const thinking = draft.engine.thinking.trim();
  if (thinking.length > PROJECT_THINKING_VALUE_MAX_LENGTH)
    return `Thinking must be at most ${PROJECT_THINKING_VALUE_MAX_LENGTH} characters.`;
  const model = draft.engine.model.trim();
  return {
    projectClassification: {
      enabled: draft.autoClassify,
      engine: {
        cli: cli === "" ? null : cli,
        model: model === "" ? null : model,
        thinking: thinking === "" ? null : thinking,
      },
    },
  };
}

/**
 * Registry projects the panel offers an override row for, in name order.
 *
 * Generic over the row shape so the caller keeps whatever it passed in — the panel needs each
 * project's stored `engine`, which the narrow rail shape does not carry.
 */
export function projectOverrideRows<T extends ProjectRailProject>(projects: readonly T[]): T[] {
  return [...projects].sort((left, right) =>
    (left.name ?? left.id) < (right.name ?? right.id) ? -1 : 1,
  );
}
