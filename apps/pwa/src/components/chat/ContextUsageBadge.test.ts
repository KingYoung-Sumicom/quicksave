// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { resolveContextUsageLimit } from './ContextUsageBadge';

describe('ContextUsageBadge', () => {
  describe('resolveContextUsageLimit', () => {
    it('keeps Codex model fallback above a smaller runtime threshold', () => {
      expect(resolveContextUsageLimit({
        agentId: 'codex',
        breakdownMaxTokens: 258_400,
        fallbackLimit: 400_000,
      })).toBe(400_000);
    });

    it('allows Codex runtime values above the fallback', () => {
      expect(resolveContextUsageLimit({
        agentId: 'codex',
        breakdownMaxTokens: 1_000_000,
        fallbackLimit: 400_000,
      })).toBe(1_000_000);
    });

    it('keeps Claude breakdown max authoritative', () => {
      expect(resolveContextUsageLimit({
        agentId: 'claude-code',
        breakdownMaxTokens: 180_000,
        fallbackLimit: 200_000,
      })).toBe(180_000);
    });
  });
});
