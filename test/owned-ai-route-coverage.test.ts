import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { type OwnedAiRouteRequest, runOwnedAiRoute } from "../src/dispatch/owned-ai-route.js";
import type { AsyncSpawnOwnership } from "../src/dispatch/types.js";

const ROOT = join(import.meta.dir, "..");

type BoundaryClass =
  | "canonical-owned-runtime"
  | "compatibility-runtime"
  | "git-or-system-command"
  | "tool-extension"
  | "presence-or-auth-probe";

/**
 * Machine-readable inventory of every file allowed to import node:child_process,
 * require it, or invoke Bun.spawn/Bun.spawnSync directly. A new direct process
 * boundary fails this test until it is classified. AI entrypoints are intentionally
 * absent: they must enter through owned-ai-route or an owned session spawner.
 */
const DIRECT_PROCESS_BOUNDARIES: Readonly<Record<string, BoundaryClass>> = {
  "src/bun-shim.mjs": "compatibility-runtime",
  "src/cli.ts": "git-or-system-command",
  "src/commands/_shared.ts": "compatibility-runtime",
  "src/commands/dispatch-diff.ts": "git-or-system-command",
  "src/commands/dispatch-reviewer-llm.ts": "git-or-system-command",
  "src/commands/hooks.ts": "git-or-system-command",
  "src/commands/orchestrate-focus.ts": "git-or-system-command",
  "src/commands/pr-gh.ts": "git-or-system-command",
  "src/commands/pr-merge-when-green.ts": "git-or-system-command",
  "src/commands/protection.ts": "git-or-system-command",
  "src/commands/tools-detect.ts": "git-or-system-command",
  "src/commands/units-ingest.ts": "git-or-system-command",
  "src/commands/waiver-gate.ts": "git-or-system-command",
  "src/dispatch/isolation.ts": "git-or-system-command",
  "src/dispatch/owned-process-launch-runtime.ts": "canonical-owned-runtime",
  "src/dispatch/owned-process-platform.ts": "canonical-owned-runtime",
  "src/dispatch/spawners.ts": "canonical-owned-runtime",
  "src/dispatch/types.ts": "canonical-owned-runtime",
  "src/durability/lock-owner.ts": "git-or-system-command",
  "src/hooks/impact-evidence.ts": "git-or-system-command",
  "src/hooks/review-evidence.ts": "git-or-system-command",
  "src/memory.ts": "tool-extension",
  "src/memory/claude-mem.ts": "tool-extension",
  "src/notify.ts": "tool-extension",
  "src/orchestrator/conversation/bootstrap-isolation.ts": "git-or-system-command",
  "src/orchestrator/conversation/conversation-delegation-workspace-git.ts": "git-or-system-command",
  "src/orchestrator/conversation/conversation-delegation-workspace-verification.ts":
    "git-or-system-command",
  "src/orchestrator/marker.ts": "git-or-system-command",
  "src/orchestrator/publish-unit.ts": "git-or-system-command",
  "src/orchestrator/scoped-gate.ts": "git-or-system-command",
  "src/preflight/probe.ts": "presence-or-auth-probe",
  "src/safety/checkpoint.ts": "git-or-system-command",
  "src/sandbox.ts": "tool-extension",
  "src/server/dashboard-diff.ts": "git-or-system-command",
  "src/skills/curator-scan.ts": "git-or-system-command",
  "src/skills/curator.ts": "git-or-system-command",
  "src/skills/policy-checks.ts": "git-or-system-command",
  "src/skills/registry-channel.ts": "tool-extension",
  "src/skills/registry-install.ts": "tool-extension",
  "src/skills/registry-release-git.ts": "git-or-system-command",
  "src/skills/security-scan.ts": "tool-extension",
  "src/spec-freshness.ts": "git-or-system-command",
  "src/superpowers-sync-exec.ts": "tool-extension",
  "src/superpowers-sync.ts": "tool-extension",
  "src/verify/core.ts": "git-or-system-command",
  "src/verify/normative-proof-run-async.ts": "git-or-system-command",
  "src/verify/normative-proof-run.ts": "git-or-system-command",
};

const AI_ROUTE_FAMILIES = [
  {
    family: "coord",
    files: ["src/commands/coord.ts"],
  },
  {
    family: "reviewer",
    files: ["src/commands/dispatch-reviewer.ts", "src/commands/dispatch-reviewer-llm.ts"],
    allowedDirectProcessFiles: ["src/commands/dispatch-reviewer-llm.ts"],
  },
  {
    family: "goal-evaluation",
    files: ["src/commands/tools-detect.ts"],
    allowedDirectProcessFiles: ["src/commands/tools-detect.ts"],
  },
  {
    family: "semantic-risk",
    files: ["src/hooks/risk-semantic.ts"],
  },
  {
    family: "skill-semantic-review",
    files: ["src/skills/semantic-filter.ts"],
  },
  {
    family: "skill-eval",
    files: ["src/skills/eval.ts", "src/commands/skills-eval.ts"],
  },
  {
    family: "agent-file-enrichment",
    files: ["src/adapters/agent-files.ts"],
  },
  {
    family: "context-generation",
    files: ["src/adapters/context-builders.ts", "src/adapters/engine-files.ts"],
  },
  {
    family: "live-preflight",
    files: ["src/preflight/check-async.ts"],
  },
  {
    family: "dispatch",
    files: ["src/dispatch.ts", "src/ai-init/dispatch.ts"],
  },
  {
    family: "ask",
    files: ["src/ask-support.ts", "src/commands/ask.ts", "src/server/ask-route.ts"],
  },
] as const;

function sourceFile(path: string): ts.SourceFile {
  const source = readFileSync(join(ROOT, path), "utf8");
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function directProcessSignals(path: string): string[] {
  const file = sourceFile(path);
  const signals: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "node:child_process"
    ) {
      signals.push("node:child_process");
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(file);
      if (callee.includes("Bun.spawn")) signals.push(callee);
      if (
        callee === "require" &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === "node:child_process"
      ) {
        signals.push("require(node:child_process)");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return signals;
}

async function discoveredDirectBoundaries(): Promise<string[]> {
  const paths: string[] = [];
  const glob = new Bun.Glob("src/**/*.{ts,mjs}");
  for await (const path of glob.scan({ cwd: ROOT, onlyFiles: true })) {
    if (directProcessSignals(path).length > 0) paths.push(path);
  }
  return paths.sort();
}

describe("owned AI route lifecycle", () => {
  test("passes a fresh exact-engine ownership claim to the canonical async spawner", async () => {
    const request: OwnedAiRouteRequest = {
      engine: "codex",
      command: "codex",
      args: ["exec", "-"],
      input: "prompt",
      cwd: "/repo",
      evidenceRoot: "/repo/evidence",
    };
    let seenOwnership: AsyncSpawnOwnership | undefined;
    const result = await runOwnedAiRoute(request, {
      randomUUID: () => "route-attempt",
      makeSpawner: (seenRequest) => {
        expect(seenRequest).toBe(request);
        return async (cmd, args, input, ownership) => {
          expect({ cmd, args, input }).toEqual({
            cmd: "codex",
            args: ["exec", "-"],
            input: "prompt",
          });
          seenOwnership = ownership;
          return { status: 0, stdout: "ok", stderr: "", timedOut: false };
        };
      },
    });

    expect(seenOwnership).toEqual({
      attemptId: "route-attempt",
      engine: "codex",
      evidenceRoot: "/repo/evidence",
    });
    expect(result).toEqual({
      attemptId: "route-attempt",
      status: 0,
      stdout: "ok",
      stderr: "",
      timedOut: false,
    });
  });

  test("rejects invalid engine identity and empty commands before creating a spawner", async () => {
    const makeSpawner = () => {
      throw new Error("must not build");
    };
    await expect(
      runOwnedAiRoute(
        { engine: "unknown" as never, command: "x", input: "" },
        { randomUUID: () => "id", makeSpawner },
      ),
    ).rejects.toThrow("invalid engine");
    await expect(
      runOwnedAiRoute(
        { engine: "claude", command: " ", input: "" },
        { randomUUID: () => "id", makeSpawner },
      ),
    ).rejects.toThrow("command is empty");
  });
});

describe("production process-boundary inventory", () => {
  test("every direct child-process boundary has an explicit non-AI classification", async () => {
    expect(await discoveredDirectBoundaries()).toEqual(
      Object.keys(DIRECT_PROCESS_BOUNDARIES).sort(),
    );
  });

  test("AI entrypoints cannot add direct spawn APIs or import spawn from the shared barrel", () => {
    for (const route of AI_ROUTE_FAMILIES) {
      for (const path of route.files) {
        const allowed =
          "allowedDirectProcessFiles" in route &&
          (route.allowedDirectProcessFiles as readonly string[]).includes(path);
        if (!allowed) expect(directProcessSignals(path), `${route.family}: ${path}`).toEqual([]);

        const source = readFileSync(join(ROOT, path), "utf8");
        expect(
          source,
          `${route.family}: ${path} may not import raw spawn through commands/_shared`,
        ).not.toMatch(
          /import\s*\{[^}]*\bspawn(?:Sync)?\b[^}]*\}\s*from\s*["'][^"']*_shared\.js["']/s,
        );
      }
    }
  });

  test("the only AI-entrypoint exceptions invoke raw child processes for git", () => {
    for (const path of ["src/commands/dispatch-reviewer-llm.ts", "src/commands/tools-detect.ts"]) {
      const source = readFileSync(join(ROOT, path), "utf8");
      expect(source).toContain('("git",');
      expect(source).not.toMatch(/(?:spawnSync|_spawnSync)\(\s*(?!["']git["'])/);
    }
  });
});
