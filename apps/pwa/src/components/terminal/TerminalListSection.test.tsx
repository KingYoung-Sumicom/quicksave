// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageBusClient } from '@sumicom/quicksave-message-bus';
import { registerAgentBusGetter } from '../../lib/busRegistry';
import { useMachineStore, type Machine } from '../../stores/machineStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { TerminalListSection } from './TerminalListSection';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../hooks/useProjects', () => ({
  useProjects: () => [
    { projectId: 'project-a', agentId: 'machine-a', cwd: '/work/alpha', displayName: 'Alpha' },
    { projectId: 'project-b', agentId: 'machine-b', cwd: '/work/beta', displayName: 'Beta' },
  ],
}));

const machine = (agentId: string, nickname: string): Machine => ({
  agentId,
  nickname,
  publicKey: '',
  icon: '',
  updatedAt: 0,
  addedAt: 0,
  lastConnectedAt: null,
  lastRepoPath: null,
  knownRepos: [],
  knownCodingPaths: [],
  isPro: false,
  cachedProjects: {},
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

describe('TerminalListSection new terminal picker', () => {
  let container: HTMLDivElement;
  let root: Root;
  const commandA = vi.fn();
  const commandB = vi.fn();

  beforeEach(async () => {
    useMachineStore.setState({ machines: [machine('machine-a', 'Mac'), machine('machine-b', 'Server'), machine('machine-c', 'Empty')] });
    useTerminalStore.setState({ terminals: {} });
    commandA.mockResolvedValue({ success: true, terminal: { terminalId: 'terminal-a' } });
    commandB.mockResolvedValue({ success: true, terminal: { terminalId: 'terminal-b' } });
    registerAgentBusGetter((agentId) => ({
      command: agentId === 'machine-a' ? commandA : commandB,
    }) as unknown as MessageBusClient);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<MemoryRouter><TerminalListSection /><LocationProbe /></MemoryRouter>);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    registerAgentBusGetter(() => null);
    useMachineStore.setState({ machines: [] });
    vi.clearAllMocks();
  });

  const clickButton = async (container: HTMLElement, label: string) => {
    const button = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes(label));
    expect(button, `button containing ${label}`).toBeDefined();
    await act(async () => { button!.click(); });
  };

  it('opens on machines, filters projects, and creates on the chosen machine', async () => {
    await clickButton(container, 'New terminal');
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain('Mac');
    expect(dialog.textContent).toContain('Server');
    expect(dialog.textContent).not.toContain('Alpha');

    await clickButton(dialog, 'Mac');
    expect(dialog.textContent).toContain('Alpha');
    expect(dialog.textContent).not.toContain('Beta');
    expect(commandA).not.toHaveBeenCalled();

    await act(async () => { (dialog.querySelector('[aria-label="Back to machines"]') as HTMLButtonElement).click(); });
    await clickButton(dialog, 'Server');
    expect(dialog.textContent).toContain('Beta');
    expect(dialog.textContent).not.toContain('Alpha');

    await clickButton(dialog, 'Beta');
    expect(commandB).toHaveBeenCalledWith('terminal:create', { cwd: '/work/beta' }, {
      timeoutMs: 15000,
    });
    expect(commandA).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe('/p/project-b/t/terminal-b');
  });

  it('shows the empty project state and can return to machines', async () => {
    await clickButton(container, 'New terminal');
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    await clickButton(dialog, 'Empty');
    expect(dialog.textContent).toContain('No projects on this machine yet.');
    await act(async () => { (dialog.querySelector('[aria-label="Back to machines"]') as HTMLButtonElement).click(); });
    expect(dialog.textContent).toContain('Mac');
    expect(commandA).not.toHaveBeenCalled();
    expect(commandB).not.toHaveBeenCalled();
  });

  it('keeps the project picker open when terminal creation fails', async () => {
    commandA.mockRejectedValueOnce(new Error('Not connected'));
    await clickButton(container, 'New terminal');
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    await clickButton(dialog, 'Mac');
    await clickButton(dialog, 'Alpha');
    expect(dialog.textContent).toContain('Not connected');
    expect(dialog.textContent).toContain('Alpha');
    expect(dialog.querySelector('[role="alert"]')).toBeTruthy();
  });
});
