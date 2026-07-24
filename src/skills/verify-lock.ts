import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { c } from "../core.js";
import { out } from "../logbus.js";
import { sharedCatalogDir } from "./catalog.js";
import { parseMarketplace, registryCacheDir, registryLockPath } from "./registry-channel.js";
import { isHexOID } from "./registry-channel.js";

export interface LockVerifyResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

function readLockRaw(
  repo: string,
):
  | { ok: false; errors: string[]; doc: null }
  | { ok: true; errors: string[]; doc: Record<string, unknown> } {
  const p = registryLockPath(repo);
  if (!existsSync(p)) return { ok: true, errors: [], doc: { schemaVersion: 1, registries: [] } };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    return { ok: false, errors: [`malformed lock file: ${(e as Error).message}`], doc: null };
  }
  if (!raw || typeof raw !== "object") {
    return { ok: false, errors: ["lock file root is not an object"], doc: null };
  }
  return { ok: true, errors: [], doc: raw as Record<string, unknown> };
}

export function verifyRegistryLockIntegrity(repo: string): LockVerifyResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const p = registryLockPath(repo);
  if (!existsSync(p)) return { ok: true, errors: [], warnings: [] };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    errors.push(`malformed lock file: ${(e as Error).message}`);
    return { ok: false, errors, warnings };
  }
  if (!raw || typeof raw !== "object") {
    errors.push("lock file root is not an object");
    return { ok: false, errors, warnings };
  }

  const doc = raw as Record<string, unknown>;
  if (doc.schemaVersion !== 1) {
    errors.push(`unsupported schemaVersion: ${doc.schemaVersion ?? "missing"} (expected 1)`);
  }
  if (!Array.isArray(doc.registries)) {
    errors.push("lock file missing registries array");
    return { ok: false, errors, warnings };
  }

  for (let i = 0; i < doc.registries.length; i++) {
    const r = doc.registries[i];
    const prefix = `registries[${i}]`;
    if (!r || typeof r !== "object") {
      errors.push(`${prefix}: not an object`);
      continue;
    }
    const reg = r as Record<string, unknown>;
    const regName = typeof reg.name === "string" ? reg.name : `[${i}]`;

    if (typeof reg.name !== "string" || !reg.name) {
      errors.push(`${prefix}: missing or invalid name`);
    }
    if (typeof reg.url !== "string" || !reg.url) {
      errors.push(`registry "${regName}": missing or invalid url`);
    }
    if (typeof reg.ref !== "string" || !reg.ref) {
      errors.push(`registry "${regName}": missing or invalid ref`);
    }
    if (typeof reg.commitOID !== "string" || !reg.commitOID) {
      errors.push(`registry "${regName}": missing or invalid commitOID`);
    } else if (!isHexOID(reg.commitOID as string)) {
      errors.push(`registry "${regName}": commitOID "${reg.commitOID}" is not valid hex`);
    }

    if (Array.isArray(reg.installed)) {
      for (let j = 0; j < reg.installed.length; j++) {
        const s = reg.installed[j];
        const sp = `registry "${regName}".installed[${j}]`;
        if (!s || typeof s !== "object") {
          errors.push(`${sp}: not an object`);
          continue;
        }
        const skill = s as Record<string, unknown>;
        const skillName = typeof skill.name === "string" ? skill.name : `[${j}]`;

        if (typeof skill.name !== "string" || !skill.name) {
          errors.push(`${sp}: missing or invalid name`);
        }
        if (typeof skill.version !== "string" || !skill.version) {
          errors.push(`installed skill "${skillName}": missing or invalid version`);
        }
        if (typeof skill.commitOID !== "string" || !skill.commitOID) {
          errors.push(`installed skill "${skillName}": missing or invalid commitOID`);
        } else if (!isHexOID(skill.commitOID as string)) {
          errors.push(
            `installed skill "${skillName}": commitOID "${skill.commitOID}" is not valid hex`,
          );
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function verifyLockMarketplaceSchemas(
  repo: string,
  opts: { homedir?: () => string } = {},
): LockVerifyResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const p = registryLockPath(repo);
  if (!existsSync(p)) return { ok: true, errors: [], warnings: [] };

  const parsed = readLockRaw(repo);
  if (!parsed.ok) return { ok: false, errors: parsed.errors, warnings };
  if (!Array.isArray(parsed.doc.registries)) return { ok: true, errors: [], warnings };

  const registries = parsed.doc.registries as Record<string, unknown>[];
  for (const reg of registries) {
    if (!reg || typeof reg !== "object") continue;
    const regName = typeof reg.name === "string" ? reg.name : "(unnamed)";
    const regUrl = typeof reg.url === "string" ? reg.url : "";
    if (!regUrl) continue;

    const cacheDir = registryCacheDir(regUrl, opts);
    const { skills, errors: mpErrors } = parseMarketplace(cacheDir);

    if (mpErrors.length) {
      for (const me of mpErrors) {
        errors.push(
          `registry "${regName}": ${me} — run \`vf skills registry update ${regName} --yes\` to refresh cache`,
        );
      }
    }
    if (skills.length > 0) {
      warnings.push(`registry "${regName}": ${skills.length} verified skill(s) in marketplace`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function verifyLockMirrorCompleteness(
  repo: string,
  opts: { catalogDir?: string } = {},
): LockVerifyResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const p = registryLockPath(repo);
  if (!existsSync(p)) return { ok: true, errors: [], warnings: [] };

  const parsed = readLockRaw(repo);
  if (!parsed.ok) {
    errors.push("cannot verify mirror completeness: lock file is malformed");
    return { ok: false, errors, warnings };
  }
  if (!Array.isArray(parsed.doc.registries)) return { ok: true, errors: [], warnings };

  const catalog = opts.catalogDir ?? sharedCatalogDir();
  const registries = parsed.doc.registries as Record<string, unknown>[];
  for (const reg of registries) {
    if (!reg || typeof reg !== "object") continue;
    if (!Array.isArray(reg.installed)) continue;
    const regName = typeof reg.name === "string" ? reg.name : "(unnamed)";
    for (const s of reg.installed) {
      if (!s || typeof s !== "object") continue;
      const skill = s as Record<string, unknown>;
      const skillName = typeof skill.name === "string" ? skill.name : "(unnamed)";
      const catDir = join(catalog, skillName);
      if (!existsSync(catDir)) {
        errors.push(
          `"${skillName}" (from registry "${regName}") pinned in lock but missing from catalog — run \`vf skills registry install ${regName}/${skillName} --yes\``,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export interface LockVerifyGateResult {
  lockOk: boolean;
  mirrorOk: boolean;
  failed: number;
}

export function verifyLockGate(
  base: string,
  opts: { catalogDir?: string } = {},
): LockVerifyGateResult {
  const lockP = join(base, ".vibeflow", "SKILL_REGISTRY.lock.json");
  let failed = 0;
  let lockOk = true;
  let mirrorOk = true;
  if (!existsSync(lockP)) return { lockOk: true, mirrorOk: true, failed: 0 };
  const lock = verifyRegistryLockIntegrity(base);
  for (const e of lock.errors) {
    failed++;
    out("vf", c.red(`[lock integrity] ${e}`));
  }
  for (const w of lock.warnings) out("vf", c.yellow(`⚠ [lock integrity] ${w}`));
  if (lock.ok) out("vf", c.green("✓ lock integrity"));
  lockOk = lock.ok;
  const mirror = verifyLockMirrorCompleteness(base, opts);
  for (const e of mirror.errors) {
    failed++;
    out("vf", c.red(`[mirror completeness] ${e}`));
  }
  for (const w of mirror.warnings) out("vf", c.yellow(`⚠ [mirror completeness] ${w}`));
  if (mirror.ok) out("vf", c.green("✓ mirror completeness"));
  mirrorOk = mirror.ok;
  return { lockOk, mirrorOk, failed };
}
