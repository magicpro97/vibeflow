// src/canary.ts
//
// Canary tests (ADR-005): human-authored behavioral tests encoding domain
// knowledge an LLM cannot self-generate (edges, business rules, known
// regressions, security payloads). First-class verification feature —
// knowledge-heavy units must have one linked to close (gate FAILURE).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { WorkUnit } from "./core/types.js";

const CANARY_RE = /\.canary\.test\.[tj]sx?$/;

/** True when a path is a canary test file (`*.canary.test.ts|js|tsx|jsx`). */
export function isCanaryFile(path: string): boolean {
  return CANARY_RE.test(path);
}

export interface DiscoverInject {
  lister?: () => string[];
}

/** List all canary test files under repo. Injectable lister for tests. */
export function discoverCanaries(repo: string, inject: DiscoverInject = {}): string[] {
  const list = inject.lister ?? (() => defaultLister(repo));
  return list().filter(isCanaryFile);
}

/** Default lister: shallow-recursive walk of `test/` (relative paths). */
function defaultLister(repo: string): string[] {
  const dir = join(repo, "test");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map((e) => join("test", String(e)));
}

export interface CanaryMatchInject {
  /** Read the scope a canary file declares (from a header comment). */
  readCanaryScope?: (file: string) => string[];
}

/** Find a canary whose declared scope overlaps the unit's scope. Returns the
 *  file path or null. Overlap = any scope path prefix shared either direction. */
export function canaryForUnit(
  unit: WorkUnit,
  canaries: string[],
  inject: CanaryMatchInject = {},
): string | null {
  const readScope = inject.readCanaryScope ?? defaultReadCanaryScope;
  const unitScope = unit.scope ?? [];
  for (const canaryFile of canaries) {
    const cScope = readScope(canaryFile);
    if (cScope.some((cs) => unitScope.some((us) => cs.startsWith(us) || us.startsWith(cs)))) {
      return canaryFile;
    }
  }
  return null;
}

/** Default: read a `// canary-scope: <path>,<path>` header from the file. */
function defaultReadCanaryScope(file: string): string[] {
  if (!existsSync(file)) return [];
  const head = readFileSync(file, "utf8").slice(0, 500);
  const m = head.match(/\/\/\s*canary-scope:\s*(.+)/);
  return m?.[1] ? m[1].split(",").map((s) => s.trim()) : [];
}

/**
 * ADR-005 gate predicate: a knowledge-heavy unit is covered iff it has a linked
 * canary whose author differs from the unit's dispatch engine identity. A canary
 * the agent wrote itself is not a canary. Scope-overlap is validated at
 * `vf canary link` time, so the gate stays pure (no disk read).
 */
export function defaultCanaryCheck(u: WorkUnit): boolean {
  const canary = u.canary;
  if (!canary?.file || !canary.author) return false;
  return canary.author !== u.owner_agent;
}
