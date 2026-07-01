import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { writeFileSafe } from "./core.js";

export interface ProjectEntry {
  path: string;
  name: string;
  lastUsed: number;
  goal: string;
  totals: { units: number; done: number; tokens: number; cost_usd: number };
}

const REGISTRY_PATH = join(homedir(), ".vibeflow", "projects.json");
const MAX_ENTRIES = 20;

export function readRegistry(): ProjectEntry[] {
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as ProjectEntry[];
  } catch {
    return [];
  }
}

export function upsertRegistry(entry: ProjectEntry): void {
  try {
    const list = readRegistry().filter((e) => e.path !== entry.path);
    list.unshift({ ...entry, name: basename(entry.path) });
    writeFileSafe(REGISTRY_PATH, JSON.stringify(list.slice(0, MAX_ENTRIES), null, 2));
  } catch {
    /* best-effort — never break the caller */
  }
}
