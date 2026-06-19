// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageBusClient } from '@sumicom/quicksave-message-bus';
import { useGitStore } from '../stores/gitStore';
import type { WebSocketClient } from '../lib/websocket';
import { useGitOperations } from './useGitOperations';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type GitOps = ReturnType<typeof useGitOperations>;

function Harness({
  clientRef,
  getBus,
  getAgentId,
  onRender,
}: {
  clientRef: React.RefObject<WebSocketClient | null>;
  getBus: () => MessageBusClient | null;
  getAgentId: () => string | null;
  onRender: (ops: GitOps) => void;
}) {
  const ops = useGitOperations(clientRef, getBus, getAgentId);
  onRender(ops);
  return null;
}

describe('useGitOperations', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    localStorage.clear();
    useGitStore.getState().reset();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    useGitStore.getState().reset();
    vi.restoreAllMocks();
  });

  it('keeps bound-agent git responses when the global active agent changes mid-flight', async () => {
    let activeAgentId = 'agent-b';
    let latestOps: GitOps | null = null;
    const command = vi.fn(async () => {
      activeAgentId = 'agent-c';
      return {
        branch: 'main',
        ahead: 0,
        behind: 0,
        staged: [],
        unstaged: [],
        untracked: [],
        __repoPath: '/repo-a',
      };
    });
    const bus = { command } as unknown as MessageBusClient;
    const clientRef = {
      current: {
        getActiveAgentId: () => activeAgentId,
      } as unknown as WebSocketClient,
    };

    useGitStore.getState().setCurrentRepoPath('/repo-a');

    await act(async () => {
      root.render(
        <Harness
          clientRef={clientRef}
          getBus={() => bus}
          getAgentId={() => 'agent-a'}
          onRender={(ops) => { latestOps = ops; }}
        />,
      );
    });

    await act(async () => {
      await latestOps?.fetchStatus();
    });

    expect(command).toHaveBeenCalledWith(
      'git:status',
      { __repoPath: '/repo-a' },
      expect.objectContaining({ timeoutMs: 30000, queueWhileDisconnected: true }),
    );
    expect(useGitStore.getState().status?.branch).toBe('main');
    expect(useGitStore.getState().error).toBeNull();
  });
});
