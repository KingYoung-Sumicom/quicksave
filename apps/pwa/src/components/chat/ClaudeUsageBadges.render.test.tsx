// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClaudeQuotaSnapshot } from '@sumicom/quicksave-shared';
import { useClaudeStore } from '../../stores/claudeStore';
import { useClaudeQuotaStore } from '../../stores/claudeQuotaStore';
import { ClaudeUsageBadges } from './ClaudeUsageBadges';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ClaudeUsageBadges rendering', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useClaudeStore.getState().reset();
    useClaudeStore.setState({
      sessionConfigs: {
        'claude-session': { agent: 'claude-code' },
      },
    });
    useClaudeQuotaStore.setState({ byAgent: {} });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    useClaudeStore.getState().reset();
    useClaudeQuotaStore.setState({ byAgent: {} });
  });

  it('shows the five-hour and seven-day windows for a subscription session', async () => {
    useClaudeQuotaStore.getState().set('agent-a', makeSnapshot({
      subscriptionType: 'max',
      windows: [
        { id: 'five_hour', label: '5h', usedPercent: 42, resetAt: Date.now() + 60_000 },
      ],
    }));

    await act(async () => {
      root.render(<ClaudeUsageBadges sessionId="claude-session" agentId="agent-a" />);
    });

    expect(container.textContent).toContain('5h');
    expect(container.textContent).toContain('42%');
    expect(container.textContent).not.toContain('7d');
  });

  it('renders nothing when rate limits are unavailable (API-key session)', async () => {
    useClaudeQuotaStore.getState().set('agent-a', makeSnapshot({
      subscriptionType: null,
      rateLimitsAvailable: false,
      windows: [],
    }));

    await act(async () => {
      root.render(<ClaudeUsageBadges sessionId="claude-session" agentId="agent-a" />);
    });

    expect(container.textContent).toBe('');
  });

  it('renders nothing when no snapshot has arrived yet', async () => {
    await act(async () => {
      root.render(<ClaudeUsageBadges sessionId="claude-session" agentId="agent-a" />);
    });

    expect(container.textContent).toBe('');
  });
});

function makeSnapshot(opts: {
  subscriptionType: ClaudeQuotaSnapshot['subscriptionType'];
  windows: ClaudeQuotaSnapshot['windows'];
  rateLimitsAvailable?: boolean;
}): ClaudeQuotaSnapshot {
  return {
    source: 'cli',
    fetchedAt: Date.now(),
    ttlMs: 30 * 60 * 1000,
    stale: false,
    subscriptionType: opts.subscriptionType,
    rateLimitsAvailable: opts.rateLimitsAvailable ?? true,
    windows: opts.windows,
  };
}
