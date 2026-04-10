import { describe, it, expect } from 'vitest';
import { AsyncQueue } from './asyncQueue.js';

describe('AsyncQueue', () => {
  it('yields pushed values in order', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);
    q.end();

    const results: number[] = [];
    for await (const v of q) {
      results.push(v);
    }
    expect(results).toEqual([1, 2, 3]);
  });

  it('waits for values when consumed before pushed', async () => {
    const q = new AsyncQueue<string>();
    const results: string[] = [];

    const consumer = (async () => {
      for await (const v of q) {
        results.push(v);
      }
    })();

    // Push after consumer starts waiting
    q.push('a');
    q.push('b');
    q.end();
    await consumer;

    expect(results).toEqual(['a', 'b']);
  });

  it('stops iterating after end() is called', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.end();
    q.push(2); // should be ignored after end

    const results: number[] = [];
    for await (const v of q) {
      results.push(v);
    }
    expect(results).toEqual([1]);
  });

  it('supports multiple sequential consumers via Symbol.asyncIterator', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);

    const iter = q[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first).toEqual({ value: 1, done: false });

    const second = await iter.next();
    expect(second).toEqual({ value: 2, done: false });

    q.end();
    const third = await iter.next();
    expect(third).toEqual({ value: undefined, done: true });
  });
});
