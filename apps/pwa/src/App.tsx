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
import { StatusBar } from './components/StatusBar';
import { RepoView } from './components/RepoView';
import { PathBrowser } from './components/PathBrowser';
import { GitignoreEditor } from './components/GitignoreEditor';
import { ClaudePanel } from './components/ClaudePanel';
import type { ClaudeUserInputResponsePayload } from '@sumicom/quicksave-shared';
import { AgentDashboard } from './components/AgentDashboard';
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
    addCodingPath,
  } = useGitOperations(clientRef);

  const {
    handleMessage: handleClaudeMessage,
    listSessions,
    getSessionMessages,
    startSession,
    resumeSession,
    cancelSession,
    closeSession,
    respondToUserInput,
    setPreferences,
    setSessionPermission,
  } = useClaudeOperations(clientRef);

  const [showPathBrowser, setShowPathBrowser] = useState(false);
  const [pathBrowserMode, setPathBrowserMode] = useState<'repo' | 'workspace'>('repo');
  const [showGitignoreEditor, setShowGitignoreEditor] = useState(false);
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const [showNavDrawer, setShowNavDrawer] = useState(isDesktop);


  // Track visualViewport height → CSS variable so #root shrinks when keyboard opens
  useEffect(() => {
    const vv = window.visualViewport;
    const update = () => {
      const h = vv ? vv.height : window.innerHeight;
      document.documentElement.style.setProperty('--vv-height', `${h}px`);
      document.documentElement.style.height = `${h}px`;
      document.body.style.height = `${h}px`;
    };
    update();
    vv?.addEventListener('resize', update);
    return () => vv?.removeEventListener('resize', update);
  }, []);

  // Prevent iOS from scrolling the layout viewport when keyboard opens
  useEffect(() => {
    const reset = () => {
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    };
    window.visualViewport?.addEventListener('scroll', reset);
    return () => window.visualViewport?.removeEventListener('scroll', reset);
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

  // Create WebSocketClient once when identity is ready
  useEffect(() => {
    if (!identityPublicKey || clientRef.current) return;

    const client = new WebSocketClient(signalingServer, identityPublicKey, {
      onConnected: (agentId, path, pro, availableRepos, availableCodingPaths, preferences) => {
        agentIdRef.current = agentId;
        if (preferences) {
          useClaudeStore.getState().setSelectedModel(preferences.model);
        }
        handlersRef.current.setConnected(path, pro, availableRepos, availableCodingPaths);
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

    client.connect().catch((error) => {
      console.error('Failed to connect WebSocket:', error);
      handlersRef.current.setError('Failed to connect to signaling server');
    });

    return () => {
      client.disconnect();
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
          currentRepoPath={repoPath}
          onAddRepo={() => openPathBrowser('repo')}
          onAddWorkspace={() => openPathBrowser('workspace')}
          onListSessions={listSessions}
          onSwitchMachine={handleSwitchMachine}
          onBackToFleet={() => { setShowNavDrawer(false); handleDisconnect(); }}
        />
        <div className="flex flex-col flex-1 min-h-0 min-w-0">
          <StatusBar
            connectionState={state}
            branch={status?.branch}
            ahead={status?.ahead}
            behind={status?.behind}
            repoPath={repoPath}
            onOpenMenu={() => setShowNavDrawer((prev) => !prev)}
            onSwitchRepo={() => openPathBrowser('repo')}
            onOpenGitignore={() => setShowGitignoreEditor(true)}
            onSetPreferences={setPreferences}
            onSetSessionPermission={setSessionPermission}
            onCloseSession={() => {
              const sid = useClaudeStore.getState().activeSessionId;
              if (sid) closeSession(sid);
            }}
            onCancelSession={() => {
              const sid = useClaudeStore.getState().activeSessionId;
              if (sid) cancelSession(sid);
            }}
          />
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {isConnected && (
              <Routes>
                <Route index element={
                  <AgentDashboard
                    agentId={currentAgentId}
                    onListSessions={listSessions}
                    onAddRepo={() => openPathBrowser('repo')}
                  />
                } />
                <Route path="/repo/:pathHash" element={
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
                    onCommit={async (msg, desc) => { await commit(msg, desc); }}
                    onGenerateAiSummary={generateCommitSummary}
                    onSetApiKey={setApiKey}
                  />
                } />
                <Route path="/coding/:pathHash" element={
                  <ClaudePanelWithHash
                    agentId={currentAgentId}
                    onListSessions={listSessions}
                    onGetSessionMessages={getSessionMessages}
                    onStartSession={startSession}
                    onResumeSession={resumeSession}
                    onRespondToUserInput={respondToUserInput}
                  />
                } />
                <Route path="/coding/:pathHash/:sessionId" element={
                  <ClaudePanelWithHash
                    agentId={currentAgentId}
                    onListSessions={listSessions}
                    onGetSessionMessages={getSessionMessages}
                    onStartSession={startSession}
                    onResumeSession={resumeSession}
                    onRespondToUserInput={respondToUserInput}
                  />
                } />
              </Routes>
            )}
          </div>
        </div>
      </div>
    );
  }, [isConnected, isReconnecting, state, status?.branch, status?.ahead, status?.behind, repoPath, isPro, handleDisconnect, handleSwitchMachine, fetchStatus, fetchDiff, stageFiles, unstageFiles, stagePatch, unstagePatch, discardChanges, untrackFiles, addToGitignore, commit, generateCommitSummary, setApiKey, showNavDrawer, isDesktop, switchRepo, listSessions, getSessionMessages, startSession, resumeSession, cancelSession, closeSession, navigate, addCodingPath]);

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
        onAddCodingPath={addCodingPath}
      />
      <GitignoreEditor
        isOpen={showGitignoreEditor}
        onClose={() => setShowGitignoreEditor(false)}
        onRead={readGitignore}
        onWrite={writeGitignore}
      />
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
  onGetSessionMessages,
  onStartSession,
  onResumeSession,
  onRespondToUserInput,
}: {
  agentId: string;
  onListSessions: (cwd?: string) => Promise<void>;
  onGetSessionMessages: (sessionId: string, offset?: number, limit?: number, cwd?: string) => Promise<void>;
  onStartSession: (prompt: string, opts?: { allowedTools?: string[]; systemPrompt?: string; model?: string; permissionMode?: string; cwd?: string }) => Promise<void>;
  onResumeSession: (sessionId: string, prompt: string, cwd?: string) => Promise<void>;
  onRespondToUserInput?: (response: ClaudeUserInputResponsePayload) => void;
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
  const boundGetMessages = useCallback(
    (sid: string, offset?: number, limit?: number) => onGetSessionMessages(sid, offset, limit, cwd),
    [onGetSessionMessages, cwd]
  );
  const boundStartSession = useCallback(
    (prompt: string, opts?: { allowedTools?: string[]; systemPrompt?: string; model?: string; permissionMode?: string }) =>
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
      onSelectSession={(sid) => navigate(`${basePath}/${sid}`)}
      onNewSession={() => navigate(`${basePath}?new`)}
      onListSessions={boundListSessions}
      onGetSessionMessages={boundGetMessages}
      onStartSession={boundStartSession}
      onResumeSession={boundResumeSession}
      onRespondToUserInput={onRespondToUserInput}
    />
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
