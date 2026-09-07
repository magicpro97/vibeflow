import { describe, expect, test } from "bun:test";
import { ProbeCache, setCachedProbe, setSharedCache } from "../src/preflight.js";
import { liveEngineReadiness } from "../src/server.js";
import { ENGINES } from "../src/core/agent-contract.js";

const REPO = "agent-live-readiness-repo";

function stubAllEngines(): void {
  for (const engine of ENGINES) {
    setCachedProbe(engine, REPO, ["live"], {
      engine,
      level: "ready",
      detail: `stub ${engine}`,
      checkedAt: "2026-09-08T00:00:00.000Z",
    });
  }
}

describe("live engine readiness (UI picker)", () => {
  test("serves cached live-probe results without re-probing", async () => {
    setSharedCache(new ProbeCache());
    try {
      stubAllEngines();
      setCachedProbe("claude", REPO, ["live"], {
        engine: "claude",
        level: "no-auth",
        detail: "claude: credential expired",
        checkedAt: "2026-09-08T00:00:00.000Z",
      });
      const rows = await liveEngineReadiness(REPO, false);
      const claude = rows.find((row) => row.engine === "claude");
      expect(claude).toBeDefined();
      expect(claude?.level).toBe("no-auth");
      expect(claude?.detail).toContain("credential expired");
    } finally {
      setSharedCache(undefined);
    }
  });
});