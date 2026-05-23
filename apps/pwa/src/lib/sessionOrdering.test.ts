// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import type { ClaudeSessionSummary } from '@sumicom/quicksave-shared';
import { compareSessionsForList, isPendingMissionActive, sessionListRank } from './sessionOrdering';

function session(overrides: Partial<ClaudeSessionSummary>): ClaudeSessionSummary {
  return {
    sessionId: overrides.sessionId ?? Math.random().toString(36),
    summary: 's',
    lastModified: 1_000,
    ...overrides,
  };
}

describe('sessionOrdering', () => {
  it('treats future pending missions as active until their due time', () => {
    expect(isPendingMissionActive(session({ pendingMission: { label: 'training', until: 2_000 } }), 1_500)).toBe(true);
    expect(isPendingMissionActive(session({ pendingMission: { label: 'training', until: 2_000 } }), 2_000)).toBe(false);
  });

  it('lowers future pending missions below ordinary active sessions', () => {
    const pending = session({ sessionId: 'pending', isActive: true, isStreaming: true, pendingMission: { label: 'training', until: 2_000 } });
    const active = session({ sessionId: 'active', isActive: true });
    expect(sessionListRank(pending, 1_500)).toBeLessThan(sessionListRank(active, 1_500));
    expect(compareSessionsForList(pending, active, 1_500)).toBeGreaterThan(0);
  });

  it('keeps pending input above pending mission lowering', () => {
    const pendingInput = session({
      isActive: true,
      hasPendingInput: true,
      pendingMission: { label: 'training', until: 2_000 },
    });
    const active = session({ isActive: true });
    expect(sessionListRank(pendingInput, 1_500)).toBeGreaterThan(sessionListRank(active, 1_500));
  });
});
