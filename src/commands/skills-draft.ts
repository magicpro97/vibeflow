import {
  CTX_DIR,
  c,
  draftSkillTemplate,
  existsSync,
  join,
  out,
  resolveDraftDomain,
  writeFileSafe,
} from "./_shared.js";

export function handleDraftSkill(repo: string, rest: string[]): number {
  const forceNew = rest.includes("--new");
  const name = rest.find((arg) => arg !== "--new")?.trim();
  if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    out(
      "vf",
      c.red("Usage: vf skills draft [--new] <name>  (lowercase-hyphen, e.g. fix-flaky-db-test)"),
      {
        level: "error",
      },
    );
    return 2;
  }
  if (!forceNew) {
    const resolution = resolveDraftDomain(repo, name);
    if (resolution.kind !== "create-new") {
      out("vf", c.yellow(`! ${resolution.details}`));
      if (resolution.existingSkill) {
        out(
          "vf",
          c.dim(`  Suggested update: vf skills propose-update ${resolution.existingSkill}`),
        );
      }
      out("vf", c.dim("  Use --new to override and create a new draft anyway."));
      return 0;
    }
  }
  const skillMd = join(repo, CTX_DIR, "skills", name, "SKILL.md");
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
