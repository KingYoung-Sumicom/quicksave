// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionRightPanel } from './SessionRightPanel';
import { useSessionRightPanelStore } from '../stores/sessionRightPanelStore';

vi.mock('../hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('SessionRightPanel mobile layout', () => {
  afterEach(() => {
    useSessionRightPanelStore.setState({ activeSessionId: null, sessionStates: {} });
  });

  it('mounts the opened agent view in the existing right-side mobile drawer', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    useSessionRightPanelStore.setState({
      activeSessionId: 'session-mobile',
      sessionStates: {
        'session-mobile': {
          mode: 'subagents',
          filesRelPath: '',
          filesPreview: null,
          artifactPreview: null,
          gitRepoOverride: null,
        },
      },
    });

    try {
      await act(async () => root.render(React.createElement(SessionRightPanel, {
        sessionId: 'session-mobile',
        agentId: 'agent-mobile',
        cwd: '/repo',
        sessionOps: {} as never,
        voiceAgent: { enabled: false, toggle: () => {} } as never,
      })));

      const panel = container.querySelector('[data-testid="session-right-panel"]');
      expect(panel).not.toBeNull();
      expect(parseFloat((panel as HTMLElement).style.width)).toBeCloseTo(390 * 0.88);
      expect(container.querySelector('[aria-label="Close session panel"]')).not.toBeNull();
      expect(container.textContent).toContain('Agents');
    } finally {
      await act(async () => root.unmount());
      container.remove();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
    }
  });
});
