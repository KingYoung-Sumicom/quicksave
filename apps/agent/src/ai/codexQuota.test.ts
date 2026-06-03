// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import type { CodexQuotaSnapshot } from '@sumicom/quicksave-shared';
import {
  CODEX_QUOTA_TTL_MS,
  CodexQuotaService,
  projectCodexQuotaResponse,
} from './codexQuota.js';

describe('projectCodexQuotaResponse', () => {
  it('maps Codex primary and secondary windows into 5h and 7d quota windows', () => {
    const snapshot = projectCodexQuotaResponse({
      rateLimits: {
        limitId: 'codex',
        limitName: 'Codex',
        primary: { usedPercent: 38.4, windowDurationMins: 300, resetsAt: 1_786_000_000 },
        secondary: { usedPercent: 71.2, windowDurationMins: 10_080, resetsAt: 1_786_500_000 },
        credits: null,
        planType: null,
        rateLimitReachedType: null,
      },
      rateLimitsByLimitId: null,
    }, CODEX_QUOTA_TTL_MS, 1_785_000_000_000);

    expect(snapshot).toEqual({
      source: 'app-server',
      fetchedAt: 1_785_000_000_000,
      ttlMs: CODEX_QUOTA_TTL_MS,
      stale: false,
      windows: [
        {
          id: 'five_hour',
          label: '5h',
          usedPercent: 38.4,
          resetAt: 1_786_000_000_000,
          windowDurationMins: 300,
        },
        {
          id: 'seven_day',
          label: '7d',
          usedPercent: 71.2,
          resetAt: 1_786_500_000_000,
          windowDurationMins: 10_080,
        },
      ],
    });
  });

  it('prefers the codex entry from the multi-limit response', () => {
    const snapshot = projectCodexQuotaResponse({
      rateLimits: {
        limitId: 'other',
        limitName: 'Other',
        primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: null },
        secondary: null,
        credits: null,
        planType: null,
        rateLimitReachedType: null,
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          limitName: 'Codex',
          primary: { usedPercent: 12, windowDurationMins: null, resetsAt: null },
          secondary: { usedPercent: 34, windowDurationMins: null, resetsAt: null },
          credits: null,
          planType: null,
          rateLimitReachedType: null,
        },
      },
    });

    expect(snapshot.windows.map((w) => [w.id, w.label, w.usedPercent])).toEqual([
      ['five_hour', '5h', 12],
      ['seven_day', '7d', 34],
    ]);
  });
});

describe('CodexQuotaService', () => {
  it('reuses a fresh cached snapshot and refreshes when forced', async () => {
    let calls = 0;
    const service = new CodexQuotaService(60_000, async () => {
      calls += 1;
      return makeSnapshot(calls);
    });

    await expect(service.refresh()).resolves.toMatchObject({
      windows: [expect.objectContaining({ usedPercent: 10 })],
    });
    await service.refresh();
    await expect(service.refresh({ force: true })).resolves.toMatchObject({
      windows: [expect.objectContaining({ usedPercent: 20 })],
    });
    expect(calls).toBe(2);
  });

  it('keeps the previous windows when a refresh fails', async () => {
    let fail = false;
    const service = new CodexQuotaService(60_000, async () => {
      if (fail) throw new Error('quota unavailable');
      return makeSnapshot(1);
    });

    await service.refresh();
    fail = true;

    const snapshot = await service.refresh({ force: true });
    expect(snapshot.error).toBe('quota unavailable');
    expect(snapshot.stale).toBe(true);
    expect(snapshot.windows).toEqual(makeSnapshot(1).windows);
  });
});

function makeSnapshot(fetchedAt: number): CodexQuotaSnapshot {
  return {
    source: 'app-server',
    fetchedAt: Date.now(),
    ttlMs: 60_000,
    stale: false,
    windows: [
      {
        id: 'five_hour',
        label: '5h',
        usedPercent: fetchedAt * 10,
        resetAt: null,
        windowDurationMins: 300,
      },
    ],
  };
}
