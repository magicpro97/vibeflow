import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { c, out } from "./_shared.js";

export function runWaiverGate(base: string, inject?: { spawner?: typeof spawnSync }): boolean {
  if (!existsSync(join(base, "scripts", "waiver-policy.cjs"))) {
    out("vf", c.dim("⚠ waiver-policy.cjs not found — skipping"));
    return true;
  }
  const s = inject?.spawner ?? spawnSync;
  const w = s("node", ["scripts/waiver-policy.cjs"], { stdio: "pipe", cwd: base });
  if (w.status !== 0) {
    out("vf", c.red("✗ waiver policy gate failed"));
    return false;
  }
  out("vf", c.green("✓ waiver policy gate"));
  return true;
}
