import { useCallback, useRef, useEffect, useMemo, useState } from 'react';
import { HashRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { useConnectionStore } from './stores/connectionStore';
import { useGitStore } from './stores/gitStore';
import { useMachineStore } from './stores/machineStore';
import { useGitOperations } from './hooks/useGitOperations';
import { WebSocketClient } from './lib/websocket';
import { ConnectionSetup } from './components/ConnectionSetup';
import { FleetDashboard } from './components/FleetDashboard';
import { ConnectingPage } from './components/ConnectingPage';
import { StatusBar } from './components/StatusBar';
import { RepoView } from './components/RepoView';
import { RepoSwitcher } from './components/RepoSwitcher';

function AppContent() {
  const clientRef = useRef<WebSocketClient | null>(null);
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
  const { machines, recordConnection } = useMachineStore();
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

  const handleConnect = useCallback(
    async (newAgentId: string, publicKey: string) => {
      // Skip if already connecting to this agent
      if (agentIdRef.current === newAgentId && clientRef.current) {
        return;
      }

      // Clean up existing connection
      if (clientRef.current) {
        clientRef.current.disconnect();
        clientRef.current = null;
      }

      // Track the current agent ID
      agentIdRef.current = newAgentId;
      setConnecting(newAgentId, publicKey);

      const client = new WebSocketClient(signalingServer, newAgentId, publicKey, {
        onConnected: (path, pro, availableRepos) => {
          setConnected(path, pro, availableRepos);
          // Set repo path in git store to load persisted commit draft
          setCurrentRepoPath(path);
          // Record connection in machine store with all available repos
          const repoPaths = availableRepos?.map((r) => r.path);
          recordConnection(newAgentId, path, pro, repoPaths);
          // Navigate to repo view
          navigate(`/repo/${newAgentId}`, { replace: true });
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
    [signalingServer, navigate, setConnecting, setSignaling, setConnected, setCurrentRepoPath, setDisconnected, setReconnecting, setError, handleResponse, recordConnection]
  );

  const handleDisconnect = useCallback(() => {
    // Mark as intentional disconnect to prevent auto-reconnect
    intentionalDisconnectRef.current = true;
    if (clientRef.current) {
      clientRef.current.disconnect();
      clientRef.current = null;
    }
    agentIdRef.current = null;
    reset();
    resetGit();
    // Navigate to home
    navigate('/', { replace: true });
  }, [reset, resetGit, navigate]);

  // Fetch status and check API key status when connected
  useEffect(() => {
    if (state === 'connected') {
      fetchStatus();
      checkApiKeyStatus();
    }
  }, [state, fetchStatus, checkApiKeyStatus]);

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
    return machines.length > 0 ? (
      <FleetDashboard onConnect={handleConnect} />
    ) : (
      <ConnectionSetup onConnect={handleConnect} />
    );
  }, [machines.length, handleConnect, isConnected]);

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
    // Reset intentional disconnect flag when user starts a new connection
    if (location.pathname.startsWith('/connect/')) {
      intentionalDisconnectRef.current = false;
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
          isPro={isPro}
          onDisconnect={handleDisconnect}
          onSwitchMachine={handleDisconnect}
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
  }, [isConnected, isReconnecting, reconnectAttempt, maxReconnectAttempts, state, status?.branch, status?.ahead, status?.behind, repoPath, isPro, handleDisconnect, fetchStatus, fetchDiff, stageFiles, unstageFiles, stagePatch, unstagePatch, discardChanges, commit, generateCommitSummary, setApiKey, showRepoSwitcher, listRepos, switchRepo]);

  return (
    <div className="min-h-screen flex flex-col bg-slate-900 text-slate-100">
      <Routes>
        <Route path="/" element={homeElement} />
        <Route path="/connect/:agentId" element={<ConnectingPage onConnect={handleConnect} />} />
        <Route path="/repo/:agentId" element={repoElement} />
      </Routes>
    </div>
  );
}

function App() {
  return (
    <HashRouter>
      <AppContent />
    </HashRouter>
  );
}

export default App;
