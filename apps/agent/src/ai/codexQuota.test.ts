// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexQuotaSnapshot } from '@sumicom/quicksave-shared';
import {
  CODEX_QUOTA_DEBOUNCE_MS,
  CODEX_QUOTA_TTL_MS,
  CodexQuotaService,
  projectCodexQuotaResponse,
  summarizeCodexQuotaError,
} from './codexQuota.js';

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  vi.useRealTimers();
});

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
      resetCredits: null,
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

  it('projects reset-credit summaries without leaking bigint over the bus', () => {
    const snapshot = projectCodexQuotaResponse({
      rateLimits: {
        limitId: 'codex',
        limitName: 'Codex',
        primary: null,
        secondary: null,
        credits: null,
        planType: null,
        rateLimitReachedType: null,
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: {
        availableCount: 2n,
        credits: [{
          id: 'credit-1',
          resetType: 'codexRateLimits',
          status: 'available',
          grantedAt: 1_786_000_000,
          expiresAt: null,
          title: 'Reset quota',
          description: 'One reset',
        }],
      },
    });

    expect(snapshot.resetCredits).toEqual({
      availableCount: 2,
      credits: [{
        id: 'credit-1',
        resetType: 'codexRateLimits',
        status: 'available',
        grantedAt: 1_786_000_000_000,
        expiresAt: null,
        title: 'Reset quota',
        description: 'One reset',
      }],
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

  it('omits quota windows whose usage percentage is not reported', () => {
    const snapshot = projectCodexQuotaResponse({
      rateLimits: {
        limitId: 'codex',
        limitName: 'Codex',
        primary: { usedPercent: null, windowDurationMins: 300, resetsAt: null } as any,
        secondary: { usedPercent: 34, windowDurationMins: 10_080, resetsAt: null },
        credits: null,
        planType: null,
        rateLimitReachedType: null,
      },
      rateLimitsByLimitId: null,
    });

    expect(snapshot.windows.map((w) => [w.id, w.label, w.usedPercent])).toEqual([
      ['seven_day', '7d', 34],
    ]);
  });
});

describe('CodexQuotaService', () => {
  it('debounces forced refreshes for three minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T00:00:00.000Z'));

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
      windows: [expect.objectContaining({ usedPercent: 10 })],
    });

    vi.setSystemTime(Date.now() + CODEX_QUOTA_DEBOUNCE_MS);
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
    }, 0);

    await service.refresh();
    fail = true;

    const snapshot = await service.refresh({ force: true });
    expect(snapshot.error).toBe('Codex quota is unavailable: quota unavailable');
    expect(snapshot.stale).toBe(true);
    expect(snapshot.windows).toEqual(makeSnapshot(1).windows);
    expect(service.getSnapshot()?.stale).toBe(true);
  });

  it('marks an initial failed read stale and uses a concise error', async () => {
    const service = new CodexQuotaService(60_000, async () => {
      throw new Error('account/rateLimits/read: failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 503 Service Unavailable; body=upstream connect error or disconnect/reset before headers');
    });

    const snapshot = await service.refresh();
    expect(snapshot).toMatchObject({
      stale: true,
      windows: [],
      error: 'Codex quota is temporarily unavailable from ChatGPT. Quicksave will retry automatically.',
    });
    expect(snapshot.error).not.toContain('backend-api/wham/usage');
    expect(service.getSnapshot()?.stale).toBe(true);
  });

  it('debounces stale retry attempts after a failed read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T00:00:00.000Z'));

    let calls = 0;
    const service = new CodexQuotaService(60_000, async () => {
      calls += 1;
      throw new Error('503 Service Unavailable');
    });

    const first = await service.refresh();
    const second = await service.refresh({ force: true });
    expect(second).toMatchObject({ error: first.error });
    expect(calls).toBe(1);

    vi.setSystemTime(Date.now() + CODEX_QUOTA_DEBOUNCE_MS);
    await service.refresh({ force: true });
    expect(calls).toBe(2);
  });
});

describe('summarizeCodexQuotaError', () => {
  it('collapses ChatGPT upstream 503 details into a temporary unavailable message', () => {
    expect(summarizeCodexQuotaError(new Error(
      'account/rateLimits/read: failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 503 Service Unavailable; body=upstream connect error',
    ))).toBe('Codex quota is temporarily unavailable from ChatGPT. Quicksave will retry automatically.');
  });

  it('collapses auth failures into a login-oriented message', () => {
    expect(summarizeCodexQuotaError(new Error('403 Forbidden'))).toBe(
      'Codex quota is unavailable because Codex is not signed in. Sign in again if this persists.',
    );
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
