// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionAppBar } from './SessionAppBar';
import { useSessionRightPanelStore } from '../stores/sessionRightPanelStore';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));
vi.mock('./AgentSettingsDrawer', () => ({
  AgentSettingsDrawer: () => <div data-testid="mobile-settings-drawer" />,
}));

describe('SessionAppBar settings button', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useSessionRightPanelStore.setState({ activeSessionId: null, sessionStates: {} });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useSessionRightPanelStore.setState({ activeSessionId: null, sessionStates: {} });
  });

  async function render(desktop: boolean, onOpenSettings: () => void) {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <SessionAppBar
            desktop={desktop}
            sessionId="route-session"
            showSettings={false}
            onOpenSettings={onOpenSettings}
            onCloseSettings={() => {}}
            onOpenMenu={() => {}}
          />
        </MemoryRouter>,
      );
    });
  }

  it('opens the route session in the desktop split panel without mounting the mobile drawer', async () => {
    const openDrawer = vi.fn();
    await render(true, openDrawer);
    expect(container.querySelector('[data-testid="mobile-settings-drawer"]')).toBeNull();
    await act(async () => {
      (container.querySelector('button[aria-label="Open settings panel"]') as HTMLButtonElement).click();
    });
    const state = useSessionRightPanelStore.getState();
    expect(state.activeSessionId).toBe('route-session');
    expect(state.sessionStates['route-session']?.mode).toBe('settings');
    expect(openDrawer).not.toHaveBeenCalled();
  });

  it('keeps the drawer action on mobile', async () => {
    const openDrawer = vi.fn();
    await render(false, openDrawer);
    expect(container.querySelector('[data-testid="mobile-settings-drawer"]')).not.toBeNull();
    await act(async () => {
      (container.querySelector('button[aria-label="Open drawer"]') as HTMLButtonElement).click();
    });
    expect(openDrawer).toHaveBeenCalledOnce();
    expect(useSessionRightPanelStore.getState().sessionStates['route-session']).toBeUndefined();
  });
});
