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
import { ConnectingOverlay } from './components/ConnectingOverlay';
import { FleetStatusBar } from './components/FleetStatusBar';
import { SessionAppBar } from './components/SessionAppBar';
import { NewSessionAppBar } from './components/NewSessionAppBar';
import { RepoView } from './components/RepoView';
import { BaseStatusBar, BackButton } from './components/BaseStatusBar';
import { Spinner } from './components/ui/Spinner';
import { PathBrowser } from './components/PathBrowser';
import { GitignoreEditor } from './components/GitignoreEditor';
import { ClaudePanel } from './components/ClaudePanel';
import { createMessage, type ClaudeUserInputResponsePayload, type Message, type PushSubscriptionOfferPayload } from '@sumicom/quicksave-shared';
import { NotificationPrompt } from './components/NotificationPrompt';
import { buildOfferMessage, getCurrentSubscription, notificationPermission } from './lib/pushSubscription';
import { GitIdentityModal } from './components/GitIdentityModal';
import { SettingsPage } from './components/SettingsPage';
import { AddNewPage } from './components/AddNewPage';
import { ProjectList } from './components/ProjectList';
import { ProjectDetail } from './components/ProjectDetail';
import { useProjectConnection } from './hooks/useProjectConnection';
import { resolveHash, getAllKnownPaths } from './lib/pathHash';
import { getApiKey, saveApiKey as saveApiKeyToStorage, exportMasterSecret, importMasterSecret } from './lib/secureStorage';
import { SyncClient } from './lib/syncClient';
import { useMediaQuery } from './hooks/useMediaQuery';

function AppContent() {
  const clientRef = useRef<WebSocketClient | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const intentionalDisconnectRef = useRef(false);
  const {
    state,
    repoPath,
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

  const { reset: resetGit, setCurrentRepoPath } = useGitStore();
  const { machines, recordConnection, overwriteMachines } = useMachineStore();
  const { initialize: initIdentity, publicKey: identityPublicKey, pairedDevices, isSource, getSecretKey, clearAll: clearIdentity, removePairedDevice, initialized: identityInitialized } = useIdentityStore();
  const agentIdRef = useRef<string | null>(null);

  const {
    handleResponse,
    cancelPendingGit,
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
    refreshCommitSummary,
    dismissAiSummary,
    applyAiSuggestion,
    setApiKey,
    checkApiKeyStatus,
    switchRepo,
    browseDirectory,
    addRepo,
    cloneRepo,
    addCodingPath,
    removeCodingPath,
    getGitIdentity,
    setGitIdentity,
    checkAgentUpdate,
    updateAgent,
    restartAgent,
  } = useGitOperations(clientRef);

  /**
   * Switch the active agent and drop any in-flight git:* responses for the
   * previous agent. Without the cancel, a late status/diff response from the
   * old agent would overwrite the gitStore right after the user navigates
   * to a different workspace.
   */
  const setActiveAgent = useCallback((agentId: string) => {
    cancelPendingGit();
    clientRef.current?.setActiveAgent(agentId);
  }, [cancelPendingGit]);

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
    sendControlRequest,
    unsubscribeSession,
    listProjectSummaries,
    listProjectRepos,
  } = useClaudeOperations(clientRef);

  const [showPathBrowser, setShowPathBrowser] = useState(false);
  const [showGitignoreEditor, setShowGitignoreEditor] = useState(false);
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const [showAgentSettings, setShowAgentSettings] = useState(false);
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
    refreshCommitSummary,
    setActiveAgent,
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
      refreshCommitSummary,
      setActiveAgent,
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
        // Update legacy single-agent state
        handlersRef.current.setConnected(path, pro, availableRepos, availableCodingPaths, agentVersion, latestVersion, devBuild);
        handlersRef.current.setCurrentRepoPath(path);
        // Update multi-agent connection map
        useConnectionStore.getState().setAgentConnected(agentId, path, pro, availableRepos, availableCodingPaths, agentVersion);
        const repoPaths = availableRepos?.map((r) => r.path);
        const codingPaths = availableCodingPaths?.map((p) => p.path);
        handlersRef.current.recordConnection(agentId, path, pro, repoPaths, codingPaths);
        // Reconcile session states: fetch actual active sessions from agent
        // and mark locally-active sessions that are no longer active (e.g. after agent restart).
        // This is safe on both initial connect and reconnect.
        setTimeout(() => {
          if (!clientRef.current) return;
          handlersRef.current.setActiveAgent(agentId);
          const msg = createMessage('claude:active-sessions', {});
          clientRef.current.send(msg);
        }, 500);

        // Hydrate agent-owned AI commit summary state so any in-flight or ready
        // suggestion survives PWA reloads/reconnects.
        if (path) {
          void handlersRef.current.refreshCommitSummary(path);
        }

        // Auto-offer push subscription: if the user has already granted
        // notification permission in a past session, re-send the offer so the
        // agent can refresh the relay registration (browsers may rotate the
        // endpoint). No-op if permission isn't granted yet — the
        // NotificationPrompt banner handles the first-time flow.
        if (notificationPermission() === 'granted') {
          void (async () => {
            try {
              const sub = await getCurrentSubscription();
              if (sub && clientRef.current) {
                clientRef.current.sendToAgent(agentId, buildOfferMessage(sub));
              }
            } catch (err) {
              console.warn('[push] auto-offer failed', err);
            }
          })();
        }

        // Project route components (/p/) manage their own navigation after connection.
        // No need to navigate on connect — the home page and project routes handle it.
      },
      onDisconnected: (disconnectedAgentId) => {
        if (disconnectedAgentId) {
          useConnectionStore.getState().setAgentDisconnected(disconnectedAgentId);
        }
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
      onAgentStatus: (agentId, online) => {
        handlersRef.current.setAgentOnline(online);
        useConnectionStore.getState().setAgentOnlineFor(agentId, online);
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
      // Skip if already connected or connecting to this agent
      if (clientRef.current?.hasSession(newAgentId)) {
        // Already connected — just set as active
        setActiveAgent(newAgentId);
        agentIdRef.current = newAgentId;
        return;
      }

      agentIdRef.current = newAgentId;
      setConnecting(newAgentId);
      useConnectionStore.getState().setAgentConnecting(newAgentId);

      if (!clientRef.current) {
        setError('WebSocket not connected yet');
        return;
      }

      setSignaling();
      clientRef.current.connectToAgent(newAgentId, publicKey);
    },
    [setConnecting, setSignaling, setError, setActiveAgent]
  );

  const handleAbortConnection = useCallback(() => {
    if (clientRef.current) {
      if (agentIdRef.current) {
        clientRef.current.disconnectFromAgent(agentIdRef.current);
      }
      clientRef.current.stopReconnecting();
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

  const handleSwitchMachine = useCallback((targetAgentId: string) => {
    // In multi-agent mode, we keep existing connections alive and just add the new one
    const machine = useMachineStore.getState().getMachine(targetAgentId);
    if (machine) {
      handleConnect(targetAgentId, machine.publicKey);
    } else {
      navigate('/', { replace: true });
    }
  }, [navigate, handleConnect]);

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

  // Auto-connect to ALL known machines on startup
  const autoConnectAllRef = useRef(false);
  useEffect(() => {
    if (autoConnectAllRef.current) return;
    if (!clientRef.current) return;
    if (intentionalDisconnectRef.current) return;
    autoConnectAllRef.current = true;

    const allMachines = useMachineStore.getState().machines;
    for (const machine of allMachines) {
      // handleConnect will skip if already connected
      handleConnect(machine.agentId, machine.publicKey);
    }
  }, [handleConnect, identityPublicKey]);

  // Fetch project summaries + session lists from each agent as they connect
  const fetchedSummariesRef = useRef<Set<string>>(new Set());
  const agentConnections = useConnectionStore((s) => s.agentConnections);
  useEffect(() => {
    for (const [agentId, conn] of Object.entries(agentConnections)) {
      if (conn.state === 'connected' && !fetchedSummariesRef.current.has(agentId)) {
        fetchedSummariesRef.current.add(agentId);
        // Set active agent to route requests to this agent
        setActiveAgent(agentId);
        listProjectSummaries().then(async (projects) => {
          if (!projects) return;
          // Cache project summaries and prune stale knownCodingPaths
          const agentConn = useConnectionStore.getState().agentConnections[agentId];
          const managedPaths = agentConn?.availableCodingPaths?.map((p) => p.path);
          useMachineStore.getState().cacheAllProjects(agentId, projects, managedPaths);
          // Fetch session lists for each project so inline sessions show on home page
          for (const project of projects) {
            setActiveAgent(agentId);
            await listSessions(project.cwd);
          }
        });
      }
    }
  }, [agentConnections, listProjectSummaries, listSessions, setActiveAgent]);

  // Show connecting overlay only for /connect routes (QR/deep link) — not for project routes
  const showOverlay = !location.pathname.startsWith('/p/') && (
    state === 'connecting' || state === 'reconnecting' || (state === 'error' && !!useConnectionStore.getState().error)
  );

  const projectRepoElement = (
    <ProjectRouteRepo
      onConnect={handleConnect}
      onSwitchMachine={handleSwitchMachine}
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
      onApplyAiSuggestion={applyAiSuggestion}
      onDismissAiSummary={dismissAiSummary}
      onSetApiKey={setApiKey}
    />
  );

  const projectDetailElement = (
    <ProjectRouteDetail
      onConnect={handleConnect}
      onSwitchMachine={handleSwitchMachine}
      onListSessions={listSessions}
      onListProjectRepos={listProjectRepos}
      onRemoveCodingPath={removeCodingPath}
      onRestartAgent={restartAgent}
    />
  );

  const projectSessionElement = (
    <ProjectRouteSession
            onConnect={handleConnect}
            onSwitchMachine={handleSwitchMachine}
            showSettings={showAgentSettings}
            onOpenSettings={() => setShowAgentSettings(true)}
            onCloseSettings={() => setShowAgentSettings(false)}
            onSetSessionConfig={setSessionConfig}
            onSendControlRequest={sendControlRequest}
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
            onSetActiveAgent={setActiveAgent}
  />
  );

  const homeElement = machines.length > 0 ? (
    <ProjectList
      onOpenSettings={() => navigate('/settings')}
      onOpenAddNew={() => navigate('/add')}
      onAddMachine={() => {/* TODO: wire add machine modal */}}
    />
  ) : (
    <div className="flex flex-col h-screen overflow-hidden">
      <FleetStatusBar title="Quicksave" onOpenSettings={() => navigate('/settings')} />
      <ConnectionSetup onConnect={handleConnect} />
    </div>
  );

  const handlePushOffer = useCallback((msg: Message<PushSubscriptionOfferPayload>) => {
    const client = clientRef.current;
    if (!client) return;
    try {
      client.send(msg);
    } catch (err) {
      console.warn('[push] failed to send subscription offer', err);
    }
  }, []);

  return (
    <div className="flex flex-col bg-slate-900 text-slate-100 overflow-hidden h-full">
      {isConnected && <NotificationPrompt onOffer={handlePushOffer} />}
      {isDesktop ? (
        machines.length === 0 ? (
          // Pre-pair: full-width connection setup, no sidebar yet.
          // Still wrap in Routes so /settings works from the gear icon.
          <Routes>
            <Route
              path="/settings"
              element={<SettingsPage onSendApiKeyToAgent={isConnected ? setApiKey : undefined} onPushOffer={handlePushOffer} />}
            />
            <Route
              path="*"
              element={
                <div className="flex flex-col h-full overflow-hidden">
                  <FleetStatusBar title="Quicksave" onOpenSettings={() => navigate('/settings')} />
                  <ConnectionSetup onConnect={handleConnect} />
                </div>
              }
            />
          </Routes>
        ) : (
          // Desktop: two-column layout — sidebar owns the home app bar, main area only renders project routes
          <div className="flex h-full overflow-hidden">
            <div className="w-72 shrink-0 border-r border-slate-700 bg-slate-800/50">
              <ProjectList compact onOpenSettings={() => navigate('/settings')} onOpenAddNew={() => navigate('/add')} />
            </div>
            <div className="flex-1 min-w-0 flex flex-col">
              <Routes>
                <Route path="/p/:projectId" element={projectDetailElement} />
                <Route path="/p/:projectId/s/:sessionId" element={projectSessionElement} />
                <Route path="/p/:projectId/r/:repoId" element={projectRepoElement} />
                <Route path="/add" element={<AddNewPage onSetActiveAgent={setActiveAgent} onBrowseDirectory={browseDirectory} onCloneRepo={cloneRepo} onAddCodingPath={addCodingPath} />} />
                <Route path="/settings" element={<SettingsPage onSendApiKeyToAgent={isConnected ? setApiKey : undefined} onPushOffer={handlePushOffer} />} />
                <Route path="/connect/:agentId" element={<ConnectHandler onConnect={handleConnect} />} />
              </Routes>
            </div>
          </div>
        )
      ) : (
        // Mobile: full-screen pages with back navigation
        <Routes>
          <Route path="/" element={homeElement} />
          <Route path="/p/:projectId" element={projectDetailElement} />
          <Route path="/p/:projectId/s/:sessionId" element={projectSessionElement} />
          <Route path="/p/:projectId/r/:repoId" element={projectRepoElement} />
          <Route path="/add" element={<AddNewPage onSetActiveAgent={setActiveAgent} onBrowseDirectory={browseDirectory} onCloneRepo={cloneRepo} onAddCodingPath={addCodingPath} />} />
          <Route path="/settings" element={<SettingsPage onSendApiKeyToAgent={isConnected ? setApiKey : undefined} onPushOffer={handlePushOffer} />} />
          <Route path="/connect/:agentId" element={<ConnectHandler onConnect={handleConnect} />} />
        </Routes>
      )}
      {showOverlay && <ConnectingOverlay onAbort={handleAbortConnection} onRetry={handleRetryConnection} />}
      <PathBrowser
        isOpen={showPathBrowser}
        mode="repo"
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

// ── Project route wrappers ──────────────────────────────────────────────────

/** Project repo view — git status/staging/commit within a project */
function ProjectRouteRepo({
  onConnect,
  onSwitchMachine,
  onSwitchRepo,
  onRefresh,
  onFetchDiff,
  onStage,
  onUnstage,
  onStagePatch,
  onUnstagePatch,
  onDiscard,
  onUntrack,
  onAddToGitignore,
  onCommit,
  onGenerateAiSummary,
  onApplyAiSuggestion,
  onDismissAiSummary,
  onSetApiKey,
}: {
  onConnect: (agentId: string, publicKey: string) => void;
  onSwitchMachine: (agentId: string) => void;
  onSwitchRepo: (path: string) => void;
} & Omit<React.ComponentProps<typeof RepoView>, 'onSwitchRepo'> & {
  onSwitchRepo: (path: string) => void;
}) {
  const { projectId, repoId } = useParams<{ projectId: string; repoId: string }>();
  const navigate = useNavigate();
  const { isReady, isConnecting, agentId } = useProjectConnection(projectId, onConnect, onSwitchMachine);
  const status = useGitStore((s) => s.status);
  const repoPath = useConnectionStore((s) => s.repoPath);

  // Resolve repoId hash → full repo path. Recompute on connect since
  // getAllKnownPaths can grow when project repos load.
  const targetRepoPath = useMemo(
    () => (agentId && repoId ? resolveHash(repoId, getAllKnownPaths(agentId)) : undefined),
    [agentId, repoId, isReady],
  );

  // Switch to the URL-specified repo once connected.
  useEffect(() => {
    if (isReady && targetRepoPath && targetRepoPath !== repoPath) {
      onSwitchRepo(targetRepoPath);
    }
  }, [isReady, targetRepoPath, repoPath, onSwitchRepo]);

  if (!isReady || !targetRepoPath) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <BaseStatusBar
          left={<BackButton onClick={() => navigate(-1)} />}
          center={<span className="text-sm font-medium text-slate-300">Repo</span>}
        />
        <div className="flex-1 flex items-center justify-center">
          {(isConnecting || (isReady && !targetRepoPath)) && <Spinner size="w-8 h-8" color="border-blue-500" />}
        </div>
      </div>
    );
  }

  return (
    <>
      <BaseStatusBar
        left={<BackButton onClick={() => navigate(-1)} />}
        center={
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-slate-300 truncate">
              {targetRepoPath.split('/').pop() || 'Repo'}
            </span>
            {status?.branch && (
              <span className="text-xs text-slate-500 truncate">
                {status.branch}
                {(status.ahead ?? 0) > 0 && ` ↑${status.ahead}`}
                {(status.behind ?? 0) > 0 && ` ↓${status.behind}`}
              </span>
            )}
          </div>
        }
      />
      <RepoView
        onRefresh={onRefresh}
        onFetchDiff={onFetchDiff}
        onStage={onStage}
        onUnstage={onUnstage}
        onStagePatch={onStagePatch}
        onUnstagePatch={onUnstagePatch}
        onDiscard={onDiscard}
        onUntrack={onUntrack}
        onAddToGitignore={onAddToGitignore}
        onCommit={onCommit}
        onGenerateAiSummary={onGenerateAiSummary}
        onApplyAiSuggestion={onApplyAiSuggestion}
        onDismissAiSummary={onDismissAiSummary}
        onSetApiKey={onSetApiKey}
      />
    </>
  );
}

/** Project detail page — shows session list for a project */
function ProjectRouteDetail({
  onConnect,
  onSwitchMachine,
  onListSessions,
  onListProjectRepos,
  onRemoveCodingPath,
  onRestartAgent,
}: {
  onConnect: (agentId: string, publicKey: string) => void;
  onSwitchMachine: (agentId: string) => void;
  onListSessions: (cwd?: string) => Promise<void>;
  onListProjectRepos?: (cwd: string) => Promise<import('@sumicom/quicksave-shared').ProjectRepo[] | null>;
  onRemoveCodingPath?: (path: string) => void;
  onRestartAgent?: () => Promise<{ success: boolean; error?: string }>;
}) {
  const { projectId } = useParams<{ projectId: string }>();
  const { isReady, isConnecting, isError, cwd, agentId } = useProjectConnection(projectId, onConnect, onSwitchMachine);

  return (
    <ProjectDetail
      isReady={isReady}
      isConnecting={isConnecting}
      isError={isError}
      cwd={cwd}
      agentId={agentId}
      onListSessions={onListSessions}
      onListProjectRepos={onListProjectRepos}
      onRemoveCodingPath={onRemoveCodingPath}
      onRestartAgent={onRestartAgent}
    />
  );
}

/** Project session page — shows chat session within a project */
function ProjectRouteSession({
  onConnect,
  onSwitchMachine,
  showSettings,
  onOpenSettings,
  onCloseSettings,
  onSetSessionConfig,
  onSendControlRequest,
  onCloseSession,
  onArchiveSession,
  onCancelSession,
  onCheckAgentUpdate,
  onUpdateAgent,
  onRestartAgent,
  onListSessions,
  onGetSessionCards,
  onGetSessionConfig,
  onStartSession,
  onResumeSession,
  onRespondToUserInput,
  onUnsubscribeSession,
  onSetActiveAgent,
}: {
  onConnect: (agentId: string, publicKey: string) => void;
  onSwitchMachine: (agentId: string) => void;
  showSettings: boolean;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
  onSetSessionConfig: (sessionId: string, key: string, value: import('@sumicom/quicksave-shared').ConfigValue) => void;
  onSendControlRequest: (sessionId: string, subtype: string, params?: Record<string, unknown>) => Promise<import('@sumicom/quicksave-shared').SessionControlRequestResponsePayload>;
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
  onSetActiveAgent?: (agentId: string) => void;
}) {
  const { projectId, sessionId: urlSessionId } = useParams<{ projectId: string; sessionId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const isNewSession = searchParams.has('new');
  const activeSessionId = useClaudeStore((s) => s.activeSessionId);

  const { isReady, isConnecting, cwd, agentId: targetAgentId } = useProjectConnection(projectId, onConnect, onSwitchMachine);

  const projectBasePath = `/p/${projectId}`;

  // Ensure this agent is active before any send() — critical for multi-agent
  const ensureActiveAgent = useCallback(() => {
    if (targetAgentId) {
      onSetActiveAgent?.(targetAgentId);
    }
  }, [targetAgentId, onSetActiveAgent]);

  // When a session starts, update URL
  const prevActiveRef = useRef(activeSessionId);
  useEffect(() => {
    if (activeSessionId && activeSessionId !== prevActiveRef.current) {
      navigate(`${projectBasePath}/s/${activeSessionId}`, { replace: true });
    }
    prevActiveRef.current = activeSessionId;
  }, [activeSessionId, projectBasePath, navigate]);

  const getSessionId = () => useClaudeStore.getState().activeSessionId || urlSessionId;

  // Bind cwd + agent routing into callbacks
  const boundListSessions = useCallback(() => { ensureActiveAgent(); return onListSessions(cwd); }, [onListSessions, cwd, ensureActiveAgent]);
  const boundGetCards = useCallback(
    (sid: string, offset?: number, limit?: number) => { ensureActiveAgent(); return onGetSessionCards(sid, offset, limit, cwd); },
    [onGetSessionCards, cwd, ensureActiveAgent]
  );
  const boundStartSession = useCallback(
    (prompt: string, opts?: { agent?: 'claude-code' | 'codex'; allowedTools?: string[]; systemPrompt?: string; model?: string; permissionMode?: string }) => {
      ensureActiveAgent(); return onStartSession(prompt, { ...opts, cwd });
    },
    [onStartSession, cwd, ensureActiveAgent]
  );
  const boundResumeSession = useCallback(
    (sid: string, prompt: string) => { ensureActiveAgent(); return onResumeSession(sid, prompt, cwd); },
    [onResumeSession, cwd, ensureActiveAgent]
  );

  if (!isReady) {
    // Show connecting/loading state
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <NewSessionAppBar cwd={cwd} onOpenMenu={() => {}} backTo={projectBasePath} />
        <div className="flex-1 flex items-center justify-center">
          {isConnecting && <div className="text-sm text-slate-400">Connecting...</div>}
        </div>
      </div>
    );
  }

  return (
    <>
      {isNewSession && !activeSessionId ? (
        <NewSessionAppBar cwd={cwd} onOpenMenu={() => {}} backTo={projectBasePath} />
      ) : (
        <SessionAppBar
          showSettings={showSettings}
          onOpenSettings={onOpenSettings}
          onCloseSettings={onCloseSettings}
          onOpenMenu={() => {}}
          backTo={projectBasePath}
          sessionId={urlSessionId}
          onSetSessionConfig={(key, value) => {
            const sid = getSessionId();
            if (sid) onSetSessionConfig(sid, key, value);
          }}
          onSendControlRequest={onSendControlRequest}
          onCloseSession={() => {
            const sid = getSessionId();
            if (sid) onCloseSession(sid);
          }}
          onArchiveSession={async () => {
            const sid = getSessionId();
            if (sid && cwd) {
              await onCloseSession(sid);
              await onArchiveSession(sid, cwd);
              const { setActiveSession, clearCards } = useClaudeStore.getState();
              setActiveSession(null);
              clearCards();
              navigate(projectBasePath, { replace: true });
              onListSessions(cwd);
            }
          }}
          onCancelSession={() => {
            const sid = getSessionId();
            if (sid) onCancelSession(sid);
          }}
          onCheckAgentUpdate={onCheckAgentUpdate}
          onUpdateAgent={onUpdateAgent}
          onRestartAgent={onRestartAgent}
        />
      )}
      <ClaudePanel
        sessionId={urlSessionId === 'new' ? undefined : urlSessionId}
        newSession={isNewSession}
        cwd={cwd}
        onSelectSession={(sid) => navigate(`${projectBasePath}/s/${sid}`)}
        onNewSession={() => navigate(`${projectBasePath}/s/new?new`)}
        onListSessions={boundListSessions}
        onGetSessionCards={boundGetCards}
        onGetSessionConfig={onGetSessionConfig}
        onSetSessionConfig={(sid, key, value) => onSetSessionConfig(sid, key, value)}
        onUnsubscribeSession={onUnsubscribeSession}
        onStartSession={boundStartSession}
        onResumeSession={boundResumeSession}
        onRespondToUserInput={onRespondToUserInput}
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
    const spk = searchParams.get('spk') || undefined;
    const name = searchParams.get('name');
    const repo = searchParams.get('repo');

    if (repo) setPendingRepoPath(repo);

    if (pk) {
      // New machine from QR code
      if (!getMachine(agentId)) {
        addMachine({ agentId, publicKey: pk, signPublicKey: spk, nickname: name || `Machine ${agentId.slice(0, 8)}`, icon: '💻' });
      }
      onConnect(agentId, pk);
    } else {
      // Reconnect to existing machine
      const machine = getMachine(agentId);
      if (machine) {
        onConnect(machine.agentId, machine.publicKey);
      }
    }

    // Redirect to home (overlay will show connecting)
    navigate('/', { replace: true });
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
