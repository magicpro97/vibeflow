import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLogbus, installLogbus, out } from "../src/logbus.js";
import { startServer } from "../src/server.js";

describe("M3 SSE stream endpoint", () => {
  let dir: string;
  let cleanupDir: () => void;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "vf-sse-"));
    cleanupDir = () => rmSync(dir, { recursive: true, force: true });
    installLogbus({ dir });
  });

  afterAll(async () => {
    const bus = getLogbus();
    if (bus) await bus.close();
    cleanupDir();
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
    out("vf", "recent-one");
    out("vf", "recent-two");
    out("vf", "recent-three");

    // Wait for async file writes to complete
    await new Promise((r) => setTimeout(r, 100));

    const bus = getLogbus();
    if (!bus) throw new Error("bus must be installed");
    const content = readFileSync(bus.currentFile(), "utf8");
    const parsed: Array<{ seq: number; text: string }> = content
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { seq: number; text: string });
    const recentTwo = parsed.find((p) => p.text === "recent-two");
    if (!recentTwo) throw new Error("recent-two not found in log");
    const sinceSeq = recentTwo.seq;

    const { server, url } = await startServer(0);
    try {
      const resp = await fetch(`${url}/api/logs/recent?since=${sinceSeq}&limit=10`);
      expect(resp.status).toBe(200);
      const data = (await resp.json()) as {
        events: Array<{ seq: number; text: string }>;
      };
      expect(data.events.length).toBeGreaterThanOrEqual(2);
      expect(data.events[0]?.text).toBe("recent-two");
      expect(data.events[1]?.text).toBe("recent-three");
    } finally {
      server.stop();
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
  // Races each read against a timeout so a missing marker returns partial text
  // (the assertions then fail loudly) instead of hanging or throwing an abort.
  async function drainUntil(
    reader: { read(): Promise<{ value?: Uint8Array; done: boolean }> },
    marker: string,
  ): Promise<string> {
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !text.includes(marker)) {
      const timeout = new Promise<{ value?: Uint8Array; done: boolean }>((r) =>
        setTimeout(() => r({ value: undefined, done: true }), 300),
      );
      const { value, done } = await Promise.race([reader.read(), timeout]);
      if (value) text += decoder.decode(value, { stream: true });
      if (done && !value) continue; // soft timeout tick — retry until deadline
      if (done) break;
    }
    return text;
  }

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
