import type { WorkUnit } from "../core.js";

// #523: parse cost/tokens from the Claude result envelope so the progress
// footer shows real numbers. Best-effort — returns undefined on any parse miss.
export function parseResources(
  raw: string | undefined,
): Partial<WorkUnit["resources"]> | undefined {
  if (!raw) return undefined;
  try {
    const env = JSON.parse(raw);
    const cost = typeof env.total_cost_usd === "number" ? env.total_cost_usd : undefined;
    const inTok = typeof env.usage?.input_tokens === "number" ? env.usage.input_tokens : 0;
    const outTok = typeof env.usage?.output_tokens === "number" ? env.usage.output_tokens : 0;
    const tokens = inTok + outTok;
    if (cost === undefined && tokens === 0) return undefined;
    return { ...(cost !== undefined ? { cost_usd: cost } : {}), ...(tokens ? { tokens } : {}) };
  } catch {
    return undefined;
  }
}
