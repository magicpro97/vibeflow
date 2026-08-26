import { type AgentEngine, agentFilePath, renderForEngine } from "../agents/render.js";
import { type RoleName, getRoleSpec, roleContextFromProfile } from "../agents/role-templates.js";
import type { RoleSpec } from "../agents/role.js";
import { ENGINES } from "../core.js";
import type { Engine } from "../core.js";
import { type OwnedAiRouteRunner, runOwnedAiRoute } from "../dispatch/owned-ai-route.js";
import type { ProjectProfile } from "../scanner.js";

async function aiEnrichRole(
  spec: RoleSpec,
  profile: ProjectProfile,
  engine: Engine,
  cwd: string,
  ownedRoute: OwnedAiRouteRunner,
): Promise<RoleSpec> {
  const cmd = process.env.VIBEFLOW_AI;
  if (!cmd) return spec;
  const prompt = [
    `Tailor the following agent role for project "${profile.name}".`,
    `Project summary: ${profile.summary ?? "(none)"}.`,
    `Detected stack: ${profile.languages.join(", ")}, packageManager=${profile.packageManager ?? "?"}.`,
    "Return ONLY the rewritten body (markdown). Do not change name, tools, model, or sandbox.",
    "Keep length under 4000 characters.",
    "",
    "Original body:",
    spec.body,
  ].join("\n");
  const result = await ownedRoute({
    engine,
    command: cmd,
    input: prompt,
    cwd,
    shell: true,
    timeoutMs: 30_000,
  });
  if (result.status !== 0 || !result.stdout.trim()) return spec;
  const enrichedBody = result.stdout.trim().slice(0, 4000);
  return { ...spec, body: enrichedBody };
}

export async function agentFiles(
  profile: ProjectProfile,
  roles: RoleName[],
  useAi = true,
  engines: readonly AgentEngine[] = ENGINES as readonly AgentEngine[],
  inject: { cwd?: string; ownedRoute?: OwnedAiRouteRunner } = {},
): Promise<Record<string, string>> {
  const ctx = roleContextFromProfile(profile);
  const out: Record<string, string> = {};
  if (engines.length === 0) return out;
  const enrichmentEngine = engines[0] as Engine;
  for (const roleName of roles) {
    const baseSpec = getRoleSpec(roleName, ctx);
    if (!baseSpec) continue;
    const spec = useAi
      ? await aiEnrichRole(
          baseSpec,
          profile,
          enrichmentEngine,
          inject.cwd ?? process.cwd(),
          inject.ownedRoute ?? runOwnedAiRoute,
        )
      : baseSpec;
    for (const engine of engines) {
      out[agentFilePath(engine, roleName)] = renderForEngine(engine, spec);
    }
  }
  return out;
}
