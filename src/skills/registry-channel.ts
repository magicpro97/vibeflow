import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { c, writeFileSafe } from "../core.js";
import { parseFrontmatter } from "../frontmatter.js";
import { out } from "../logbus.js";
import type {
  GitOp,
  InstalledSkill,
  MarketplaceSkill,
  RegistryEntry,
  RegistryLock,
  SpawnFn,
} from "./registry-types.js";
import { validateSkillDir } from "./validator.js";
export function sharedCatalog(inject?: { homedir?: () => string }): string {
  const home = inject?.homedir ? inject.homedir() : (process.env.VF_SKILLS_HOME ?? homedir());
  return join(home, ".vibeflow", "skills");
}

const defaultSpawn: SpawnFn = spawnSync as SpawnFn;
export type {
  GitOp,
  InstalledSkill,
  MarketplaceSkill,
  RegistryEntry,
  RegistryLock,
  ScanSummary,
  SpawnFn,
} from "./registry-types.js";

const LOCK_REL = join(".vibeflow", "SKILL_REGISTRY.lock.json");

export function registryLockPath(repo: string): string {
  return join(repo, LOCK_REL);
}

export function parseInstalledSkill(raw: unknown): InstalledSkill | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (
    typeof s.name !== "string" ||
    typeof s.version !== "string" ||
    typeof s.commitOID !== "string"
  )
    return null;
  const bundleHash = typeof s.bundleHash === "string" ? s.bundleHash : undefined;
  if (bundleHash !== undefined && !/^[0-9a-f]{64}$/.test(bundleHash)) return null;
  const skillPath = typeof s.skillPath === "string" ? s.skillPath : undefined;
  if (
    skillPath !== undefined &&
    (!skillPath || skillPath.includes("..") || skillPath.includes("\\") || skillPath.includes("\0"))
  )
    return null;
  const scan_summary =
    s.scan_summary && typeof s.scan_summary === "object"
      ? (s.scan_summary as InstalledSkill["scan_summary"])
      : undefined;
  return {
    name: s.name,
    version: s.version,
    commitOID: s.commitOID,
    bundleHash,
    skillPath,
    scan_summary,
  };
}

export function parseRegistryLock(repo: string): RegistryLock {
  const p = registryLockPath(repo);
  if (!existsSync(p)) return { schemaVersion: 1, registries: [] };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    if (
      raw &&
      typeof raw === "object" &&
      raw.schemaVersion === 1 &&
      Array.isArray(raw.registries)
    ) {
      const registries: RegistryEntry[] = [];
      for (const r of raw.registries) {
        if (
          r &&
          typeof r.name === "string" &&
          typeof r.url === "string" &&
          typeof r.ref === "string" &&
          typeof r.commitOID === "string"
        ) {
          const installed = Array.isArray(r.installed)
            ? r.installed
                .map(parseInstalledSkill)
                .filter((s: InstalledSkill | null): s is InstalledSkill => s !== null)
            : undefined;
          registries.push({
            name: r.name,
            url: r.url,
            ref: r.ref,
            commitOID: r.commitOID,
            installed,
          });
        }
      }
      return { schemaVersion: 1, registries };
    }
  } catch {
    /* malformed → start fresh */
  }
  return { schemaVersion: 1, registries: [] };
}

export function writeRegistryLock(
  repo: string,
  lock: RegistryLock,
  inject: { writeFileSafe?: typeof writeFileSafe } = {},
): void {
  const _write = inject.writeFileSafe ?? writeFileSafe;
  _write(registryLockPath(repo), JSON.stringify(lock, null, 2));
}

export function registryCacheDir(url: string, inject?: { homedir?: () => string }): string {
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
  const home = inject?.homedir ? inject.homedir() : homedir();
  return join(home, ".vibeflow", "skill-registries", hash);
}

export function parseMarketplace(
  cacheDir: string,
  inject: { existsSync?: typeof existsSync; readFileSync?: typeof readFileSync } = {},
): { skills: MarketplaceSkill[]; errors: string[] } {
  const _exists = inject.existsSync ?? existsSync;
  const _read = inject.readFileSync ?? readFileSync;
  const mp = join(cacheDir, "marketplace.json");
  if (!_exists(mp)) return { skills: [], errors: ["marketplace.json not found"] };
  let raw: unknown;
  try {
    raw = JSON.parse(_read(mp, "utf8"));
  } catch {
    return { skills: [], errors: ["marketplace.json malformed JSON"] };
  }
  if (!raw || typeof raw !== "object")
    return { skills: [], errors: ["marketplace.json not an object"] };
  const doc = raw as Record<string, unknown>;
  if (doc.schemaVersion !== 1)
    return {
      skills: [],
      errors: [`marketplace.json unsupported schemaVersion: ${doc.schemaVersion}`],
    };
  if (!Array.isArray(doc.skills))
    return { skills: [], errors: ["marketplace.json missing skills array"] };
  const skills: MarketplaceSkill[] = [];
  const errors: string[] = [];
  for (const s of doc.skills) {
    if (!s || typeof s !== "object") {
      errors.push("marketplace.json: invalid skill entry");
      continue;
    }
    const e = s as Record<string, unknown>;
    if (typeof e.name !== "string" || !e.name) {
      errors.push("marketplace.json: skill missing name");
      continue;
    }
    if (typeof e.version !== "string" || !e.version) {
      errors.push(`marketplace.json: skill "${e.name}" missing version`);
      continue;
    }
    if (typeof e.status !== "string" || !e.status) {
      errors.push(`marketplace.json: skill "${e.name}" missing status`);
      continue;
    }
    skills.push({
      name: e.name,
      version: e.version,
      description: typeof e.description === "string" ? e.description : undefined,
      status: e.status,
      path: typeof e.path === "string" ? e.path : undefined,
      scope: typeof e.scope === "string" ? e.scope : undefined,
      projectId: typeof e["project.id"] === "string" ? e["project.id"] : undefined,
      extends: Array.isArray(e.extends) ? e.extends.map(String) : undefined,
    });
  }
  return { skills, errors };
}

export function isHexOID(s: string): boolean {
  return /^[0-9a-f]{1,64}$/.test(s);
}

export function isValidRegistryName(name: string): boolean {
  return /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(name);
}

function spawnGit(
  args: string[],
  inject?: { spawnSync?: SpawnFn },
): { status: number; stdout: string; stderr: string } {
  const _spawn = inject?.spawnSync ?? defaultSpawn;
  const cwd = args[0] === "clone" ? dirname(args.at(-1) ?? "") : (args[1] ?? "");
  const result = _spawn("git", args, {
    timeout: 60_000,
    stdio: "pipe",
    cwd,
  });
  return {
    status: result.status ?? 1,
    stdout: typeof result.stdout === "string" ? result.stdout : (result.stdout?.toString() ?? ""),
    stderr: typeof result.stderr === "string" ? result.stderr : (result.stderr?.toString() ?? ""),
  };
}
function planClone(url: string, cacheDir: string, ref: string): GitOp[] {
  return [
    {
      cmd: "git",
      args: ["clone", "--filter=blob:none", "--no-checkout", "--depth", "1", url, cacheDir],
    },
    { cmd: "git", args: ["-C", cacheDir, "fetch", "origin", ref] },
  ];
}
function planFetch(cacheDir: string, ref: string): GitOp[] {
  return [{ cmd: "git", args: ["-C", cacheDir, "fetch", "origin", ref] }];
}
function resolveOidAndCheckout(cacheDir: string, inject?: { spawnSync?: SpawnFn }): string | null {
  const oidResult = spawnGit(["-C", cacheDir, "rev-parse", "FETCH_HEAD"], inject);
  const oid = oidResult.status === 0 ? oidResult.stdout.trim() : "";
  if (!isHexOID(oid)) return null;
  const co = spawnGit(["-C", cacheDir, "checkout", "--detach", oid], inject);
  return co.status === 0 ? oid : null;
}
export function registryAdd(
  repo: string,
  url: string,
  name: string,
  ref: string,
  opts: { yes?: boolean; spawnSync?: SpawnFn; writeFileSafe?: typeof writeFileSafe } = {},
): number {
  if (!isValidRegistryName(name)) {
    out("vf", c.red(`Invalid registry name "${name}". Use lowercase-hyphen/dot syntax.`), {
      level: "error",
    });
    return 2;
  }
  // Trust boundary: only allow https:// URLs to prevent file:///, ssh://, and other scheme attacks
  if (!url.toLowerCase().startsWith("https://")) {
    out("vf", c.red(`Invalid registry URL "${url}". Only https:// URLs are allowed.`), {
      level: "error",
    });
    return 2;
  }

  const cacheDir = registryCacheDir(url);
  const lock = parseRegistryLock(repo);
  if (lock.registries.some((r) => r.name === name)) {
    out("vf", c.red(`Registry "${name}" already exists in lock file.`), { level: "error" });
    return 1;
  }

  const ops = planClone(url, cacheDir, ref);

  if (!opts.yes) {
    out("vf", c.yellow("Dry-run (no --yes). Planned git operations:"));
    for (const op of ops) {
      out("vf", c.dim(`  ${op.cmd} ${op.args.join(" ")}`));
    }
    out("vf", c.dim(`Cache dir: ${cacheDir}`));
    return 0;
  }

  if (!opts.spawnSync) mkdirSync(dirname(cacheDir), { recursive: true });
  for (const op of ops) {
    const result = spawnGit(op.args, { spawnSync: opts.spawnSync });
    if (result.status !== 0) {
      out("vf", c.red(`git ${op.args[0]} failed: ${result.stderr.trim()}`), { level: "error" });
      return 1;
    }
  }

  const commitOID = resolveOidAndCheckout(cacheDir, { spawnSync: opts.spawnSync });

  if (!commitOID) {
    out("vf", c.red("Invalid commit OID from FETCH_HEAD. Refusing to persist lock."), {
      level: "error",
    });
    return 1;
  }

  lock.registries.push({ name, url, ref, commitOID });
  writeRegistryLock(repo, lock, { writeFileSafe: opts.writeFileSafe });

  out("vf", c.green(`+ registry "${name}" added → ${url} @ ${commitOID.slice(0, 12)}`));
  return 0;
}

export function registryList(repo: string): number {
  const lock = parseRegistryLock(repo);
  if (lock.registries.length === 0) {
    out("vf", c.dim("No registries configured."));
    return 0;
  }
  for (const r of lock.registries) {
    out(
      "vf",
      `${c.bold(r.name)} ${c.dim(`→ ${r.url} @ ${r.commitOID.slice(0, 12)} (ref: ${r.ref})`)}`,
    );
  }
  return 0;
}

export function registryUpdate(
  repo: string,
  id?: string,
  opts: { yes?: boolean; spawnSync?: SpawnFn; writeFileSafe?: typeof writeFileSafe } = {},
): number {
  const lock = parseRegistryLock(repo);
  const targets = id ? lock.registries.filter((r) => r.name === id) : lock.registries;

  if (id && targets.length === 0) {
    out("vf", c.red(`Registry "${id}" not found in lock file.`), { level: "error" });
    return 1;
  }

  if (targets.length === 0) {
    out("vf", c.dim("No registries to update."));
    return 0;
  }

  const allOps: GitOp[] = [];
  for (const r of targets) {
    const cacheDir = registryCacheDir(r.url);
    const ops = existsSync(cacheDir)
      ? planFetch(cacheDir, r.ref)
      : planClone(r.url, cacheDir, r.ref);
    allOps.push(...ops);
  }

  if (!opts.yes) {
    out("vf", c.yellow("Dry-run (no --yes). Planned git operations:"));
    for (const op of allOps) {
      out("vf", c.dim(`  ${op.cmd} ${op.args.join(" ")}`));
    }
    return 0;
  }

  let exitCode = 0;
  const updated: RegistryEntry[] = [...lock.registries];

  for (const r of targets) {
    const cacheDir = registryCacheDir(r.url);
    const idx = updated.findIndex((e) => e.name === r.name);
    const priorEntry: RegistryEntry | null =
      idx >= 0 && updated[idx] !== undefined ? (updated[idx] as RegistryEntry) : null;

    const ops = existsSync(cacheDir)
      ? planFetch(cacheDir, r.ref)
      : planClone(r.url, cacheDir, r.ref);
    let failed = false;
    for (const op of ops) {
      const result = spawnGit(op.args, { spawnSync: opts.spawnSync });
      if (result.status !== 0) {
        out("vf", c.red(`git ${op.args[0]} failed for "${r.name}": ${result.stderr.trim()}`), {
          level: "error",
        });
        failed = true;
        exitCode = 1;
        break;
      }
    }

    if (failed) {
      if (priorEntry && idx >= 0) {
        updated[idx] = priorEntry;
      }
      out("vf", c.yellow(`  Preserved prior checkout for "${r.name}".`));
      continue;
    }

    const newOID = resolveOidAndCheckout(cacheDir, { spawnSync: opts.spawnSync });

    if (!newOID) {
      out(
        "vf",
        c.red(`Invalid commit OID from FETCH_HEAD for "${r.name}". Refusing to persist lock.`),
        { level: "error" },
      );
      if (priorEntry && idx >= 0) {
        updated[idx] = priorEntry;
      }
      out("vf", c.yellow(`  Preserved prior checkout for "${r.name}".`));
      exitCode = 1;
      continue;
    }

    const shortOID = newOID.slice(0, 12);

    if (idx >= 0) {
      updated[idx] = { ...r, commitOID: newOID };
    }
    out("vf", c.green(`✔ "${r.name}" → ${shortOID} (was ${r.commitOID.slice(0, 12)})`));
  }
  writeRegistryLock(repo, { ...lock, registries: updated }, { writeFileSafe: opts.writeFileSafe });
  return exitCode;
}
