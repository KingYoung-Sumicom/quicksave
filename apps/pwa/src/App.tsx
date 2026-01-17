import { useCallback, useRef, useEffect } from 'react';
import { useConnectionStore } from './stores/connectionStore';
import { useGitStore } from './stores/gitStore';
import { useMachineStore } from './stores/machineStore';
import { useGitOperations } from './hooks/useGitOperations';
import { WebRTCClient } from './lib/webrtc';
import { ConnectionSetup } from './components/ConnectionSetup';
import { FleetDashboard } from './components/FleetDashboard';
import { StatusBar } from './components/StatusBar';
import { RepoView } from './components/RepoView';

function App() {
  const clientRef = useRef<WebRTCClient | null>(null);
  const {
    state,
    repoPath,
    isPro,
    signalingServer,
    reconnectAttempt,
    maxReconnectAttempts,
    setConnecting,
    setSignaling,
    setConnected,
    setDisconnected,
    setReconnecting,
    setError,
    reset,
  } = useConnectionStore();

  const { status, reset: resetGit } = useGitStore();
  const { machines, recordConnection } = useMachineStore();

  const {
    handleResponse,
    fetchStatus,
    fetchDiff,
    stageFiles,
    unstageFiles,
    commit,
    discardChanges,
  } = useGitOperations(clientRef);

  const handleConnect = useCallback(
    async (newAgentId: string, publicKey: string) => {
      // Clean up existing connection
      if (clientRef.current) {
        clientRef.current.disconnect();
        clientRef.current = null;
      }

      setConnecting(newAgentId, publicKey);

      const client = new WebRTCClient(signalingServer, newAgentId, publicKey, {
        onConnected: (path, pro) => {
          setConnected(path, pro);
          // Record connection in machine store
          recordConnection(newAgentId, path, pro);
        },
        onDisconnected: () => {
          setDisconnected();
        },
        onReconnecting: (attempt, maxAttempts) => {
          setReconnecting(attempt, maxAttempts);
        },
        onMessage: (message) => {
          handleResponse(message);
        },
        onError: (error) => {
          setError(error.message);
        },
      });

      clientRef.current = client;

      try {
        setSignaling();
        await client.connect();
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Connection failed');
      }
    },
    [signalingServer, setConnecting, setSignaling, setConnected, setDisconnected, setReconnecting, setError, handleResponse, recordConnection]
  );

  const handleDisconnect = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.disconnect();
      clientRef.current = null;
    }
    reset();
    resetGit();
  }, [reset, resetGit]);

  // Fetch status when connected
  useEffect(() => {
    if (state === 'connected') {
      fetchStatus();
    }
  }, [state, fetchStatus]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (clientRef.current) {
        clientRef.current.disconnect();
      }
    };
  }, []);

  const isConnected = state === 'connected';
  const isReconnecting = state === 'reconnecting';

  return (
    <div className="min-h-screen flex flex-col bg-slate-900 text-slate-100">
      {/* Reconnecting Overlay */}
      {isReconnecting && (
        <div className="fixed inset-0 bg-slate-900/80 flex items-center justify-center z-50">
          <div className="bg-slate-800 rounded-lg p-6 text-center max-w-sm mx-4">
            <div className="flex justify-center mb-4">
              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-500"></div>
            </div>
            <h3 className="text-lg font-medium mb-2">Reconnecting...</h3>
            <p className="text-sm text-slate-400">
              Attempt {reconnectAttempt} of {maxReconnectAttempts}
            </p>
          </div>
        </div>
      )}

      {isConnected || isReconnecting ? (
        <>
          <StatusBar
            connectionState={state}
            branch={status?.branch}
            ahead={status?.ahead}
            behind={status?.behind}
            repoPath={repoPath}
            isPro={isPro}
            onDisconnect={handleDisconnect}
            onSwitchMachine={handleDisconnect}
          />
          <RepoView
            onRefresh={fetchStatus}
            onFetchDiff={fetchDiff}
            onStage={stageFiles}
            onUnstage={unstageFiles}
            onDiscard={discardChanges}
            onCommit={async (msg, desc) => { await commit(msg, desc); }}
          />
        </>
      ) : machines.length > 0 ? (
        <FleetDashboard onConnect={handleConnect} />
      ) : (
        <ConnectionSetup onConnect={handleConnect} />
      )}
    </div>
  );
}

export default App;
