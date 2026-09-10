// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useEffect, useRef } from 'react';
import { useConnectionStore } from '../stores/connectionStore';
import { useMachineStore } from '../stores/machineStore';
import { fromProjectId, resolveProjectCwd } from '../lib/projectId';

/**
 * Ensures we're connected to the correct agent for a given projectId.
 * In multi-agent mode, checks the per-agent connection state.
 * If not connected, triggers connect. Returns connection readiness + resolved cwd.
 */
export function useProjectConnection(
  projectId: string | undefined,
  onConnect: (agentId: string, publicKey: string) => void,
  _onSwitchMachine: (agentId: string) => void,
) {
  const agentConnections = useConnectionStore((s) => s.agentConnections);
  // Track the in-flight target, not just whether any machine is connecting.
  // Route switches must be able to start machine B while machine A is still
  // completing its handshake.
  const connectingRef = useRef<string | null>(null);

  const { agentId: targetAgentId } = projectId ? fromProjectId(projectId) : { agentId: '' };
  const resolved = projectId ? resolveProjectCwd(projectId) : undefined;
  const cwd = resolved?.cwd;

  const agentState = targetAgentId ? agentConnections[targetAgentId] : undefined;
  // Keep an already-mounted project usable through a transient relay retry.
  // A cold target has no `connectedAt`, so it still waits for handshake.
  const isConnectedToTarget = agentState?.state === 'connected'
    || (agentState?.state === 'reconnecting' && agentState.connectedAt !== null);
  // Reconnecting is still an in-flight connection attempt. Treating it as
  // disconnected here starts a second connect flow for the same machine.
  const isConnecting = agentState?.state === 'connecting' || agentState?.state === 'reconnecting';
  const isError = agentState?.state === 'error';

  useEffect(() => {
    if (!targetAgentId || isConnectedToTarget || isConnecting || connectingRef.current === targetAgentId) return;

    const machine = useMachineStore.getState().getMachine(targetAgentId);
    if (!machine) return;

    connectingRef.current = targetAgentId;
    onConnect(targetAgentId, machine.publicKey);
  }, [targetAgentId, isConnectedToTarget, isConnecting, onConnect]);

  // Reset connecting ref when we actually connect
  useEffect(() => {
    if (isConnectedToTarget) {
      if (connectingRef.current === targetAgentId) connectingRef.current = null;
    }
  }, [isConnectedToTarget]);

  return {
    isReady: isConnectedToTarget,
    isConnecting: !!isConnecting,
    isError: !!isError,
    cwd,
    agentId: targetAgentId,
    // Bumps on every successful handshake (including post-resume reconnect).
    // Callers depend on this to refresh stateless repo views after reconnect.
    connectedAt: agentState?.connectedAt ?? null,
  };
}
