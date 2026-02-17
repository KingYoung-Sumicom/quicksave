import { useCallback, useRef, useEffect, useMemo, useState } from 'react';
import { HashRouter, Routes, Route, useNavigate, useLocation, useParams } from 'react-router-dom';
import { useConnectionStore } from './stores/connectionStore';
import { useGitStore } from './stores/gitStore';
import { useMachineStore } from './stores/machineStore';
import { useIdentityStore } from './stores/identityStore';
import { useGitOperations } from './hooks/useGitOperations';
import { WebSocketClient } from './lib/websocket';
import { ConnectionSetup } from './components/ConnectionSetup';
import { FleetDashboard } from './components/FleetDashboard';
import { ConnectingPage } from './components/ConnectingPage';
import { StatusBar } from './components/StatusBar';
import { RepoView } from './components/RepoView';
import { RepoSwitcher } from './components/RepoSwitcher';
import { getApiKey, saveApiKey as saveApiKeyToStorage, exportMasterSecret, importMasterSecret } from './lib/secureStorage';
import { SyncClient } from './lib/syncClient';

function AppContent() {
  const clientRef = useRef<WebSocketClient | null>(null);
  const [clientReady, setClientReady] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const intentionalDisconnectRef = useRef(false);
  const {
    state,
    repoPath,
    isPro,
    signalingServer,
    reconnectAttempt,
    maxReconnectAttempts,
    pendingRepoPath,
    setConnecting,
    setSignaling,
    setConnected,
    setDisconnected,
    setReconnecting,
    setError,
    setPendingRepoPath,
    reset,
  } = useConnectionStore();

  const { status, reset: resetGit, setCurrentRepoPath } = useGitStore();
  const { machines, recordConnection, overwriteMachines } = useMachineStore();
  const { initialize: initIdentity, publicKey: identityPublicKey, pairedDevices, isSource, getSecretKey, clearAll: clearIdentity, removePairedDevice, initialized: identityInitialized } = useIdentityStore();
  const agentIdRef = useRef<string | null>(null);

  const {
    handleResponse,
    fetchStatus,
    fetchDiff,
    stageFiles,
    unstageFiles,
    stagePatch,
    unstagePatch,
    commit,
    discardChanges,
    generateCommitSummary,
    setApiKey,
    checkApiKeyStatus,
    listRepos,
    switchRepo,
    browseDirectory,
    addRepo,
  } = useGitOperations(clientRef);

  const [showRepoSwitcher, setShowRepoSwitcher] = useState(false);

  // Initialize identity store (persistent X25519 keypair) on startup
  useEffect(() => {
    initIdentity();
  }, [initIdentity]);

  const syncClient = useMemo(() => new SyncClient(signalingServer), [signalingServer]);

  // Check mailbox on startup
  useEffect(() => {
    if (!identityPublicKey || !identityInitialized) return;

    let cancelled = false;
    (async () => {
      try {
        const secretKey = await getSecretKey();
        if (!secretKey || cancelled) return;

        const result = await syncClient.fetchMyMailbox(identityPublicKey, secretKey);
        if (cancelled) return;

        if (result?.type === 'blob') {
          overwriteMachines(result.payload.machines);
          if (result.payload.masterSecret) {
            await importMasterSecret(result.payload.masterSecret);
          }
          if (result.payload.apiKey) {
            await saveApiKeyToStorage(result.payload.apiKey);
          }
        } else if (result?.type === 'tombstone') {
          // Key has been rotated - wipe everything
          console.warn('Tombstone detected - wiping local data');
          await clearIdentity();
        }
      } catch (error) {
        console.error('Failed to check sync mailbox:', error);
      }
    })();

    return () => { cancelled = true; };
  }, [identityPublicKey, identityInitialized]);

  // Push to paired devices when machines change (if source)
  useEffect(() => {
    if (!isSource || pairedDevices.length === 0 || !identityPublicKey) return;

    let cancelled = false;
    (async () => {
      try {
        const masterSecret = await exportMasterSecret();
        const apiKey = await getApiKey();
        const payload = {
          version: 2 as const,
          masterSecret,
          apiKey: apiKey || undefined,
          machines,
          exportedAt: new Date().toISOString(),
        };

        for (const device of pairedDevices) {
          if (cancelled) return;
          try {
            const result = await syncClient.pushToDevice(payload, device.publicKey);
            if (result === 'tombstone') {
              removePairedDevice(device.publicKey);
            }
          } catch (error) {
            console.error(`Failed to sync to device ${device.publicKey.slice(0, 8)}:`, error);
          }
        }
      } catch (error) {
        console.error('Failed to push sync:', error);
      }
    })();

    return () => { cancelled = true; };
  }, [machines, isSource, pairedDevices, identityPublicKey]);

  // Stable callback refs to avoid recreating the client on every render
  const handlersRef = useRef({
    setConnected,
    setCurrentRepoPath,
    recordConnection,
    navigate,
    setDisconnected,
    setReconnecting,
    handleResponse,
    setError,
  });
  useEffect(() => {
    handlersRef.current = {
      setConnected,
      setCurrentRepoPath,
      recordConnection,
      navigate,
      setDisconnected,
      setReconnecting,
      handleResponse,
      setError,
    };
  });

  // Create WebSocketClient once when identity is ready
  useEffect(() => {
    if (!identityPublicKey || clientRef.current) return;

    const client = new WebSocketClient(signalingServer, identityPublicKey, {
      onConnected: (agentId, path, pro, availableRepos) => {
        agentIdRef.current = agentId;
        handlersRef.current.setConnected(path, pro, availableRepos);
        handlersRef.current.setCurrentRepoPath(path);
        const repoPaths = availableRepos?.map((r) => r.path);
        handlersRef.current.recordConnection(agentId, path, pro, repoPaths);
        handlersRef.current.navigate(`/repo/${agentId}`, { replace: true });
      },
      onDisconnected: () => {
        handlersRef.current.setDisconnected();
      },
      onReconnecting: (attempt, maxAttempts) => {
        handlersRef.current.setReconnecting(attempt, maxAttempts);
      },
      onMessage: (message) => {
        handlersRef.current.handleResponse(message);
      },
      onError: (error) => {
        handlersRef.current.setError(error.message);
      },
    });

    clientRef.current = client;
    setClientReady(true);

    client.connect().catch((error) => {
      console.error('Failed to connect WebSocket:', error);
      handlersRef.current.setError('Failed to connect to signaling server');
    });

    return () => {
      client.disconnect();
      clientRef.current = null;
      setClientReady(false);
    };
  }, [identityPublicKey, signalingServer]);

  const handleConnect = useCallback(
    async (newAgentId: string, publicKey: string) => {
      // Skip if already connecting to this agent
      if (agentIdRef.current === newAgentId && clientRef.current?.getActiveAgentId() === newAgentId) {
        return;
      }

      agentIdRef.current = newAgentId;
      setConnecting(newAgentId);

      if (!clientRef.current) {
        setError('WebSocket not connected yet');
        return;
      }

      setSignaling();
      clientRef.current.connectToAgent(newAgentId, publicKey);
    },
    [setConnecting, setSignaling, setError]
  );

  const handleDisconnect = useCallback(() => {
    intentionalDisconnectRef.current = true;
    if (clientRef.current && agentIdRef.current) {
      clientRef.current.disconnectFromAgent(agentIdRef.current);
    }
    agentIdRef.current = null;
    reset();
    resetGit();
    navigate('/', { replace: true });
  }, [reset, resetGit, navigate]);

  const switchingMachineRef = useRef(false);
  const handleSwitchMachine = useCallback((targetAgentId: string) => {
    switchingMachineRef.current = true;
    if (clientRef.current && agentIdRef.current) {
      clientRef.current.disconnectFromAgent(agentIdRef.current);
    }
    agentIdRef.current = null;
    reset();
    resetGit();
    navigate(`/connect/${targetAgentId}`, { replace: true });
  }, [reset, resetGit, navigate]);

  // Fetch status and sync API key when connected
  useEffect(() => {
    if (state === 'connected') {
      fetchStatus();
      // Send locally stored API key to agent if available
      getApiKey().then((storedKey) => {
        if (storedKey) {
          setApiKey(storedKey);
        }
      });
      checkApiKeyStatus();
    }
  }, [state, fetchStatus, checkApiKeyStatus, setApiKey]);

  // Switch to pending repo after connection if different from current
  useEffect(() => {
    if (state === 'connected' && pendingRepoPath && pendingRepoPath !== repoPath) {
      // Clear pending first to prevent re-triggering
      setPendingRepoPath(null);
      // Switch to the requested repo
      switchRepo(pendingRepoPath);
    }
  }, [state, pendingRepoPath, repoPath, setPendingRepoPath, switchRepo]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (clientRef.current) {
        clientRef.current.disconnect();
        clientRef.current = null;
      }
      agentIdRef.current = null;
    };
  }, []);

  const isConnected = state === 'connected';
  const isReconnecting = state === 'reconnecting';

  // Home page - redirect to repo if connected
  const homeElement = useMemo(() => {
    if (isConnected && agentIdRef.current) {
      // Already connected, will redirect via effect
    }
    const saveApiKey = isConnected ? setApiKey : undefined;
    return machines.length > 0 ? (
      <FleetDashboard onConnect={handleConnect} onSendApiKeyToAgent={saveApiKey} />
    ) : (
      <ConnectionSetup onConnect={handleConnect} onSendApiKeyToAgent={saveApiKey} />
    );
  }, [machines.length, handleConnect, isConnected, setApiKey]);

  // Redirect to repo if connected on home page
  // Note: We check clientRef.current to ensure we have an active connection,
  // not just state that might be stale during disconnect
  useEffect(() => {
    // Don't redirect if user intentionally disconnected
    if (intentionalDisconnectRef.current) {
      return;
    }
    if (location.pathname === '/' && isConnected && agentIdRef.current && clientRef.current) {
      navigate(`/repo/${agentIdRef.current}`, { replace: true });
    }
  }, [location.pathname, isConnected, navigate]);

  // Redirect to connect page if on repo page but not connected
  const repoRedirectRef = useRef(false);
  useEffect(() => {
    // Don't redirect if user intentionally disconnected
    if (intentionalDisconnectRef.current) return;
    if (repoRedirectRef.current) return;
    // Don't redirect if switching machines (handleSwitchMachine already navigated)
    if (switchingMachineRef.current) return;
    if (location.pathname.startsWith('/repo/') && !isConnected && !isReconnecting && state !== 'connecting') {
      repoRedirectRef.current = true;
      const match = location.pathname.match(/\/repo\/([^/]+)/);
      if (match) {
        navigate(`/connect/${match[1]}`, { replace: true });
      } else {
        navigate('/', { replace: true });
      }
    }
  }, [location.pathname, isConnected, isReconnecting, state, navigate]);

  // Reset redirect ref and intentional disconnect flag when navigating away from repo
  useEffect(() => {
    if (!location.pathname.startsWith('/repo/')) {
      repoRedirectRef.current = false;
    }
    // Reset flags when user starts a new connection
    if (location.pathname.startsWith('/connect/')) {
      intentionalDisconnectRef.current = false;
      switchingMachineRef.current = false;
    }
  }, [location.pathname]);

  // Repo page content
  const repoElement = useMemo(() => {
    if (!isConnected && !isReconnecting) {
      return null; // Will redirect
    }

    return (
      <>
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

        <StatusBar
          connectionState={state}
          branch={status?.branch}
          ahead={status?.ahead}
          behind={status?.behind}
          repoPath={repoPath}
          onDisconnect={handleDisconnect}
          onSwitchMachine={handleSwitchMachine}
          onSwitchRepo={() => setShowRepoSwitcher(true)}
        />
        <RepoSwitcher
          isOpen={showRepoSwitcher}
          onClose={() => setShowRepoSwitcher(false)}
          onListRepos={listRepos}
          onSwitchRepo={switchRepo}
          onBrowseDirectory={browseDirectory}
          onAddRepo={addRepo}
        />
        <RepoView
          onRefresh={fetchStatus}
          onFetchDiff={fetchDiff}
          onStage={stageFiles}
          onUnstage={unstageFiles}
          onStagePatch={stagePatch}
          onUnstagePatch={unstagePatch}
          onDiscard={discardChanges}
          onCommit={async (msg, desc) => { await commit(msg, desc); }}
          onGenerateAiSummary={generateCommitSummary}
          onSetApiKey={setApiKey}
        />
      </>
    );
  }, [isConnected, isReconnecting, reconnectAttempt, maxReconnectAttempts, state, status?.branch, status?.ahead, status?.behind, repoPath, isPro, handleDisconnect, handleSwitchMachine, fetchStatus, fetchDiff, stageFiles, unstageFiles, stagePatch, unstagePatch, discardChanges, commit, generateCommitSummary, setApiKey, showRepoSwitcher, listRepos, switchRepo]);

  return (
    <div className="min-h-screen flex flex-col bg-slate-900 text-slate-100">
      <Routes>
        <Route path="/" element={homeElement} />
        <Route path="/connect/:agentId" element={<ConnectingPageWrapper onConnect={handleConnect} clientReady={clientReady} />} />
        <Route path="/repo/:agentId" element={repoElement} />
      </Routes>
    </div>
  );
}

// Wrapper to force ConnectingPage remount when agentId changes
function ConnectingPageWrapper({ onConnect, clientReady }: { onConnect: (agentId: string, publicKey: string) => void; clientReady: boolean }) {
  const { agentId } = useParams<{ agentId: string }>();
  return <ConnectingPage key={agentId} onConnect={onConnect} clientReady={clientReady} />;
}

function App() {
  return (
    <HashRouter>
      <AppContent />
    </HashRouter>
  );
}

export default App;
