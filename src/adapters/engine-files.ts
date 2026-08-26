import type { ProjectContext } from "../adapters/context-builders.js";
import {
  VF_COMMANDS_SLIM,
  VF_WORKFLOW_SLIM,
  aiGenerate,
  navigationPolicy,
} from "../adapters/context-builders.js";
import { type Engine, VERSION } from "../core.js";
import type { OwnedAiRouteRunner } from "../dispatch/owned-ai-route.js";
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
  const enforcement = engineEnforcement(engine).preActionBlocking;
  const guardrailNote =
    enforcement === "native-bash-only"
      ? "> ⚠ Codex native blocking covers Bash/shell only. Edit/Write/apply_patch/MCP calls remain unguarded by this hook; rely on `vf verify` and the git pre-commit gate. Codex hook config is global at `~/.codex/`.\n"
      : "";
  return `${title}
## ⚡ VibeFlow v${VERSION} Active — local-first orchestrator for AI coding agents (https://github.com/magicpro97/vibeflow).
Project: ${ctx.name} · Goal: ${goal}
${navLine}${guardrailNote}${VF_COMMANDS_SLIM}
${VF_WORKFLOW_SLIM}
Powered by VibeFlow v${VERSION} — https://github.com/magicpro97/vibeflow
`;
}

export async function engineFiles(
  engine: Engine,
  ctx: ProjectContext,
  useAi = true,
  inject: { cwd?: string; ownedRoute?: OwnedAiRouteRunner } = {},
): Promise<Record<string, string>> {
  const compose = (prompt: string, fallback: () => string): Promise<string> =>
    useAi ? aiGenerate(engine, prompt, fallback, inject) : Promise.resolve(fallback());
  // AI-mode emits the SAME slim block as the fallback (#322): keep the managed region short and
  // point to the `vf` skill for the full workflow — do NOT re-expand it into the old verbose form.
  const prompt = `Compose the ${engine} instruction file for project "${ctx.name}" from this context:\n${JSON.stringify(ctx)}\nKeep the VibeFlow-managed block SLIM (≤ ~13 lines): banner, the 5 core commands, the confidence gate, and a pointer to the \`vf\` skill — do not expand the full workflow narrative inline.`;
  const body = await compose(prompt, () => engineBody(engine, ctx));
  switch (engine) {
    case "claude":
      return { "CLAUDE.md": body };
    case "codex":
      return { "AGENTS.md": body };
    case "copilot":
      return {
        "AGENTS.md": body,
        ".github/copilot-instructions.md": await compose(
          `Compose .github/copilot-instructions.md for "${ctx.name}".`,
          () => `# Copilot Instructions\n\n${engineBody("copilot", ctx)}\n`,
        ),
      };
    case "opencode":
      return { "AGENTS.md": body };
    case "antigravity":
      return { "AGENTS.md": body };
  }
}
