// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonRestartSection } from './DaemonRestartSection';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockState = vi.hoisted(() => ({
  agentConnections: {} as Record<string, { state: string }>,
  busCommand: vi.fn(),
}));

vi.mock('../../stores/connectionStore', () => ({
  useConnectionStore: (selector: (state: unknown) => unknown) =>
    selector({ agentConnections: mockState.agentConnections }),
}));

vi.mock('../../lib/busRegistry', () => ({
  getBusForAgent: (agentId: string) => (
    mockState.agentConnections[agentId] ? { command: mockState.busCommand } : null
  ),
}));

const messages = {
  'settings.daemonRestart.button': 'Restart background daemon',
  'settings.daemonRestart.description': 'Restarts the daemon.',
  'settings.daemonRestart.restarting': 'Restarting…',
  'settings.daemonRestart.confirm.title': 'Restart?',
  'settings.daemonRestart.confirm.message': 'The connection drops briefly.',
  'settings.daemonRestart.confirm.button': 'Restart',
  'common.cancel': 'Cancel',
};

describe('DaemonRestartSection', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mockState.agentConnections = { 'agent-a': { state: 'connected' } };
    mockState.busCommand.mockResolvedValue({ success: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    await act(async () => {
      root.render(
        <IntlProvider locale="en" messages={messages}>
          <DaemonRestartSection />
        </IntlProvider>,
      );
    });
  }

  it('sends agent:restart to the connected machine after confirmation', async () => {
    await render();
    const button = Array.from(container.querySelectorAll('button'))
      .find((el) => el.textContent === 'Restart background daemon')!;
    expect(button.disabled).toBe(false);

    await act(async () => { button.click(); });
    expect(container.textContent).toContain('Restart?');
    expect(mockState.busCommand).not.toHaveBeenCalled();

    const confirmButton = Array.from(container.querySelectorAll('button'))
      .find((el) => el.textContent === 'Restart' && !el.disabled)!;
    await act(async () => { confirmButton.click(); });

    expect(mockState.busCommand).toHaveBeenCalledWith(
      'agent:restart',
      {},
      { timeoutMs: 30_000, queueWhileDisconnected: false },
    );
    expect(container.textContent).toContain('Restarting…');
  });

  it('is disabled while no machine is connected', async () => {
    mockState.agentConnections = {};
    await render();
    const button = Array.from(container.querySelectorAll('button'))
      .find((el) => el.textContent === 'Restart background daemon')!;
    expect(button.disabled).toBe(true);
  });

  it('surfaces a daemon error and stays actionable', async () => {
    mockState.busCommand.mockResolvedValue({ success: false, error: 'Restart is only available for dev builds' });
    await render();
    const button = Array.from(container.querySelectorAll('button'))
      .find((el) => el.textContent === 'Restart background daemon')!;
    await act(async () => { button.click(); });
    const confirmButton = Array.from(container.querySelectorAll('button'))
      .find((el) => el.textContent === 'Restart' && !el.disabled)!;
    await act(async () => { confirmButton.click(); });

    expect(container.textContent).toContain('Restart is only available for dev builds');
    expect(button.disabled).toBe(false);
  });
});
