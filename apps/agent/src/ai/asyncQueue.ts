/**
 * Push-based async iterable.
 * Consumers `for await` over it; producers call `push()` to enqueue values
 * and `end()` to signal completion.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolve: (() => void) | null = null;
  private done = false;

  /** Enqueue a value. No-op if end() was already called. */
  push(value: T): void {
    if (this.done) return;
    this.queue.push(value);
    if (this.resolve) {
      this.resolve();
      this.resolve = null;
    }
  }

  /** Signal that no more values will be pushed. */
  end(): void {
    this.done = true;
    if (this.resolve) {
      this.resolve();
      this.resolve = null;
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => { this.resolve = r; });
    }
  }
}
