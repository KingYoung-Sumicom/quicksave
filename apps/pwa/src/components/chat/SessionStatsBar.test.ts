// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { formatCountdown } from './SessionStatsBar';

describe('SessionStatsBar', () => {
  describe('formatCountdown', () => {
    it('uses mm:ss below one hour', () => {
      expect(formatCountdown(9 * 60 * 1000 + 5 * 1000)).toBe('09:05');
    });

    it('uses hours and minutes for long OpenAI prompt-cache TTLs', () => {
      expect(formatCountdown(23 * 60 * 60 * 1000 + 59 * 60 * 1000)).toBe('23h 59m');
    });

    it('uses days and hours above one day', () => {
      expect(formatCountdown(2 * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000)).toBe('2d 03h');
    });
  });
});
