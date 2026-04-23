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
  const connectingRef = useRef(false);

  const { agentId: targetAgentId } = projectId ? fromProjectId(projectId) : { agentId: '' };
  const resolved = projectId ? resolveProjectCwd(projectId) : undefined;
  const cwd = resolved?.cwd;

  const agentState = targetAgentId ? agentConnections[targetAgentId] : undefined;
  const isConnectedToTarget = agentState?.state === 'connected';
  const isConnecting = agentState?.state === 'connecting';
  const isError = agentState?.state === 'error';

  useEffect(() => {
    if (!targetAgentId || isConnectedToTarget || isConnecting || connectingRef.current) return;

    const machine = useMachineStore.getState().getMachine(targetAgentId);
    if (!machine) return;

    connectingRef.current = true;
    onConnect(targetAgentId, machine.publicKey);
  }, [targetAgentId, isConnectedToTarget, isConnecting, onConnect]);

  // Reset connecting ref when we actually connect
  useEffect(() => {
    if (isConnectedToTarget) {
      connectingRef.current = false;
    }
  }, [isConnectedToTarget]);

  return {
    isReady: isConnectedToTarget,
    isConnecting: !!isConnecting,
    isError: !!isError,
    cwd,
    agentId: targetAgentId,
    // Bumps on every successful handshake (including post-resume reconnect).
    // Callers depend on this to re-issue switch-repo/refresh after the agent
    // has reset the peer's clientRepos entry.
    connectedAt: agentState?.connectedAt ?? null,
  };
}
