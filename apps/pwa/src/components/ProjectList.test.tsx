// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageBusClient } from '@sumicom/quicksave-message-bus';
import { registerAgentBusGetter } from '../lib/busRegistry';
import { useSessionStore, type StoredSessionSummary } from '../stores/sessionStore';
import enMessages from '../i18n/messages/en.json';
import { ProjectList } from './ProjectList';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../hooks/useProjects', () => ({
  useProjects: () => [
    { projectId: 'project-a', agentId: 'machine-a', cwd: '/work/a', displayName: 'A' },
    { projectId: 'project-b', agentId: 'machine-b', cwd: '/work/b', displayName: 'B' },
  ],
}));

describe('ProjectList session context menu', () => {
  let container: HTMLDivElement;
  let root: Root;
  const commandA = vi.fn();
  const commandB = vi.fn();

  beforeEach(async () => {
    useSessionStore.getState().reset();
    const sessions: Record<string, StoredSessionSummary> = {
      'session-a': {
        sessionId: 'session-a', summary: 'Running task', lastModified: 2,
        cwd: '/work/a', machineAgentId: 'machine-a', isStreaming: true,
      },
      'session-b': {
        sessionId: 'session-b', summary: 'Idle task', lastModified: 1,
        cwd: '/work/b', machineAgentId: 'machine-b', isStreaming: false,
      },
    };
    useSessionStore.setState({ sessions, activeSessionId: 'session-b' });
    commandA.mockResolvedValue({ success: true });
    commandB.mockResolvedValue({ success: true });
    registerAgentBusGetter((agentId) => ({
      command: agentId === 'machine-a' ? commandA : commandB,
    }) as unknown as MessageBusClient);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <IntlProvider locale="en" messages={enMessages}>
          <MemoryRouter><ProjectList compact /></MemoryRouter>
        </IntlProvider>,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    registerAgentBusGetter(() => null);
    useSessionStore.getState().reset();
    vi.clearAllMocks();
  });

  const openMenu = async (container: HTMLElement, title: string) => {
    const card = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes(title));
    expect(card).toBeDefined();
    await act(async () => {
      card!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: 80 }));
    });
    return document.querySelector('[role="menu"]') as HTMLElement;
  };

  it('routes Stop to the selected machine and only enables it for a running task', async () => {
    const runningMenu = await openMenu(container, 'Running task');
    const stop = Array.from(runningMenu.querySelectorAll('button')).find((button) => button.textContent === 'Stop')!;
    expect(stop.disabled).toBe(false);
    await act(async () => { stop.click(); });
    expect(commandA).toHaveBeenCalledWith('claude:cancel', { sessionId: 'session-a' }, {
      timeoutMs: 30_000, queueWhileDisconnected: true,
    });
    expect(commandB).not.toHaveBeenCalled();

    const idleMenu = await openMenu(container, 'Idle task');
    const idleStop = Array.from(idleMenu.querySelectorAll('button')).find((button) => button.textContent === 'Stop')!;
    expect(idleStop.disabled).toBe(true);
    const idleEndTask = Array.from(idleMenu.querySelectorAll('button')).find((button) => button.textContent === 'End Task')!;
    expect(idleEndTask.disabled).toBe(false);
  });

  it('ends the right-clicked task without changing the selected session', async () => {
    useSessionStore.setState({ isStreaming: true });
    const menu = await openMenu(container, 'Running task');
    const endTask = Array.from(menu.querySelectorAll('button')).find((button) => button.textContent === 'End Task')!;
    await act(async () => { endTask.click(); });
    expect(commandA).toHaveBeenCalledWith('claude:end-task', { sessionId: 'session-a' }, {
      timeoutMs: 30_000, queueWhileDisconnected: true,
    });
    expect(useSessionStore.getState().activeSessionId).toBe('session-b');
    expect(useSessionStore.getState().isStreaming).toBe(true);
    expect(commandB).not.toHaveBeenCalled();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('updates compact session groups as a task starts needing attention', async () => {
    const groupNames = () => Array.from(container.querySelectorAll('section h3'))
      .map((heading) => heading.textContent?.replace(/\d+$/, '').trim());
    expect(groupNames()).toEqual(['In progress', 'Recent']);

    const session = useSessionStore.getState().sessions['session-a'];
    await act(async () => useSessionStore.setState((state) => ({
      sessions: { ...state.sessions, 'session-a': { ...session, hasPendingInput: true } },
    })));
    expect(groupNames()).toEqual(['Needs attention', 'Recent']);
    expect(container.textContent).toContain('Running task');
    expect(container.textContent).toContain('Idle task');
  });

  it('shows the same grouped navigation and filters on the full-width mobile list', async () => {
    await act(async () => {
      root.render(
        <IntlProvider locale="en" messages={enMessages}>
          <MemoryRouter><ProjectList /></MemoryRouter>
        </IntlProvider>,
      );
    });

    expect(Array.from(container.querySelectorAll('section h3')).map((heading) => heading.textContent?.replace(/\d+$/, '').trim()))
      .toEqual(['In progress', 'Recent']);
    expect(container.querySelector('h2')).toBeNull();
    expect(container.querySelector('button[aria-pressed="true"]')?.textContent).toContain('Sessions');
    expect(container.querySelectorAll('section button')).toHaveLength(2);

    const toggle = container.querySelector('button[aria-controls="session-list-filters"]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('#session-list-filters')).toBeNull();
    await act(async () => { toggle.click(); });
    const filterRow = container.querySelector('#session-list-filters .grid') as HTMLElement;
    expect(filterRow.className).toContain('grid-cols-2');
    const dropdowns = filterRow.querySelectorAll('button[aria-haspopup="listbox"]');
    expect(dropdowns).toHaveLength(2);

    await act(async () => { (dropdowns[1] as HTMLButtonElement).click(); });
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    await act(async () => { (dropdowns[1] as HTMLButtonElement).click(); });
    const projectOption = Array.from(container.querySelectorAll('[role="option"]'))
      .find((option) => option.textContent?.includes('· B')) as HTMLButtonElement;
    expect(projectOption).toBeDefined();
    await act(async () => { projectOption.click(); });
    expect(container.textContent).not.toContain('Running task');
    expect(container.textContent).toContain('Idle task');
    expect(toggle.textContent).toContain('1 active');
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('1 active');
  });
});
