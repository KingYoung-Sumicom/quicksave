// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageBusClient } from '@sumicom/quicksave-message-bus';
import { useClaudeStore } from '../stores/claudeStore';
import { useClaudeOperations } from './useClaudeOperations';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ClaudeOps = ReturnType<typeof useClaudeOperations>;

function Harness({
  getBus,
  onRender,
}: {
  getBus: () => MessageBusClient | null;
  onRender: (ops: ClaudeOps) => void;
}) {
  const ops = useClaudeOperations(getBus);
  onRender(ops);
  return null;
}

describe('useClaudeOperations', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useClaudeStore.getState().reset();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    useClaudeStore.getState().reset();
    vi.restoreAllMocks();
  });

  it('does not switch back to a cold-resumed session if the user navigated away before the response', async () => {
    let latestOps: ClaudeOps | null = null;
    let resolveCommand: (value: unknown) => void = () => {};
    const command = vi.fn(() => new Promise((resolve) => { resolveCommand = resolve; }));
    const bus = { command } as unknown as MessageBusClient;

    useClaudeStore.getState().setSessions([
      { sessionId: 'session-A', summary: 'A', lastModified: 1, isActive: false, isStreaming: false } as any,
      { sessionId: 'session-B', summary: 'B', lastModified: 2, isActive: true, isStreaming: false } as any,
    ]);
    useClaudeStore.getState().setActiveSession('session-A');

    await act(async () => {
      root.render(<Harness getBus={() => bus} onRender={(ops) => { latestOps = ops; }} />);
    });

    let resumePromise: Promise<void> = Promise.resolve();
    await act(async () => {
      resumePromise = latestOps!.resumeSession('session-A', 'continue', '/repo');
      await Promise.resolve();
    });

    act(() => {
      useClaudeStore.getState().setActiveSession('session-B');
    });

    await act(async () => {
      resolveCommand({ success: true, sessionId: 'session-A' });
      await resumePromise;
    });

    expect(command).toHaveBeenCalledWith(
      'claude:resume',
      { sessionId: 'session-A', prompt: 'continue', cwd: '/repo' },
      expect.objectContaining({ timeoutMs: 120000, queueWhileDisconnected: true }),
    );
    expect(useClaudeStore.getState().activeSessionId).toBe('session-B');
    expect(useClaudeStore.getState().sessions['session-A'].isStreaming).toBe(true);
  });
});
