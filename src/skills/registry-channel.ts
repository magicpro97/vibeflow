import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { c, writeFileSafe } from "../core.js";
import { out } from "../logbus.js";

interface SpawnResult {
  status: number | null;
  stdout: string | Buffer;
  stderr: string | Buffer;
}
// Lightweight spawn type compatible with both real spawnSync and test fakes
type SpawnFn = (
  command: string,
  args: readonly string[],
  options: Record<string, unknown>,
) => SpawnResult;
const defaultSpawn: SpawnFn = spawnSync as SpawnFn;

export interface RegistryEntry {
  name: string;
  url: string;
  ref: string;
  commitOID: string;
}

export interface RegistryLock {
  schemaVersion: 1;
  registries: RegistryEntry[];
}

export interface GitOp {
  cmd: string;
  args: string[];
}

const LOCK_REL = join(".vibeflow", "SKILL_REGISTRY.lock.json");

export function registryLockPath(repo: string): string {
  return join(repo, LOCK_REL);
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
          registries.push({ name: r.name, url: r.url, ref: r.ref, commitOID: r.commitOID });
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

export function registryCacheDir(url: string): string {
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
  return join(homedir(), ".vibeflow", "skill-registries", hash);
}

function isHexOID(s: string): boolean {
  return /^[0-9a-f]{1,64}$/.test(s);
}

function spawnGit(
  args: string[],
  inject?: { spawnSync?: SpawnFn },
): { status: number; stdout: string; stderr: string } {
  const _spawn = inject?.spawnSync ?? defaultSpawn;
  const result = _spawn("git", args, { timeout: 60_000, stdio: "pipe" });
  return {
    status: result.status ?? 1,
    stdout: typeof result.stdout === "string" ? result.stdout : (result.stdout?.toString() ?? ""),
    stderr: typeof result.stderr === "string" ? result.stderr : (result.stderr?.toString() ?? ""),
  };
}

function planClone(url: string, cacheDir: string, ref: string): GitOp[] {
  return [
    { cmd: "git", args: ["clone", "--filter=blob:none", "--no-checkout", url, cacheDir] },
    { cmd: "git", args: ["-C", cacheDir, "fetch", "origin", ref] },
    { cmd: "git", args: ["-C", cacheDir, "checkout", ref, "--detach"] },
    { cmd: "git", args: ["-C", cacheDir, "rev-parse", "HEAD"] },
  ];
}

function planFetch(cacheDir: string, ref: string): GitOp[] {
  return [
    { cmd: "git", args: ["-C", cacheDir, "fetch", "origin"] },
    { cmd: "git", args: ["-C", cacheDir, "checkout", ref, "--detach"] },
    { cmd: "git", args: ["-C", cacheDir, "rev-parse", "HEAD"] },
  ];
}

export function registryAdd(
  repo: string,
  url: string,
  name: string,
  ref: string,
  opts: { yes?: boolean; spawnSync?: SpawnFn; writeFileSafe?: typeof writeFileSafe } = {},
): number {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(name)) {
    out("vf", c.red(`Invalid registry name "${name}". Use lowercase-hyphen/dot syntax.`), {
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

  for (const op of ops) {
    const result = spawnGit(op.args, { spawnSync: opts.spawnSync });
    if (result.status !== 0) {
      out("vf", c.red(`git ${op.args[0]} failed: ${result.stderr.trim()}`), { level: "error" });
      return 1;
    }
  }

  const oidResult = spawnGit(["-C", cacheDir, "rev-parse", "HEAD"], { spawnSync: opts.spawnSync });
  const commitOID = oidResult.status === 0 ? oidResult.stdout.trim() : "";

  if (!isHexOID(commitOID)) {
    out(
      "vf",
      c.red(`Invalid commit OID "${commitOID}" from git rev-parse HEAD. Refusing to persist lock.`),
      { level: "error" },
    );
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

    const oidResult = spawnGit(["-C", cacheDir, "rev-parse", "HEAD"], {
      spawnSync: opts.spawnSync,
    });
    const newOID = oidResult.status === 0 ? oidResult.stdout.trim() : "";

    if (!newOID || !isHexOID(newOID)) {
      out(
        "vf",
        c.red(
          `Invalid commit OID "${newOID}" from git rev-parse HEAD for "${r.name}". Refusing to persist lock.`,
        ),
        { level: "error" },
      );
      if (priorEntry && idx >= 0) {
        updated[idx] = priorEntry;
      }
      out("vf", c.yellow(`  Preserved prior checkout for "${r.name}".`));
      exitCode = 1;
      continue;
    }

    const refResult = spawnGit(["-C", cacheDir, "rev-parse", "--short", "HEAD"], {
      spawnSync: opts.spawnSync,
    });
    const shortOID = refResult.status === 0 ? refResult.stdout.trim() : newOID.slice(0, 12);

    if (idx >= 0) {
      updated[idx] = { ...r, commitOID: newOID };
    }
    out("vf", c.green(`✔ "${r.name}" → ${shortOID} (was ${r.commitOID.slice(0, 12)})`));
  }

  writeRegistryLock(repo, { ...lock, registries: updated }, { writeFileSafe: opts.writeFileSafe });
  return exitCode;
}

export function handleRegistrySubcommand(repo: string, args: string[]): number {
  const cmd = args[0];
  const rest = args.slice(1);
  if (cmd === "add") {
    let url = "";
    let name = "";
    let ref = "";
    let yes = false;
    for (let i = 0; i < rest.length; i++) {
      const tok: string | undefined = rest[i];
      if (tok === "--name") {
        name = rest[++i] ?? "";
      } else if (tok?.startsWith("--name=")) {
        name = tok.slice("--name=".length);
      } else if (tok === "--ref") {
        ref = rest[++i] ?? "";
      } else if (tok?.startsWith("--ref=")) {
        ref = tok.slice("--ref=".length);
      } else if (tok === "--yes") {
        yes = true;
      } else if (tok?.startsWith("--")) {
        out(
          "vf",
          c.red(
            `Unknown flag: ${tok}. Usage: vf skills registry add <git-url> --name <id> --ref <tag-or-commit> [--yes]`,
          ),
          { level: "error" },
        );
        return 2;
      } else if (url) {
        out(
          "vf",
          c.red(
            `Duplicate positional argument: ${tok}. Usage: vf skills registry add <git-url> --name <id> --ref <tag-or-commit> [--yes]`,
          ),
          { level: "error" },
        );
        return 2;
      } else if (tok !== undefined) {
        url = tok;
      }
    }
    if (!url || !name || !ref) {
      out(
        "vf",
        c.red("Usage: vf skills registry add <git-url> --name <id> --ref <tag-or-commit> [--yes]"),
        { level: "error" },
      );
      return 2;
    }
    return registryAdd(repo, url, name, ref, { yes });
  }
  if (cmd === "list") {
    if (rest.length > 0) {
      out("vf", c.red("Usage: vf skills registry list — no arguments or flags supported."), {
        level: "error",
      });
      return 2;
    }
    return registryList(repo);
  }
  if (cmd === "update") {
    let id: string | undefined;
    let yes = false;
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i];
      if (tok === "--yes") {
        yes = true;
      } else if (!tok?.startsWith("--")) {
        id = tok;
      }
    }
    return registryUpdate(repo, id, { yes });
  }
  out("vf", c.red("Usage: vf skills registry <add|list|update> [args]"), { level: "error" });
  return 2;
}
