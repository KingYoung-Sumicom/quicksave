import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EventStore } from './eventStore.js';

let tempDir: string;
let store: EventStore;

describe('EventStore', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'eventStore-test-'));
    store = new EventStore(join(tempDir, 'quicksave.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('record + getSessionEvents', () => {
    it('records events and retrieves them ordered by time', () => {
      store.record({ type: 'prompt_sent', sessionId: 's1', cwd: '/p', time: 1000, data: { length: 10 } });
      store.record({ type: 'turn_ended', sessionId: 's1', cwd: '/p', time: 2000, data: { inputTokens: 5, outputTokens: 10, costUsd: 0.01 } });

      const events = store.getSessionEvents('s1');
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('prompt_sent');
      expect(events[0].data).toEqual({ length: 10 });
      expect(events[1].type).toBe('turn_ended');
      expect(events[1].time).toBe(2000);
    });

    it('isolates events by sessionId', () => {
      store.record({ type: 'prompt_sent', sessionId: 's1', time: 1000 });
      store.record({ type: 'prompt_sent', sessionId: 's2', time: 2000 });

      expect(store.getSessionEvents('s1')).toHaveLength(1);
      expect(store.getSessionEvents('s2')).toHaveLength(1);
    });

    it('stores null data when data is undefined', () => {
      store.record({ type: 'session_cancelled', sessionId: 's1', time: 500 });
      const events = store.getSessionEvents('s1');
      expect(events[0].data).toBeNull();
    });

    it('auto-fills time with Date.now() when omitted', () => {
      const before = Date.now();
      store.record({ type: 'prompt_sent', sessionId: 's1' });
      const after = Date.now();
      const events = store.getSessionEvents('s1');
      expect(events[0].time).toBeGreaterThanOrEqual(before);
      expect(events[0].time).toBeLessThanOrEqual(after);
    });
  });

  describe('getSessionStats', () => {
    it('returns zero stats for a session with no events', () => {
      const stats = store.getSessionStats('unknown');
      expect(stats).toEqual({
        turnCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
        lastPromptAt: null,
        lastTurnEndedAt: null,
      });
    });

    it('aggregates turn_ended events into cumulative totals', () => {
      store.record({ type: 'turn_ended', sessionId: 's1', time: 1000, data: { inputTokens: 100, outputTokens: 50, costUsd: 0.02 } });
      store.record({ type: 'turn_ended', sessionId: 's1', time: 2000, data: { inputTokens: 200, outputTokens: 75, costUsd: 0.05 } });

      const stats = store.getSessionStats('s1');
      expect(stats.turnCount).toBe(2);
      expect(stats.totalInputTokens).toBe(300);
      expect(stats.totalOutputTokens).toBe(125);
      expect(stats.totalCostUsd).toBeCloseTo(0.07, 6);
      expect(stats.lastTurnEndedAt).toBe(2000);
    });

    it('returns lastPromptAt as the max time of prompt_sent events', () => {
      store.record({ type: 'prompt_sent', sessionId: 's1', time: 1000 });
      store.record({ type: 'prompt_sent', sessionId: 's1', time: 3000 });
      store.record({ type: 'prompt_sent', sessionId: 's1', time: 2000 });

      const stats = store.getSessionStats('s1');
      expect(stats.lastPromptAt).toBe(3000);
    });

    it('ignores events for other sessions', () => {
      store.record({ type: 'turn_ended', sessionId: 's1', time: 1000, data: { inputTokens: 100, outputTokens: 50, costUsd: 0.02 } });
      store.record({ type: 'turn_ended', sessionId: 's2', time: 2000, data: { inputTokens: 999, outputTokens: 999, costUsd: 9.99 } });

      const stats = store.getSessionStats('s1');
      expect(stats.turnCount).toBe(1);
      expect(stats.totalInputTokens).toBe(100);
    });

    it('handles turn_ended events with missing token/cost fields', () => {
      store.record({ type: 'turn_ended', sessionId: 's1', time: 1000, data: {} });

      const stats = store.getSessionStats('s1');
      expect(stats.turnCount).toBe(1);
      expect(stats.totalInputTokens).toBe(0);
      expect(stats.totalOutputTokens).toBe(0);
      expect(stats.totalCostUsd).toBe(0);
    });
  });

  describe('getLastTurn', () => {
    it('returns null when no turn_ended events exist', () => {
      expect(store.getLastTurn('s1')).toBeNull();
    });

    it('returns token breakdown from the most recent turn', () => {
      store.record({ type: 'turn_ended', sessionId: 's1', time: 1000, data: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 } });
      store.record({ type: 'turn_ended', sessionId: 's1', time: 2000, data: { inputTokens: 20, outputTokens: 15, cacheReadTokens: 7, costUsd: 0.02 } });

      const last = store.getLastTurn('s1');
      expect(last).not.toBeNull();
      expect(last!.time).toBe(2000);
      expect(last!.inputTokens).toBe(20);
      expect(last!.cacheReadTokens).toBe(7);
      expect(last!.contextUsage).toBeUndefined();
    });

    it('surfaces the contextUsage blob when present', () => {
      const usage = {
        categories: [{ name: 'System prompt', tokens: 1234, color: 'x' }],
        totalTokens: 1234,
        maxTokens: 200000,
        percentage: 1,
        capturedAt: 2500,
      };
      store.record({
        type: 'turn_ended',
        sessionId: 's1',
        time: 2000,
        data: { inputTokens: 1, outputTokens: 1, costUsd: 0, contextUsage: usage },
      });

      const last = store.getLastTurn('s1');
      expect(last!.contextUsage).toEqual(usage);
    });
  });

  describe('persistence', () => {
    it('persists events across instances (same db file)', () => {
      store.record({ type: 'prompt_sent', sessionId: 's1', time: 1000 });
      store.close();

      const reopened = new EventStore(join(tempDir, 'quicksave.db'));
      const events = reopened.getSessionEvents('s1');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('prompt_sent');
      reopened.close();
    });
  });

  describe('pagination', () => {
    it('respects limit and offset', () => {
      for (let i = 0; i < 10; i++) {
        store.record({ type: 'prompt_sent', sessionId: 's1', time: 1000 + i });
      }
      const page1 = store.getSessionEvents('s1', 3, 0);
      const page2 = store.getSessionEvents('s1', 3, 3);
      expect(page1).toHaveLength(3);
      expect(page2).toHaveLength(3);
      expect(page1[0].time).toBe(1000);
      expect(page2[0].time).toBe(1003);
    });
  });
});
