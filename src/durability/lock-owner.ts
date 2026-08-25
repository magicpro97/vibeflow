import { execFileSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import { hostname } from "node:os";
import { canonicalJsonBytes } from "./canonical.js";
import { durabilityError } from "./errors.js";

export interface ProcessLockOwnerV1 {
  schema_version: "1.0";
  pid: number;
  process_start_identity: string;
  host: string;
  operation: string;
  nonce: string;
}

const OWNER_KEYS = [
  "host",
  "nonce",
  "operation",
  "pid",
  "process_start_identity",
  "schema_version",
] as const;

export function boundedOwnerAscii(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    Buffer.byteLength(value, "utf8") <= max &&
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x20 && code <= 0x7e;
    })
  );
}

export function parseProcessLockOwner(bytes: Buffer): ProcessLockOwnerV1 {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    return durabilityError("corrupt", "invalid process lock owner metadata", error);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    durabilityError("corrupt", "invalid process lock owner metadata");
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (keys.length !== OWNER_KEYS.length || keys.some((key, index) => key !== OWNER_KEYS[index]))
    durabilityError("corrupt", "unknown process lock owner metadata field");
  if (
    row.schema_version !== "1.0" ||
    !Number.isSafeInteger(row.pid) ||
    (row.pid as number) < 1 ||
    (row.pid as number) > 2_147_483_647 ||
    !boundedOwnerAscii(row.process_start_identity, 512) ||
    !boundedOwnerAscii(row.host, 255) ||
    !boundedOwnerAscii(row.operation, 512) ||
    typeof row.nonce !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.nonce)
  )
    durabilityError("corrupt", "invalid process lock owner metadata");
  const canonical = canonicalJsonBytes(row);
  if (canonical.length !== bytes.length || !timingSafeEqual(canonical, bytes))
    durabilityError("corrupt", "process lock owner metadata is not canonical");
  return row as unknown as ProcessLockOwnerV1;
}

function linuxStartIdentity(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    if (stat.length > 16 * 1024) return null;
    const end = stat.lastIndexOf(")");
    if (end < 0) return null;
    const startTicks = stat
      .slice(end + 2)
      .trim()
      .split(/\s+/)[19];
    if (!startTicks || !/^[0-9]+$/.test(startTicks)) return null;
    const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (!/^[a-f0-9-]{16,64}$/i.test(bootId)) return null;
    return `linux:${bootId.toLowerCase()}:${startTicks}`;
  } catch {
    return null;
  }
}

function psStartIdentity(pid: number): string | null {
  try {
    const result = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return result ? `${process.platform}:${result}` : null;
  } catch {
    return null;
  }
}

export function processStartIdentity(pid = process.pid): string | null {
  return process.platform === "linux" ? linuxStartIdentity(pid) : psStartIdentity(pid);
}

export function processLockOwnerIsAlive(owner: ProcessLockOwnerV1): boolean | null {
  if (owner.host !== hostname()) return null;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : null;
  }
  if (process.platform !== "linux")
    return owner.pid === process.pid && owner.process_start_identity === processStartIdentity()
      ? true
      : null;
  const observed = processStartIdentity(owner.pid);
  return observed === null ? null : observed === owner.process_start_identity;
}
