import { useCallback, useRef, useEffect, useMemo, useState } from 'react';
import { HashRouter, Routes, Route, useNavigate, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { useConnectionStore } from './stores/connectionStore';
import { useClaudeStore } from './stores/claudeStore';
import { useGitStore } from './stores/gitStore';
import { useMachineStore } from './stores/machineStore';
import { useIdentityStore } from './stores/identityStore';
import { useGitOperations } from './hooks/useGitOperations';
import { useClaudeOperations } from './hooks/useClaudeOperations';
import { WebSocketClient } from './lib/websocket';
import { ConnectionSetup } from './components/ConnectionSetup';
import { FleetDashboard } from './components/FleetDashboard';
import { ConnectingOverlay } from './components/ConnectingOverlay';
import { FleetStatusBar } from './components/FleetStatusBar';
import { DashboardAppBar } from './components/DashboardAppBar';
import { RepoAppBar } from './components/RepoAppBar';
import { SessionAppBar } from './components/SessionAppBar';
import { RepoView } from './components/RepoView';
import { PathBrowser } from './components/PathBrowser';
import { GitignoreEditor } from './components/GitignoreEditor';
import { ClaudePanel } from './components/ClaudePanel';
import type { ClaudeUserInputResponsePayload } from '@sumicom/quicksave-shared';
import { AgentDashboard } from './components/AgentDashboard';
import { GitIdentityModal } from './components/GitIdentityModal';
import { NavigationDrawer } from './components/NavigationDrawer';
import { getApiKey, saveApiKey as saveApiKeyToStorage, exportMasterSecret, importMasterSecret } from './lib/secureStorage';
import { SyncClient } from './lib/syncClient';
import { resolveHash, getAllKnownPaths } from './lib/pathHash';
import { useMediaQuery } from './hooks/useMediaQuery';

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
    pendingRepoPath,
    setConnecting,
    setSignaling,
    setConnected,
    setDisconnected,
    setReconnecting,
    setError,
    setPendingRepoPath,
    setConnectionStep,
    setAgentOnline,
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
    untrackFiles,
    addToGitignore,
    readGitignore,
    writeGitignore,
    generateCommitSummary,
    setApiKey,
    checkApiKeyStatus,
    switchRepo,
    browseDirectory,
    addRepo,
    removeRepo,
    cloneRepo,
    addCodingPath,
    removeCodingPath,
    listSubmodules,
    getGitIdentity,
    setGitIdentity,
    checkAgentUpdate,
    updateAgent,
    restartAgent,
  } = useGitOperations(clientRef);

  const {
    handleMessage: handleClaudeMessage,
    listSessions,
    getSessionCards,
    startSession,
    resumeSession,
    cancelSession,
    closeSession,
    archiveSession,
    respondToUserInput,
    getSessionConfig,
    setSessionConfig,
    unsubscribeSession,
  } = useClaudeOperations(clientRef);

  const [showPathBrowser, setShowPathBrowser] = useState(false);
  const [pathBrowserMode, setPathBrowserMode] = useState<'repo' | 'workspace'>('repo');
  const [showGitignoreEditor, setShowGitignoreEditor] = useState(false);
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const [showNavDrawer, setShowNavDrawer] = useState(isDesktop);
  const [showFleetSettings, setShowFleetSettings] = useState(false);
  const [showAgentSettings, setShowAgentSettings] = useState(false);
  const [dashboardEditing, setDashboardEditing] = useState(false);
  const [showGitIdentityModal, setShowGitIdentityModal] = useState(false);


  // Track visualViewport height → CSS variable so #root shrinks when keyboard opens.
  useEffect(() => {
    const vv = window.visualViewport;
    const setHeight = () => {
      const h = vv ? vv.height : window.innerHeight;
      document.documentElement.style.setProperty('--vv-height', `${h}px`);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    };
    setHeight();
    vv?.addEventListener('resize', setHeight);
    vv?.addEventListener('scroll', setHeight);

    // On focus, poll each rAF until viewport height stabilises — this catches the
    // keyboard animation on iOS before the first resize/scroll event fires.
    const onFocus = (e: FocusEvent) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return;
      let last = -1;
      let stable = 0;
      const poll = () => {
        const h = vv ? vv.height : window.innerHeight;
        document.documentElement.style.setProperty('--vv-height', `${h}px`);
        if (h === last) {
          if (++stable >= 3) return; // settled for 3 consecutive frames
        } else {
          stable = 0;
          last = h;
        }
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    };
    document.addEventListener('focusin', onFocus);

    return () => {
      vv?.removeEventListener('resize', setHeight);
      vv?.removeEventListener('scroll', setHeight);
      document.removeEventListener('focusin', onFocus);
    };
  }, []);

  // Prevent body bounce scroll
  useEffect(() => {
    const prevent = (e: TouchEvent) => {
      if (e.target === document.body || e.target === document.documentElement) {
        e.preventDefault();
      }
    };
    document.addEventListener('touchmove', prevent, { passive: false });
    return () => document.removeEventListener('touchmove', prevent);
  }, []);

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

  // Track current location for reconnect-safe navigation
  const locationRef = useRef(location);
  useEffect(() => { locationRef.current = location; });

  // Stable callback refs to avoid recreating the client on every render
  const handlersRef = useRef({
    setConnected,
    setCurrentRepoPath,
    recordConnection,
    navigate,
    setDisconnected,
    setReconnecting,
    handleResponse,
    handleClaudeMessage,
    setError,
    setConnectionStep,
    setAgentOnline,
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
      handleClaudeMessage,
      setError,
      setConnectionStep,
      setAgentOnline,
    };
  });

  // Create WebSocketClient once when identity is ready.
  // Preserve the client across Vite HMR updates so we don't destroy the
  // WebSocket connection (and cause a black screen) every time a file changes.
  useEffect(() => {
    if (!identityPublicKey) return;

    // Recover a surviving client from a previous HMR cycle
    const hot = (import.meta as any).hot as import('vite/types/hot.d.ts').ViteHotContext | undefined;
    const hmrClient = hot?.data?.wsClient as WebSocketClient | undefined;

    if (hmrClient) {
      // Reuse the existing connected client
      clientRef.current = hmrClient;
      if (typeof window !== 'undefined') (window as any).__wsClient = hmrClient;
      return;
    }

    if (clientRef.current) return;

    const client = new WebSocketClient(signalingServer, identityPublicKey, {
      onConnected: (agentId, path, pro, availableRepos, availableCodingPaths, preferences, agentVersion, latestVersion, devBuild, codexModels) => {
        agentIdRef.current = agentId;
        if (preferences) {
          useClaudeStore.getState().setSelectedModel(preferences.model);
        }
        if (codexModels?.length) {
          useConnectionStore.getState().setCodexModels(codexModels);
        }
        handlersRef.current.setConnected(path, pro, availableRepos, availableCodingPaths, agentVersion, latestVersion, devBuild);
        handlersRef.current.setCurrentRepoPath(path);
        const repoPaths = availableRepos?.map((r) => r.path);
        const codingPaths = availableCodingPaths?.map((p) => p.path);
        handlersRef.current.recordConnection(agentId, path, pro, repoPaths, codingPaths);
        // Only navigate on initial connection, not reconnect
        if (!locationRef.current.pathname.startsWith(`/agent/${agentId}`)) {
          // Check for a saved returnPath (e.g. from memory recovery or disconnect redirect)
          const returnPath = sessionStorage.getItem('quicksave:returnPath');
          sessionStorage.removeItem('quicksave:returnPath');
          if (returnPath && returnPath.startsWith(`/agent/${agentId}`)) {
            handlersRef.current.navigate(returnPath, { replace: true });
          } else {
            handlersRef.current.navigate(`/agent/${agentId}`, { replace: true });
          }
        }
      },
      onDisconnected: () => {
        handlersRef.current.setDisconnected();
      },
      onReconnecting: (attempt, maxAttempts) => {
        if (!intentionalDisconnectRef.current) {
          handlersRef.current.setReconnecting(attempt, maxAttempts);
        }
      },
      onMessage: (message) => {
        // Try Claude push/response messages first, then git responses
        if (!handlersRef.current.handleClaudeMessage(message)) {
          handlersRef.current.handleResponse(message);
        }
      },
      onError: (error) => {
        // Don't show errors during intentional disconnect
        if (!intentionalDisconnectRef.current) {
          handlersRef.current.setError(error.message);
        }
      },
      onConnectionStep: (step, attempt) => {
        handlersRef.current.setConnectionStep(step, attempt);
      },
      onAgentStatus: (_agentId, online) => {
        handlersRef.current.setAgentOnline(online);
      },
    });

    clientRef.current = client;
    // Debug: expose for console access
    if (typeof window !== 'undefined') (window as any).__wsClient = client;

    client.connect().catch((error) => {
      console.error('Failed to connect WebSocket:', error);
      handlersRef.current.setError('Failed to connect to signaling server');
    });

    return () => {
      // During HMR, stash the client so the next module instance can reuse it
      if (hot) {
        hot.data.wsClient = client;
      } else {
        client.disconnect();
      }
      clientRef.current = null;
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

  const handleAbortConnection = useCallback(() => {
    if (clientRef.current && agentIdRef.current) {
      clientRef.current.disconnectFromAgent(agentIdRef.current);
    }
    agentIdRef.current = null;
    reset();
    resetGit();
    navigate('/', { replace: true });
  }, [reset, resetGit, navigate]);

  const handleRetryConnection = useCallback(() => {
    const currentAgentId = agentIdRef.current;
    if (!currentAgentId) return;

    if (clientRef.current) {
      clientRef.current.disconnectFromAgent(currentAgentId);
    }
    reset();

    const machine = useMachineStore.getState().getMachine(currentAgentId);
    if (machine) {
      handleConnect(currentAgentId, machine.publicKey);
    }
  }, [reset, handleConnect]);

  const handleDisconnect = useCallback(() => {
    intentionalDisconnectRef.current = true;
    handleAbortConnection();
    navigate('/', { replace: true });
  }, [handleAbortConnection, navigate]);

  const handleSwitchMachine = useCallback((targetAgentId: string) => {
    if (clientRef.current && agentIdRef.current) {
      clientRef.current.disconnectFromAgent(agentIdRef.current);
    }
    agentIdRef.current = null;
    reset();
    resetGit();
    // Look up machine and connect directly (overlay will appear)
    const machine = useMachineStore.getState().getMachine(targetAgentId);
    if (machine) {
      handleConnect(targetAgentId, machine.publicKey);
    } else {
      navigate('/', { replace: true });
    }
  }, [reset, resetGit, navigate, handleConnect]);

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

  // Clean up on unmount (but not during HMR — the main effect handles that)
  useEffect(() => {
    return () => {
      const hot = (import.meta as any).hot as import('vite/types/hot.d.ts').ViteHotContext | undefined;
      if (hot) return; // HMR: let the main effect stash the client
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
    const handleCheckUpdate = isConnected ? checkAgentUpdate : undefined;
    const handleUpdateAgent = isConnected ? updateAgent : undefined;
    const inner = machines.length > 0 ? (
      <FleetDashboard
        onNavigate={(agentId) => {
          intentionalDisconnectRef.current = false;
          const machine = useMachineStore.getState().getMachine(agentId);
          if (machine) handleConnect(agentId, machine.publicKey);
          navigate(`/agent/${agentId}`);
        }}
        onConnect={handleConnect}
        onSendApiKeyToAgent={saveApiKey}
        onCheckAgentUpdate={handleCheckUpdate}
        onUpdateAgent={handleUpdateAgent}
        showSettings={showFleetSettings}
        onCloseSettings={() => setShowFleetSettings(false)}
      />
    ) : (
      <ConnectionSetup onConnect={handleConnect} onSendApiKeyToAgent={saveApiKey} onCheckAgentUpdate={handleCheckUpdate} onUpdateAgent={handleUpdateAgent} />
    );
    return (
      <div className="flex flex-col h-screen overflow-hidden">
        <FleetStatusBar
          title="Quicksave"
          onOpenSettings={() => setShowFleetSettings(true)}
        />
        {inner}
      </div>
    );
  }, [machines.length, handleConnect, isConnected, setApiKey, checkAgentUpdate, updateAgent, state, showFleetSettings, navigate]);

  // Redirect to repo if connected on home page
  // Note: We check clientRef.current to ensure we have an active connection,
  // not just state that might be stale during disconnect
  useEffect(() => {
    // Don't redirect if user intentionally disconnected
    if (intentionalDisconnectRef.current) {
      return;
    }
    if (location.pathname === '/' && isConnected && agentIdRef.current && clientRef.current) {
      navigate(`/agent/${agentIdRef.current}`, { replace: true });
    }
  }, [location.pathname, isConnected, navigate]);

  // Auto-connect when on agent page but disconnected
  const autoConnectRef = useRef(false);
  useEffect(() => {
    if (intentionalDisconnectRef.current) return;
    if (autoConnectRef.current) return;
    // Wait for WS client to be ready (identity must initialize first)
    if (!clientRef.current) return;
    if (location.pathname.startsWith('/agent/') && !isConnected && !isReconnecting && state !== 'connecting') {
      const match = location.pathname.match(/\/agent\/([^/]+)/);
      if (match) {
        autoConnectRef.current = true;
        // Save current path for restoration after connect
        sessionStorage.setItem('quicksave:returnPath', location.pathname);
        const machine = useMachineStore.getState().getMachine(match[1]);
        if (machine) {
          handleConnect(machine.agentId, machine.publicKey);
        } else {
          navigate('/', { replace: true });
        }
      } else {
        navigate('/', { replace: true });
      }
    }
  }, [location.pathname, isConnected, isReconnecting, state, navigate, handleConnect, identityPublicKey]);

  // Reset auto-connect ref when navigating away
  useEffect(() => {
    if (!location.pathname.startsWith('/agent/')) {
      autoConnectRef.current = false;
    }
  }, [location.pathname]);

  // Repo page content
  const repoElement = useMemo(() => {
    if (!isConnected && !isReconnecting && state !== 'connecting') {
      return null; // Will auto-connect
    }

    const currentAgentId = agentIdRef.current || '';

    const openPathBrowser = (mode: 'repo' | 'workspace' = 'repo') => {
      if (!isDesktop) setShowNavDrawer(false);
      setPathBrowserMode(mode);
      setShowPathBrowser(true);
    };

    return (
      <div className="flex flex-1 min-h-0">
        <NavigationDrawer
          isOpen={showNavDrawer}
          persistent={isDesktop}
          onClose={() => setShowNavDrawer(false)}
          agentId={currentAgentId}
          onAddRepo={() => openPathBrowser('repo')}
          onAddWorkspace={() => openPathBrowser('workspace')}
          onListSessions={listSessions}
          onSwitchMachine={handleSwitchMachine}
          onBackToFleet={() => { setShowNavDrawer(false); handleDisconnect(); }}
          onOpen={() => setShowNavDrawer(true)}
        />
        <div className="flex flex-col flex-1 min-h-0 min-w-0">
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {isConnected && (
              <Routes>
                <Route index element={
                  <>
                    <DashboardAppBar
                      editing={dashboardEditing}
                      onToggleEdit={() => setDashboardEditing((prev) => !prev)}
                      onOpenMenu={() => setShowNavDrawer((prev) => !prev)}
                    />
                    <AgentDashboard
                      agentId={currentAgentId}
                      editing={dashboardEditing}
                      onListSessions={listSessions}
                      onAddRepo={() => openPathBrowser('repo')}
                      onRemoveRepo={removeRepo}
                      onRemoveCodingPath={removeCodingPath}
                      onArchiveSession={archiveSession}
                    />
                  </>
                } />
                <Route path="/repo/:pathHash" element={
                  <>
                    <RepoAppBar
                      branch={status?.branch}
                      ahead={status?.ahead}
                      behind={status?.behind}
                      repoPath={repoPath}
                      onOpenMenu={() => setShowNavDrawer((prev) => !prev)}
                      onSwitchRepo={switchRepo}
                      onListSubmodules={listSubmodules}
                      onOpenGitignore={() => setShowGitignoreEditor(true)}
                    />
                    <RepoViewWithHash
                      agentId={currentAgentId}
                      onSwitchRepo={switchRepo}
                      onRefresh={fetchStatus}
                      onFetchDiff={fetchDiff}
                      onStage={stageFiles}
                      onUnstage={unstageFiles}
                      onStagePatch={stagePatch}
                      onUnstagePatch={unstagePatch}
                      onDiscard={discardChanges}
                      onUntrack={untrackFiles}
                      onAddToGitignore={addToGitignore}
                      onCommit={async (msg, desc) => {
                        try {
                          await commit(msg, desc);
                        } catch (err) {
                          const errMsg = err instanceof Error ? err.message : '';
                          if (errMsg.includes('empty ident') || errMsg.includes('Please tell me who you are')) {
                            setShowGitIdentityModal(true);
                          }
                        }
                      }}
                      onGenerateAiSummary={generateCommitSummary}
                      onSetApiKey={setApiKey}
                    />
                  </>
                } />
                <Route path="/coding/:pathHash" element={
                  <>
                    <DashboardAppBar
                      editing={dashboardEditing}
                      onToggleEdit={() => setDashboardEditing((prev) => !prev)}
                      onOpenMenu={() => setShowNavDrawer((prev) => !prev)}
                    />
                    <ClaudePanelWithHash
                      agentId={currentAgentId}
                      onListSessions={listSessions}
                      onGetSessionCards={getSessionCards}
                      onGetSessionConfig={getSessionConfig}
                      onStartSession={startSession}
                      onResumeSession={resumeSession}
                      onRespondToUserInput={respondToUserInput}
                      onUnsubscribeSession={unsubscribeSession}
                    />
                  </>
                } />
                <Route path="/coding/:pathHash/:sessionId" element={
                  <SessionRouteWithHash
                    agentId={currentAgentId}
                    showSettings={showAgentSettings}
                    onOpenSettings={() => setShowAgentSettings(true)}
                    onCloseSettings={() => setShowAgentSettings(false)}
                    onOpenMenu={() => setShowNavDrawer((prev) => !prev)}
                    onSetSessionConfig={setSessionConfig}
                    onCloseSession={closeSession}
                    onArchiveSession={archiveSession}
                    onCancelSession={cancelSession}
                    onCheckAgentUpdate={checkAgentUpdate}
                    onUpdateAgent={updateAgent}
                    onRestartAgent={restartAgent}
                    onListSessions={listSessions}
                    onGetSessionCards={getSessionCards}
                    onGetSessionConfig={getSessionConfig}
                    onStartSession={startSession}
                    onResumeSession={resumeSession}
                    onRespondToUserInput={respondToUserInput}
                    onUnsubscribeSession={unsubscribeSession}
                  />
                } />
              </Routes>
            )}
          </div>
        </div>
      </div>
    );
  }, [isConnected, isReconnecting, state, status?.branch, status?.ahead, status?.behind, repoPath, isPro, handleDisconnect, handleSwitchMachine, fetchStatus, fetchDiff, stageFiles, unstageFiles, stagePatch, unstagePatch, discardChanges, untrackFiles, addToGitignore, commit, generateCommitSummary, setApiKey, showNavDrawer, isDesktop, switchRepo, listSessions, getSessionCards, startSession, resumeSession, cancelSession, closeSession, navigate, addCodingPath, showAgentSettings, dashboardEditing]);

  // Show connecting overlay globally (covers any page)
  const showOverlay = state === 'connecting' || state === 'reconnecting' || (state === 'error' && !!useConnectionStore.getState().error);

  return (
    <div className="flex flex-col bg-slate-900 text-slate-100 overflow-hidden h-full">
      <Routes>
        <Route path="/" element={homeElement} />
        <Route path="/connect/:agentId" element={<ConnectHandler onConnect={handleConnect} />} />
        <Route path="/agent/:agentId/*" element={repoElement} />
      </Routes>
      {showOverlay && <ConnectingOverlay onAbort={handleAbortConnection} onRetry={handleRetryConnection} />}
      <PathBrowser
        isOpen={showPathBrowser}
        mode={pathBrowserMode}
        onClose={() => setShowPathBrowser(false)}
        onSwitchRepo={switchRepo}
        onBrowseDirectory={browseDirectory}
        onAddRepo={addRepo}
        onCloneRepo={cloneRepo}
        onAddCodingPath={addCodingPath}
      />
      <GitignoreEditor
        isOpen={showGitignoreEditor}
        onClose={() => setShowGitignoreEditor(false)}
        onRead={readGitignore}
        onWrite={writeGitignore}
      />
      {showGitIdentityModal && (
        <GitIdentityModal
          onClose={() => setShowGitIdentityModal(false)}
          onSave={setGitIdentity}
          onGetIdentity={getGitIdentity}
        />
      )}
    </div>
  );
}

// Wrapper that resolves :pathHash → full path and switches repo if needed
function RepoViewWithHash({
  agentId,
  onSwitchRepo,
  ...repoViewProps
}: { agentId: string; onSwitchRepo: (path: string) => void } & React.ComponentProps<typeof RepoView>) {
  const { pathHash } = useParams<{ pathHash: string }>();
  const { repoPath } = useConnectionStore();

  useEffect(() => {
    if (!pathHash) return;
    const resolved = resolveHash(pathHash, getAllKnownPaths(agentId));
    if (resolved && resolved !== repoPath) {
      onSwitchRepo(resolved);
    }
  }, [pathHash, agentId, repoPath, onSwitchRepo]);

  return <RepoView {...repoViewProps} />;
}

// Wrapper that resolves :pathHash → cwd and binds it to Claude operations
function ClaudePanelWithHash({
  agentId,
  onListSessions,
  onGetSessionCards,
  onGetSessionConfig,
  onStartSession,
  onResumeSession,
  onRespondToUserInput,
  onUnsubscribeSession,
}: {
  agentId: string;
  onListSessions: (cwd?: string) => Promise<void>;
  onGetSessionCards: (sessionId: string, offset?: number, limit?: number, cwd?: string) => Promise<void>;
  onGetSessionConfig?: (sessionId: string) => Promise<void>;
  onStartSession: (prompt: string, opts?: { agent?: 'claude-code' | 'codex'; allowedTools?: string[]; systemPrompt?: string; model?: string; permissionMode?: string; cwd?: string }) => Promise<void>;
  onResumeSession: (sessionId: string, prompt: string, cwd?: string) => Promise<void>;
  onRespondToUserInput?: (response: ClaudeUserInputResponsePayload) => void;
  onUnsubscribeSession?: (sessionId: string) => void;
}) {
  const { pathHash, sessionId: urlSessionId } = useParams<{ pathHash: string; sessionId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isNewSession = searchParams.has('new');
  const activeSessionId = useClaudeStore((s) => s.activeSessionId);

  const cwd = pathHash ? resolveHash(pathHash, getAllKnownPaths(agentId)) : undefined;
  const basePath = pathHash ? `/agent/${agentId}/coding/${pathHash}` : `/agent/${agentId}`;

  // When a session starts (activeSessionId changes), update URL to include sessionId.
  // Only react to activeSessionId changes — including urlSessionId in deps causes a
  // navigate→param change→re-fire loop that triggers browser throttling.
  const prevActiveRef = useRef(activeSessionId);
  useEffect(() => {
    if (activeSessionId && activeSessionId !== prevActiveRef.current) {
      navigate(`${basePath}/${activeSessionId}`, { replace: true });
    }
    prevActiveRef.current = activeSessionId;
  }, [activeSessionId, basePath, navigate]);

  // Bind cwd into all callbacks
  const boundListSessions = useCallback(() => onListSessions(cwd), [onListSessions, cwd]);
  const boundGetCards = useCallback(
    (sid: string, offset?: number, limit?: number) => onGetSessionCards(sid, offset, limit, cwd),
    [onGetSessionCards, cwd]
  );
  const boundStartSession = useCallback(
    (prompt: string, opts?: { agent?: 'claude-code' | 'codex'; allowedTools?: string[]; systemPrompt?: string; model?: string; permissionMode?: string }) =>
      onStartSession(prompt, { ...opts, cwd }),
    [onStartSession, cwd]
  );
  const boundResumeSession = useCallback(
    (sid: string, prompt: string) => onResumeSession(sid, prompt, cwd),
    [onResumeSession, cwd]
  );

  return (
    <ClaudePanel
      sessionId={urlSessionId}
      newSession={isNewSession && !activeSessionId}
      cwd={cwd}
      onSelectSession={(sid) => navigate(`${basePath}/${sid}`)}
      onNewSession={() => navigate(`${basePath}?new`)}
      onListSessions={boundListSessions}
      onGetSessionCards={boundGetCards}
      onGetSessionConfig={onGetSessionConfig}
      onUnsubscribeSession={onUnsubscribeSession}
      onStartSession={boundStartSession}
      onResumeSession={boundResumeSession}
      onRespondToUserInput={onRespondToUserInput}
    />
  );
}


// Wrapper that gives SessionAppBar access to route params for cwd resolution
function SessionRouteWithHash({
  agentId,
  showSettings,
  onOpenSettings,
  onCloseSettings,
  onOpenMenu,
  onSetSessionConfig,
  onCloseSession,
  onArchiveSession,
  onCancelSession,
  onCheckAgentUpdate,
  onUpdateAgent,
  onRestartAgent,
  ...claudeProps
}: {
  agentId: string;
  showSettings: boolean;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
  onOpenMenu: () => void;
  onSetSessionConfig: (sessionId: string, key: string, value: import('@sumicom/quicksave-shared').ConfigValue) => void;
  onCloseSession: (sessionId: string) => void;
  onArchiveSession: (sessionId: string, cwd: string) => Promise<void>;
  onCancelSession: (sessionId: string) => void;
  onCheckAgentUpdate?: () => Promise<{ currentVersion: string; latestVersion?: string; updateAvailable: boolean; error?: string }>;
  onUpdateAgent?: () => Promise<{ success: boolean; previousVersion: string; newVersion?: string; restarting: boolean; error?: string }>;
  onRestartAgent?: () => Promise<{ success: boolean; error?: string }>;
  onListSessions: (cwd?: string) => Promise<void>;
  onGetSessionCards: (sessionId: string, offset?: number, limit?: number, cwd?: string) => Promise<void>;
  onGetSessionConfig?: (sessionId: string) => Promise<void>;
  onStartSession: (prompt: string, opts?: { agent?: 'claude-code' | 'codex'; allowedTools?: string[]; systemPrompt?: string; model?: string; permissionMode?: string; cwd?: string }) => Promise<void>;
  onResumeSession: (sessionId: string, prompt: string, cwd?: string) => Promise<void>;
  onRespondToUserInput?: (response: ClaudeUserInputResponsePayload) => void;
  onUnsubscribeSession?: (sessionId: string) => void;
}) {
  const { pathHash } = useParams<{ pathHash: string }>();
  const cwd = pathHash ? resolveHash(pathHash, getAllKnownPaths(agentId)) : undefined;

  return (
    <>
      <SessionAppBar
        showSettings={showSettings}
        onOpenSettings={onOpenSettings}
        onCloseSettings={onCloseSettings}
        onOpenMenu={onOpenMenu}
        onSetSessionConfig={(key, value) => {
          const sid = useClaudeStore.getState().activeSessionId;
          if (sid) onSetSessionConfig(sid, key, value);
        }}
        onCloseSession={() => {
          const sid = useClaudeStore.getState().activeSessionId;
          if (sid) onCloseSession(sid);
        }}
        onArchiveSession={() => {
          const sid = useClaudeStore.getState().activeSessionId;
          if (sid && cwd) onArchiveSession(sid, cwd);
        }}
        onCancelSession={() => {
          const sid = useClaudeStore.getState().activeSessionId;
          if (sid) onCancelSession(sid);
        }}
        onCheckAgentUpdate={onCheckAgentUpdate}
        onUpdateAgent={onUpdateAgent}
        onRestartAgent={onRestartAgent}
      />
      <ClaudePanelWithHash
        agentId={agentId}
        {...claudeProps}
      />
    </>
  );
}

// Lightweight handler for QR code / shared link connections (/connect/:agentId?pk=...&name=...)
// Adds machine if new, triggers connection, and redirects — no UI of its own.
function ConnectHandler({ onConnect }: { onConnect: (agentId: string, publicKey: string) => void }) {
  const { agentId } = useParams<{ agentId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { addMachine, getMachine } = useMachineStore();
  const { setPendingRepoPath } = useConnectionStore();
  const initiated = useRef(false);

  useEffect(() => {
    if (initiated.current || !agentId) return;
    initiated.current = true;

    const pk = searchParams.get('pk');
    const name = searchParams.get('name');
    const repo = searchParams.get('repo');

    if (repo) setPendingRepoPath(repo);

    if (pk) {
      // New machine from QR code
      if (!getMachine(agentId)) {
        addMachine({ agentId, publicKey: pk, nickname: name || `Machine ${agentId.slice(0, 8)}`, icon: '💻' });
      }
      onConnect(agentId, pk);
    } else {
      // Reconnect to existing machine
      const machine = getMachine(agentId);
      if (machine) {
        onConnect(machine.agentId, machine.publicKey);
      }
    }

    // Redirect to agent page (overlay will show connecting)
    navigate(`/agent/${agentId}`, { replace: true });
  }, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

function App() {
  return (
    <HashRouter>
      <AppContent />
    </HashRouter>
  );
}

export default App;
