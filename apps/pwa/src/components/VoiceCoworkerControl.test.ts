// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { calculateVoiceConversationRatio } from './VoiceCoworkerControl';

describe('calculateVoiceConversationRatio', () => {
  it('tracks the pointer within the available split pane', () => {
    expect(calculateVoiceConversationRatio(300, 100, 500)).toBe(0.4);
  });

  it('keeps both conversation and decision trace visible', () => {
    expect(calculateVoiceConversationRatio(100, 100, 500)).toBeCloseTo(72 / 500);
    expect(calculateVoiceConversationRatio(600, 100, 500)).toBeCloseTo(1 - (140 / 500));
  });
});
