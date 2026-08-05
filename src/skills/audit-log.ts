// src/skills/audit-log.ts
//
// Append-only audit log for skill lifecycle events (#678).
// Path: .vibeflow/logs/skill-audit.jsonl
// Every event is one JSON line. Malformed lines skipped on read.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { c } from "../core.js";
import { out } from "../logbus.js";

export type SkillAuditAction = "verify" | "unverify" | "waiver" | "policy" | "curator-setup";

export interface StoredSkillAuditEvent {
  ts: string;
  actor: string;
  action: SkillAuditAction;
  skillName: string | null;
  oldStatus: string | null;
  newStatus: string | null;
  evidence: string[];
  reason: string | null;
  unitName?: string;
}

export interface SkillAuditEvent {
  ts?: string;
  actor: string;
  action: SkillAuditAction;
  skillName: string | null;
  oldStatus: string | null;
  newStatus: string | null;
  evidence: string[];
  reason: string | null;
  unitName?: string;
}

export interface AppendSkillAuditDeps {
  repo?: string;
  append?: (path: string, data: string, enc: "utf8") => void;
  mkdir?: (path: string, opts: { recursive: boolean }) => void;
  now?: () => string;
}

export interface ReadSkillAuditDeps {
  repo?: string;
  read?: (path: string, enc: "utf8") => string;
  exists?: (path: string) => boolean;
}

const VALID_ACTIONS: ReadonlySet<string> = new Set([
  "verify",
  "unverify",
  "waiver",
  "policy",
  "curator-setup",
]);
const VALID_STATUSES: ReadonlySet<string> = new Set(["verified", "unverified"]);

function logDir(repo: string): string {
  return join(repo, ".vibeflow", "logs");
}

function logPath(repo: string): string {
  return join(logDir(repo), "skill-audit.jsonl");
}

function validateEvent(e: SkillAuditEvent): boolean {
  if (typeof e.actor !== "string" || e.actor.length === 0) return false;
  if (!VALID_ACTIONS.has(e.action)) return false;
  if (e.skillName !== null && (typeof e.skillName !== "string" || e.skillName.length === 0))
    return false;
  if (e.oldStatus !== null && !VALID_STATUSES.has(e.oldStatus)) return false;
  if (e.newStatus !== null && !VALID_STATUSES.has(e.newStatus)) return false;
  if (!Array.isArray(e.evidence)) return false;
  for (const ev of e.evidence) {
    if (typeof ev !== "string" || ev.length === 0) return false;
  }
  if (e.reason !== null && (typeof e.reason !== "string" || e.reason.length === 0)) return false;
  if (e.unitName !== undefined && (typeof e.unitName !== "string" || e.unitName.length === 0))
    return false;
  return true;
}

function isValidStoredEvent(v: unknown): v is StoredSkillAuditEvent {
  if (v === null || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  if (typeof e.ts !== "string" || e.ts.length === 0) return false;
  if (typeof e.actor !== "string" || e.actor.length === 0) return false;
  if (typeof e.action !== "string" || !VALID_ACTIONS.has(e.action)) return false;
  if (!("skillName" in e)) return false;
  if (e.skillName !== null && (typeof e.skillName !== "string" || e.skillName.length === 0))
    return false;
  if (!("oldStatus" in e)) return false;
  if (e.oldStatus !== null && (typeof e.oldStatus !== "string" || !VALID_STATUSES.has(e.oldStatus)))
    return false;
  if (!("newStatus" in e)) return false;
  if (e.newStatus !== null && (typeof e.newStatus !== "string" || !VALID_STATUSES.has(e.newStatus)))
    return false;
  if (!Array.isArray(e.evidence)) return false;
  for (const ev of e.evidence) {
    if (typeof ev !== "string" || ev.length === 0) return false;
  }
  if (!("reason" in e)) return false;
  if (e.reason !== null && (typeof e.reason !== "string" || e.reason.length === 0)) return false;
  if (e.unitName !== undefined && (typeof e.unitName !== "string" || e.unitName.length === 0))
    return false;
  return true;
}

export function appendSkillAudit(event: SkillAuditEvent, deps: AppendSkillAuditDeps = {}): boolean {
  if (!validateEvent(event)) return false;
  const repo = deps.repo ?? process.cwd();
  const _append = deps.append ?? appendFileSync;
  const _mkdir = deps.mkdir ?? mkdirSync;
  const ts = deps.now?.() ?? new Date().toISOString();
  try {
    _mkdir(logDir(repo), { recursive: true });
    _append(logPath(repo), `${JSON.stringify({ ...event, ts })}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

export function appendWaiverAudit(
  repo: string,
  name: string,
  reason: string,
  deps?: AppendSkillAuditDeps,
): boolean {
  return appendSkillAudit(
    {
      actor: "human",
      action: "waiver",
      skillName: null,
      oldStatus: null,
      newStatus: null,
      evidence: [`workflow-unit:${name}`],
      reason,
      unitName: name,
    },
    { repo, ...deps },
  );
}

export function readSkillAudit(deps: ReadSkillAuditDeps = {}): StoredSkillAuditEvent[] {
  const repo = deps.repo ?? process.cwd();
  const _read = deps.read ?? readFileSync;
  const _exists = deps.exists ?? existsSync;
  const path = logPath(repo);
  if (!_exists(path)) return [];
  let raw: string;
  try {
    raw = _read(path, "utf8");
  } catch {
    return [];
  }
  const events: StoredSkillAuditEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isValidStoredEvent(parsed)) {
        events.push(parsed);
      }
    } catch {
      // skip malformed
    }
  }
  return events;
}

export function renderSkillAudit(events: SkillAuditEvent[]): string[] {
  if (!events.length) return [c.dim("no skill audit records")];
  return events.map((e) => {
    const parts = [`${e.ts}`, `${e.actor}`, `${e.action}`];
    if (e.skillName) parts.push(`skill=${e.skillName}`);
    if (e.oldStatus && e.newStatus) parts.push(`${e.oldStatus}→${e.newStatus}`);
    if (e.reason) parts.push(`reason=${JSON.stringify(e.reason)}`);
    if (e.unitName) parts.push(`unit=${e.unitName}`);
    if (e.evidence.length) {
      for (const ev of e.evidence) parts.push(`ev=${ev}`);
    }
    return parts.join(" ");
  });
}

export function handleSkillAuditLog(repo: string, rest: string[]): number {
  if (rest.length > 0) {
    out("vf", c.red("Usage: vf skills audit-log"), { level: "error" });
    return 2;
  }
  const events = readSkillAudit({ repo });
  for (const line of renderSkillAudit(events)) {
    out("vf", line);
  }
  return 0;
}
