// src/commands/canary.ts
//
// `vf canary list|link|check` (ADR-005). Canary tests are a first-class
// verification feature: a knowledge-heavy unit cannot close without a linked,
// human-authored canary test (gate FAILURE, enforced in src/gates.ts).
//
//   vf canary list                 list *.canary.test.ts + which unit each covers
//   vf canary link <unit> <file>   link a canary to a unit (records git-blame author;
//                                   refuses when the author IS the dispatch engine)
//   vf canary check                report knowledge-heavy units missing a canary
//
// The git-blame author lookup is an inject seam (test seam, same pattern as
// vf worktree's runCommandSync) so the routing is unit-testable offline.

import { canaryForUnit, defaultCanaryCheck, discoverCanaries, isCanaryFile } from "../canary.js";
import { c, out, readState, resolveRepo, spawnSync, writeState } from "./_shared.js";

/** Inject seam: the git-blame author lookup and the link timestamp. */
export interface CanaryInject {
  blameAuthor?: (repo: string, file: string) => string | null;
  now?: () => string;
}

/** Last git author of a file (`git log -1 --format=%an`). null when unknown. */
function defaultBlameAuthor(repo: string, file: string): string | null {
  const r = spawnSync("git", ["log", "-1", "--format=%an", "--", file], {
    cwd: repo,
    encoding: "utf8",
  });
  const name = typeof r.stdout === "string" ? r.stdout.trim() : "";
  return r.status === 0 && name ? name : null;
}

/** `vf canary list` — every canary file + which unit (if any) it covers. */
function canaryList(repo: string): number {
  const files = discoverCanaries(repo);
  if (!files.length) {
    out("vf", c.dim("No canary tests found (test/**/*.canary.test.ts)."));
    return 0;
  }
  const units = readState(repo)?.work_units ?? [];
  out("vf", c.bold(`Canary tests (${files.length}):`));
  for (const f of files) {
    const unit = units.find((u) => canaryForUnit(u, [f]) !== null);
    const cover = unit ? c.green(`covers ${unit.name}`) : c.dim("no unit match");
    out("vf", `  ${f}  ${cover}`);
  }
  return 0;
}

/** `vf canary link <unit> <file>` — set WorkUnit.canary; refuse self-authored. */
function canaryLink(
  unitName: string | undefined,
  file: string | undefined,
  repo: string,
  inject: CanaryInject,
): number {
  if (!unitName || !file) {
    out("vf", c.red("Usage: vf canary link <unit> <file>"), { level: "error" });
    return 2;
  }
  if (!isCanaryFile(file)) {
    out("vf", c.red(`Not a canary file: "${file}" — must match *.canary.test.ts`), {
      level: "error",
    });
    return 2;
  }
  const state = readState(repo);
  if (!state) {
    out("vf", c.red("No workflow state — run `vf init` first."), { level: "error" });
    return 1;
  }
  const unit = state.work_units.find((u) => u.name === unitName);
  if (!unit) {
    out("vf", c.red(`No such unit "${unitName}".`), { level: "error" });
    const names = state.work_units.map((u) => u.name);
    out("vf", names.length ? `Available: ${names.join(", ")}` : c.dim("(no work units)"));
    return 1;
  }
  const author = (inject.blameAuthor ?? defaultBlameAuthor)(repo, file);
  if (!author) {
    out("vf", c.red(`Could not determine a git author for "${file}" — commit it first.`), {
      level: "error",
    });
    return 1;
  }
  if (author === unit.owner_agent) {
    out(
      "vf",
      c.red(
        `Refusing: "${file}" was authored by "${author}", the unit's dispatch engine. A canary must be written by a human, not the agent it verifies.`,
      ),
      { level: "error" },
    );
    return 1;
  }
  const now = (inject.now ?? (() => new Date().toISOString()))();
  unit.canary = { file, author, linkedAt: now };
  writeState(repo, state);
  out("vf", c.green(`✓ linked canary ${file} (by ${author}) → ${unitName}`));
  return 0;
}

/** `vf canary check` — knowledge-heavy done units without a human canary. */
function canaryCheckCmd(repo: string): number {
  const units = readState(repo)?.work_units ?? [];
  const missing = units.filter(
    (u) => u.knowledge_heavy === true && u.status === "done" && !defaultCanaryCheck(u),
  );
  if (!missing.length) {
    out("vf", c.green("✓ every knowledge-heavy unit has a human canary."));
    return 0;
  }
  for (const u of missing) {
    out(
      "vf",
      c.red(
        `canary-required: "${u.name}" is knowledge-heavy but has no human canary ` +
          `→ vf canary link ${u.name} <file>`,
      ),
      { level: "error" },
    );
  }
  return 1;
}

/** `vf canary <list|link|check>` — first-class canary feature (ADR-005). */
export function canary(
  sub: string | undefined,
  rest: string[],
  flags: Record<string, string | boolean>,
  inject: CanaryInject = {},
): number {
  const repoFlag = typeof flags.repo === "string" ? flags.repo : undefined;
  const repo = resolveRepo(repoFlag);
  if (sub === undefined || sub === "list") return canaryList(repo);
  if (sub === "link") return canaryLink(rest[0], rest[1], repo, inject);
  if (sub === "check") return canaryCheckCmd(repo);
  out("vf", c.red(`Unknown subcommand: vf canary ${sub}  (use: list | link | check)`), {
    level: "error",
  });
  return 2;
}
