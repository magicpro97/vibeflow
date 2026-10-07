/** Pure browser-safe projections for the update banner; the wire shape lives in
 *  the shared dependency-neutral contract (also imported by the server routes). */
import type { UpdateStatusView } from "../../update/update-status-contract.js";

export function bannerVisible(s: UpdateStatusView): boolean {
  return s.upgrade_available || s.rollback !== null;
}

export function bannerLine(s: UpdateStatusView): string | null {
  if (s.upgrade_available && s.latest !== null) {
    const n = s.stale_servers.length;
    const tail = n === 0 ? "" : ` · ${n} running UI server${n === 1 ? "" : "s"} on old code`;
    return `VibeFlow v${s.installed} → v${s.latest} available${tail}`;
  }
  if (s.rollback !== null) return `Rollback available: v${s.rollback.version}`;
  return null;
}
