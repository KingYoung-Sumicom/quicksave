// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageBusClient } from '@sumicom/quicksave-message-bus';
import { useSessionStore } from '../stores/sessionStore';
import { useUiPrefsStore } from '../stores/uiPrefsStore';
import { useSessionOperations } from './useSessionOperations';

const cacheMocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  clear: vi.fn(),
}));
vi.mock('../lib/sessionHistoryCache', () => ({
  readSessionHistoryCache: cacheMocks.read,
  writeSessionHistoryCache: cacheMocks.write,
  subscribeSessionHistoryCache: cacheMocks.subscribe,
  clearSessionHistoryCache: cacheMocks.clear,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type SessionOps = ReturnType<typeof useSessionOperations>;

function Harness({
  getBus,
  onRender,
}: {
  getBus: () => MessageBusClient | null;
  onRender: (ops: SessionOps) => void;
}) {
  const ops = useSessionOperations(getBus);
  onRender(ops);
  return null;
}

describe('useSessionOperations', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useSessionStore.getState().reset();
    useUiPrefsStore.getState().setSessionHistoryCacheEnabled(true);
    cacheMocks.read.mockClear();
    cacheMocks.write.mockClear();
    cacheMocks.subscribe.mockClear();
    cacheMocks.clear.mockClear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    useSessionStore.getState().reset();
    vi.restoreAllMocks();
  });

  it('refreshes and replaces the cached history for the selected machine', async () => {
    let latestOps: SessionOps | null = null;
    const command = vi.fn().mockResolvedValue({
      success: true,
      entries: [{
        sessionId: 'fresh', cwd: '/repo', agent: 'codex', createdAt: 1, lastAccessedAt: 2,
      }],
    });
    const bus = { command } as unknown as MessageBusClient;
    useSessionStore.getState().setSessions([
      { sessionId: 'stale', machineAgentId: 'machine-a' } as any,
      { sessionId: 'other', machineAgentId: 'machine-b' } as any,
    ]);

    await act(async () => {
      root.render(<Harness getBus={() => bus} onRender={(ops) => { latestOps = ops; }} />);
    });
    await act(async () => {
      await latestOps!.refreshSessionHistory('machine-a');
    });

    expect(command).toHaveBeenCalledWith(
      'session:refresh-history',
      {},
      expect.objectContaining({ timeoutMs: 120000, queueWhileDisconnected: true }),
    );
    expect(Object.keys(useSessionStore.getState().sessions).sort()).toEqual(['fresh', 'other']);
    expect(useSessionStore.getState().sessions.fresh.machineAgentId).toBe('machine-a');
  });

  it('does not switch back to a cold-resumed session if the user navigated away before the response', async () => {
    let latestOps: SessionOps | null = null;
    let resolveCommand: (value: unknown) => void = () => {};
    const command = vi.fn(() => new Promise((resolve) => { resolveCommand = resolve; }));
    const bus = { command } as unknown as MessageBusClient;

    useSessionStore.getState().setSessions([
      { sessionId: 'session-A', summary: 'A', lastModified: 1, isActive: false, isStreaming: false } as any,
      { sessionId: 'session-B', summary: 'B', lastModified: 2, isActive: true, isStreaming: false } as any,
    ]);
    useSessionStore.getState().setActiveSession('session-A');

    await act(async () => {
      root.render(<Harness getBus={() => bus} onRender={(ops) => { latestOps = ops; }} />);
    });

    let resumePromise: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      resumePromise = latestOps!.resumeSession('session-A', 'continue', '/repo');
      await Promise.resolve();
    });

    expect(useSessionStore.getState().cards).toHaveLength(0);

    act(() => {
      useSessionStore.getState().setActiveSession('session-B');
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
    expect(useSessionStore.getState().activeSessionId).toBe('session-B');
    expect(useSessionStore.getState().sessions['session-A'].isStreaming).toBe(true);
    expect(await resumePromise).toBe(true);
    expect(useSessionStore.getState().cards).toHaveLength(0);
  });

  it('gives /compact a longer RPC timeout than a normal resume', async () => {
    let latestOps: SessionOps | null = null;
    const command = vi.fn().mockResolvedValue({ success: true, sessionId: 'session-A' });
    const bus = { command } as unknown as MessageBusClient;
    useSessionStore.getState().setSessions([
      { sessionId: 'session-A', summary: 'A', lastModified: 1, isActive: true, isStreaming: false } as any,
    ]);
    useSessionStore.getState().setActiveSession('session-A');

    await act(async () => {
      root.render(<Harness getBus={() => bus} onRender={(ops) => { latestOps = ops; }} />);
    });

    await act(async () => {
      await latestOps!.resumeSession('session-A', '/compact', '/repo');
    });

    expect(command).toHaveBeenCalledWith(
      'claude:resume',
      { sessionId: 'session-A', prompt: '/compact', cwd: '/repo' },
      expect.objectContaining({ timeoutMs: 600000, queueWhileDisconnected: true }),
    );
    expect(useSessionStore.getState().cards).toHaveLength(0);
    expect(useSessionStore.getState().sessions['session-A'].isStreaming).toBe(false);
    expect(useSessionStore.getState().sessions['session-A'].isCompacting).toBe(false);
  });

  it('sends an explicit active-turn mode only when the user overrides queueing', async () => {
    let latestOps: SessionOps | null = null;
    const command = vi.fn().mockResolvedValue({ success: true, sessionId: 'session-A' });
    const bus = { command } as unknown as MessageBusClient;
    useSessionStore.getState().setSessions([
      { sessionId: 'session-A', summary: 'A', lastModified: 1, isActive: true, isStreaming: true } as any,
    ]);
    useSessionStore.getState().setActiveSession('session-A');
    useSessionStore.getState().setStreaming(true);
    await act(async () => {
      root.render(<Harness getBus={() => bus} onRender={(ops) => { latestOps = ops; }} />);
    });
    await act(async () => {
      await latestOps!.resumeSession('session-A', 'change direction', '/repo', { deliveryMode: 'steer' });
    });
    expect(command).toHaveBeenCalledWith('claude:resume', expect.objectContaining({
      sessionId: 'session-A',
      prompt: 'change direction',
      deliveryMode: 'steer',
    }), expect.anything());
  });

  it('shows prompts submitted during compaction in the existing queued-message state', async () => {
    let latestOps: SessionOps | null = null;
    let resolveCommand: (value: unknown) => void = () => {};
    const command = vi.fn(() => new Promise((resolve) => { resolveCommand = resolve; }));
    const bus = { command } as unknown as MessageBusClient;
    useSessionStore.getState().setSessions([
      {
        sessionId: 'session-A',
        summary: 'A',
        lastModified: 1,
        isActive: true,
        isStreaming: false,
        isCompacting: true,
      } as any,
    ]);
    useSessionStore.getState().setActiveSession('session-A');

    await act(async () => {
      root.render(<Harness getBus={() => bus} onRender={(ops) => { latestOps = ops; }} />);
    });

    let resumePromise: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      resumePromise = latestOps!.resumeSession('session-A', 'continue after compact', '/repo');
      await Promise.resolve();
    });

    expect(useSessionStore.getState().sessions['session-A'].queueState).toMatchObject({
      pendingUserMessages: 1,
      queuedPromptPreviews: ['continue after compact'],
    });
    expect(useSessionStore.getState().cards).toHaveLength(0);

    await act(async () => {
      resolveCommand({
        success: true,
        sessionId: 'session-A',
        queueState: {
          pendingUserMessages: 1,
          latestPromptPreview: 'continue after compact',
          queuedPromptPreviews: ['continue after compact'],
          queuedPromptIds: ['queued-1'],
          canInterruptCurrentTurn: false,
        },
      });
      await resumePromise;
    });

    expect(useSessionStore.getState().sessions['session-A'].queueState?.queuedPromptIds).toEqual(['queued-1']);
    expect(useSessionStore.getState().cards).toHaveLength(0);
  });

  it('adds the user card only after an acknowledged resume', async () => {
    let latestOps: SessionOps | null = null;
    let resolveCommand: (value: unknown) => void = () => {};
    const command = vi.fn(() => new Promise((resolve) => { resolveCommand = resolve; }));
    const bus = { command } as unknown as MessageBusClient;
    useSessionStore.getState().setSessions([
      { sessionId: 'session-A', summary: 'A', lastModified: 1, isActive: true, isStreaming: false } as any,
    ]);
    useSessionStore.getState().setActiveSession('session-A');

    await act(async () => {
      root.render(<Harness getBus={() => bus} onRender={(ops) => { latestOps = ops; }} />);
    });

    let resumePromise: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      resumePromise = latestOps!.resumeSession('session-A', 'show after ack', '/repo');
      await Promise.resolve();
    });
    expect(useSessionStore.getState().cards).toHaveLength(0);

    await act(async () => {
      resolveCommand({ success: true, sessionId: 'session-A' });
      await resumePromise;
    });
    expect(useSessionStore.getState().cards).toEqual([
      expect.objectContaining({ type: 'user', text: 'show after ack' }),
    ]);
  });

  it('returns false when the agent does not acknowledge a resume command', async () => {
    let latestOps: SessionOps | null = null;
    const command = vi.fn().mockResolvedValue({ success: false, error: 'agent rejected prompt' });
    const bus = { command } as unknown as MessageBusClient;
    useSessionStore.getState().setSessions([
      { sessionId: 'session-A', summary: 'A', lastModified: 1, isActive: true, isStreaming: false } as any,
    ]);
    useSessionStore.getState().setActiveSession('session-A');

    await act(async () => {
      root.render(<Harness getBus={() => bus} onRender={(ops) => { latestOps = ops; }} />);
    });

    let acknowledged = true;
    await act(async () => {
      acknowledged = await latestOps!.resumeSession('session-A', 'keep this', '/repo');
    });

    expect(acknowledged).toBe(false);
    expect(useSessionStore.getState().streamError).toBe('agent rejected prompt');
    expect(useSessionStore.getState().cards).toHaveLength(0);
  });

  it('returns the agent-issued cursor when loading older card history', async () => {
    let latestOps: SessionOps | null = null;
    const command = vi.fn().mockResolvedValue({
      cards: [],
      total: 100,
      hasMore: true,
      nextCursor: 'memory-ordinal:25',
    });
    const bus = { command } as unknown as MessageBusClient;
    useSessionStore.setState({ historyCursor: 'memory-ordinal:50' });

    await act(async () => {
      root.render(<Harness getBus={() => bus} onRender={(ops) => { latestOps = ops; }} />);
    });
    await act(async () => {
      await latestOps!.getSessionCards('session-A', 123, 50, '/repo');
    });

    expect(command).toHaveBeenCalledWith(
      'claude:get-cards',
      {
        sessionId: 'session-A',
        offset: 123,
        limit: 50,
        cursor: 'memory-ordinal:50',
        cwd: '/repo',
      },
      expect.objectContaining({ timeoutMs: 30000, queueWhileDisconnected: true }),
    );
    expect(useSessionStore.getState().historyCursor).toBe('memory-ordinal:25');
  });

  it('does not restore cached session cards when local history cache is disabled', async () => {
    let latestOps: SessionOps | null = null;
    const bus = { subscribe: vi.fn(() => () => {}) } as unknown as MessageBusClient;
    useSessionStore.setState({ activeSessionId: 'session-A' });
    useUiPrefsStore.getState().setSessionHistoryCacheEnabled(false);

    await act(async () => {
      root.render(<Harness getBus={() => bus} onRender={(ops) => { latestOps = ops; }} />);
    });
    await act(async () => {
      await latestOps!.getSessionCards('session-A');
    });

    expect(cacheMocks.read).not.toHaveBeenCalled();
    expect(useSessionStore.getState().cards).toEqual([]);
  });
});
