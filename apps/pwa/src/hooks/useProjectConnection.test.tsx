// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMachineStore } from '../stores/machineStore';
import { useConnectionStore } from '../stores/connectionStore';
import { useProjectConnection } from './useProjectConnection';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('useProjectConnection machine-scoped reconnect readiness', () => {
  let container: HTMLDivElement;
  let root: Root;
  let result: ReturnType<typeof useProjectConnection> | undefined;
  const onConnect = vi.fn();
  const onSwitchMachine = vi.fn();

  function Harness({ projectId }: { projectId: string }) {
    const value = useProjectConnection(projectId, onConnect, onSwitchMachine);
    useEffect(() => { result = value; });
    return null;
  }

  beforeEach(() => {
    useConnectionStore.getState().reset();
    useConnectionStore.setState({ agentConnections: {} });
    onConnect.mockClear();
    onSwitchMachine.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useConnectionStore.getState().reset();
  });

  function installMachines(...agentIds: string[]) {
    const machines = agentIds.map((agentId) => ({
      agentId,
      publicKey: 'key',
      nickname: agentId,
      icon: 'computer',
      updatedAt: 0,
      addedAt: 0,
      lastConnectedAt: null,
      lastRepoPath: null,
      knownRepos: [],
      knownCodingPaths: [],
      isPro: false,
      cachedProjects: {},
    }));
    useMachineStore.setState({ machines, getMachine: (id) => machines.find((m) => m.agentId === id) });
  }

  it('keeps a warmed target ready during reconnect', async () => {
    installMachines('machine-a');
    useConnectionStore.getState().setAgentConnecting('machine-a');
    useConnectionStore.getState().setAgentConnected('machine-a', '/repo', false);
    useConnectionStore.getState().setAgentReconnecting('machine-a', 1, 3);

    await act(async () => { root.render(<Harness projectId="machine-a:repo" />); });

    expect(result?.isReady).toBe(true);
    expect(result?.isConnecting).toBe(true);
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('waits for a cold target while reconnecting', async () => {
    installMachines('machine-a');
    useConnectionStore.getState().setAgentConnecting('machine-a');
    useConnectionStore.getState().setAgentReconnecting('machine-a', 1, 3);

    await act(async () => { root.render(<Harness projectId="machine-a:repo" />); });

    expect(result?.isReady).toBe(false);
    expect(result?.isConnecting).toBe(true);
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('connects the new target when switching away from a cold connecting machine', async () => {
    installMachines('machine-a', 'machine-b');

    await act(async () => { root.render(<Harness projectId="machine-a:repo" />); });
    expect(onConnect).toHaveBeenCalledWith('machine-a', 'key');

    await act(async () => { root.render(<Harness projectId="machine-b:repo" />); });

    expect(onConnect).toHaveBeenNthCalledWith(2, 'machine-b', 'key');
  });
});
