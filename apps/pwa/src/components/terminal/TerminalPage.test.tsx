// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '../../stores/terminalStore';
import { TerminalPage } from './TerminalPage';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const terminalOps = vi.hoisted(() => ({
  closeTerminal: vi.fn(),
  renameTerminal: vi.fn(),
}));

vi.mock('../../hooks/useTerminalOps', () => ({
  useTerminalOps: () => terminalOps,
}));
vi.mock('./TerminalView', () => ({ TerminalView: () => <div>Terminal screen</div> }));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

describe('TerminalPage action failures', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    terminalOps.closeTerminal.mockReset();
    terminalOps.renameTerminal.mockReset();
    useTerminalStore.setState({ terminals: {
      'term-1': {
        terminalId: 'term-1', machineAgentId: 'machine-a', title: 'Shell',
        cwd: '/work', shell: '/bin/sh', cols: 80, rows: 24,
        createdAt: 1, lastActivityAt: 1, exited: false,
      },
    } });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/p/project-a/t/term-1']}>
          <Routes><Route path="/p/:projectId/t/:terminalId" element={<TerminalPage />} /></Routes>
          <LocationProbe />
        </MemoryRouter>,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useTerminalStore.setState({ terminals: {} });
  });

  it('stays on the terminal and shows the failure when close is rejected', async () => {
    terminalOps.closeTerminal.mockRejectedValueOnce(new Error('Not connected'));
    await act(async () => { (container.querySelector('[aria-label="Terminal actions"]') as HTMLButtonElement).click(); });
    const kill = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Kill terminal')!;
    await act(async () => { kill.click(); });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Not connected');
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe('/p/project-a/t/term-1');
  });

  it('keeps rename editable and reports a rejected rename', async () => {
    terminalOps.renameTerminal.mockRejectedValueOnce(new Error('Rename denied'));
    await act(async () => { (container.querySelector('[title="Rename terminal"]') as HTMLButtonElement).click(); });
    const input = container.querySelector('input') as HTMLInputElement;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(terminalOps.renameTerminal).toHaveBeenCalledWith('term-1', 'Shell');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Rename denied');
    expect(container.querySelector('input')).toBeTruthy();
  });
});
