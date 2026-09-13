// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConnectionStore } from '../stores/connectionStore';
import { ConnectingOverlay, ConnectingStages } from './ConnectingOverlay';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const messages = {
  'connecting.title.reconnecting': 'Reconnecting',
  'connecting.title.agentOffline': 'Agent offline',
  'connecting.title.handshake': 'Handshake',
  'connecting.subtitle.reconnecting': 'Trying again',
  'connecting.subtitle.agentOffline': 'Waiting for agent',
  'connecting.subtitle.checkingAgent': 'Checking agent',
  'connecting.subtitle.keyExchangeAttempt': 'Key exchange attempt {attempt}',
  'connecting.subtitle.handshake': 'Finishing handshake',
  'connecting.subtitle.fallback': 'Connecting',
  'connecting.step.server': 'Server',
  'connecting.step.agent': 'Agent',
  'connecting.step.key': 'Key',
  'connecting.step.secure': 'Secure',
};

describe('ConnectingOverlay machine scoping', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useConnectionStore.getState().reset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useConnectionStore.getState().reset();
  });

  it('hides the overlay when the target machine is connected despite another error', async () => {
    useConnectionStore.getState().setAgentConnecting('target');
    useConnectionStore.getState().setAgentConnected('target', '/repo', false);
    useConnectionStore.getState().setAgentError('other', 'other machine failed');

    await act(async () => {
      root.render(
        <IntlProvider locale="en" messages={messages}>
          <ConnectingOverlay agentId="target" onAbort={vi.fn()} onRetry={vi.fn()} />
        </IntlProvider>,
      );
    });

    expect(container.textContent).toBe('');
  });

  it('shows the target handshake stage and ignores another machine offline state', async () => {
    useConnectionStore.getState().setAgentConnecting('target');
    useConnectionStore.getState().setAgentConnectionStep('target', 'handshake');
    useConnectionStore.getState().setAgentConnecting('other');
    useConnectionStore.getState().setAgentOnlineFor('other', false);
    useConnectionStore.getState().setAgentError('other', 'other machine failed');

    await act(async () => {
      root.render(
        <IntlProvider locale="en" messages={messages}>
          <ConnectingStages agentId="target" />
        </IntlProvider>,
      );
    });

    expect(container.textContent).toContain('Handshake');
    expect(container.textContent).not.toContain('Agent offline');
  });
});
