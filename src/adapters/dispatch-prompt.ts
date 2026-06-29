import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectContext } from "../adapters/context-builders.js";
import type { Engine } from "../core.js";
import { CTX_DIR, cwd } from "../core.js";

// ponytail: inlined from dispatch-rules.ts (#390)
export const DISPATCH_HARD_RULES = [
  "- Push with an explicit refspec: `git push origin HEAD:<branch>` (a bare push can hit main).",
  "- Stage explicit paths (`git add <file>`), never `git add -A` (it sweeps unrelated junk).",
  "- Verify lint with the FULL tree: `bunx biome check src test` (a single-file check misses format/organizeImports/noDelete).",
  "- To cover a gh/exec call, use an injectable `exec = execFileSync` default-param seam plus a fake — NEVER `mock.module` + `?nocache=` (it dual-imports the module and craters coverage).",
  "- Verify coverage in the FULL suite (the gate measures the full suite), not an isolated file run.",
];
export function readDispatchPolicyRules(readPolicy?: () => string | undefined): string[] {
  try {
    const reader =
      readPolicy ??
      (() => {
        const policyPath = join(cwd(), CTX_DIR, "WORKFLOW_POLICY.md");
        if (!existsSync(policyPath)) return undefined;
        return readFileSync(policyPath, "utf-8");
      });
    const policyText = reader();
    if (!policyText) return [];
    const section = policyText.match(/## Dispatch hard rules\n([\s\S]*?)(?=\n## |$)/);
    if (!section?.[1]) return [];
    return section[1]
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .map((l) => l.trim());
  } catch {
    return [];
  }
}
export function resolveDispatchRules(readPolicy?: () => string | undefined): string[] {
  const augment = readDispatchPolicyRules(readPolicy);
  return [...new Set([...DISPATCH_HARD_RULES, ...augment])];
}

export type UnitBrief =
  | string
  | {
      name: string;
      spec?: string;
      scope?: string[];
      /** Verified skills resolved for this unit (by name) — injected so the engine follows them. */
      skills?: string[];
      /** True when this is a knowledge-heavy unit (e.g. UX/UI) and NO skill matched. */
      skillGap?: boolean;
    };

function briefName(u: UnitBrief): string {
  return typeof u === "string" ? u : u.name;
}

type UnitBriefObj = Exclude<UnitBrief, string>;

export function dispatchPrompt(
  engine: Engine,
  ctx: ProjectContext,
  units: UnitBrief[],
  inject: { readPolicy?: () => string | undefined } = {},
): string {
  const names = units.map(briefName);
  const objs = units.filter((u): u is UnitBriefObj => typeof u !== "string");
  const specs = objs.filter(
    (u) => Boolean(u.spec?.trim()) || Boolean(u.scope?.length) || Boolean(u.skills?.length),
  );
  const goal = (ctx.goal ?? "").trim();
  const lines = [
    `# VibeFlow dispatch → ${engine}`,
    "",
    `Goal: ${goal}`,
    `Work units: ${names.length ? names.join(", ") : "(none — running the whole task)"}`,
    "",
  ];
  if (specs.length) {
    lines.push("Work unit details:");
    for (const u of specs) {
      lines.push(`- ${u.name}`);
      if (u.scope?.length) lines.push(`  scope: ${u.scope.join(", ")}`);
      if (u.spec?.trim()) lines.push(`  spec: ${u.spec.trim()}`);
      if (u.skills?.length) lines.push(`  skills: ${u.skills.join(", ")}`);
    }
    lines.push("");
  }
  const matched = objs.flatMap((u) => u.skills ?? []);
  const gaps = objs.filter((u) => u.skillGap).map((u) => u.name);
  if (matched.length || gaps.length) {
    lines.push("Skills:");
    if (matched.length) {
      lines.push(
        `- Follow these verified skills before improvising: ${[...new Set(matched)].join(", ")}.`,
      );
    }
    if (gaps.length) {
      lines.push(
        `- NO verified skill matched for: ${gaps.join(", ")}. Do NOT freelance knowledge-heavy work (especially UX/UI) — follow the spec exactly, mirror existing patterns in the repo, and flag in your uncertainty that no skill backed this.`,
      );
    }
    lines.push("");
  }
  const enabledTools: string[] = [];
  if (ctx.settings?.tools?.codegraph) enabledTools.push("codegraph (code-graph MCP)");
  if (ctx.settings?.tools?.lsp) enabledTools.push("lsp (language-server MCP)");
  if (enabledTools.length) {
    lines.push(
      "Code navigation:",
      `- Prefer these MCP tools over raw grep/find for definitions, references, and callers: ${enabledTools.join(", ")}.`,
      "- Priority order: codegraph > lsp > native search. Fall back to native only if the tool is unavailable.",
      "",
    );
  }
  const hardRules = resolveDispatchRules(inject.readPolicy);

  lines.push(
    "Constraints:",
    "- Stay within the declared scope of your work unit.",
    "- Use selected skills; do not invent manual steps when a verified skill exists.",
    "- Return a JSON summary: skills used, files changed, commands run, tests run, confidence, uncertainty.",
    ...hardRules,
    "",
  );
  return lines.join("\n");
}
