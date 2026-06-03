// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import type { CodexQuotaWindow } from '@sumicom/quicksave-shared';
import { expectedUsedPercent, quotaTone } from './CodexQuotaBadges';

describe('expectedUsedPercent', () => {
  it('computes the linear cycle budget from reset time and duration', () => {
    const now = Date.UTC(2026, 5, 3, 12, 0, 0);
    const window: CodexQuotaWindow = {
      id: 'five_hour',
      label: '5h',
      usedPercent: 10,
      windowDurationMins: 300,
      resetAt: now + 2 * 60 * 60 * 1000,
    };

    expect(expectedUsedPercent(window, now)).toBe(60);
  });

  it('returns null when reset time or duration is unavailable', () => {
    expect(expectedUsedPercent({
      id: 'seven_day',
      label: '7d',
      usedPercent: 10,
      resetAt: null,
      windowDurationMins: 10_080,
    })).toBeNull();
  });
});

describe('quotaTone', () => {
  const now = Date.UTC(2026, 5, 3, 12, 0, 0);

  it('is green when usage is within the expected cycle budget', () => {
    expect(quotaTone(makeWindow(50), { now })).toBe('green');
  });

  it('is yellow when usage is moderately ahead of the expected cycle budget', () => {
    expect(quotaTone(makeWindow(70), { now })).toBe('yellow');
  });

  it('is red when usage is far ahead of the expected cycle budget', () => {
    expect(quotaTone(makeWindow(90), { now })).toBe('red');
  });

  it('is muted when snapshot state is stale or errored', () => {
    expect(quotaTone(makeWindow(10), { now, stale: true })).toBe('muted');
    expect(quotaTone(makeWindow(10), { now, error: true })).toBe('muted');
  });

  function makeWindow(usedPercent: number): CodexQuotaWindow {
    return {
      id: 'five_hour',
      label: '5h',
      usedPercent,
      windowDurationMins: 300,
      resetAt: now + 2 * 60 * 60 * 1000,
    };
  }
});
