import type { PublicStoredTraceEvent } from "../trace/types.js";
import type { ConversationListener, Unsubscribe } from "./types.js";

interface Subscriber {
  listener: ConversationListener;
  lastSeq: number;
  replaying: boolean;
  active: boolean;
  pending: PublicStoredTraceEvent[];
}

export class ConversationSubscribers {
  private readonly values = new Map<string, Set<Subscriber>>();

  notify(event: PublicStoredTraceEvent): void {
    const id = event.conversation_id as unknown as string;
    for (const subscriber of this.values.get(id) ?? []) {
      if (!subscriber.active) continue;
      if (subscriber.replaying) subscriber.pending.push(event);
      else if (event.seq > subscriber.lastSeq) {
        subscriber.lastSeq = event.seq;
        try {
          subscriber.listener(event);
        } catch (error) {
          void error;
        }
      }
    }
  }

  subscribe(
    id: string,
    listener: ConversationListener,
    replay: () => Promise<PublicStoredTraceEvent[] | null>,
    afterSeq: number,
  ): Unsubscribe {
    const subscriber: Subscriber = {
      listener,
      lastSeq: afterSeq,
      replaying: true,
      active: true,
      pending: [],
    };
    const set = this.values.get(id) ?? new Set<Subscriber>();
    set.add(subscriber);
    this.values.set(id, set);
    void replay().then(
      (events) => {
        if (!subscriber.active) return;
        subscriber.pending = Array.from(events ?? []).concat(subscriber.pending);
        while (subscriber.active && subscriber.pending.length) {
          const merged = subscriber.pending.sort((a, b) => a.seq - b.seq);
          subscriber.pending = [];
          for (const event of merged) {
            if (!subscriber.active) break;
            if (event.seq <= subscriber.lastSeq) continue;
            subscriber.lastSeq = event.seq;
            try {
              listener(event);
            } catch (error) {
              void error;
            }
          }
        }
        subscriber.replaying = false;
      },
      () => {
        subscriber.active = false;
        subscriber.pending = [];
        subscriber.replaying = false;
        set.delete(subscriber);
        if (!set.size) this.values.delete(id);
      },
    );
    return () => {
      subscriber.active = false;
      set.delete(subscriber);
      if (!set.size) this.values.delete(id);
    };
  }
}
