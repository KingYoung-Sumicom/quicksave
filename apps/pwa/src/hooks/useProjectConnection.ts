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
  const connectingRef = useRef<string | null>(null);

  const { agentId: targetAgentId } = projectId ? fromProjectId(projectId) : { agentId: '' };
  const resolved = projectId ? resolveProjectCwd(projectId) : undefined;
  const cwd = resolved?.cwd;

  const agentState = targetAgentId ? agentConnections[targetAgentId] : undefined;
  // Keep a previously connected project usable through its own reconnect.
  // A cold connection has no connectedAt anchor and still waits normally.
  const isConnectedToTarget = agentState?.state === 'connected'
    || (agentState?.state === 'reconnecting' && agentState.connectedAt !== null);
  const isConnecting = agentState?.state === 'connecting' || agentState?.state === 'reconnecting';
  const isError = agentState?.state === 'error';

  useEffect(() => {
    if (!targetAgentId || isConnectedToTarget || isConnecting || connectingRef.current === targetAgentId) return;

    const machine = useMachineStore.getState().getMachine(targetAgentId);
    if (!machine) return;

    connectingRef.current = targetAgentId;
    onConnect(targetAgentId, machine.publicKey);
  }, [targetAgentId, isConnectedToTarget, isConnecting, onConnect]);

  // The route owns only its target's in-flight marker. Switching machines must
  // never inherit a cold connection marker from the prior target.
  useEffect(() => {
    if (isConnectedToTarget && connectingRef.current === targetAgentId) {
      connectingRef.current = null;
    }
  }, [isConnectedToTarget, targetAgentId]);

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
