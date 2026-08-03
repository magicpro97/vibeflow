// Pure read-model for the #688 Registry tab. No git/network/cache/local-path
// calls — every field shown in the browser is derived from the sanitized
// `.vibeflow/SKILL_REGISTRY.lock.json` content so a malicious lock can never
// leak a filesystem path or force the UI to touch the disk.
//
// This module does NOT go through parseRegistryLock (registry-channel.ts):
// that function DROPS malformed rows. The whole point of the registry view is
// to render one sanitized row per raw `registries[]` entry, including malformed
// rows as `valid:false`, so we parse the raw file here with an injected reader
// at a small trust boundary.

import { readFileSync } from "node:fs";
import { isValidRegistryName, registryLockPath } from "./registry-channel.js";

/** Reader over the lock file path. Injected so tests avoid disk. */
export type LockReader = (path: string) => string;

export interface RegistryViewEntry {
  id: string;
  url: string;
  ref: string;
  commitOID: string;
  /** Raw length of the lock's `installed[]` array (bounded by the parsed lock only). */
  entryCount: number;
  /** Truthful count of valid installed skills across the entire array. */
  installedCount: number;
  /** True when the lock entry has valid name/url/ref/commitOID. */
  valid: boolean;
}

export interface RegistryView {
  ok: true;
  registries: RegistryViewEntry[];
}

const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Hard cap on URL length, applied before AND after sanitization. */
const MAX_URL_LENGTH = 2048;
/** Installed-skill version cap, matching the parser's bounded version. */
const MAX_VERSION_LENGTH = 128;

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length < 1 || raw.length > 64) return null;
  if (!isValidRegistryName(raw)) return null;
  return raw;
}

/**
 * Pure equivalent of `git check-ref-format --branch` for a lock ref. Accepts
 * names like `main`, `refs/heads/main`, `release/v1`; rejects control chars,
 * space, `~ ^ : ? * [ \`, leading-dash, leading/trailing-slash, double-slash,
 * `..`, `@{`, a component starting with `.`, a component ending `.lock`, and a
 * trailing dot. Mirrors Git's ref rules so a malicious lock never injects an
 * unsafe ref into the CLI.
 */
export function isSafeBranchRef(ref: string): boolean {
  if (ref === "HEAD") return false;
  if (ref.length === 0 || ref.length > 256) return false;
  if (hasControlChar(ref)) return false;
  if (ref.startsWith("-")) return false;
  if (ref.startsWith("/") || ref.endsWith("/")) return false;
  if (ref.includes("//")) return false;
  if (ref.includes("..")) return false;
  if (ref.includes("@{")) return false;
  for (const ch of ref) {
    if (
      ch === " " ||
      ch === "~" ||
      ch === "^" ||
      ch === ":" ||
      ch === "?" ||
      ch === "*" ||
      ch === "[" ||
      ch === "\\"
    ) {
      return false;
    }
  }
  if (ref.endsWith(".")) return false;
  for (const comp of ref.split("/")) {
    if (comp.startsWith(".")) return false;
    if (comp.endsWith(".lock")) return false;
  }
  return true;
}

function sanitizeRef(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (!isSafeBranchRef(raw)) return null;
  return raw;
}

function isValidVersion(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  if (raw.length === 0 || raw.length > MAX_VERSION_LENGTH) return false;
  return !hasControlChar(raw);
}

function sanitizeUrl(raw: unknown): string {
  if (typeof raw !== "string") return "";
  if (raw.length > MAX_URL_LENGTH) return ""; // raw overlong → invalid
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "";
  }
  // http/https only.
  if (u.protocol !== "https:" && u.protocol !== "http:") return "";
  // Strip credentials, query, and fragment before surfacing to the browser.
  u.username = "";
  u.password = "";
  u.search = "";
  u.hash = "";
  const out = u.toString();
  return out.length > MAX_URL_LENGTH ? "" : out; // sanitized overlong → invalid
}

function sanitizeOID(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return GIT_OID.test(raw) ? raw : null;
}

function fallbackId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let out = "";
  for (const ch of raw) {
    if (hasControlChar(ch)) continue;
    out += ch;
    if (out.length >= 64) break;
  }
  return out;
}

/** Read the raw lock's `registries[]` array. Missing/malformed → empty. */
function readRegistryRows(repo: string, reader?: LockReader): unknown[] {
  if (!reader) return [];
  const path = registryLockPath(repo);
  let rawText: string;
  try {
    rawText = reader(path);
  } catch {
    return []; // missing file → empty
  }
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    return []; // malformed JSON → empty
  }
  if (!raw || typeof raw !== "object") return [];
  const doc = raw as Record<string, unknown>;
  if (!Array.isArray(doc.registries)) return [];
  return doc.registries;
}

const defaultReader: LockReader = (p) => readFileSync(p, "utf8");

/** Build the browser-safe registry view from a repo's lock file. */
export function buildRegistryView(repo: string, reader?: LockReader): RegistryView {
  const rows = readRegistryRows(repo, reader ?? defaultReader);
  const registries: RegistryViewEntry[] = [];
  for (const rawRow of rows) {
    const row = rawRow && typeof rawRow === "object" ? (rawRow as Record<string, unknown>) : {};
    const name = sanitizeName(row.name);
    const url = sanitizeUrl(row.url);
    const ref = sanitizeRef(row.ref);
    const oid = sanitizeOID(row.commitOID);
    const valid = name !== null && url !== "" && ref !== null && oid !== null;

    const installed = Array.isArray(row.installed) ? row.installed : [];
    let installedCount = 0;
    for (const s of installed) {
      const inst = s && typeof s === "object" ? (s as Record<string, unknown>) : {};
      if (
        sanitizeName(inst.name) !== null &&
        isValidVersion(inst.version) &&
        sanitizeOID(inst.commitOID) !== null
      ) {
        installedCount++;
      }
    }

    registries.push({
      id: name ?? fallbackId(row.name),
      url,
      ref: ref ?? "",
      commitOID: oid ?? "",
      entryCount: installed.length,
      installedCount,
      valid,
    });
  }
  return { ok: true, registries };
}

/** Resolve a validated registry id from the lock, or null when unknown.
 *  Requires the FULL row to be valid (name/url/ref/commitOID) — not URL only. */
export function findRegistryId(repo: string, id: string, reader?: LockReader): string | null {
  if (sanitizeName(id) === null) return null;
  const rows = readRegistryRows(repo, reader ?? defaultReader);
  for (const rawRow of rows) {
    const row = rawRow && typeof rawRow === "object" ? (rawRow as Record<string, unknown>) : {};
    if (String(row.name) !== id) continue;
    if (sanitizeUrl(row.url) === "") continue;
    if (sanitizeRef(row.ref) === null) continue;
    if (sanitizeOID(row.commitOID) === null) continue;
    return id;
  }
  return null;
}
