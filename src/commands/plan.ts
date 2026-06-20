// src/commands/plan.ts
//
// A3 of the orchestrator-first plan (issue #169): `vf plan <artifact>`.
//
// Dispatches a planner engine (codex by default) to produce a
// structured plan file. The plan is parsed for 6 canonical sections
// (matching the brief's 6-section shape) and written to
// `.vibeflow/plans/<slug>.md`.
//
// The dispatch uses the same `runDispatchAsync` pattern as the
// orchestrate cluster. The engine does NOT execute the plan — it
// only produces it. The coordinator decides what to do next.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRIEF_PATH, CTX_DIR, c, cwd, out } from "./_shared.js";

/** The 6 canonical plan sections (match the brief's 6). */
export const PLAN_SECTIONS = [
  "## 1. The artifact",
  "## 2. The proposed changes",
  "## 3. The dependency graph",
  "## 4. The acceptance criteria",
  "## 5. The risk register",
  "## 6. The test plan",
] as const;

/** Default plans directory. */
export const PLANS_DIR = `${CTX_DIR}/plans`;

/** Default engine. */
export const DEFAULT_PLAN_ENGINE = "codex";

/** Default slug truncation. */
export const SLUG_MAX = 60;

/** Slugify an artifact for use in the plan filename.
 *  Lowercase, spaces to dashes, stripped of special chars (but dots
 *  are preserved since they're meaningful in source filenames like
 *  `state.ts`). Truncated to `max` chars. */
export function slugify(artifact: string, max = SLUG_MAX): string {
  return (
    artifact
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9.-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^\.+|\.+$/g, "")
      .replace(/^-+|-+$/g, "")
      // Truncate to max, but also strip a trailing dash/dot so we
      // don't produce "foo-" when the max cuts mid-word.
      .slice(0, max)
      .replace(/[-.]+$/g, "") || "plan"
  );
}

/** Build the prompt that the planner engine will see. The prompt:
 *  - names the artifact
 *  - lists the 6 required sections
 *  - includes the brief's §2 non-negotiables (so the plan respects them)
 *  - asks for the JSON summary contract
 *
 *  Returns the prompt string. */
export function buildPlanPrompt(artifact: string, briefRaw: string | null): string {
  const sections = PLAN_SECTIONS.map((s, i) => `${i + 1}. ${s.replace(/^## \d+\. /, "")}`).join(
    "\n",
  );
  const nonNegotiables = briefRaw
    ? (extractSection(briefRaw, "## 2. Non-negotiables") ?? "(none specified)")
    : "(no brief — running without §2 constraints)";
  return `You are a planning engine. Produce a structured plan for the following artifact.

ARTIFACT:
${artifact}

The plan MUST contain these 6 sections (use exactly these headings, in order):
${sections}

§2 NON-NEGOTIABLES from the brief (the plan must respect these):
${nonNegotiables}

The plan is the OUTPUT. Do not execute it. Just write the plan.

When done, output the plan as a markdown block. Do not include any other commentary.`;
}

/** Extract a section by heading from a brief (or plan) body. */
function extractSection(raw: string, heading: string): string | null {
  const idx = raw.indexOf(heading);
  if (idx === -1) return null;
  const rest = raw.slice(idx + heading.length);
  const next = rest.search(/^## /m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

/** Parse the engine response for the 6 sections. If a section is
 *  missing, return the parsed sections + a list of missing headings
 *  so the caller can warn. */
export function parsePlanSections(raw: string): {
  sections: Record<string, string>;
  missing: readonly string[];
} {
  const sections: Record<string, string> = {};
  const missing: string[] = [];
  for (const heading of PLAN_SECTIONS) {
    const content = extractSection(raw, heading);
    if (content === null) {
      missing.push(heading);
    } else {
      sections[heading] = content;
    }
  }
  return { sections, missing };
}

/** The plan entry point. Dispatches the engine, parses the response,
 *  writes the plan file. Returns 0 on success, 1 on failure. */
export async function plan(
  args: string[],
  flags: Record<string, string | boolean>,
  inject: {
    existsSync?: (p: string) => boolean;
    readFileSync?: (p: string, enc: string) => string;
    writeFileSync?: (p: string, data: string) => void;
    now?: () => number;
    dispatch?: (opts: { engine: string; prompt: string; mode: string }) => Promise<{
      ok: boolean;
      raw: string;
      reason?: string;
    }>;
  } = {},
): Promise<number> {
  const artifact = args.join(" ").trim();
  if (artifact.length === 0) {
    out(
      "vf",
      c.red(
        'vf plan <artifact>: missing artifact. Usage: vf plan "split commands.ts into state.ts + state-frontmatter.ts + atomic-write.ts"',
      ),
      {
        level: "error",
      },
    );
    return 2;
  }
  const engine =
    typeof flags.engine === "string" && flags.engine.length > 0
      ? flags.engine
      : DEFAULT_PLAN_ENGINE;
  const customOut = typeof flags.out === "string" && flags.out.length > 0 ? flags.out : null;
  const _exists = inject.existsSync ?? existsSync;
  const _read = inject.readFileSync ?? readFileSync;
  const _write = inject.writeFileSync ?? writeFileSync;
  const _now = inject.now ?? (() => Date.now());

  // Read the brief (if it exists) for the §2 non-negotiables.
  const briefPath = join(cwd(), BRIEF_PATH);
  const briefRaw = _exists(briefPath) ? _read(briefPath, "utf8") : null;
  const prompt = buildPlanPrompt(artifact, briefRaw);

  // Resolve the output path.
  const slug = slugify(artifact);
  const defaultPath = join(cwd(), PLANS_DIR, `${slug}.md`);
  const outPath = customOut ?? defaultPath;

  // Dispatch the engine.
  out("vf", c.dim(`vf plan: dispatching ${engine} for "${artifact}"`), {
    meta: { kind: "plan-dispatch", engine, artifact, outPath },
  });
  const dispatch = inject.dispatch;
  if (!dispatch) {
    out("vf", c.red("vf plan: no dispatch inject provided (test seam required for now)"), {
      level: "error",
    });
    return 1;
  }
  const result = await dispatch({ engine, prompt, mode: "cli" });
  if (!result.ok) {
    out("vf", c.red(`vf plan: dispatch failed: ${result.reason ?? "unknown error"}`), {
      level: "error",
      meta: { kind: "plan-failed", engine, reason: result.reason },
    });
    return 1;
  }

  // Parse the response.
  const parsed = parsePlanSections(result.raw);
  if (parsed.missing.length > 0) {
    out(
      "vf",
      c.yellow(
        `vf plan: engine response is missing ${parsed.missing.length} canonical section(s): ${parsed.missing.join(", ")}. Writing what we have.`,
      ),
      { level: "warn", meta: { kind: "plan-incomplete", missing: [...parsed.missing] } },
    );
  }

  // Write the plan file. The content is the engine's raw response
  // (NOT our re-assembled sections) — the engine is the source of
  // truth for the prose.
  try {
    mkdirSync(join(outPath, ".."), { recursive: true });
  } catch {
    // best-effort
  }
  _write(outPath, result.raw);

  out("vf", c.green(`vf plan: wrote plan to ${outPath}`), {
    meta: { kind: "plan-written", outPath, engine, missing: parsed.missing.length },
  });
  return 0;
}
