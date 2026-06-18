// src/commands/init-ctx7.ts
//
// ctx7 auth + find-skills fallback helpers for `vf init` (issue #80, phase 9/14).
// Extracted from src/commands/init.ts to keep init.ts under the 400-line cap.
//
// Contents:
// - Ctx7AuthResult: the auth-probe result shape returned by ensureCtx7Auth.
// - ensureCtx7Auth: checks ctx7 login status, prompts device-OAuth login on a
//   TTY, and falls back to the find-skills HTTP path on timeout / non-TTY / skip.
// - defaultAskConfirm: the Y/n stdin prompt used by ensureCtx7Auth (exported so
//   unit tests can drive it directly).
// - runFindSkillsFallback: zero-install Context7 HTTP skill discovery, writing
//   .vibeflow/ai-context/find-skills-results.md for the AI enrichment phase.
//
// All cross-module symbols come through the _shared barrel (cycle rule:
// test/commands-no-cycle.test.ts forbids sibling imports). Node builtins and
// the discovery/context7 HTTP client are imported directly from src/*.

import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { type DiscoveryResult, searchSkillsHttp } from "../discovery/context7.js";
import { CTX_DIR, c, join, out, scanRepo, spawnSync, writeFileSafe } from "./_shared.js";

/**
 * Check ctx7 auth status. If not logged in, prompt the user to login via
 * device OAuth flow. Returns the auth result so the caller can decide
 * whether to use ctx7 CLI or the find-skills HTTP fallback.
 *
 * Timeout / non-TTY / skip → fallback mode.
 */
export interface Ctx7AuthResult {
  authenticated: boolean;
  /** true when ctx7 login was skipped or failed (use find-skills fallback). */
  fallback: boolean;
}

export async function ensureCtx7Auth(
  inject: {
    spawner?: typeof spawnSync;
    askConfirm?: (q: string) => Promise<boolean | null>;
  } = {},
): Promise<Ctx7AuthResult> {
  const spawn = inject.spawner ?? spawnSync;
  const ask = inject.askConfirm ?? defaultAskConfirm;
  if (!process.stdin.isTTY) {
    return { authenticated: false, fallback: true };
  }

  // Step 1: quick check
  const whoami = spawn("npx", ["ctx7", "whoami"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const alreadyAuth =
    whoami.status === 0 && whoami.stdout != null && !whoami.stdout.includes("Not logged in");

  if (alreadyAuth) {
    return { authenticated: true, fallback: false };
  }

  // Step 2: prompt user
  out("vf", c.yellow("⚠ ctx7 not logged in"));
  out("vf", c.dim("  ctx7 provides up-to-date library docs for automatic skill discovery."));

  const answer = await ask("  Login now via device OAuth? (Y/n) ");

  if (answer === false || answer === null) {
    out("vf", c.yellow("! ctx7 login skipped — using find-skills (HTTP) fallback"));
    return { authenticated: false, fallback: true };
  }

  // Step 3: run device OAuth login
  out("vf", c.cyan("▶ Starting ctx7 device login..."));
  out("vf", c.dim("  Open the URL below in any browser and enter the code to approve."));

  const login = spawn("npx", ["ctx7", "login", "--no-browser"], {
    stdio: "inherit",
    timeout: 120_000,
  });

  if (login.status === 0) {
    out("vf", c.green("✔ ctx7 authenticated"));
    return { authenticated: true, fallback: false };
  }

  out("vf", c.yellow("! ctx7 login failed or timed out — using find-skills (HTTP) fallback"));
  return { authenticated: false, fallback: true };
}

/**
 * Prompt the user a Y/n question on stdin. Returns true for "y"/""/"Y",
 * false for "n", or null on timeout. Exported for direct unit-test
 * coverage of the PR129 default-ask-confirm path (issue #80 rebase;
 * previously a private function). The `createInterface` parameter is
 * an optional test seam: production callers leave it undefined and
 * the real `node:readline` is used.
 */
export function defaultAskConfirm(
  q: string,
  deps: { createInterface?: typeof createInterface } = {},
): Promise<boolean | null> {
  const mkRl = deps.createInterface ?? createInterface;
  return new Promise((res) => {
    const rl = mkRl({ input: process.stdin, output: process.stdout });
    const timer = setTimeout(() => {
      rl.close();
      res(null);
    }, 15_000);
    rl.question(q, (a) => {
      clearTimeout(timer);
      rl.close();
      res(a.trim().toLowerCase() === "y" || a.trim() === "");
    });
  });
}

/**
 * Find-skills fallback: use Context7 HTTP API (zero-install, no auth needed)
 * to discover skills for the detected stack. Writes results to
 * `.vibeflow/ai-context/find-skills-results.md` so the AI engine can
 * use them during Phase 2 instead of relying on ctx7 CLI.
 */
export async function runFindSkillsFallback(base: string): Promise<void> {
  // Exported for test coverage of the PR129 find-skills fallback path
  // (issue #80 rebase; was a private function on main). Production callers
  // are only `init()` — exporting does not widen the API surface.
  const profile = scanRepo(base);

  // Build search queries from the detected stack
  const queries = new Set<string>();

  // Filter out noisy/placeholder values
  function isNoise(v: string): boolean {
    const lower = v.toLowerCase();
    return (
      lower === "" ||
      lower.length < 3 ||
      lower.includes("none") ||
      lower.includes("not found") ||
      lower.includes("see ") ||
      lower === "configured" ||
      lower === "present" ||
      lower === "yes" ||
      lower === "no" ||
      lower.includes("(see")
    );
  }

  for (const fw of profile.frameworks) {
    if (!isNoise(fw)) queries.add(fw.toLowerCase());
  }

  const majorLangs = new Set([
    "typescript",
    "javascript",
    "java",
    "python",
    "go",
    "rust",
    "kotlin",
    "ruby",
    "php",
    "c#",
    "c++",
    "swift",
    "scala",
  ]);
  for (const lang of profile.languages) {
    const lower = lang.toLowerCase();
    if (majorLangs.has(lower)) queries.add(lower);
  }

  // Add findings that describe real stack components
  for (const f of profile.findings) {
    const val = f.value.toLowerCase();
    if (isNoise(val)) continue;
    const comp = f.component.toLowerCase();
    if (
      comp.includes("framework") ||
      comp.includes("database") ||
      comp.includes("cache") ||
      comp.includes("build") ||
      comp.includes("test") ||
      comp.includes("ui") ||
      comp.includes("orm") ||
      comp.includes("package") ||
      comp.includes("language")
    ) {
      queries.add(val);
    }
  }

  // Add package manager and manifest-specific technology hints
  if (profile.packageManager && !isNoise(profile.packageManager)) {
    queries.add(profile.packageManager.toLowerCase());
  }
  // Derive technology hints from manifest filenames
  for (const m of profile.manifests) {
    const mq = m
      .replace(/\.json$/i, "")
      .replace(/\.yaml$/i, "")
      .replace(/\.yml$/i, "")
      .toLowerCase();
    if (!isNoise(mq)) queries.add(mq);
  }

  // Search Context7 HTTP API in parallel (no auth needed, bounded 8s per call)
  const allResults: DiscoveryResult[] = [];
  const seen = new Set<string>();

  const outcomes = await Promise.allSettled(
    [...queries].map((q) => searchSkillsHttp(q, { approved: true, timeoutMs: 8000 })),
  );

  for (const o of outcomes) {
    if (o.status === "fulfilled" && o.value.ok) {
      for (const r of o.value.results) {
        const key = r.name ?? r.title;
        if (key && !seen.has(key)) {
          seen.add(key);
          allResults.push(r);
        }
      }
    }
  }

  // Write results as markdown for the AI engine
  const ctxDir = join(base, CTX_DIR, "ai-context");
  try {
    mkdirSync(ctxDir, { recursive: true });
  } catch {
    /* best effort */
  }

  if (allResults.length > 0) {
    const lines: string[] = [
      "# Find-Skills Results (Context7 HTTP API)",
      "",
      `Discovered ${allResults.length} library/skill candidates for the detected stack.`,
      `Search queries used: ${[...queries].join(", ")}`,
      "",
      "| Library | Description | Source |",
      "|---------|-------------|--------|",
    ];
    for (const r of allResults) {
      const name = r.name ?? r.title;
      const desc = r.snippet.replace(/\n/g, " ").slice(0, 120);
      lines.push(`| ${name} | ${desc} | ${r.source} |`);
    }
    lines.push("");
    lines.push(
      "Each entry above is a known Context7 library. Use `npx ctx7 docs <name>`",
      "to fetch full documentation, then author the corresponding SKILL.md",
      "following ANTHROPIC_SKILL_STANDARD.md.",
    );

    writeFileSafe(join(ctxDir, "find-skills-results.md"), lines.join("\n"));
    out("vf", c.green(`✔ find-skills: ${allResults.length} library/skill candidate(s) discovered`));
  } else {
    const fallbackNote = [
      "# Find-Skills Results (Context7 HTTP API)",
      "",
      "No results from Context7 HTTP API for the detected stack.",
      `Search queries tried: ${[...queries].join(", ")}`,
      "",
      "Fall back to web search and manual skill authoring as described in step 3c.",
    ];
    writeFileSafe(join(ctxDir, "find-skills-results.md"), fallbackNote.join("\n"));
    out("vf", c.yellow("! find-skills: no candidates discovered"));
  }
}
