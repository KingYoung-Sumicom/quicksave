// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalView } from './TerminalView';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const terminalMocks = vi.hoisted(() => ({
  onData: null as ((data: string) => void) | null,
  sendInput: vi.fn(),
  resizeTerminal: vi.fn(),
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options = { fontSize: 13 };
    cols = 80;
    rows = 24;
    textarea = document.createElement('textarea');
    loadAddon() {}
    open(container: HTMLElement) { container.appendChild(document.createElement('div')); }
    onData(handler: (data: string) => void) {
      terminalMocks.onData = handler;
      return { dispose() {} };
    }
    reset() {}
    resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; }
    write(_data: string, callback?: () => void) { callback?.(); }
    writeln() {}
    focus() {}
    dispose() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('../../hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));
vi.mock('../../hooks/useTerminalOps', () => ({
  useTerminalOps: () => ({
    sendInput: terminalMocks.sendInput,
    resizeTerminal: terminalMocks.resizeTerminal,
    subscribeOutput: () => () => {},
  }),
}));

describe('TerminalView command failures', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    terminalMocks.onData = null;
    terminalMocks.sendInput.mockReset();
    terminalMocks.resizeTerminal.mockReset().mockResolvedValue({ success: true });
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<TerminalView terminalId="term-1" getBus={() => null} />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('shows an input rejection until the user dismisses it', async () => {
    terminalMocks.sendInput.mockRejectedValueOnce(new Error('Terminal has exited'));
    await act(async () => { terminalMocks.onData?.('x'); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Terminal has exited');

    terminalMocks.sendInput.mockResolvedValueOnce({ success: true });
    await act(async () => { terminalMocks.onData?.('y'); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Terminal has exited');

    await act(async () => { (container.querySelector('[aria-label="Dismiss terminal error"]') as HTMLButtonElement).click(); });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
