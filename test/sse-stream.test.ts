import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLogbus, installLogbus, out, setLogbusForTests } from "../src/logbus.js";
import type { Logbus } from "../src/logbus.js";
import { startServer } from "../src/server.js";

type DurableEvent = { seq: number; text: string };

async function waitForDurableSequence(
  bus: Pick<Logbus, "currentFile">,
  target: number,
  seams: {
    read?: (path: string) => string;
    now?: () => number;
    pause?: (ms: number) => Promise<void>;
  } = {},
): Promise<DurableEvent[]> {
  const read = seams.read ?? ((path: string) => readFileSync(path, "utf8"));
  const now = seams.now ?? Date.now;
  const pause = seams.pause ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + 6_000;
  let lastObserved: number | undefined;
  while (true) {
    const events = read(bus.currentFile())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as DurableEvent);
    for (const event of events)
      if (lastObserved === undefined || event.seq > lastObserved) lastObserved = event.seq;
    if (events.some(({ seq }) => seq === target)) return events;
    if (now() >= deadline)
      throw new Error(
        `durable sequence timeout: target=${target} lastObserved=${lastObserved ?? "none"}`,
      );
    await pause(20);
  }
}

describe("M3 SSE stream endpoint", () => {
  let dir: string;
  let cleanupDir: () => void;
  let previousBus: Logbus | null;
  let ownedBus: Logbus;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "vf-sse-"));
    cleanupDir = () => rmSync(dir, { recursive: true, force: true });
    previousBus = getLogbus();
    ownedBus = installLogbus({ dir });
  });

  afterAll(async () => {
    try {
      await ownedBus.close();
    } finally {
      setLogbusForTests(previousBus);
      cleanupDir();
    }
  });

  test("waits for exact durable sequence across delayed snapshots and reports bounded timeout", async () => {
    const snapshots = [
      '{"seq":41,"text":"prior"}\n',
      '{"seq":41,"text":"prior"}\n{"seq":42,"text":"target"}\n',
    ];
    let reads = 0;
    const events = await waitForDurableSequence({ currentFile: () => "unused" }, 42, {
      read: () => snapshots[Math.min(reads++, snapshots.length - 1)] ?? "",
      now: () => 0,
      pause: async () => {},
    });
    expect(snapshots[0]).not.toContain('"seq":42');
    expect(reads).toBeGreaterThan(1);
    expect(events).toContainEqual({ seq: 42, text: "target" });

    let now = 0;
    await expect(
      waitForDurableSequence({ currentFile: () => "unused" }, 99, {
        read: () => '{"seq":41,"text":"prior"}\n',
        now: () => now,
        pause: async (ms) => {
          now += ms;
        },
      }),
    ).rejects.toThrow("durable sequence timeout: target=99 lastObserved=41");
  });

  test("subscribe receives events synchronously; unsubscribe stops them", () => {
    const bus = getLogbus();
    if (!bus) throw new Error("bus must be installed");
    const events: Array<{ channel: string; text: string }> = [];
    const unsub = bus.subscribe((ev) => events.push({ channel: ev.channel, text: ev.text }));
    out("vf", "hello");
    out("engine-stderr", "error msg", { level: "warn" });
    expect(events).toHaveLength(2);
    expect(events[0]?.channel).toBe("vf");
    expect(events[0]?.text).toBe("hello");
    expect(events[1]?.channel).toBe("engine-stderr");
    unsub();
  });

  test("unsubscribe prevents further events from reaching callback", () => {
    const bus = getLogbus();
    if (!bus) throw new Error("bus must be installed");
    const events: string[] = [];
    const unsub = bus.subscribe((ev) => events.push(ev.text));
    out("vf", "a");
    unsub();
    out("vf", "b");
    expect(events).toEqual(["a"]);
  });

  test("/api/logs/recent returns events filtered by since seq", async () => {
    const marker = `v8.24-${crypto.randomUUID()}`;
    const captured: DurableEvent[] = [];
    const unsubscribe = ownedBus.subscribe((event) => {
      if (event.text.startsWith(marker)) captured.push({ seq: event.seq, text: event.text });
    });
    let server: Awaited<ReturnType<typeof startServer>>["server"] | undefined;
    try {
      out("vf", `${marker}-recent-one`);
      out("vf", `${marker}-recent-two`);
      out("vf", `${marker}-recent-three`);
      expect(captured.map(({ text }) => text)).toEqual([
        `${marker}-recent-one`,
        `${marker}-recent-two`,
        `${marker}-recent-three`,
      ]);
      const recentTwo = captured[1];
      const recentThree = captured[2];
      if (!recentTwo || !recentThree) throw new Error("marker events not captured");
      await waitForDurableSequence(ownedBus, recentThree.seq);

      const started = await startServer(0);
      server = started.server;
      const resp = await fetch(`${started.url}/api/logs/recent?since=${recentTwo.seq}&limit=10`);
      expect(resp.status).toBe(200);
      const data = (await resp.json()) as { events: DurableEvent[] };
      expect(data.events.map(({ seq, text }) => ({ seq, text }))).toEqual([recentTwo, recentThree]);
    } finally {
      unsubscribe();
      server?.stop();
    }
  });

  test("SSE endpoint sends initial comment with correct headers", async () => {
    const { server, url } = await startServer(0);
    try {
      // Use a timeout signal so the SSE connection closes cleanly when the test ends
      const resp = await fetch(`${url}/api/logs/stream`, {
        signal: AbortSignal.timeout(500),
      });
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toBe("text/event-stream");
      expect(resp.headers.get("cache-control")).toBe("no-cache");

      const body = resp.body;
      expect(body).not.toBeNull();
      const reader = (body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      const { value, done } = await reader.read();
      const text = decoder.decode(value, { stream: true });
      expect(text).toContain(": vibeflow-logs-1");
      reader.cancel();
    } catch {
      // The AbortSignal.timeout fires after 500ms; if it fires before we finish
      // reading, the fetch rejects — that's acceptable for this test
    } finally {
      // Give the abort signal time to close the connection before closing the server
      await new Promise((r) => setTimeout(r, 100));
      server.stop();
    }
  });

  test("SSE stream includes catch-up events from current.log", async () => {
    // Write events before connecting to test catch-up
    out("vf", "catchup-one");

    // Wait for async file writes to complete
    await new Promise((r) => setTimeout(r, 100));

    const { server, url } = await startServer(0);
    try {
      const resp = await fetch(`${url}/api/logs/stream`, {
        signal: AbortSignal.timeout(500),
      });
      const body = resp.body;
      expect(body).not.toBeNull();
      const reader = (body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();

      // Read first chunk — should contain initial comment + catch-up events
      const { value, done } = await reader.read();
      const text = decoder.decode(value, { stream: true });
      expect(text).toContain(": vibeflow-logs-1");
      expect(text).toContain("catchup-one");
      reader.cancel();
    } catch {
      // Timeout acceptable — check headers only
    } finally {
      await new Promise((r) => setTimeout(r, 100));
      server.stop();
    }
  });

  test("SSE stream delivers events live after subscription", async () => {
    const { server, url } = await startServer(0);
    try {
      const resp = await fetch(`${url}/api/logs/stream`, {
        signal: AbortSignal.timeout(2000),
      });
      const body = resp.body;
      expect(body).not.toBeNull();
      const reader = (body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();

      // Read past the initial comment
      await reader.read();

      // Write a live event — the SSE subscriber should receive it synchronously
      out("vf", "live-event");

      // Allow the response stream buffer to flush
      await new Promise((r) => setTimeout(r, 100));

      // Read the next chunk — should contain the live event
      const { value, done } = await reader.read();
      const text = decoder.decode(value, { stream: true });
      expect(text).toContain("event: log");
      expect(text).toContain("live-event");

      reader.cancel();
    } catch {
      // Timeout acceptable
    } finally {
      await new Promise((r) => setTimeout(r, 200));
      server.stop();
    }
  });

  test("old /events endpoint still works for backward compat", async () => {
    const { server, url } = await startServer(0);
    try {
      const resp = await fetch(`${url}/events`, {
        signal: AbortSignal.timeout(500),
      });
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toBe("text/event-stream");
    } catch {
      // Timeout acceptable — headers arrived before that
    } finally {
      await new Promise((r) => setTimeout(r, 100));
      server.stop();
    }
  });

  // #525: read live SSE chunks until `marker` appears or a soft deadline.
  // Races the read against a timeout so a missing marker returns partial text
  // (the assertions then fail loudly) instead of hanging or throwing an abort.
  //
  // #535: keep a SINGLE pending read across ticks. Issuing a fresh reader.read()
  // every loop orphaned the prior one; when its chunk landed, that orphan
  // consumed it and its value was discarded → the marker chunk was silently
  // lost → a spurious toContain() failure. A dedicated TICK sentinel also keeps
  // a real end-of-stream (done:true) distinct from a timeout tick, so EOF breaks
  // instead of spinning to the deadline.
  const TICK = Symbol("tick");
  async function drainUntil(
    reader: { read(): Promise<{ value?: Uint8Array; done: boolean }> },
    marker: string,
  ): Promise<string> {
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 2000;
    let pending: Promise<{ value?: Uint8Array; done: boolean }> | null = null;
    while (Date.now() < deadline && !text.includes(marker)) {
      if (!pending) pending = reader.read();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<typeof TICK>((r) => {
        timer = setTimeout(() => r(TICK), 300);
      });
      const res = await Promise.race([pending, timeout]);
      clearTimeout(timer); // don't leave a 300ms tick timer dangling when the read wins
      if (res === TICK) continue; // soft timeout — reuse `pending`, retry until deadline
      pending = null; // read settled — a fresh one may be issued next loop
      if (res.value) text += decoder.decode(res.value, { stream: true });
      if (res.done) break;
    }
    return text;
  }

  test("drainUntil keeps a chunk that lands after a timeout tick (#535)", async () => {
    const marker = "u535-late-chunk";
    const chunk = new TextEncoder().encode(`x ${marker} y`);
    let reads = 0;
    const reader = {
      read(): Promise<{ value?: Uint8Array; done: boolean }> {
        reads++;
        // First read resolves AFTER the 300ms internal tick — the old
        // fresh-read-per-loop code orphaned it and dropped this chunk.
        if (reads === 1)
          return new Promise((r) => setTimeout(() => r({ value: chunk, done: false }), 350));
        // A second read must NOT be issued while the first is still pending.
        return new Promise(() => {}); // never resolves
      },
    };
    const text = await drainUntil(reader, marker);
    expect(text).toContain(marker); // chunk survived the tick
    expect(reads).toBe(1); // single pending read reused, not re-issued
  });

  test("drainUntil keeps a final chunk delivered WITH done:true (#535 EOF path)", async () => {
    // EOF that carries the last chunk (value + done:true in one read). The loop
    // must append the value THEN break — not drop it on the done branch.
    const marker = "u535-eof-chunk";
    let reads = 0;
    const reader = {
      read(): Promise<{ value?: Uint8Array; done: boolean }> {
        reads++;
        if (reads === 1)
          return Promise.resolve({ value: new TextEncoder().encode(marker), done: true });
        return Promise.resolve({ value: undefined, done: true });
      },
    };
    const text = await drainUntil(reader, marker);
    expect(text).toContain(marker); // final chunk not lost on EOF
    expect(reads).toBe(1); // broke on done:true, no extra read
  });

  test("SSE ?unit=A streams only unit-A events live (#525)", async () => {
    const { server, url } = await startServer(0);
    let text = "";
    try {
      const resp = await fetch(`${url}/api/logs/stream?unit=A`, {
        signal: AbortSignal.timeout(3000),
      });
      const reader = (resp.body as ReadableStream<Uint8Array>).getReader();
      // Prime: block on the initial comment chunk so the SSE start()/subscribe
      // has run before we emit — otherwise the live events miss the subscriber.
      await reader.read();

      out("engine-stdout", "u525-B-live", { level: "info", unit: "B" });
      out("vf", "u525-novf-live");
      out("engine-stdout", "u525-A-live", { level: "info", unit: "A" });
      await new Promise((r) => setTimeout(r, 100));

      text = await drainUntil(reader, "u525-A-live");
      reader.cancel();
    } catch (e) {
      // Only a stream timeout/abort is acceptable — a broken filter must NOT be
      // swallowed here (else the assertions below can never fail the test).
      if (!(e instanceof DOMException)) throw e;
    } finally {
      await new Promise((r) => setTimeout(r, 200));
      server.stop();
    }
    expect(text).toContain("u525-A-live");
    expect(text).not.toContain("u525-B-live");
    expect(text).not.toContain("u525-novf-live");
  });

  test("SSE with no ?unit= streams every event (back-compat, #525)", async () => {
    const { server, url } = await startServer(0);
    let text = "";
    try {
      const resp = await fetch(`${url}/api/logs/stream`, {
        signal: AbortSignal.timeout(3000),
      });
      const reader = (resp.body as ReadableStream<Uint8Array>).getReader();
      // Prime: block on the initial comment so the subscribe is active first.
      await reader.read();

      out("engine-stdout", "u525-all-unit", { level: "info", unit: "Z" });
      out("vf", "u525-all-novf");
      await new Promise((r) => setTimeout(r, 100));

      text = await drainUntil(reader, "u525-all-novf");
      reader.cancel();
    } catch (e) {
      if (!(e instanceof DOMException)) throw e;
    } finally {
      await new Promise((r) => setTimeout(r, 200));
      server.stop();
    }
    expect(text).toContain("u525-all-unit");
    expect(text).toContain("u525-all-novf");
  });
});
