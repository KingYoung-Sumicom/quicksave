// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { TokenAccounting, makeBreakdown, makeUsage } from '../tokenAccounting.js';
import type { ThreadTokenUsageUpdatedNotification } from '../schema/generated/v2/ThreadTokenUsageUpdatedNotification.js';

function notification(
  turnId: string,
  lastIn: number,
  lastOut: number,
  totalIn: number,
  totalOut: number,
  totalCached = 0,
  threadId = 'thr_1',
): ThreadTokenUsageUpdatedNotification {
  return {
    threadId,
    turnId,
    tokenUsage: makeUsage(
      makeBreakdown(lastIn, lastOut),
      makeBreakdown(totalIn, totalOut, totalCached),
    ),
  };
}

describe('TokenAccounting.observe + toCardStreamEndUsage', () => {
  it('passes per-turn `last` through as input/output and exposes cumulative `total`', () => {
    const t = new TokenAccounting();
    t.observe(notification('turn_1', 100, 50, 1000, 500, 200));
    const usage = TokenAccounting.toCardStreamEndUsage(t['byTurn'].get('turn_1'));
    expect(usage).toEqual({
      input: 100,
      output: 50,
      cumulativeInput: 1000,
      cumulativeOutput: 500,
      cumulativeCachedInput: 200,
    });
  });

  it('snapshotCumulative reflects the latest observed total', () => {
    const t = new TokenAccounting();
    t.observe(notification('turn_1', 10, 5, 10, 5, 2));
    t.observe(notification('turn_2', 20, 10, 30, 15, 7));
    expect(t.snapshotCumulative()).toEqual({
      inputTokens: 30,
      outputTokens: 15,
      cachedInputTokens: 7,
    });
  });

  it('returns undefined usage when nothing was observed', () => {
    expect(TokenAccounting.toCardStreamEndUsage(null)).toBeUndefined();
    expect(TokenAccounting.toCardStreamEndUsage(undefined)).toBeUndefined();
  });
});

describe('TokenAccounting.seedFromLastTurn — cold-resume parity', () => {
  it('seeds the running cumulative from a persisted snapshot', () => {
    const t = new TokenAccounting();
    t.seedFromLastTurn({ inputTokens: 800, outputTokens: 400, cachedInputTokens: 50 });
    expect(t.snapshotCumulative()).toEqual({
      inputTokens: 800,
      outputTokens: 400,
      cachedInputTokens: 50,
    });
  });

  it('tolerates a missing cachedInputTokens', () => {
    const t = new TokenAccounting();
    t.seedFromLastTurn({ inputTokens: 50, outputTokens: 25 });
    expect(t.snapshotCumulative().cachedInputTokens).toBe(0);
  });

  it('is a no-op when no seed is provided', () => {
    const t = new TokenAccounting();
    t.seedFromLastTurn(null);
    t.seedFromLastTurn(undefined);
    expect(t.snapshotCumulative()).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
  });
});

describe('TokenAccounting.awaitTurnUsage — ordering tolerance', () => {
  it('resolves immediately when the notification has already been observed', async () => {
    const t = new TokenAccounting();
    t.observe(notification('turn_1', 5, 3, 5, 3));
    const usage = await t.awaitTurnUsage('turn_1', 1000);
    expect(usage?.last.inputTokens).toBe(5);
  });

  it('resolves when the notification arrives later', async () => {
    const t = new TokenAccounting();
    const promise = t.awaitTurnUsage('turn_2', 1000);
    t.observe(notification('turn_2', 7, 2, 7, 2));
    const usage = await promise;
    expect(usage?.last.outputTokens).toBe(2);
  });

  it('resolves to null on timeout without leaking the waiter', async () => {
    const t = new TokenAccounting();
    const usage = await t.awaitTurnUsage('turn_x', 5);
    expect(usage).toBeNull();
    // Late observation must not throw.
    t.observe(notification('turn_x', 1, 1, 1, 1));
  });

  it('isolates waiters by turnId', async () => {
    const t = new TokenAccounting();
    const turn1 = t.awaitTurnUsage('turn_1', 1000);
    const turn2 = t.awaitTurnUsage('turn_2', 1000);
    t.observe(notification('turn_2', 9, 9, 9, 9));
    expect((await turn2)?.last.inputTokens).toBe(9);
    t.observe(notification('turn_1', 1, 1, 10, 10));
    expect((await turn1)?.last.inputTokens).toBe(1);
  });
});

describe('TokenAccounting.releaseTurn', () => {
  it('drops cached usage and pending waiters', async () => {
    const t = new TokenAccounting();
    t.observe(notification('turn_1', 1, 1, 1, 1));
    t.releaseTurn('turn_1');
    // After release, awaitTurnUsage waits anew (no instant resolve).
    const result = await Promise.race([
      t.awaitTurnUsage('turn_1', 5),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 10)),
    ]);
    expect(result).toBeNull();
  });
});
