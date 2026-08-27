import { type Ref, watch } from "vue";

export class HomeMessageQueueInterruptedAdmissions<Entry> {
  private readonly entriesByRoot = new Map<string, Entry[]>();
  private readonly epochByRoot = new Map<string, number>();
  private readonly blockerByRoot = new Map<string, string>();

  retain(root: string, entries: Entry[], compare: (left: Entry, right: Entry) => number): void {
    if (!entries.length) return;
    const retained = [...(this.entriesByRoot.get(root) ?? []), ...entries].sort(compare);
    this.entriesByRoot.set(root, retained);
  }

  count(root: string): number {
    return this.entriesByRoot.get(root)?.length ?? 0;
  }

  list(root: string): readonly Entry[] {
    return [...(this.entriesByRoot.get(root) ?? [])];
  }

  claim(root: string): Entry | undefined {
    const retained = this.entriesByRoot.get(root);
    const entry = retained?.shift();
    if (!retained?.length) this.entriesByRoot.delete(root);
    return entry;
  }

  blockedBy(root: string): string | null {
    return this.blockerByRoot.get(root) ?? null;
  }

  block(root: string, idempotencyKey: string): void {
    this.blockerByRoot.set(root, idempotencyKey);
  }

  releaseBlocker(root: string, idempotencyKey: string): boolean {
    if (this.blockerByRoot.get(root) !== idempotencyKey) return false;
    this.blockerByRoot.delete(root);
    return true;
  }

  watchOffline(
    online: Ref<boolean>,
    activeRootId: Ref<string | null>,
    interrupt: (root: string) => void,
  ): () => void {
    return watch(
      online,
      (available) => {
        const root = activeRootId.value;
        if (!available && root) interrupt(root);
      },
      { flush: "sync" },
    );
  }

  epoch(root: string): number {
    return this.epochByRoot.get(root) ?? 0;
  }

  invalidate(root: string): void {
    this.epochByRoot.set(root, this.epoch(root) + 1);
  }

  begin(root: string): number {
    this.invalidate(root);
    return this.epoch(root);
  }

  clear(): void {
    this.entriesByRoot.clear();
    this.epochByRoot.clear();
    this.blockerByRoot.clear();
  }
}
