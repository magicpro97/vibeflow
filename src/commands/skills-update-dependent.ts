// src/commands/skills-update-dependent.ts — #671
//
// `vf skills update-dependent <canonical-skill>` — detect version changes,
// mark transitive dependents as needs-review, run evals, report pass/fail.

import { c } from "../core.js";
import type { Skill } from "../core/types.js";
import { out } from "../logbus.js";
import {
  clearNeedsReview,
  detectVersionChange,
  evalDependentSkill,
  markNeedsReview,
  readDependentVersions,
  resolveDependentSkills,
  writeDependentVersions,
} from "../skills/dependent.js";
import { discoverSkills } from "../skills/registry.js";

export function skillsUpdateDependentCmd(repo: string, rest: string[]): number {
  const canonicalName = rest[0]?.trim();
  if (!canonicalName || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(canonicalName)) {
    out(
      "vf",
      c.red("Usage: vf skills update-dependent <canonical-skill>  (lowercase-hyphen name)"),
      {
        level: "error",
      },
    );
    return 2;
  }

  const skills = discoverSkills(repo);
  const canonical = skills.find((s) => s.name === canonicalName);
  if (!canonical) {
    out("vf", c.red(`Canonical skill "${canonicalName}" not found.`), { level: "error" });
    return 1;
  }
  if (canonical.domain?.role !== "canonical") {
    out(
      "vf",
      c.yellow(
        `! "${canonicalName}" is not a canonical skill (domain.role: ${canonical.domain?.role ?? "none"}).`,
      ),
    );
  }

  const state = readDependentVersions(repo);
  const currentVersion = canonical.version;

  const versionChange = detectVersionChange(state, canonicalName, currentVersion);
  let needsReviewCount = 0;

  // Persist current version
  state.versions[canonicalName] = currentVersion ?? "0.0.0";

  const dependents = resolveDependentSkills(skills, canonicalName);

  if (dependents.length === 0) {
    if (versionChange.versionChanged) {
      out(
        "vf",
        c.yellow(
          `! ${canonicalName} version changed (${versionChange.oldVersion} → ${versionChange.newVersion}), but no dependents found.`,
        ),
      );
    } else {
      out("vf", c.dim(`No dependents found for "${canonicalName}".`));
    }
    writeDependentVersions(repo, state);
    return 0;
  }

  out("vf", c.bold(`Dependents of "${canonicalName}": ${dependents.join(", ")}`));

  if (versionChange.versionChanged) {
    out(
      "vf",
      c.yellow(`Version changed: ${versionChange.oldVersion} → ${versionChange.newVersion}`),
    );
    for (const dep of dependents) {
      markNeedsReview(
        state,
        dep,
        canonicalName,
        `canonical ${canonicalName} version changed: ${versionChange.oldVersion} → ${versionChange.newVersion}`,
      );
      needsReviewCount++;
    }
    out("vf", c.yellow(`Marked ${needsReviewCount} dependent(s) as needs-review.`));
  } else if (canonical.version === undefined) {
    out("vf", c.dim("Canonical skill has no version. Version state recorded."));
  } else {
    out("vf", c.dim(`Version unchanged (${currentVersion}). No needs-review marks.`));
  }

  // Run evals for all dependents
  out("vf", c.bold("\nRunning evals for dependents..."));
  out("vf", "");

  const allPass: string[] = [];
  const allFail: string[] = [];
  const allNoEvals: string[] = [];
  const allErrors: string[] = [];

  const depSkills = skills.filter((s) => dependents.includes(s.name));
  for (const dep of depSkills) {
    const result = evalDependentSkill(dep);
    const icon =
      result.status === "pass"
        ? c.green("✔")
        : result.status === "no-evals"
          ? c.dim("○")
          : c.red("✗");
    out(
      "vf",
      `  ${icon} ${dep.name}: ${result.status}${result.detail ? ` — ${result.detail}` : ""}`,
    );

    if (result.status === "pass") allPass.push(dep.name);
    else if (result.status === "fail") allFail.push(dep.name);
    else if (result.status === "no-evals") allNoEvals.push(dep.name);
    else allErrors.push(dep.name);

    if (result.status === "pass" || result.status === "no-evals") {
      clearNeedsReview(state, dep.name);
    }
  }

  out("vf", "");
  out("vf", c.bold("Summary:"));
  out("vf", `  pass:     ${allPass.length}`);
  out("vf", `  fail:     ${allFail.length}`);
  out("vf", `  no-evals: ${allNoEvals.length}`);
  out("vf", `  error:    ${allErrors.length}`);

  writeDependentVersions(repo, state);

  if (allFail.length > 0 || allErrors.length > 0) {
    return 1;
  }
  return 0;
}
