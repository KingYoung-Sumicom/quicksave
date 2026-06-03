// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { ContextUsageBreakdown } from '@sumicom/quicksave-shared';

export function normalizeStoredContextUsage(contextUsage: unknown): ContextUsageBreakdown | undefined {
  if (!contextUsage || typeof contextUsage !== 'object') return undefined;
  const usage = contextUsage as Partial<ContextUsageBreakdown>;

  // Legacy Codex synthetic breakdowns used thread-cumulative accounting as
  // context occupancy. Ignore them so the UI falls back to last-turn tokens
  // instead of showing impossible values like 20M/1M.
  if (usage.autocompactSource === 'codex-token-usage') return undefined;
  if (!Array.isArray(usage.categories) || typeof usage.totalTokens !== 'number') return undefined;

  return usage as ContextUsageBreakdown;
}

export function buildCodexContextUsage({
  model,
  modelContextWindow,
  inputTokens,
  cachedInputTokens,
}: {
  model?: string;
  modelContextWindow?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
}): ContextUsageBreakdown | null {
  if (!modelContextWindow || modelContextWindow <= 0) return null;

  // Codex totals are lifetime accounting counters for the thread, not the
  // current prompt size. Use the latest turn's input tokens as the closest
  // context-window estimate the app-server exposes.
  const contextTokens = Math.max(0, inputTokens ?? 0);
  const cacheReadTokens = Math.max(0, Math.min(cachedInputTokens ?? 0, contextTokens));
  const uncachedInputTokens = Math.max(0, contextTokens - cacheReadTokens);

  return {
    categories: [
      { name: 'Codex input', tokens: uncachedInputTokens, color: 'claude' },
      { name: 'Codex cached input', tokens: cacheReadTokens, color: 'warning' },
    ],
    totalTokens: contextTokens,
    maxTokens: modelContextWindow,
    rawMaxTokens: modelContextWindow,
    autocompactSource: 'codex-last-turn-input',
    percentage: (contextTokens / modelContextWindow) * 100,
    model,
  };
}
