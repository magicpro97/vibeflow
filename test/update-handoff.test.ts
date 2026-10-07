import { describe, expect, test } from "bun:test";
import {
  type HandoffSeams,
  performHandoff,
  requestIsActionable,
  startServerWithBindRetry,
  startUpdateHandoffWatcher,
  takeoverConfirmed,
} from "../src/update/ui-handoff.js";
import {
  type HandoffStateV1,
  UPDATE_HANDOFF,
  UPDATE_HANDOFF_STATE,
  type UpdateRequestV1,
} from "../src/update/update-contract.js";

const request = (over: Partial<UpdateRequestV1> = {}): UpdateRequestV1 => ({
  schema_version: "1.0",
  request_id: "req-1",
  requested_at: 1_700_000_000_000,
  target_version: "0.21.0",
  requested_by_pid: 42,
  ...over,
});

function handoffHarness(over: Partial<HandoffSeams> = {}) {
  const states: HandoffStateV1[] = [];
  const log: string[] = [];
  let clock = 0;
  let discovery: { pid: number; app_version?: string } | null = null;
  let exitCb: (() => void) | null = null;
  let replacementAlive = true;
  const seams: HandoffSeams = {
    base: "/repo",
    currentVersion: "0.20.0",
    spawnReplacement: () => ({
      pid: 4242,
      onExit: (cb) => {
        exitCb = cb;
      },
      isAlive: () => replacementAlive,
    }),
    stopServer: async () => {
      log.push("stop");
    },
    recoverServer: async () => {
      log.push("recover");
    },
    readDiscovery: () => discovery,
    writeState: (s) => {
      states.push(s);
    },
    sleep: async (ms) => {
      clock += ms;
      log.push(`sleep:${ms}`);
    },
    now: () => clock,
    ...over,
  };
  return {
    seams,
    states,
    log,
    setDiscovery: (d: { pid: number; app_version?: string } | null) => {
      discovery = d;
    },
    fireReplacementExit: () => exitCb?.(),
    setReplacementAlive: (v: boolean) => {
      replacementAlive = v;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("requestIsActionable", () => {
  test("only a strictly newer target is actionable", () => {
    expect(requestIsActionable(null, "0.20.0")).toBe(false);
    expect(requestIsActionable(request(), "0.21.0")).toBe(false);
    expect(requestIsActionable(request({ target_version: "0.19.9" }), "0.20.0")).toBe(false);
    expect(requestIsActionable(request(), "0.20.0")).toBe(true);
  });
});

describe("takeoverConfirmed", () => {
  test("requires the replacement pid", () => {
    expect(takeoverConfirmed(null, 4242, "0.21.0")).toBe(false);
    expect(takeoverConfirmed({ pid: 1, app_version: "0.21.0" }, 4242, "0.21.0")).toBe(false);
  });
  test("accepts a matching or version-less record", () => {
    expect(takeoverConfirmed({ pid: 4242, app_version: "0.21.0" }, 4242, "0.21.0")).toBe(true);
    expect(takeoverConfirmed({ pid: 4242 }, 4242, "0.21.0")).toBe(true);
    expect(takeoverConfirmed({ pid: 4242, app_version: "0.20.0" }, 4242, "0.21.0")).toBe(false);
  });
});

describe("startServerWithBindRetry", () => {
  test("returns the first success", async () => {
    let calls = 0;
    const ok = await startServerWithBindRetry(
      async () => {
        calls += 1;
        return "server";
      },
      { sleep: async () => {} },
    );
    expect(ok).toBe("server");
    expect(calls).toBe(1);
  });
  test("default sleep: retries on the real timer", async () => {
    let calls = 0;
    const ok = await startServerWithBindRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("in use"), { code: "EADDRINUSE" });
        return "server";
      },
      { retryMs: 1 },
    );
    expect(ok).toBe("server");
    expect(calls).toBe(2);
  });
  test("retries EADDRINUSE until success", async () => {
    let calls = 0;
    const slept: number[] = [];
    const ok = await startServerWithBindRetry(
      async () => {
        calls += 1;
        if (calls <= 2) throw Object.assign(new Error("in use"), { code: "EADDRINUSE" });
        return "server";
      },
      {
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );
    expect(ok).toBe("server");
    expect(calls).toBe(3);
    expect(slept).toEqual([UPDATE_HANDOFF.BIND_RETRY_MS, UPDATE_HANDOFF.BIND_RETRY_MS]);
  });
  test("rethrows non-EADDRINUSE errors immediately", async () => {
    let calls = 0;
    await expect(
      startServerWithBindRetry(
        async () => {
          calls += 1;
          throw Object.assign(new Error("boom"), { code: "EACCES" });
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });
  test("gives up at the deadline and rethrows EADDRINUSE", async () => {
    let clock = 0;
    let calls = 0;
    await expect(
      startServerWithBindRetry(
        async () => {
          calls += 1;
          throw Object.assign(new Error("in use"), { code: "EADDRINUSE" });
        },
        {
          sleep: async (ms) => {
            clock += ms;
          },
          now: () => clock,
          deadlineMs: 600,
          retryMs: 250,
        },
      ),
    ).rejects.toThrow("in use");
    expect(calls).toBe(3); // 0, 250, 500 < 600
  });
});

describe("performHandoff", () => {
  test("fails fast when the replacement cannot spawn; the listener is kept", async () => {
    const h = handoffHarness({
      spawnReplacement: () => ({ pid: undefined, onExit: () => {}, isAlive: () => false }),
    });
    expect(await performHandoff(h.seams, request())).toBe("failed");
    expect(h.log).not.toContain("stop");
    expect(h.log).not.toContain("recover");
    expect(h.states.at(-1)?.state).toBe("failed");
    expect(h.states.at(-1)?.failure).toBe("replacement spawn failed");
  });
  test("never rejects: a throwing spawnReplacement reports failed", async () => {
    const h = handoffHarness();
    h.seams.spawnReplacement = () => {
      throw new Error("spawn boom");
    };
    expect(await performHandoff(h.seams, request())).toBe("failed");
    expect(h.log).not.toContain("recover");
    expect(h.states.at(-1)?.failure).toContain("spawn boom");
  });
  test("never rejects: a throwing stopServer reports failed without recovery", async () => {
    const h = handoffHarness();
    h.seams.stopServer = async () => {
      throw new Error("stop boom");
    };
    expect(await performHandoff(h.seams, request())).toBe("failed");
    expect(h.log).not.toContain("recover"); // listener state unknown → no rebind attempt
    expect(h.states.at(-1)?.failure).toContain("stop boom");
  });
  test("never rejects: a throwing recoverServer still reports failed", async () => {
    const h = handoffHarness();
    let called = false;
    h.seams.recoverServer = async () => {
      called = true;
      throw new Error("recover boom");
    };
    expect(await performHandoff(h.seams, request())).toBe("failed"); // timeout path, recovery best-effort
    expect(called).toBe(true); // recovery must be ATTEMPTED, and its throw contained
    expect(h.states.at(-1)?.failure).toBe("replacement did not take over in time");
  });
  test("never rejects: a throwing writeState is contained", async () => {
    const h = handoffHarness();
    h.seams.writeState = () => {
      throw new Error("state boom");
    };
    expect(await performHandoff(h.seams, request())).toBe("failed");
    expect(h.log).not.toContain("recover");
  });
  test("fails before stopping the listener when the replacement exits during grace", async () => {
    const h = handoffHarness();
    h.seams.sleep = async (ms) => {
      h.fireReplacementExit();
      h.advance(ms);
    };
    expect(await performHandoff(h.seams, request())).toBe("failed");
    expect(h.log).not.toContain("stop");
    expect(h.log).not.toContain("recover");
    expect(h.states.at(-1)?.failure).toBe("replacement exited before takeover");
  });
  test("fails after stopping and recovers when the replacement never takes over", async () => {
    const h = handoffHarness();
    expect(await performHandoff(h.seams, request())).toBe("failed");
    expect(h.log).toContain("stop");
    expect(h.log).toContain("recover");
    expect(h.states.at(-1)?.failure).toBe("replacement did not take over in time");
  });
  test("drains when the replacement publishes the port with its pid", async () => {
    const h = handoffHarness();
    let reads = 0;
    h.seams.readDiscovery = () => {
      reads += 1;
      return reads >= 2 ? { pid: 4242, app_version: "0.21.0" } : null;
    };
    expect(await performHandoff(h.seams, request())).toBe("drained");
    expect(h.log).toContain("stop");
    expect(h.log).not.toContain("recover");
    expect(h.states.map((s) => s.state)).toEqual([
      UPDATE_HANDOFF_STATE.REPLACEMENT_STARTED,
      UPDATE_HANDOFF_STATE.DRAINED,
    ]);
    expect(h.states.at(-1)?.replacement_pid).toBe(4242);
  });
  test("a replacement that dies right after publishing discovery never drains us", async () => {
    const h = handoffHarness();
    h.seams.readDiscovery = () => ({ pid: 4242, app_version: "0.21.0" }); // confirmed
    h.setReplacementAlive(false); // but the OS says it is already gone
    expect(await performHandoff(h.seams, request())).toBe("failed");
    expect(h.log).toContain("recover"); // dead replacement freed the port; we rebind
    expect(h.states.map((s) => s.state)).not.toContain(UPDATE_HANDOFF_STATE.DRAINED);
    expect(h.states.at(-1)?.failure).toBe("replacement did not take over in time");
  });
  test("an exit delivered during the poll wait wins over a confirmed discovery", async () => {
    const h = handoffHarness();
    let reads = 0;
    h.seams.readDiscovery = () => {
      reads += 1;
      return reads >= 2 ? { pid: 4242, app_version: "0.21.0" } : null;
    };
    let sleeps = 0;
    h.seams.sleep = async (ms) => {
      h.advance(ms);
      sleeps += 1;
      if (sleeps === 2) h.fireReplacementExit(); // dies while we wait for the next poll (after stop)
    };
    expect(await performHandoff(h.seams, request())).toBe("failed"); // never drains a dead replacement
    expect(h.log).toContain("recover");
    expect(h.states.map((s) => s.state)).not.toContain(UPDATE_HANDOFF_STATE.DRAINED);
  });
  test("a throwing DRAINED writeState still drains (state file is advisory)", async () => {
    const h = handoffHarness();
    h.seams.readDiscovery = () => ({ pid: 4242, app_version: "0.21.0" });
    h.seams.writeState = (s) => {
      if (s.state === UPDATE_HANDOFF_STATE.DRAINED) throw new Error("state boom");
      h.states.push(s);
    };
    expect(await performHandoff(h.seams, request())).toBe("drained");
    expect(h.log).not.toContain("recover"); // the replacement owns the port; no zombie recovery
  });
});

describe("startUpdateHandoffWatcher", () => {
  function watcherHarness(
    over: Partial<
      HandoffSeams & {
        readRequest: () => UpdateRequestV1 | null;
        clearRequest: (requestId: string) => void;
        onOutcome: (o: string) => void;
        outFn: (m: string) => void;
        pollMs?: number;
      }
    > = {},
  ) {
    const h = handoffHarness(over);
    const clearedIds: string[] = [];
    const outcomes: string[] = [];
    const messages: string[] = [];
    let pending: UpdateRequestV1 | null = null;
    // Shared seams object, not a spread copy: the watcher holds the reference
    // it is given and reads properties live at tick time. Only `runs one
    // handoff and clears the request` depends on its post-construction
    // `w.h.seams.readDiscovery = …` stub reaching the running watcher.
    const watcher = startUpdateHandoffWatcher(
      Object.assign(
        h.seams,
        {
          readRequest: () => pending,
          // Mirrors the production identity guard: only the consumed request
          // is removed; a newer one written mid-flight survives.
          clearRequest: (requestId: string) => {
            clearedIds.push(requestId);
            if (pending !== null && pending.request_id !== requestId) return;
            pending = null;
          },
          onOutcome: (o: string) => {
            outcomes.push(o);
          },
          outFn: (m: string) => {
            messages.push(m);
          },
          pollMs: 1_000_000, // interval stays parked; tests drive tick()
        },
        over,
      ),
    );
    return {
      h,
      watcher,
      clearedIds,
      outcomes,
      messages,
      pendingRequest: () => pending,
      setRequest: (r: UpdateRequestV1) => {
        pending = r;
      },
    };
  }

  test("does nothing without a request", async () => {
    const w = watcherHarness();
    await w.watcher.tick();
    expect(w.clearedIds.length).toBe(0);
  });
  test("consumes a non-actionable request without handoff", async () => {
    const w = watcherHarness();
    w.setRequest(request({ target_version: "0.20.0" }));
    await w.watcher.tick();
    expect(w.clearedIds).toEqual(["req-1"]); // clears by the consumed id
    expect(w.outcomes.length).toBe(0);
    expect(w.messages[0]).toContain("not newer");
    // No state write: a non-actionable request must never overwrite an outcome.
    expect(w.h.states.length).toBe(0);
  });
  test("a throwing swap still clears the request and reports the outcome", async () => {
    const w = watcherHarness({
      stopServer: async () => {
        throw new Error("socket boom");
      },
    });
    w.setRequest(request());
    await w.watcher.tick();
    expect(w.outcomes).toEqual([UPDATE_HANDOFF_STATE.FAILED]);
    expect(w.clearedIds).toEqual(["req-1"]);
  });
  test("a newer request written mid-flight survives the older clear", async () => {
    const w = watcherHarness();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let firstSleep = true;
    w.h.seams.sleep = async (ms) => {
      if (firstSleep) {
        firstSleep = false;
        w.setRequest(request({ request_id: "req-2", target_version: "0.22.0" }));
        await gate; // hold the handoff so req-2 lands mid-flight
      }
      w.h.advance(ms);
    };
    w.setRequest(request()); // req-1 consumed by this tick
    const first = w.watcher.tick();
    await Promise.resolve();
    release?.();
    await first;
    expect(w.clearedIds).toEqual(["req-1"]); // clear attempted with the CONSUMED id
    expect(w.pendingRequest()?.request_id).toBe("req-2"); // and req-2 is intact
    // The next tick must still be able to process req-2.
    let reads = 0;
    w.h.seams.readDiscovery = () => (++reads >= 2 ? { pid: 4242, app_version: "0.22.0" } : null);
    await w.watcher.tick();
    expect(w.outcomes.at(-1)).toBe(UPDATE_HANDOFF_STATE.DRAINED);
    expect(w.clearedIds).toEqual(["req-1", "req-2"]);
  });
  test("an error while clearing the request is contained (tick catch arm)", async () => {
    const w = watcherHarness({
      clearRequest: () => {
        throw new Error("clear boom");
      },
    });
    let reads = 0;
    w.h.seams.readDiscovery = () => (++reads >= 2 ? { pid: 4242, app_version: "0.21.0" } : null);
    w.setRequest(request());
    await w.watcher.tick(); // must resolve, never reject
    expect(w.outcomes).toEqual([]); // onOutcome unreachable when the clear throws
    expect(w.messages.some((m) => m.includes("clear boom"))).toBe(true);
  });
  test("a throwing readRequest is contained: tick resolves, no state, no outcome", async () => {
    const w = watcherHarness({
      readRequest: () => {
        throw new Error("read boom");
      },
    });
    await w.watcher.tick(); // must resolve, never reject
    expect(w.h.states.length).toBe(0);
    expect(w.outcomes).toEqual([]);
    expect(w.clearedIds.length).toBe(0);
    expect(w.messages.some((m) => m.includes("read boom"))).toBe(true);
  });
  test("runs one handoff and clears the request", async () => {
    const w = watcherHarness();
    let reads = 0;
    w.h.seams.readDiscovery = () => (++reads >= 2 ? { pid: 4242, app_version: "0.21.0" } : null);
    w.setRequest(request());
    await w.watcher.tick();
    expect(w.outcomes).toEqual([UPDATE_HANDOFF_STATE.DRAINED]);
    expect(w.clearedIds).toEqual(["req-1"]);
    await w.watcher.tick(); // nothing pending anymore
    expect(w.outcomes.length).toBe(1);
  });
  test("single-flight: a slow handoff blocks a second tick", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let firstCall = true;
    const w = watcherHarness({
      sleep: async (ms: number) => {
        if (firstCall) {
          firstCall = false;
          await gate; // park the first sleep (the replacement grace) until released
        }
        w.h.advance(ms); // keep the harness clock moving so the deadline terminates
      },
    });
    w.setRequest(request());
    const first = w.watcher.tick();
    await w.watcher.tick(); // must return immediately while first is in flight
    release?.();
    await first;
    expect(w.clearedIds.length).toBe(1);
    expect(w.outcomes).toEqual([UPDATE_HANDOFF_STATE.FAILED]);
  });
  test("single-flight re-arms: a second request is handled after a completed handoff", async () => {
    const w = watcherHarness();
    w.setRequest(request({ target_version: "0.21.0" }));
    await w.watcher.tick(); // first swap fails (no takeover) but completes
    w.setRequest(request({ request_id: "req-2", target_version: "0.22.0" }));
    await w.watcher.tick(); // must not be blocked by the first tick's flag
    expect(w.outcomes).toEqual([UPDATE_HANDOFF_STATE.FAILED, UPDATE_HANDOFF_STATE.FAILED]);
    expect(w.clearedIds.length).toBe(2);
    expect(w.h.states.at(-1)?.target_version).toBe("0.22.0");
  });
  test("the interval fires the tick", async () => {
    const w = watcherHarness({ pollMs: 5 });
    let reads = 0;
    w.h.seams.readDiscovery = () => (++reads >= 2 ? { pid: 4242, app_version: "0.21.0" } : null);
    w.setRequest(request());
    await Bun.sleep(50);
    w.watcher.stop();
    expect(w.clearedIds.length).toBeGreaterThanOrEqual(1);
  });
});
