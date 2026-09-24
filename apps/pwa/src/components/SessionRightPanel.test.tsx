// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionRightPanel } from './SessionRightPanel';
import { useSessionRightPanelStore } from '../stores/sessionRightPanelStore';

vi.mock('../hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('SessionRightPanel responsive layout', () => {
  afterEach(() => {
    useSessionRightPanelStore.setState({ activeSessionId: null, sessionStates: {} });
  });

  it('mounts the opened agent view in the existing right-side mobile drawer', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 });
    useSessionRightPanelStore.setState({
      activeSessionId: 'session-mobile',
      panelWidth: 520,
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
      expect((panel as HTMLElement).style.width).toBe('400px');
      expect(container.querySelector('[aria-label="Close session panel"]')).not.toBeNull();
      expect(container.textContent).toContain('Agents');
    } finally {
      await act(async () => root.unmount());
      container.remove();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
    }
  });

  it('uses the desktop split-panel width without a mobile backdrop', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    useSessionRightPanelStore.setState({
      activeSessionId: 'session-desktop',
      panelWidth: 420,
      sessionStates: {
        'session-desktop': {
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
        desktop: true,
        sessionId: 'session-desktop',
        agentId: 'agent-desktop',
        cwd: '/repo',
        sessionOps: {} as never,
        voiceAgent: { enabled: false, toggle: () => {} } as never,
      })));

      const panel = container.querySelector('[data-testid="session-right-panel"]') as HTMLElement;
      expect(panel.style.width).toBe('420px');
      expect(container.querySelector('[aria-label="Close session panel"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
