// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useConnectionStore } from '../../stores/connectionStore';
import { StreamingReconnectIndicator } from './StreamingReconnectIndicator';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('StreamingReconnectIndicator', () => {
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

  it('uses only the session machine state when another machine reconnects', async () => {
    useConnectionStore.getState().setAgentConnecting('machine-a');
    useConnectionStore.getState().setAgentConnected('machine-a', '/repo', false);
    useConnectionStore.getState().setAgentConnecting('machine-b');
    useConnectionStore.getState().setAgentReconnecting('machine-b', 2, 5);

    await act(async () => {
      root.render(<StreamingReconnectIndicator agentId="machine-a" />);
    });

    expect(container.textContent).toBe('');
  });

  it('shows reconnecting when the owning machine is reconnecting', async () => {
    useConnectionStore.getState().setAgentConnecting('machine-a');
    useConnectionStore.getState().setAgentReconnecting('machine-a', 2, 5);

    await act(async () => {
      root.render(<StreamingReconnectIndicator agentId="machine-a" />);
    });

    expect(container.textContent).toContain('重新連線中… (2/5)');
  });

  it('ignores another machine going offline or entering an error state', async () => {
    useConnectionStore.getState().setAgentConnecting('machine-a');
    useConnectionStore.getState().setAgentConnected('machine-a', '/repo', false);
    useConnectionStore.getState().setAgentConnecting('machine-b');
    useConnectionStore.getState().setAgentOnlineFor('machine-b', false);
    useConnectionStore.getState().setAgentError('machine-b', 'unreachable');

    await act(async () => {
      root.render(<StreamingReconnectIndicator agentId="machine-a" />);
    });

    expect(container.textContent).toBe('');
  });
});
