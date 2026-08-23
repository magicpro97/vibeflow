import type { Engine } from "../core.js";
import type { DispatchMarker } from "./marker.js";
import { readMarker } from "./marker.js";

/** #618 PR2b-1: decide whether a unit dispatch should resume the engine's prior session.
 *  Resume only when the operator opted in (`resume`), a marker survives from a crashed run
 *  (any non-terminal state — `running`/`blocked`/`failed`; a clean `done` or not-yet-started
 *  `pending` never resumes), and that marker carries an `engineSessionId` (claude + codex in
 *  PR2b-2; copilot has no by-id resume, so it falls through to a fresh dispatch here).
 *  Returns the session id to resume, else undefined (fresh). */
export function resolveResumeId(
  unit: string,
  resume: boolean,
  engine: Engine,
  read: (u: string) => DispatchMarker | null = readMarker,
): string | undefined {
  if (!resume) return undefined;
  const marker = read(unit);
  if (!marker) return undefined;
  // Resume only crash-dở states; a clean `done` or not-yet-started `pending` never resumes.
  if (marker.status === "done" || marker.status === "pending") return undefined;
  if (!marker.engineSessionId || !marker.engineSessionEngine) return undefined;
  if (marker.engineSessionEngine !== engine) {
    throw new Error(
      `resume engine mismatch: marker=${marker.engineSessionEngine}, requested=${engine}`,
    );
  }
  return marker.engineSessionId;
}
