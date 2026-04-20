import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { SessionRegistryEntry } from '@sumicom/quicksave-shared';
import { setQuicksaveDir } from './singleton.js';
import { getEventStore, resetEventStore } from '../storage/eventStore.js';
import { enrichEntry } from '../ai/enrichEntry.js';

function baseEntry(overrides: Partial<SessionRegistryEntry> = {}): SessionRegistryEntry {
  return {
    sessionId: 's1',
    cwd: '/p',
    createdAt: 1000,
    lastAccessedAt: 2000,
    ...overrides,
  };
}

let tempDir: string;

describe('enrichEntry', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'enrich-entry-test-'));
    setQuicksaveDir(tempDir);
    resetEventStore();
    // Force state dir to exist so EventStore's ctor can create the db file.
    const stateDir = join(tempDir, 'state');
    // mkdirSync -> rely on EventStore ctor which runs mkdirSync(dir, recursive:true)
    // (it calls dirname(dbPath) so the state dir is auto-created).
    void stateDir;
  });

  afterEach(() => {
    resetEventStore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns the bare entry with undefined cache fields when no events exist', () => {
    const out = enrichEntry(baseEntry());
    expect(out.sessionId).toBe('s1');
    expect(out.cwd).toBe('/p');
    expect(out.lastPromptAt).toBeUndefined();
    expect(out.lastTurnEndedAt).toBeUndefined();
    expect(out.turnCount).toBeUndefined();
    expect(out.totalInputTokens).toBeUndefined();
    expect(out.lastTurnInputTokens).toBeUndefined();
    expect(out.lastTurnCacheCreationTokens).toBeUndefined();
    expect(out.lastTurnCacheReadTokens).toBeUndefined();
    expect(out.lastTurnContextUsage).toBeUndefined();
  });

  it('joins in stats + last-turn cache fields when events exist', () => {
    const store = getEventStore();
    store.record({ type: 'prompt_sent', sessionId: 's1', time: 1500, data: null });
    store.record({
      type: 'turn_ended',
      sessionId: 's1',
      time: 1800,
      data: {
        inputTokens: 10,
        outputTokens: 20,
        cacheCreationTokens: 5,
        cacheReadTokens: 7,
        costUsd: 0.003,
      },
    });
    const ctx = {
      categories: [{ name: 'system', tokens: 100, color: 'claude' }],
      totalTokens: 500,
      maxTokens: 200_000,
      percentage: 0.25,
      capturedAt: 1900,
    };
    store.record({
      type: 'turn_ended',
      sessionId: 's1',
      time: 2500,
      data: {
        inputTokens: 2,
        outputTokens: 4,
        cacheCreationTokens: 11,
        cacheReadTokens: 22,
        costUsd: 0.001,
        contextUsage: ctx,
      },
    });

    const out = enrichEntry(baseEntry());
    expect(out.lastPromptAt).toBe(1500);
    expect(out.lastTurnEndedAt).toBe(2500);
    expect(out.turnCount).toBe(2);
    expect(out.totalInputTokens).toBe(12);
    expect(out.totalOutputTokens).toBe(24);
    // Most recent turn wins — older row's 5/7 must not leak through.
    expect(out.lastTurnInputTokens).toBe(2);
    expect(out.lastTurnCacheCreationTokens).toBe(11);
    expect(out.lastTurnCacheReadTokens).toBe(22);
    expect(out.lastTurnContextUsage).toEqual(ctx);
  });

  it('does not mutate the input entry', () => {
    const entry = baseEntry({ title: 'abc' });
    const before = JSON.stringify(entry);
    enrichEntry(entry);
    expect(JSON.stringify(entry)).toBe(before);
    expect((entry as Record<string, unknown>).lastTurnCacheCreationTokens).toBeUndefined();
  });

  it('preserves all registry fields on the broadcast entry', () => {
    const entry = baseEntry({
      title: 'debug session',
      stage: 'working',
      note: 'exploring',
      messageCount: 3,
      totalCostUsd: 0.42,
      pinned: true,
    });
    const out = enrichEntry(entry);
    expect(out.title).toBe('debug session');
    expect(out.stage).toBe('working');
    expect(out.note).toBe('exploring');
    expect(out.messageCount).toBe(3);
    expect(out.totalCostUsd).toBe(0.42);
    expect(out.pinned).toBe(true);
  });

  it('scopes stats by sessionId so other sessions do not leak in', () => {
    const store = getEventStore();
    store.record({
      type: 'turn_ended',
      sessionId: 'other',
      time: 3000,
      data: { inputTokens: 999, outputTokens: 999, cacheCreationTokens: 999, cacheReadTokens: 999, costUsd: 9.9 },
    });
    const out = enrichEntry(baseEntry({ sessionId: 's1' }));
    expect(out.lastTurnCacheCreationTokens).toBeUndefined();
    expect(out.turnCount).toBeUndefined();
  });
});
