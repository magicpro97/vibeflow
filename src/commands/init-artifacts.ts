// src/commands/init-artifacts.ts
//
// Extracted from src/commands/init.ts (issue #186, PR6). Contains the
// second half of init(): workflow-artifact generation, tool provisioning,
// hooks setup, ctx7 auth, find-skills fallback, AI enrichment, and cleanup.
// Called from init() with every captured local threaded as an explicit param.

import {
  CTX_DIR,
  ENGINES,
  TOOLS,
  VALID_TOOLS,
  armHooks,
  basename,
  c,
  collectHookSetup,
  copyPhaseAgentTemplates,
  copyPhaseSkillTemplates,
  copySkillCreator,
  copyUsageGuide,
  cwd,
  defaultHookConfig,
  ensureContextDir,
  ensureCtx7Auth,
  ensureToolIndex,
  existsSync,
  generateWorkflowArtifacts,
  join,
  out,
  panel,
  provisionTool,
  readSettings,
  readTemplate,
  rmSync,
  runFindSkillsFallback,
  runInitAiEnrichment,
  runMemoryPhase,
  spawnSync,
  writeFileSafe,
  writeSettings,
  writeToolConfigs,
} from "./_shared.js";
import type {
  AgentEngine,
  ApplyIntakeResult,
  AsyncSpawner,
  Ctx7AuthResult,
  Engine,
  EngineReadiness,
  HookConfig,
  IntakeAnswers,
  MemoryPhaseInject,
  StepSpawner,
  ToolName,
  UnitDispatcher,
  WorkflowPhase,
} from "./_shared.js";
import { detectToolchain } from "./tools-detect.js";

function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

export function seedClaudeCode(base: string, engines: readonly string[], dry: boolean): string[] {
  if (!engines.includes("claude")) return [];
  const written: string[] = [];
  const claudeDir = join(base, ".claude");

  const tc = detectToolchain(base);
  const runner =
    tc.kind === "npm" || tc.kind === "monorepo" ? tc.runner : tc.kind === "gradle" ? tc.cmd : "npm";
  const toolchainLabel =
    tc.kind === "npm"
      ? `${runner} + TypeScript`
      : tc.kind === "monorepo"
        ? `${runner} + TypeScript (monorepo: ${tc.dir})`
        : tc.kind === "gradle"
          ? "Gradle"
          : "Unknown";
  const vars = { runner, toolchainLabel, projectName: basename(base) };

  // .claude/rules/coding-conventions.md (create-if-absent)
  const rulesPath = join(claudeDir, "rules", "coding-conventions.md");
  if (!dry && !existsSync(rulesPath)) {
    writeFileSafe(rulesPath, readTemplate("claude/rules/coding-conventions.md"));
    written.push(".claude/rules/coding-conventions.md");
  }

  // .claude/CLAUDE.md (create-if-absent)
  const claudeMdPath = join(claudeDir, "CLAUDE.md");
  if (!dry && !existsSync(claudeMdPath)) {
    writeFileSafe(claudeMdPath, renderTemplate(readTemplate("claude/CLAUDE.md.mustache"), vars));
    written.push(".claude/CLAUDE.md");
  }

  return written;
}

export async function writeInitArtifacts(params: {
  answers: IntakeAnswers;
  result: ApplyIntakeResult;
  dry: boolean;
  ai: boolean;
  useAgentTeam: boolean;
  initEngine: Engine;
  engines: Engine[];
  flags: Record<string, string | boolean>;
  inject: {
    syncSpawner?: StepSpawner;
    hasCommandFn?: (cmd: string) => boolean;
    /** Override tool detection for Phase 1.6 (test seam). Defaults to TOOLS[name].detect(). */
    detectTool?: (name: ToolName) => boolean;
    hookSetup?: HookConfig | null;
    memoryInject?: MemoryPhaseInject;
    aiSpawner?: AsyncSpawner;
    aiPreflight?: (engines: Engine[], opts: { probe: boolean }) => EngineReadiness[];
    dispatcher?: UnitDispatcher;
    ctx7Inject?: {
      spawner?: typeof spawnSync;
      askConfirm?: (q: string) => Promise<boolean | null>;
    };
  };
}): Promise<number> {
  const { answers, result, dry, ai, useAgentTeam, initEngine, engines, flags, inject } = params;

  // Phase 1.5: Deterministic workflow artifacts (from questionnaire phases)
  const hasPhases = Boolean(answers.workflowPhases?.length);
  if (!dry && hasPhases) {
    const targetEngines = (answers.engines ?? ["copilot"]) as AgentEngine[];
    const projectName = basename(cwd());
    const phases = answers.workflowPhases as WorkflowPhase[];
    const artifactFiles = generateWorkflowArtifacts({
      phases,
      engines: targetEngines,
      projectName,
      base: cwd(),
    });
    if (artifactFiles.length) {
      out("vf");
      out("vf", panel("Workflow", c.bold("artifacts")));
      for (const rel of artifactFiles) {
        out("vf", c.green(`+ ${rel}`));
      }
      out("vf");
      out("vf", c.bold(`Generated ${artifactFiles.length} workflow artifact(s).`));
    }
    if (!result.refused) {
      for (const rel of copySkillCreator(cwd(), targetEngines)) {
        out("vf", c.green(`+ ${rel}/SKILL.md`));
      }
      for (const rel of copyPhaseAgentTemplates(cwd(), phases, targetEngines, projectName)) {
        out("vf", c.green(`+ ${rel}`));
      }
      for (const rel of copyPhaseSkillTemplates(cwd(), phases, projectName)) {
        out("vf", c.green(`+ ${rel}`));
      }
      for (const rel of ensureContextDir(cwd())) {
        out("vf", c.green(`+ ${rel}`));
      }
      for (const rel of copyUsageGuide(cwd(), phases, targetEngines, projectName)) {
        out("vf", c.green(`+ ${rel}`));
      }
    }
  }

  // Phase 1.55: claude-mem opt-in. Skipped on dry runs.
  if (!dry && !result.refused) {
    const memoryEngines = (answers.engines?.length ? answers.engines : ENGINES).filter(
      (e): e is Engine => (ENGINES as string[]).includes(e),
    );
    await runMemoryPhase(cwd(), flags, memoryEngines, inject.memoryInject);
  }

  // Phase 1.6: Tool provisioning — auto-install every enabled-but-missing tool
  // (issue #333), write MCP config once, and build per-tool index.
  if (!dry) {
    const syncSpawner: StepSpawner =
      inject.syncSpawner ??
      ((cmd, args) => {
        const r = spawnSync(cmd, args, { cwd: cwd(), stdio: "inherit" });
        return { status: r.status ?? 1 };
      });
    const curSettings = readSettings(cwd());
    let toolsNewlyInstalled = false;

    for (const name of VALID_TOOLS) {
      if (!curSettings.tools?.[name]) continue; // not enabled by user — skip
      const detect = inject.detectTool ?? ((name: ToolName) => TOOLS[name].detect());
      const installed = detect(name);
      if (installed) {
        ensureToolIndex(cwd(), name, syncSpawner);
      } else {
        out("vf", c.cyan(`▶ Installing ${TOOLS[name].title}...`));
        const rc = provisionTool(cwd(), name, syncSpawner);
        if (rc === 0) {
          out("vf", c.green(`+ installed ${TOOLS[name].title}`));
          ensureToolIndex(cwd(), name, syncSpawner);
          toolsNewlyInstalled = true;
        } else {
          out(
            "vf",
            c.yellow(
              `! ${TOOLS[name].title} install failed — skipping. Run \`vf tools install ${name}\` manually.`,
            ),
          );
        }
      }
    }

    // Only re-sync MCP configs when a tool was newly installed this run.
    // applyIntake() already called writeToolConfigs via syncToolConfigs for
    // pre-existing tools, so a second call would duplicate the Copilot
    // instructions print without changing any files.
    if (toolsNewlyInstalled) {
      writeToolConfigs(cwd(), readSettings(cwd()), engines);
    }
  }

  // Phase 1.65: Guardrail-hooks setup — interactive on TTY, auto-arm with
  // default all-on policy in headless/CI mode (issue #333).
  const wantHooks = !dry && !result.refused && !flags["no-hooks"];
  if (wantHooks) {
    const config =
      inject.hookSetup !== undefined
        ? inject.hookSetup
        : process.stdin.isTTY
          ? await collectHookSetup()
          : defaultHookConfig(); // headless/CI: auto-arm with all-on default
    if (config) {
      out("vf");
      const armed = armHooks(cwd(), config);
      out("vf", panel("Hooks", c.bold("armed")));
      out("vf", c.green(`+ ${CTX_DIR}/SETTINGS.json (hooks policy)`));
      for (const rel of armed) out("vf", `${c.green("+")} ${rel}`);
      const custom = config.custom.length ? `, ${config.custom.length} custom` : "";
      out("vf", c.dim(`${config.templates.length} template(s) active${custom}.`));
    } else {
      out("vf", c.dim("Hooks setup skipped — existing guardrail policy left unchanged."));
    }
  }

  // Phase 1.66: Claude Code scaffolding (create-if-absent)
  const claudeFiles = seedClaudeCode(cwd(), engines, dry);
  for (const rel of claudeFiles) {
    out("vf", `${c.green("+")} ${rel}`);
  }

  // Phase 1.7: ctx7 auth check
  let ctx7Auth: Ctx7AuthResult = { authenticated: false, fallback: true };
  if (ai && !dry && !result.refused && process.stdin.isTTY) {
    out("vf");
    out("vf", panel("ctx7", c.bold("auth")));
    ctx7Auth = await ensureCtx7Auth(inject.ctx7Inject ?? {});
  }

  // Phase 1.8: find-skills fallback
  if (ai && !dry && !result.refused && ctx7Auth.fallback) {
    out("vf");
    out("vf", panel("Skills", c.bold("find")));
    await runFindSkillsFallback(cwd());
  }

  // Phase 2: AI enrichment
  await runInitAiEnrichment({
    ai,
    dry,
    refused: Boolean(result.refused),
    initEngine,
    useAgentTeam,
    hasPhases,
    answers,
    ctx7Auth,
    autopilot: Boolean(flags.autopilot),
    inject: {
      aiSpawner: inject.aiSpawner,
      aiPreflight: inject.aiPreflight,
      dispatcher: inject.dispatcher,
    },
  });

  // Phase 3: Cleanup
  if (ai && !dry && !result.refused) {
    const aiCtxDir = join(cwd(), CTX_DIR, "ai-context");
    if (existsSync(aiCtxDir)) {
      rmSync(aiCtxDir, { recursive: true, force: true });
      out("vf", c.dim(`  cleaned ${CTX_DIR}/ai-context/ (init-only temp files)`));
    }
  }

  return 0;
}
