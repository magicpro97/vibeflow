export class HomeMessageQueueTransportSequencer {
  private readonly tails = new Map<string, Promise<void>>();

  schedule(root: string, run: () => Promise<boolean>): Promise<boolean> {
    const prior = this.tails.get(root);
    const result = prior ? prior.then(run) : run();
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(root, tail);
    return result.then(
      (value) => {
        if (this.tails.get(root) === tail) this.tails.delete(root);
        return value;
      },
      (error: unknown) => {
        if (this.tails.get(root) === tail) this.tails.delete(root);
        throw error;
      },
    );
  }

  detach(root: string): void {
    this.tails.delete(root);
  }

  clear(): void {
    this.tails.clear();
  }
}
