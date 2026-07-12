import type { DispatchMarker } from "./marker.js";
import { readMarker } from "./marker.js";

/** #618 PR2b-1: decide whether a unit dispatch should resume the engine's prior session.
 *  Resume only when the operator opted in (`resume`), a marker survives from a crashed run
 *  (any non-terminal state — `running`/`blocked`/`failed`; a clean `done` or not-yet-started
 *  `pending` never resumes), and that marker carries an `engineSessionId` (claude only today;
 *  PR1 persists no id for codex/copilot, so they fall through to a fresh dispatch here).
 *  Returns the session id to resume, else undefined (fresh). */
export function resolveResumeId(
  unit: string,
  resume: boolean,
  read: (u: string) => DispatchMarker | null = readMarker,
): string | undefined {
  if (!resume) return undefined;
  const marker = read(unit);
  if (!marker) return undefined;
  // Resume only crash-dở states; a clean `done` or not-yet-started `pending` never resumes.
  if (marker.status === "done" || marker.status === "pending") return undefined;
  return marker.engineSessionId;
}
