/** Coalesces only byte-identical revision requests in this process. */
export class ConversationRevisionRequestSingleFlightV1<T> {
  private readonly active = new Map<string, Promise<T>>();

  run(key: string, start: () => Promise<T>): Promise<T> {
    const existing = this.active.get(key);
    if (existing) return existing;
    const running = start();
    this.active.set(key, running);
    const clear = () => {
      if (this.active.get(key) === running) this.active.delete(key);
    };
    void running.then(clear, clear);
    return running;
  }
}
