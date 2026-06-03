// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { buildCodexContextUsage, normalizeStoredContextUsage } from './contextUsage.js';

describe('buildCodexContextUsage', () => {
  it('uses last-turn input tokens as the Codex context-window estimate', () => {
    const usage = buildCodexContextUsage({
      model: 'gpt-5.3-codex',
      modelContextWindow: 1_000_000,
      inputTokens: 12_000,
      cachedInputTokens: 2_500,
    });

    expect(usage).toEqual({
      categories: [
        { name: 'Codex input', tokens: 9_500, color: 'claude' },
        { name: 'Codex cached input', tokens: 2_500, color: 'warning' },
      ],
      totalTokens: 12_000,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      autocompactSource: 'codex-last-turn-input',
      percentage: 1.2,
      model: 'gpt-5.3-codex',
    });
  });

  it('bounds cached input to the latest input tokens', () => {
    const usage = buildCodexContextUsage({
      modelContextWindow: 200_000,
      inputTokens: 1_000,
      cachedInputTokens: 5_000,
    });

    expect(usage?.categories).toEqual([
      { name: 'Codex input', tokens: 0, color: 'claude' },
      { name: 'Codex cached input', tokens: 1_000, color: 'warning' },
    ]);
    expect(usage?.totalTokens).toBe(1_000);
    expect(usage?.percentage).toBe(0.5);
  });

  it('returns null without a positive model context window', () => {
    expect(buildCodexContextUsage({ inputTokens: 1_000 })).toBeNull();
    expect(buildCodexContextUsage({ modelContextWindow: 0, inputTokens: 1_000 })).toBeNull();
  });

  it('drops legacy cumulative Codex context usage from persisted events', () => {
    expect(normalizeStoredContextUsage({
      categories: [{ name: 'Codex input', tokens: 20_000_000, color: 'claude' }],
      totalTokens: 20_000_000,
      maxTokens: 1_000_000,
      percentage: 2000,
      autocompactSource: 'codex-token-usage',
    })).toBeUndefined();
  });

  it('keeps current context usage persisted by the fixed Codex path', () => {
    const usage = {
      categories: [{ name: 'Codex input', tokens: 12_000, color: 'claude' }],
      totalTokens: 12_000,
      maxTokens: 1_000_000,
      percentage: 1.2,
      autocompactSource: 'codex-last-turn-input',
    };

    expect(normalizeStoredContextUsage(usage)).toBe(usage);
  });
});
