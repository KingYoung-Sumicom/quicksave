// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CodexQuotaSnapshot } from '@sumicom/quicksave-shared';
import { useClaudeStore } from '../../stores/claudeStore';
import { useCodexQuotaStore } from '../../stores/codexQuotaStore';
import { CodexQuotaBadges } from './CodexQuotaBadges';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('CodexQuotaBadges rendering', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useClaudeStore.getState().reset();
    useClaudeStore.setState({
      sessionConfigs: {
        'codex-session': { agent: 'codex' },
      },
    });
    useCodexQuotaStore.setState({ byAgent: {} });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    useClaudeStore.getState().reset();
    useCodexQuotaStore.setState({ byAgent: {} });
  });

  it('hides quota windows that are absent from the snapshot', async () => {
    useCodexQuotaStore.getState().set('agent-a', makeSnapshot([
      { id: 'five_hour', label: '5h', usedPercent: 42, windowDurationMins: 300, resetAt: Date.now() + 60_000 },
    ]));

    await act(async () => {
      root.render(<CodexQuotaBadges sessionId="codex-session" agentId="agent-a" />);
    });

    expect(container.textContent).toContain('5h');
    expect(container.textContent).toContain('42%');
    expect(container.textContent).not.toContain('7d');
    expect(container.textContent).not.toContain('--');
  });

  it('renders nothing when the quota snapshot has no usable windows', async () => {
    useCodexQuotaStore.getState().set('agent-a', makeSnapshot([]));

    await act(async () => {
      root.render(<CodexQuotaBadges sessionId="codex-session" agentId="agent-a" />);
    });

    expect(container.textContent).toBe('');
  });
});

function makeSnapshot(windows: CodexQuotaSnapshot['windows']): CodexQuotaSnapshot {
  return {
    source: 'app-server',
    fetchedAt: Date.now(),
    ttlMs: 5 * 60 * 1000,
    stale: false,
    windows,
  };
}
