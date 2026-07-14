import type { ProjectContext } from "../adapters/context-builders.js";
import {
  VF_COMMANDS_SLIM,
  VF_WORKFLOW_SLIM,
  aiGenerate,
  navigationPolicy,
} from "../adapters/context-builders.js";
import { type Engine, VERSION } from "../core.js";
import { engineEnforcement } from "../hooks/adapters.js";

/**
 * Build the SLIM always-loaded instruction body (issue #322). Engines auto-load
 * CLAUDE.md / AGENTS.md / .github/copilot-instructions.md on every (headless) run, so the
 * managed block must stay small: a one-line banner, the 5 CORE commands, the confidence gate,
 * and a POINTER to the `vf` skill. The long workflow narrative, the full command surface,
 * knowledge write-back, and the execution-retry policy live in the on-demand
 * `.vibeflow/WORKFLOW_POLICY.md` and the `vf` skill — not in every headless load.
 * Keeps the fenced block ≤ 15 lines (markers included).
 */
function engineBody(engine: Engine, ctx: ProjectContext): string {
  const nav = navigationPolicy(ctx.settings);
  const navLine = nav ? `- ${nav}\n` : "";
  const goal = (ctx.goal ?? "").trim();
  const title = engine === "claude" ? "# CLAUDE.md" : "# AGENTS.md";
  // #624 Task 5: honesty for detection-only engines (Codex has no vetoing pre-tool
  // hook). Tell the agent its risky actions are flagged AFTER the fact, not blocked,
  // so it must lean on `vf verify` + the commit-time git gate rather than assume a
  // live guardrail will stop a destructive action. Native engines get no such line.
  const detectionOnly =
    engineEnforcement(engine).preActionBlocking === "post-hoc-only"
      ? "> ⚠ Detection-only guardrails on this engine: risky actions are flagged AFTER they run, not blocked. Rely on `vf verify` and the git pre-commit gate — do not assume a live hook will stop a destructive command.\n"
      : "";
  return `${title}
## ⚡ VibeFlow v${VERSION} Active — local-first orchestrator for AI coding agents (https://github.com/magicpro97/vibeflow).
Project: ${ctx.name} · Goal: ${goal}
${navLine}${detectionOnly}${VF_COMMANDS_SLIM}
${VF_WORKFLOW_SLIM}
Powered by VibeFlow v${VERSION} — https://github.com/magicpro97/vibeflow
`;
}

export function engineFiles(
  engine: Engine,
  ctx: ProjectContext,
  useAi = true,
): Record<string, string> {
  const compose = (prompt: string, fallback: () => string): string =>
    useAi ? aiGenerate(prompt, fallback) : fallback();
  // AI-mode emits the SAME slim block as the fallback (#322): keep the managed region short and
  // point to the `vf` skill for the full workflow — do NOT re-expand it into the old verbose form.
  const prompt = `Compose the ${engine} instruction file for project "${ctx.name}" from this context:\n${JSON.stringify(ctx)}\nKeep the VibeFlow-managed block SLIM (≤ ~13 lines): banner, the 5 core commands, the confidence gate, and a pointer to the \`vf\` skill — do not expand the full workflow narrative inline.`;
  const body = compose(prompt, () => engineBody(engine, ctx));
  switch (engine) {
    case "claude":
      return { "CLAUDE.md": body };
    case "codex":
      return { "AGENTS.md": body };
    case "copilot":
      return {
        "AGENTS.md": body,
        ".github/copilot-instructions.md": compose(
          `Compose .github/copilot-instructions.md for "${ctx.name}".`,
          () => `# Copilot Instructions\n\n${engineBody("copilot", ctx)}\n`,
        ),
      };
    case "opencode":
      return { "AGENTS.md": body };
  }
}
