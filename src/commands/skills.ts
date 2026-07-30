import { enrichFreshness, verifyFreshnessCommand } from "../skills/anchor-freshness.js";
import { showSkill } from "../skills/lifecycle.js";
import {
  CTX_DIR,
  c,
  crystallize,
  cwd,
  discoverSkills,
  draftSkillName,
  draftSkillTemplate,
  existsSync,
  handleAuditDuplicatesSubcommand,
  handleCiDomainIntegrity,
  handleCiSecurity,
  handleCiValidation,
  handleDomainSubcommand,
  handleFactsSubcommand,
  handleImpactEvidenceSubcommand,
  handleImpactSubcommand,
  handleOptimizeDescription,
  handlePolicyChecksSubcommand,
  handleProposeMergeSubcommand,
  handleProposeSplitSubcommand,
  handleRegistrySubcommand,
  handleSkillAuditLog,
  handleSkillCiGate,
  handleTelemetrySubcommand,
  importSkillFromDir,
  importSkillsFromParent,
  join,
  matchSkillsForTask,
  migrateToSharedCatalog,
  out,
  readFileSync,
  readState,
  recordSkillResolution,
  renderSkillIndex,
  renderSkillNeeds,
  resolveSkillNeeds,
  scanRepo,
  skillTemplate,
  skillsEvalCmd,
  syncSkillMirrors,
  validateSkillRoots,
  verifyLockMarketplaceSchemas,
  verifyLockMirrorCompleteness,
  verifyRegistryLockIntegrity,
  verifySkillCommand,
  verifySkillSync,
  writeFileSafe,
} from "./_shared.js";
export function skills(sub: string | undefined, rest: string[] = []): number {
  const repo = cwd();
  const found = discoverSkills(repo);
  if (sub === undefined || sub === "list") {
    if (!found.length) {
      out(
        "vf",
        c.dim(`No skills discovered under ${CTX_DIR}/skills, .kiro/skills, or .claude/skills.`),
      );
      return 0;
    }
    for (const s of found) enrichFreshness(s, repo);
    process.stdout.write(renderSkillIndex(found));
    return 0;
  }
  if (sub === "show") return showSkill(found, rest);
  if (sub === "validate") {
    const result = validateSkillRoots(repo);
    for (const w of result.warnings) out("vf", c.yellow(`! ${w}`));
    for (const e of result.errors) out("vf", c.red(`✗ ${e}`));
    if (result.ok) {
      out("vf", c.green(`✔ ${result.skills.length} skill(s) valid`));
      return 0;
    }
    if (result.skills.length === 0) {
      out(
        "vf",
        c.red("✗ no skills found — run `vf skills sync` or add skills under .vibeflow/skills/"),
        { level: "error" },
      );
    } else {
      out("vf", c.red(`✗ ${result.errors.length} validation error(s)`), { level: "error" });
    }
    return 1;
  }
  if (sub === "search") {
    const term = rest.join(" ").trim();
    if (!term) {
      out("vf", c.red("Usage: vf skills search <term>"), {
        level: "error",
      });
      return 2;
    }
    const matches = matchSkillsForTask(found, term);
    if (!matches.length) {
      out("vf", c.dim(`No skill matched "${term}".`));
      return 0;
    }
    for (const m of matches) {
      out("vf", `${c.bold(m.skill.name)} ${c.dim(`(${m.score.toFixed(2)})`)} — ${m.reason}`);
    }
    return 0;
  }
  if (sub === "resolve") {
    // Demand-driven: derive skill NEEDS from the repo scan + saved intake, then report
    // which are satisfied locally and which must be acquired on demand (never pre-installed).
    const state = readState(repo);
    const needs = resolveSkillNeeds({
      repo,
      attachments: (state?.attachments ?? []).map((a) => a.name),
      task: state?.goal,
      profile: scanRepo(repo),
    });
    recordSkillResolution("resolve", needs);
    process.stdout.write(renderSkillNeeds(needs));
    return 0;
  }
  if (sub === "telemetry") return handleTelemetrySubcommand();
  if (sub === "audit-log") return handleSkillAuditLog(repo, rest);
  if (sub === "audit-duplicates") return handleAuditDuplicatesSubcommand(repo, rest);
  if (sub === "sync") {
    // Parse sync flags; default pointer mode targets copilot.
    let mode: "pointer" | "full" = "pointer";
    let fromRegistry = false;
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i];
      if (tok === "--mode") {
        const v = rest[i + 1];
        if (v !== "full" && v !== "pointer") {
          out("vf", c.red(`✗ --mode must be 'pointer' or 'full', got '${v ?? "(missing)"}'`), {
            level: "error",
          });
          return 2;
        }
        mode = v;
      }
      if (typeof tok === "string" && tok.startsWith("--mode=")) {
        const v = tok.slice("--mode=".length);
        if (v !== "full" && v !== "pointer") {
          out("vf", c.red(`✗ --mode must be 'pointer' or 'full', got '${v}'`), {
            level: "error",
          });
          return 2;
        }
        mode = v;
      }
      if (tok === "--from-registry") fromRegistry = true;
    }
    const result = syncSkillMirrors(repo, { mode, fromRegistry });
    for (const w of result.warnings) out("vf", c.yellow(`! ${w}`));
    for (const e of result.errors) out("vf", c.red(`✗ ${e}`));
    if (result.ok) {
      out(
        "vf",
        c.green(
          `✔ synced ${result.synced.length} skill mirror(s) (mode=${result.mode})${result.synced.length > 0 ? ` → ${result.synced.slice(0, 3).join(", ")}${result.synced.length > 3 ? "…" : ""}` : ""}`,
        ),
      );
      return 0;
    }
    out("vf", c.red(`✗ ${result.errors.length} sync error(s)`), { level: "error" });
    return 1;
  }
  if (sub === "verify-sync") {
    // Parse --engine flag; --from-registry checks all engine mirrors.
    let fromRegistry = false;
    const engines: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i];
      if (tok === "--from-registry") fromRegistry = true;
      if (tok === "--engine") {
        const v = rest[i + 1];
        if (v) {
          engines.push(v);
        }
      }
    }
    const result = verifySkillSync(repo, engines.length ? (engines as any) : undefined, {
      fromRegistry,
    });
    for (const e of result.errors) out("vf", c.red(`✗ ${e}`));
    if (result.ok) {
      out("vf", c.green(`✔ all ${result.synced.length} mirror(s) in sync`));
      return 0;
    }
    out("vf", c.red(`✗ ${result.errors.length} mirror(s) out of sync`), { level: "error" });
    return 1;
  }
  if (sub === "import") {
    const target = rest.join(" ").trim();
    if (!target) {
      out("vf", c.red("Usage: vf skills import <dir>   (a directory containing SKILL.md)"), {
        level: "error",
      });
      return 2;
    }
    // Existing SKILL.md dir imports one skill; context7 stays a non-executing hint.
    if (target.startsWith("context7:")) {
      out(
        "vf",
        c.yellow(
          `! context7 lookup not auto-executed. Run \`vf discover skills ${target.slice("context7:".length)} --yes\` first, then \`vf skills import <download-dir>\`.`,
        ),
      );
      return 2;
    }
    const result = importSkillFromDir(repo, target);
    // If single-skill import found nothing, try parent-dir import.
    const finalResult = result.imported.length > 0 ? result : importSkillsFromParent(repo, target);
    for (const w of finalResult.warnings) out("vf", c.yellow(`! ${w}`));
    for (const e of finalResult.errors) out("vf", c.red(`✗ ${e}`));
    if (finalResult.ok) {
      out(
        "vf",
        c.green(
          `✔ imported ${finalResult.imported.length} skill(s): ${finalResult.imported.join(", ")}`,
        ),
      );
      return 0;
    }
    out("vf", c.red(`✗ import failed: ${finalResult.errors.join("; ")}`), { level: "error" });
    return 1;
  }
  if (sub === "init") {
    const name = rest[0]?.trim();
    if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      out("vf", c.red("Usage: vf skills init <name>  (lowercase-hyphen, e.g. compose-screen-ux)"), {
        level: "error",
      });
      return 2;
    }
    const dir = join(repo, CTX_DIR, "skills", name);
    const skillMd = join(dir, "SKILL.md");
    if (existsSync(skillMd)) {
      out("vf", c.red(`Skill "${name}" already exists at ${skillMd}.`), {
        level: "error",
      });
      return 1;
    }
    writeFileSafe(skillMd, skillTemplate(name));
    out("vf", c.green(`+ scaffolded skill ${c.bold(name)} → ${skillMd}`));
    out(
      "vf",
      c.dim(
        "Edit triggers/capabilities so `vf skills search <task>` matches it, then fill the steps.",
      ),
    );
    return 0;
  }
  if (sub === "draft") {
    const name = rest[0]?.trim();
    if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      out(
        "vf",
        c.red("Usage: vf skills draft <name>  (lowercase-hyphen, e.g. fix-flaky-db-test)"),
        {
          level: "error",
        },
      );
      return 2;
    }
    const dir = join(repo, CTX_DIR, "skills", name);
    const skillMd = join(dir, "SKILL.md");
    if (existsSync(skillMd)) {
      out("vf", c.red(`Skill "${name}" already exists at ${skillMd}.`), { level: "error" });
      return 1;
    }
    writeFileSafe(skillMd, draftSkillTemplate(name));
    out("vf", c.green(`+ drafted skill ${c.bold(name)} → ${skillMd}`));
    out(
      "vf",
      c.dim(
        "status: draft — captured from a real task. Fill in Why/Evidence/Steps, then it stays a DRAFT for review (never auto-installed).",
      ),
    );
    return 0;
  }
  if (sub === "verify") {
    return verifySkillCommand(repo, rest);
  }
  if (sub === "crystallize") {
    const runId = rest[0]?.trim();
    if (!runId) {
      out("vf", c.red("Usage: vf skills crystallize <run-id>"), { level: "error" });
      return 2;
    }
    // Missing run/journal files are empty sources, not errors.
    const logPath = join(repo, CTX_DIR, "logs", "current.log");
    const journalPath = join(repo, CTX_DIR, "knowledge", "log.md");
    const readLines = (p: string): string[] =>
      existsSync(p) ? readFileSync(p, "utf8").split("\n") : [];
    const result = crystallize({
      runId,
      logLines: readLines(logPath),
      journalLines: readLines(journalPath),
    });
    if (!result.hasPatterns) {
      out(
        "vf",
        c.dim(
          `No recurring patterns crossed the threshold for run "${runId}" — nothing to crystallize.`,
        ),
      );
      return 0;
    }
    const draftDir = join(repo, CTX_DIR, "skills", result.draftName);
    const draftMd = join(draftDir, "SKILL.md");
    if (existsSync(draftMd)) {
      out("vf", c.red(`Draft "${result.draftName}" already exists at ${draftMd}.`), {
        level: "error",
      });
      return 1;
    }
    writeFileSafe(draftMd, result.draft);
    out("vf", c.green(`+ drafted skill ${c.bold(result.draftName)} → ${draftMd}`));
    out(
      "vf",
      c.dim(
        `${result.patterns.length} pattern(s) crystallized. DRAFT only — NOT installed. Review the untracked file, then \`git add\` it if useful.`,
      ),
    );
    return 0;
  }
  if (sub === "migrate") {
    const result = migrateToSharedCatalog(repo);
    if (!result.migrated.length && !result.errors.length) {
      out("vf", c.dim("No project-scoped skills to migrate (nothing at .vibeflow/skills/)."));
      return 0;
    }
    for (const name of result.collisions) {
      out("vf", c.yellow(`! collision: ${name} — backed up existing, overwrote (last-write-wins)`));
    }
    for (const e of result.errors) out("vf", c.red(`✗ ${e}`));
    if (result.migrated.length) {
      out(
        "vf",
        c.green(
          `✔ migrated ${result.migrated.length} skill(s) to ~/.vibeflow/skills/: ${result.migrated.join(", ")}`,
        ),
      );
    }
    return result.errors.length ? 1 : 0;
  }
  if (sub === "domain") return handleDomainSubcommand(repo, rest);
  if (sub === "registry") return handleRegistrySubcommand(repo, rest);
  if (sub === "facts") return handleFactsSubcommand(repo, rest);
  if (sub === "impact-evidence") return handleImpactEvidenceSubcommand(repo, rest);
  if (sub === "impact") return handleImpactSubcommand(repo, rest);
  if (sub === "policy-checks") return handlePolicyChecksSubcommand(repo, rest);
  if (sub === "eval") return skillsEvalCmd(repo, rest);
  if (sub === "verify-lock") {
    const allErrors: string[] = [];
    const allWarnings: string[] = [];
    let ok = true;

    const lock = verifyRegistryLockIntegrity(repo);
    if (!lock.ok) {
      for (const e of lock.errors) out("vf", c.red(`[lock integrity] ${e}`));
      allErrors.push(...lock.errors);
      ok = false;
    }
    allWarnings.push(...lock.warnings.map((w) => `[lock integrity] ${w}`));

    const schema = verifyLockMarketplaceSchemas(repo);
    if (!schema.ok) {
      for (const e of schema.errors) out("vf", c.red(`[marketplace] ${e}`));
      allErrors.push(...schema.errors);
      ok = false;
    }
    allWarnings.push(...schema.warnings.map((w) => `[marketplace] ${w}`));

    const mirror = verifyLockMirrorCompleteness(repo);
    if (!mirror.ok) {
      for (const e of mirror.errors) out("vf", c.red(`[mirror] ${e}`));
      allErrors.push(...mirror.errors);
      ok = false;
    }
    allWarnings.push(...mirror.warnings.map((w) => `[mirror] ${w}`));

    for (const w of allWarnings) out("vf", c.yellow(`! ${w}`));
    if (ok) {
      out("vf", c.green("✔ lock file integrity + marketplace schema + mirror completeness OK"));
      return 0;
    }
    out("vf", c.red(`✗ ${allErrors.length} lock verification error(s)`), { level: "error" });
    return 1;
  }
  if (sub === "optimize-description") return handleOptimizeDescription(repo, rest);
  if (sub === "ci-gate") return handleSkillCiGate(repo, rest);
  if (sub === "ci-validation") return handleCiValidation(repo, rest);
  if (sub === "ci-security") return handleCiSecurity(repo, rest);
  if (sub === "ci-domain-integrity") return handleCiDomainIntegrity(repo, rest);
  if (sub === "verify-freshness") return verifyFreshnessCommand(found, repo);
  if (sub === "propose-merge") return handleProposeMergeSubcommand(repo, rest);
  if (sub === "propose-split") return handleProposeSplitSubcommand(repo, rest);
  out("vf", c.dim(`vf skills ${sub} — unrecognized subcommand.`));
  return 0;
}
