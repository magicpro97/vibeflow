import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { c, writeFileSafe } from "../core.js";
import { parseFrontmatter } from "../frontmatter.js";
import { out } from "../logbus.js";
import {
  isHexOID,
  parseMarketplace,
  parseRegistryLock,
  registryAdd,
  registryCacheDir,
  registryList,
  registryLockPath,
  registryUpdate,
  sharedCatalog,
  writeRegistryLock,
} from "./registry-channel.js";
import type { InstalledSkill, RegistryEntry, RegistryLock, SpawnFn } from "./registry-types.js";
import { type ScanDeps, scanBlocksPromotion, scanSkillDir } from "./security-scan.js";
import { validateSkillDir } from "./validator.js";

// ponytail: rename collision uses simple numeric suffix. Upgrade to semantic
// slug generation when collision rate warrants it.
function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 1;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

const COLLISION_OPTIONS = new Set(["skip", "replace", "rename"]);

function registrySkillDir(cacheDir: string, path: string): string | null {
  if (!path || path.includes("\0") || path.includes("\\")) return null;
  const resolved = resolve(cacheDir, path);
  return resolved.startsWith(`${resolve(cacheDir)}/`) ? resolved : null;
}

export function registryInstall(
  repo: string,
  registryId: string,
  skillName: string,
  opts: {
    version?: string;
    onCollision?: "skip" | "replace" | "rename";
    yes?: boolean;
    homedir?: () => string;
    cpSync?: typeof cpSync;
    existsSync?: typeof existsSync;
    readFileSync?: typeof readFileSync;
    writeFileSync?: typeof writeFileSync;
    writeFileSafe?: typeof writeFileSafe;
    spawnSync?: SpawnFn;
    hasCommand?: NonNullable<ScanDeps["hasCommand"]>;
  } = {},
): number {
  const _cpSync = opts.cpSync ?? cpSync;
  const _exists = opts.existsSync ?? existsSync;
  const _read = opts.readFileSync ?? readFileSync;
  const _write = opts.writeFileSync ?? writeFileSync;
  const _writeSafe = opts.writeFileSafe ?? writeFileSafe;
  const onCollision = opts.onCollision ?? "skip";

  const lock = parseRegistryLock(repo);
  const entry = lock.registries.find((r) => r.name === registryId);
  if (!entry) {
    out(
      "vf",
      c.red(
        `Registry "${registryId}" not found in lock. Add it first with \`vf skills registry add\`.`,
      ),
      { level: "error" },
    );
    return 1;
  }

  const cacheDir = registryCacheDir(entry.url, { homedir: opts.homedir });
  if (!_exists(cacheDir)) {
    out(
      "vf",
      c.red(
        `Cache for registry "${registryId}" not found. Update registry first with \`vf skills registry update ${registryId} --yes\`.`,
      ),
      { level: "error" },
    );
    return 1;
  }

  const { skills: marketplace, errors: mpErrors } = parseMarketplace(cacheDir);
  if (mpErrors.length) {
    for (const e of mpErrors) out("vf", c.red(e), { level: "error" });
    return 1;
  }

  const mpEntry = marketplace.find((s) => s.name === skillName && s.status === "verified");
  if (!mpEntry) {
    const available = marketplace.filter((s) => s.name === skillName).map((s) => s.status);
    if (available.length) {
      out(
        "vf",
        c.red(
          `Skill "${skillName}" found in marketplace but status is ${available.join(", ")} (require "verified").`,
        ),
        { level: "error" },
      );
    } else {
      out("vf", c.red(`Skill "${skillName}" not found in marketplace.`), { level: "error" });
    }
    return 1;
  }

  if (opts.version && mpEntry.version !== opts.version) {
    out(
      "vf",
      c.red(
        `Skill "${skillName}" version mismatch: requested ${opts.version}, marketplace has ${mpEntry.version}.`,
      ),
      { level: "error" },
    );
    return 1;
  }

  const subPath = mpEntry.path ?? `skills/${skillName}`;
  const skillDir = registrySkillDir(cacheDir, subPath);
  if (!skillDir) {
    out("vf", c.red(`Invalid marketplace path for skill "${skillName}".`), { level: "error" });
    return 1;
  }
  if (!_exists(join(skillDir, "SKILL.md"))) {
    out("vf", c.red(`SKILL.md not found at expected path ${subPath}/SKILL.md in registry cache.`), {
      level: "error",
    });
    return 1;
  }

  const validation = validateSkillDir(skillDir);
  if (!validation.ok) {
    for (const e of validation.errors)
      out("vf", c.red(`Validation error: ${e}`), { level: "error" });
    return 1;
  }
  for (const w of validation.warnings) out("vf", c.yellow(`Validation warning: ${w}`));

  // Frontmatter cross-check
  const fmText = _read(join(skillDir, "SKILL.md"), "utf8");
  const { data } = parseFrontmatter(fmText);
  const fmName = typeof data.name === "string" ? data.name.trim() : "";
  const fmVersion = typeof data.version === "string" ? data.version.trim() : mpEntry.version;
  if (fmName !== mpEntry.name) {
    out(
      "vf",
      c.red(`Frontmatter name "${fmName}" does not match marketplace entry "${mpEntry.name}".`),
      { level: "error" },
    );
    return 1;
  }
  if (fmVersion !== mpEntry.version) {
    out(
      "vf",
      c.red(
        `Frontmatter version "${fmVersion}" does not match marketplace version "${mpEntry.version}".`,
      ),
      { level: "error" },
    );
    return 1;
  }
  const validatedSkillDir: string = skillDir ?? "";

  // Security scan gate (#651): run after path/frontmatter validation, before
  // catalog copy. HIGH/CRITICAL blocks; MEDIUM warns; absent scanner proceeds.
  function runScan(): {
    blocked: boolean;
    scan_summary?: InstalledSkill["scan_summary"];
  } {
    const scan = scanSkillDir(validatedSkillDir, {
      hasCommand: opts.hasCommand,
      spawnSync: opts.spawnSync as never,
      homedir: opts.homedir,
    });
    if (!scan.scanned) {
      out(
        "vf",
        c.yellow(`! ${skillName}: security scan skipped (${scan.reason ?? "not-scanned"})`),
      );
      return {
        blocked: false,
        scan_summary: {
          scanned: false,
          risk_severity: undefined,
          finding_count: 0,
          reason: scan.reason,
        },
      };
    }
    const gate = scanBlocksPromotion(scan);
    if (gate.blocked) {
      out("vf", c.red(`✗ Cannot install "${skillName}": ${gate.reason}`), { level: "error" });
      return { blocked: true };
    }
    if (gate.warn) out("vf", c.yellow(`⚠ ${skillName}: ${gate.reason}`));
    return {
      blocked: false,
      scan_summary: {
        scanned: true,
        risk_severity: scan.risk_severity,
        finding_count: scan.findings.length,
      },
    };
  }

  const catalog = sharedCatalog({ homedir: opts.homedir });
  const dstDir = join(catalog, fmName);
  const existing = _exists(dstDir);

  if (existing && onCollision === "skip") {
    out(
      "vf",
      c.yellow(
        `Skill "${fmName}" already installed in catalog. --on-collision=skip, leaving untouched.`,
      ),
    );
    return 0;
  }

  if (!opts.yes) {
    const actions: string[] = [];
    if (existing && onCollision === "replace")
      actions.push(`backup existing "${fmName}" → .backup/<ts>/`);
    if (existing && onCollision === "rename") actions.push("copy as renamed slug");
    actions.push(`copy "${fmName}" to catalog ${dstDir}`);
    actions.push(`security scan: skillspector scan ${skillDir} --no-llm`);
    actions.push("update SKILL_REGISTRY.lock.json");
    out("vf", c.yellow("Dry-run (no --yes):"));
    for (const a of actions) out("vf", c.dim(`  ${a}`));
    return 0;
  }

  // -- Security scan (real run) --
  const { blocked, scan_summary } = runScan();
  if (blocked) return 1;

  // --- Real run ---
  mkdirSync(catalog, { recursive: true });
  let finalName = fmName;

  if (existing && onCollision === "replace") {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = join(catalog, ".backup", ts, fmName);
    mkdirSync(dirname(backup), { recursive: true });
    _cpSync(dstDir, backup, { recursive: true });
    rmSync(dstDir, { recursive: true, force: true });
    out("vf", c.dim(`Backed up "${fmName}" → .backup/${ts}/`));
  } else if (existing && onCollision === "rename") {
    const allSkills = readdirSync(catalog);
    const taken = new Set(allSkills.filter((n) => !n.startsWith(".")));
    const slug = uniqueSlug(fmName, taken);
    finalName = slug;

    // Copy skill dir to new name
    const renamedDst = join(catalog, slug);
    _cpSync(skillDir, renamedDst, { recursive: true });

    // Rewrite SKILL.md name: frontmatter
    const newFmText = fmText.replace(/^name:\s*.+$/m, `name: ${slug}`);
    _write(join(renamedDst, "SKILL.md"), newFmText);

    // Re-validate
    const reValidation = validateSkillDir(renamedDst);
    if (!reValidation.ok) {
      rmSync(renamedDst, { recursive: true, force: true });
      for (const e of reValidation.errors)
        out("vf", c.red(`Rename validation error: ${e}`), { level: "error" });
      out("vf", c.red(`Rename failed — rolled back "${slug}".`), { level: "error" });
      return 1;
    }
    finalName = slug;
    out("vf", c.dim(`Renamed "${fmName}" → "${slug}" to avoid collision.`));
  }

  if (!existing || onCollision !== "rename") {
    _cpSync(skillDir, join(catalog, finalName), { recursive: true });
  }

  // Update lock — record installed skill only after successful copy
  const installed: InstalledSkill = {
    name: finalName,
    version: mpEntry.version,
    commitOID: entry.commitOID,
    scan_summary,
  };
  const updatedEntries: RegistryEntry[] = lock.registries.map((r) => {
    if (r.name !== registryId) return r;
    const current = r.installed ?? [];
    const filtered = current.filter((s) => s.name !== finalName);
    return { ...r, installed: [...filtered, installed] };
  });
  _writeSafe(
    registryLockPath(repo),
    JSON.stringify({ ...lock, registries: updatedEntries }, null, 2),
  );

  out(
    "vf",
    c.green(
      `✔ skill "${finalName}" v${mpEntry.version} installed from registry "${registryId}" → catalog`,
    ),
  );
  return 0;
}
