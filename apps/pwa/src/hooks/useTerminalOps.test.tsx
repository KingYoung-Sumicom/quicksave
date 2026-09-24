// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MessageBusClient } from '@sumicom/quicksave-message-bus';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTerminalOps } from './useTerminalOps';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('useTerminalOps commands', () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    if (root) act(() => root.unmount());
    container?.remove();
  });

  async function renderOps(command: ReturnType<typeof vi.fn> | null) {
    let ops!: ReturnType<typeof useTerminalOps>;
    function Probe() {
      ops = useTerminalOps(() => command ? ({ command } as unknown as MessageBusClient) : null);
      return null;
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(<Probe />); });
    return ops;
  }

  it('does not queue a terminal create while disconnected', async () => {
    const command = vi.fn().mockRejectedValue(new Error('Transport is disconnected'));
    const ops = await renderOps(command);
    await expect(ops.createTerminal({ cwd: '/work' })).rejects.toThrow('Transport is disconnected');
    expect(command).toHaveBeenCalledWith('terminal:create', { cwd: '/work' }, { timeoutMs: 15000 });
  });

  it('rejects terminal failures returned in a successful bus response', async () => {
    const command = vi.fn().mockResolvedValue({ success: false, error: 'Terminal has exited' });
    const ops = await renderOps(command);
    await expect(ops.sendInput('term-1', 'x')).rejects.toThrow('Terminal has exited');
    await expect(ops.closeTerminal('term-1', true)).rejects.toThrow('Terminal has exited');
  });

  it('rejects immediately when no agent bus exists', async () => {
    const ops = await renderOps(null);
    await expect(ops.sendInput('term-1', 'x')).rejects.toThrow('Not connected');
  });

  it('buffers updates until a fresh snapshot arrives for a shared subscription', async () => {
    let resolveSnapshot!: (snapshot: unknown) => void;
    let callbacks!: {
      onSnapshot: (snapshot: unknown) => void;
      onUpdate: (chunk: unknown) => void;
      replayCachedSnapshot?: boolean;
      acceptStaleSnapshots?: boolean;
    };
    const bus = {
      subscribe: vi.fn((_path, nextCallbacks) => {
        callbacks = nextCallbacks;
        return vi.fn();
      }),
      getSnapshot: vi.fn(() => new Promise((resolve) => { resolveSnapshot = resolve; })),
      command: vi.fn(),
    } as unknown as MessageBusClient;
    let ops!: ReturnType<typeof useTerminalOps>;
    function Probe() {
      ops = useTerminalOps(() => bus);
      return null;
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(<Probe />); });

    const events: string[] = [];
    const unsubscribe = ops.subscribeOutput('term-1', {
      onSnapshot: (snapshot) => events.push(`snapshot:${snapshot?.seq}`),
      onChunk: (chunk) => events.push(`chunk:${chunk.seq}`),
    });
    expect(callbacks.replayCachedSnapshot).toBe(false);
    expect(callbacks.acceptStaleSnapshots).toBe(true);
    callbacks.onUpdate({ terminalId: 'term-1', seq: 11, chunk: 'new' });
    expect(events).toEqual([]);

    await act(async () => {
      resolveSnapshot({ terminalId: 'term-1', seq: 10, buffer: 'old', cols: 80, rows: 24, exited: false });
    });
    expect(events).toEqual(['snapshot:10', 'chunk:11']);
    callbacks.onSnapshot({ terminalId: 'term-1', seq: 9, buffer: 'stale', cols: 80, rows: 24, exited: false });
    expect(events).toEqual(['snapshot:10', 'chunk:11']);
    unsubscribe();
  });
});
