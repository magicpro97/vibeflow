// src/memory/claude-mem.ts
import { spawnSync } from "node:child_process";
import type { MemoryHit, MemoryProvider } from "./types.js";

interface SpawnResult {
  status: number | null;
  stdout: string;
}
export interface ClaudeMemInject {
  spawner?: (query: string, limit: number) => SpawnResult;
}

export class ClaudeMemProvider implements MemoryProvider {
  private spawner: (query: string, limit: number) => SpawnResult;
  constructor(inject: ClaudeMemInject = {}) {
    this.spawner =
      inject.spawner ??
      ((query, limit) => {
        const r = spawnSync("claude-mem", ["search", query, "--json", "--limit", String(limit)], {
          encoding: "utf8",
          timeout: 5000,
        });
        return { status: r.status, stdout: r.stdout ?? "" };
      });
  }
  recall(query: string, opts?: { limit?: number }): MemoryHit[] {
    const limit = opts?.limit ?? 3;
    try {
      const r = this.spawner(query, limit);
      if (r.status !== 0 || !r.stdout.trim()) return [];
      const arr = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
      return arr.slice(0, limit).map((o) => ({
        id: String(o.id ?? o.title ?? ""),
        title: String(o.title ?? ""),
        content: String(o.text ?? o.content ?? ""),
        score: typeof o.score === "number" ? o.score : 0.5,
      }));
    } catch {
      return [];
    }
  }
}
