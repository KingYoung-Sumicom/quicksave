// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { sendPromptUntilAccepted } from '../provider.js';

/**
 * Virtual clock so these tests run instantly and deterministically: `sleep`
 * advances `t` synchronously instead of waiting on real timers. Mirrors how the
 * provider drives the TUI re-type loop (send → wait for proof → re-send).
 */
function virtualClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
    get t() { return t; },
  };
}

describe('sendPromptUntilAccepted', () => {
  it('sends once and returns the token when the prompt is accepted immediately', async () => {
    const clock = virtualClock();
    let sends = 0;
    let probes = 0;

    const result = await sendPromptUntilAccepted({
      send: () => { sends++; },
      // pre-check (1st probe) null, then accepted right after the first send.
      probe: () => (++probes >= 2 ? 'sid-1' : null),
      timeoutMs: 30_000,
      initialDelayMs: 1000,
      retryIntervalMs: 2500,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result).toBe('sid-1');
    expect(sends).toBe(1);
  });

  it('re-types the prompt when the first attempt is eaten, then succeeds', async () => {
    const clock = virtualClock();
    let sends = 0;

    const result = await sendPromptUntilAccepted({
      send: () => { sends++; },
      // The JSONL only appears in the SECOND retry window (cold TUI ate the
      // first keystrokes), so the loop must re-type to make progress.
      probe: () => (clock.t >= 4000 ? 'sid-2' : null),
      timeoutMs: 30_000,
      initialDelayMs: 1000,
      retryIntervalMs: 2500,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result).toBe('sid-2');
    expect(sends).toBe(2);
  });

  it('throws when the prompt is never accepted before the deadline', async () => {
    const clock = virtualClock();
    let sends = 0;

    await expect(
      sendPromptUntilAccepted({
        send: () => { sends++; },
        probe: () => null,
        timeoutMs: 30_000,
        initialDelayMs: 1000,
        retryIntervalMs: 2500,
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).rejects.toThrow(/not accepted within 30000ms/);

    // It kept re-typing across the whole window rather than giving up early.
    expect(sends).toBeGreaterThan(1);
  });

  it('aborts promptly when the abort hook fires', async () => {
    const clock = virtualClock();
    let sends = 0;

    await expect(
      sendPromptUntilAccepted({
        send: () => { sends++; },
        probe: () => null,
        abort: () => true,
        timeoutMs: 30_000,
        initialDelayMs: 0,
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).rejects.toThrow(/aborted/);

    expect(sends).toBe(0);
  });

  it('returns without sending when the prompt was already accepted (pre-check)', async () => {
    const clock = virtualClock();
    let sends = 0;

    const result = await sendPromptUntilAccepted({
      send: () => { sends++; },
      probe: () => 'already-there',
      timeoutMs: 30_000,
      initialDelayMs: 0,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result).toBe('already-there');
    expect(sends).toBe(0);
  });
});
