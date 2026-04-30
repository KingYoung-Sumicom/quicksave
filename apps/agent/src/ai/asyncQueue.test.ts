// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
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

  it('waits for values when consumed before push', async () => {
    const q = new AsyncQueue<string>();

    // Start consuming in the background
    const collected: string[] = [];
    const consumer = (async () => {
      for await (const v of q) {
        collected.push(v);
      }
    })();

    // Push values after a microtask delay
    await Promise.resolve();
    q.push('a');
    await Promise.resolve();
    q.push('b');
    await Promise.resolve();
    q.end();

    await consumer;
    expect(collected).toEqual(['a', 'b']);
  });

  it('end() terminates the iterator', async () => {
    const q = new AsyncQueue<number>();
    q.end();

    const results: number[] = [];
    for await (const v of q) {
      results.push(v);
    }
    expect(results).toEqual([]);
  });

  it('ignores pushes after end()', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.end();
    q.push(2); // should be ignored

    const results: number[] = [];
    for await (const v of q) {
      results.push(v);
    }
    expect(results).toEqual([1]);
  });
});
