// #555: head-to-head race state, split from store.ts for the 400-line cap
// (same pattern as store-release.ts). Holds the ranked rows the Stage 3 table
// renders plus the engines the server skipped as unavailable. Read-after-run
// only: the CLI/route owns dispatch, this file never merges anything.
import { ref } from "vue";
import { type RaceResultRow, api } from "./api.js";

export function createRaceState() {
  const raceRunning = ref(false);
  const raceRanking = ref<RaceResultRow[]>([]);
  const raceSkipped = ref<Array<{ engine: string; reason: string }>>([]);
  const raceError = ref<string | null>(null);

  /** Race the task across `engines` (empty = every installed engine). */
  async function runRace(task: string, engines: string[]) {
    raceRunning.value = true;
    raceError.value = null;
    try {
      const result = await api.race({
        task,
        ...(engines.length ? { engines } : {}),
      });
      raceRanking.value = result.ranking;
      raceSkipped.value = result.skipped;
    } catch (e) {
      raceRanking.value = [];
      raceSkipped.value = [];
      raceError.value = e instanceof Error ? e.message.slice(0, 120) : "Race failed";
    } finally {
      raceRunning.value = false;
    }
  }

  return { raceRunning, raceRanking, raceSkipped, raceError, runRace };
}
