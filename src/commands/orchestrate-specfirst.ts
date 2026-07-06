// src/commands/orchestrate-specfirst.ts
//
// ADR-002: spec-first test generation, extracted from orchestrate.ts (#472).
// Builds a spec-only prompt (no source, no reviewer machinery) and delegates
// to an injected llmFn. Behavior-preserving move — body byte-identical.

export interface SpecFirstOpts {
  unitName: string;
  spec: string;
  /** Injectable LLM call — production uses engine dispatch; tests use a fake. */
  llmFn: (prompt: string) => Promise<string>;
}

/**
 * Generate test stubs from a unit's spec BEFORE the implementer is dispatched.
 * The LLM sees ONLY the spec — no source code, no implementation context.
 * Returns null when spec is empty (spec-first skipped for that unit).
 * ADR-002: written files are protected from implementer writes via pre-write hook.
 * ponytail: llmFn is injected; production wiring via --spec-first flag in phase 2.
 */
export async function generateSpecFirstTests(opts: SpecFirstOpts): Promise<string | null> {
  if (!opts.spec.trim()) return null;
  const prompt = [
    "You are a test author. Given ONLY the spec below (no implementation), write failing test stubs.",
    "Return ONLY the test code — no explanation, no markdown fences, no implementation.",
    `Unit: ${opts.unitName}`,
    `Spec: ${opts.spec}`,
  ].join("\n");
  return opts.llmFn(prompt);
}
