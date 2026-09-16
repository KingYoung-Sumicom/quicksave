// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from 'vitest';
import { ClaudeQuotaCache, projectClaudeUsage, type ClaudeUsageRawResponse } from './claudeUsage.js';

describe('projectClaudeUsage', () => {
  it('projects a subscription session with five_hour + seven_day windows', () => {
    const raw: ClaudeUsageRawResponse = {
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 42.5, resets_at: '2026-09-16T20:00:00Z' },
        seven_day: { utilization: 10, resets_at: '2026-09-20T00:00:00Z' },
      },
    };
    const snapshot = projectClaudeUsage(raw, 30 * 60 * 1000, 1_000_000);
    expect(snapshot.subscriptionType).toBe('max');
    expect(snapshot.rateLimitsAvailable).toBe(true);
    expect(snapshot.stale).toBe(false);
    expect(snapshot.windows).toEqual([
      { id: 'five_hour', label: '5h', usedPercent: 42.5, resetAt: Date.parse('2026-09-16T20:00:00Z') },
      { id: 'seven_day', label: '7d', usedPercent: 10, resetAt: Date.parse('2026-09-20T00:00:00Z') },
    ]);
  });

  it('returns rateLimitsAvailable: false and no windows for an API-key session', () => {
    const raw: ClaudeUsageRawResponse = {
      subscription_type: null,
      rate_limits_available: false,
      rate_limits: null,
    };
    const snapshot = projectClaudeUsage(raw);
    expect(snapshot.subscriptionType).toBeNull();
    expect(snapshot.rateLimitsAvailable).toBe(false);
    expect(snapshot.windows).toEqual([]);
  });

  it('drops windows with missing/non-numeric utilization instead of throwing', () => {
    const raw: ClaudeUsageRawResponse = {
      subscription_type: 'pro',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: null, resets_at: null },
        seven_day: { utilization: 5 },
      },
    };
    const snapshot = projectClaudeUsage(raw);
    expect(snapshot.windows).toEqual([{ id: 'seven_day', label: '7d', usedPercent: 5, resetAt: null }]);
  });

  it('clamps out-of-range utilization into 0-100', () => {
    const raw: ClaudeUsageRawResponse = {
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 142 } },
    };
    const snapshot = projectClaudeUsage(raw);
    expect(snapshot.windows[0]?.usedPercent).toBe(100);
  });

  it('projects model_scoped windows, dropping entries with no display name', () => {
    const raw: ClaudeUsageRawResponse = {
      rate_limits_available: true,
      rate_limits: {
        model_scoped: [
          { display_name: 'Fable', utilization: 30, resets_at: '2026-09-22T00:00:00Z' },
          { display_name: '', utilization: 5 },
        ],
      },
    };
    const snapshot = projectClaudeUsage(raw);
    expect(snapshot.modelWindows).toEqual([
      { displayName: 'Fable', usedPercent: 30, resetAt: Date.parse('2026-09-22T00:00:00Z') },
    ]);
  });

  it('never throws on a malformed/empty response', () => {
    expect(() => projectClaudeUsage(null)).not.toThrow();
    expect(() => projectClaudeUsage({} as ClaudeUsageRawResponse)).not.toThrow();
    expect(projectClaudeUsage(null).windows).toEqual([]);
  });
});

describe('ClaudeQuotaCache', () => {
  it('ignores responses without rate-limit data, keeping the previous snapshot', () => {
    const cache = new ClaudeQuotaCache();
    cache.ingest({ subscription_type: 'pro', rate_limits_available: true, rate_limits: { five_hour: { utilization: 20 } } });
    const before = cache.getSnapshot();
    expect(before?.windows[0]?.usedPercent).toBe(20);

    cache.ingest({ subscription_type: null, rate_limits_available: false, rate_limits: null });
    expect(cache.getSnapshot()).toEqual(before);
  });

  it('notifies the update handler only on usable ingests', () => {
    const cache = new ClaudeQuotaCache();
    const handler = vi.fn();
    cache.setUpdateHandler(handler);

    cache.ingest({ rate_limits_available: false });
    expect(handler).not.toHaveBeenCalled();

    cache.ingest({ rate_limits_available: true, rate_limits: { seven_day: { utilization: 1 } } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('flags a snapshot stale once it exceeds the cache TTL', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const cache = new ClaudeQuotaCache(1000);
      cache.ingest({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 1 } } });
      expect(cache.getSnapshot()?.stale).toBe(false);
      vi.setSystemTime(2000);
      expect(cache.getSnapshot()?.stale).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns null when nothing has been ingested yet', () => {
    expect(new ClaudeQuotaCache().getSnapshot()).toBeNull();
  });
});
