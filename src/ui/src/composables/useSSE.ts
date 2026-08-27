import { onUnmounted, ref } from "vue";
import { UI_LAN_TOKEN_HEADER } from "../../../core/ui-cli-contract.js";
import { decodeLogEvent } from "../../../logbus/types.js";
import { LOG_SSE_EVENT } from "../../../orchestrator/conversation/conversation-sse-contract.js";
import { readUiPageToken, withUiEventSourceToken } from "../browser-ui-token.js";
import type { LogEvent } from "../types.js";

export function useSSE(url: string, maxLines = 500) {
  const pageToken = readUiPageToken();
  const logs = ref<LogEvent[]>([]);
  const error = ref<string | null>(null);
  // ponytail: set for O(1) dedup between catchup and live SSE events
  const seen = new Set<number>();

  let es: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = 1000; // ms — doubles on each failure, caps at 30 s
  let destroyed = false;
  /** Events buffered while catchup is in flight — flushed after catchup completes */
  let catchupPending = true;
  const liveBuffer: LogEvent[] = [];
  const fetchHeaders = pageToken ? { [UI_LAN_TOKEN_HEADER]: pageToken } : undefined;

  function pushSorted(event: LogEvent) {
    if (seen.has(event.seq)) return;
    seen.add(event.seq);
    // Insert in seq order so mixed catchup + live arrivals stay sorted
    let insertAt = logs.value.length;
    for (let i = logs.value.length - 1; i >= 0; i--) {
      if ((logs.value[i]?.seq ?? 0) <= event.seq) break;
      insertAt = i;
    }
    logs.value.splice(insertAt, 0, event);
    if (logs.value.length > maxLines) {
      const removed = logs.value.shift();
      if (removed) seen.delete(removed.seq);
    }
  }

  function push(event: LogEvent) {
    if (catchupPending) {
      // Buffer live events until catchup completes so they arrive in seq order
      liveBuffer.push(event);
      return;
    }
    pushSorted(event);
  }

  async function catchup() {
    try {
      // Use session start seq so we don't show logs from previous server runs
      let since = 0;
      try {
        const sess = await fetch("/api/logs/session", { headers: fetchHeaders });
        if (sess.ok) {
          const { sessionStartSeq } = (await sess.json()) as { sessionStartSeq?: number };
          since = sessionStartSeq ?? 0;
        }
      } catch {
        /* fall back to since=0 */
      }
      const res = await fetch(`/api/logs/recent?since=${since}&limit=200`, {
        headers: fetchHeaders,
      });
      if (res.ok) {
        const payload: unknown = await res.json();
        if (
          payload &&
          typeof payload === "object" &&
          Array.isArray((payload as { events?: unknown }).events)
        )
          for (const value of (payload as { events: unknown[] }).events) {
            const ev = decodeLogEvent(value);
            if (ev) pushSorted(ev);
          }
      }
    } catch (_e) {
      // catchup failed — live SSE still works
    } finally {
      catchupPending = false;
      // If destroyed while catchup was in flight, discard the buffer to
      // avoid writing to a reactive ref after unmount (Vue readonly warning).
      if (!destroyed) {
        liveBuffer.sort((a, b) => a.seq - b.seq);
        for (const ev of liveBuffer) pushSorted(ev);
      }
      liveBuffer.length = 0;
    }
  }

  function connect() {
    if (destroyed) return;
    es = new EventSource(withUiEventSourceToken(url, pageToken));

    es.addEventListener(LOG_SSE_EVENT.LOG, (e) => {
      // Reset backoff only on actual data events (not just open)
      retryDelay = 1000;
      error.value = null;
      try {
        const event = decodeLogEvent(JSON.parse((e as MessageEvent).data));
        if (event) push(event);
      } catch (_e) {
        // malformed SSE frame — skip silently
      }
    });

    es.addEventListener("open", () => {
      error.value = null;
    });

    es.onerror = () => {
      es?.close();
      es = null;
      if (destroyed) return;
      // Guard: don't schedule another retry if one is already pending
      if (retryTimer !== null) return;
      error.value = "SSE disconnected — reconnecting…";
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!destroyed) connect();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30_000);
    };
  }

  catchup();
  connect();

  function clearLogs() {
    logs.value = [];
    seen.clear();
    catchupPending = true;
    catchup();
  }

  onUnmounted(() => {
    destroyed = true;
    es?.close();
    if (retryTimer !== null) clearTimeout(retryTimer);
  });

  return { logs, error, clearLogs };
}
