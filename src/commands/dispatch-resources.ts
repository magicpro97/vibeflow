import type { WorkUnit } from "../core.js";
import { AGENT_ENGINE } from "../core/agent-contract.js";
import { parseEngineResources } from "../engine-output.js";

// #523: claude-default back-compat shim; engine-aware parsing (all four engines)
// lives in src/engine-output.ts — callers that know the running unit's engine
// should call parseEngineResources directly. Best-effort: undefined on any parse miss.
export const parseResources = (
  raw: string | undefined,
): Partial<WorkUnit["resources"]> | undefined => parseEngineResources(AGENT_ENGINE.CLAUDE, raw);
