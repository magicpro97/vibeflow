/**
 * In-session verdict ordering for the composer chip.
 *
 * Split from `ui-project-settings.test.ts` (which owns the gate, confirm, and dismissal memory)
 * because this suite is about one contract only: when two classifications for the *same* session
 * are in flight, the last request wins even if the earlier response lands last. "Last response
 * wins" would offer a move inferred from a message the user has already superseded.
 */
const { describe, expect, test } = await import(String("bun:test"));
import { type HomeProjectRow, createHomeProjectRuntime } from "../conversation-home-projects.js";

const ROW: HomeProjectRow = {
  id: "alpha",
  name: "alpha-service",
  goal: "Ship the alpha",
  engine: { cli: "codex", model: null, thinking: "high" },
};

type Verdict = { project_id: string; confidence: number; reason: "ai" };

/** A promise whose resolution the test controls; the UI lib target has no `Promise.withResolvers`. */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function runtimeWith(classify: (message: string) => Promise<Verdict>) {
  const asked: string[] = [];
  const runtime = createHomeProjectRuntime({
    client: {
      listProjects: async () => [ROW],
      classifyMessage: (input) => {
        asked.push(input.message);
        return classify(input.message);
      },
      updateProjectEngine: async () => {},
      moveConversation: async () => {},
      readProjectSettings: async () => null,
      writeProjectSettings: async () => null,
    },
    activeRootId: () => "root-1",
    activeProjectId: () => "idea",
    autoClassify: () => true,
  });
  return { runtime, asked };
}

describe("project verdict sequencing", () => {
  test("the newest verdict wins when an older one resolves last", async () => {
    const first = createDeferred<Verdict>();
    const { runtime, asked } = runtimeWith((message) =>
      message === "first message"
        ? first.promise
        : Promise.resolve({ project_id: "bravo", confidence: 0.9, reason: "ai" as const }),
    );
    const stale = runtime.classifyAndPropose("first message");
    await runtime.classifyAndPropose("second message");
    expect(runtime.suggestion.value?.project_id).toBe("bravo");
    // The superseded verdict now lands: it must not replace the newer proposal.
    first.resolve({ project_id: "alpha", confidence: 0.9, reason: "ai" });
    await stale;
    expect(runtime.suggestion.value?.project_id).toBe("bravo");
    expect(asked).toEqual(["first message", "second message"]);
  });

  test("the newest verdict wins even when the stale one is the only one that resolves", async () => {
    // The second classification fails while the first is still in flight: the failure must not
    // clear a chip the user is looking at, and the superseded verdict must not refill it either.
    const first = createDeferred<Verdict>();
    const { runtime } = runtimeWith((message) =>
      message === "first message" ? first.promise : Promise.reject(new Error("classifier down")),
    );
    const stale = runtime.classifyAndPropose("first message");
    await runtime.classifyAndPropose("second message");
    // A rejected classification for the newer message already cleared the chip.
    expect(runtime.suggestion.value).toBeNull();
    first.resolve({ project_id: "alpha", confidence: 0.9, reason: "ai" });
    await stale;
    expect(runtime.suggestion.value).toBeNull();
  });
});
