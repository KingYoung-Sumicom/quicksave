// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import type { ClaudeQuotaWindow } from '@sumicom/quicksave-shared';
import { expectedUsedPercent, quotaTone } from './ClaudeUsageBadges';

describe('expectedUsedPercent', () => {
  it('computes the linear cycle budget from reset time using the fixed 5h duration', () => {
    const now = Date.UTC(2026, 5, 3, 12, 0, 0);
    const window: ClaudeQuotaWindow = {
      id: 'five_hour',
      label: '5h',
      usedPercent: 10,
      resetAt: now + 2 * 60 * 60 * 1000,
    };

    expect(expectedUsedPercent(window, now)).toBe(60);
  });

  it('returns null when reset time is unavailable', () => {
    expect(expectedUsedPercent({
      id: 'seven_day',
      label: '7d',
      usedPercent: 10,
      resetAt: null,
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

  it('is muted when the snapshot is stale', () => {
    expect(quotaTone(makeWindow(10), { now, stale: true })).toBe('muted');
  });

  it('is muted when there is no window', () => {
    expect(quotaTone(null, { now })).toBe('muted');
  });

  function makeWindow(usedPercent: number): ClaudeQuotaWindow {
    return {
      id: 'five_hour',
      label: '5h',
      usedPercent,
      resetAt: now + 2 * 60 * 60 * 1000,
    };
  }
});
