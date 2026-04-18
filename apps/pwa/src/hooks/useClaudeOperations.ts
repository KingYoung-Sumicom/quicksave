import { useCallback, useRef } from 'react';
import {
  type CardHistoryResponse,
  type ClaudeListSessionsResponsePayload,
  type ClaudeStartResponsePayload,
  type ClaudeResumeResponsePayload,
  type ClaudeCancelResponsePayload,
  type ClaudeCloseResponsePayload,
  type ClaudeGetMessagesRequestPayload,
  type ClaudeUserInputResponsePayload,
  type ClaudePreferences,
  type ClaudeSetPreferencesResponsePayload,
  type ClaudeSetSessionPermissionResponsePayload,
  type AgentId,
  type ConfigValue,
  type SessionCardsUpdate,
  type SessionGetConfigResponsePayload,
  type SessionSetConfigResponsePayload,
  type SessionControlRequestPayload,
  type SessionControlRequestResponsePayload,
  type SessionUpdateHistoryResponsePayload,
  type ProjectListSummariesResponsePayload,
  type ProjectListReposResponsePayload,
} from '@sumicom/quicksave-shared';
import type { MessageBusClient } from '@sumicom/quicksave-message-bus';
import { useClaudeStore } from '../stores/claudeStore';
import { applySessionCardsSnapshot, applySessionCardsUpdate } from '../lib/applySessionCards';

export function useClaudeOperations(
  busRef: React.RefObject<MessageBusClient | null>,
) {
  // Per-session unsubscribe fns for /sessions/:id/cards bus subscriptions.
  const cardsUnsubsRef = useRef<Map<string, () => void>>(new Map());
  const {
    mergeSessions,
    upsertSession,
    setLoadingSessions,
    setActiveSession,
    setStreaming,
    setStreamError,
    prependCards,
    appendCard,
    setHistoryMeta,
    setLoadingHistory,
    setHistoryError,
    clearCards,
    setSelectedModel,
    setSelectedPermissionMode,
    setSelectedReasoningEffort,
    setSessionConfigKey,
    applySessionConfig,
  } = useClaudeStore();

  // Apply a full or partial ClaudePreferences object to the store
  const applyPreferences = useCallback((prefs: Partial<ClaudePreferences>) => {
    if (prefs.model !== undefined) setSelectedModel(prefs.model);
    if (prefs.reasoningEffort !== undefined) setSelectedReasoningEffort(prefs.reasoningEffort);
  }, [setSelectedModel, setSelectedReasoningEffort]);

  /**
   * Issue a one-shot bus command. Rejects if the bus isn't ready, on timeout,
   * or on a server-side error (encoded as "CODE: message" by the agent's bus
   * adapter so callers can parse specific codes like REPO_MISMATCH).
   */
  const sendCommand = useCallback(
    <R, P = unknown>(verb: string, payload: P, timeoutMs = 30000): Promise<R> => {
      const bus = busRef.current;
      if (!bus) return Promise.reject(new Error('Not connected'));
      return bus.command<R, P>(verb, payload, { timeoutMs, queueWhileDisconnected: true });
    },
    [busRef],
  );

  /**
   * Refresh the active-sessions view after (re)connect. Replaces the older
   * push-based `claude:active-sessions:response` flow — with the bus, we just
   * issue a command and reconcile the store inline.
   */
  const reconcileActiveSessions = useCallback(async () => {
    try {
      const resp = await sendCommand<{
        sessions: Array<{
          sessionId: string;
          isStreaming?: boolean;
          hasPendingInput?: boolean;
          agent?: AgentId;
          permissionMode?: string;
        }>;
      }>('claude:active-sessions', {}, 10_000);
      const activeIds = new Set(resp.sessions.map((s) => s.sessionId));
      useClaudeStore.getState().reconcileActiveSessions(activeIds);
      for (const s of resp.sessions) {
        upsertSession({
          sessionId: s.sessionId,
          isActive: true,
          isStreaming: s.isStreaming,
          hasPendingInput: s.hasPendingInput,
          agent: s.agent,
          permissionMode: s.permissionMode,
        });
      }
    } catch (err) {
      console.warn('reconcileActiveSessions failed:', err);
    }
  }, [sendCommand, upsertSession]);

  const listSessions = useCallback(async (cwd?: string) => {
    setLoadingSessions(true);
    try {
      const response = await sendCommand<ClaudeListSessionsResponsePayload>(
        'claude:list-sessions',
        { ...(cwd ? { cwd } : {}) },
      );
      if (response.error) {
        throw new Error(response.error);
      }
      // Merge into map: preserves sessions from other cwds, removes stale ones for this cwd
      mergeSessions(response.sessions, cwd);
    } catch (error) {
      console.error('Failed to list sessions:', error);
    } finally {
      setLoadingSessions(false);
    }
  }, [sendCommand, mergeSessions, setLoadingSessions]);

  /**
   * For offset === 0 (initial load / resubscribe after navigation): opens a
   * `/sessions/:id/cards` bus subscription. The snapshot populates cards +
   * title; subsequent updates stream live CardEvents and CardStreamEnd into
   * the store. Duplicate calls for the same session are no-ops (the bus
   * client dedups wire frames and the per-session unsub handle is preserved).
   *
   * For offset > 0 (pagination): issues the `claude:get-cards` command and
   * prepends the returned page to the store.
   */
  const getSessionCards = useCallback(
    async (sessionId: string, offset = 0, limit = 50, cwd?: string, subscribeOnly = false) => {
      if (offset === 0) {
        const bus = busRef.current;
        if (!bus) return;
        if (cardsUnsubsRef.current.has(sessionId)) return; // already subscribed
        if (!subscribeOnly) {
          setLoadingHistory(true);
          setHistoryError(null);
        }
        const unsub = bus.subscribe<CardHistoryResponse, SessionCardsUpdate>(
          `/sessions/${sessionId}/cards`,
          {
            onSnapshot: (snap) => {
              if (!subscribeOnly) setLoadingHistory(false);
              applySessionCardsSnapshot(sessionId, snap);
            },
            onUpdate: (update) => applySessionCardsUpdate(sessionId, update),
            onError: (err) => {
              console.warn(`[bus] /sessions/${sessionId}/cards error:`, err);
              if (!subscribeOnly) {
                setHistoryError(err);
                setLoadingHistory(false);
              }
            },
          },
        );
        cardsUnsubsRef.current.set(sessionId, unsub);
        return;
      }

      // Pagination: fetch older history via command.
      setLoadingHistory(true);
      setHistoryError(null);
      try {
        const response = await sendCommand<CardHistoryResponse, ClaudeGetMessagesRequestPayload>(
          'claude:get-cards',
          { sessionId, offset, limit, ...(cwd ? { cwd } : {}) },
        );
        if (response.error) throw new Error(response.error);
        prependCards(response.cards);
        setHistoryMeta(response.total, response.hasMore);
      } catch (error) {
        console.error('Failed to get session cards:', error);
        setHistoryError(error instanceof Error ? error.message : 'Failed to load history');
      } finally {
        setLoadingHistory(false);
      }
    },
    [busRef, sendCommand, prependCards, setHistoryMeta, setLoadingHistory, setHistoryError]
  );

  const startSession = useCallback(
    async (prompt: string, opts?: { agent?: AgentId; allowedTools?: string[]; systemPrompt?: string; model?: string; permissionMode?: string; cwd?: string; sandboxed?: boolean }) => {
      clearCards();
      setStreaming(true);
      setStreamError(null);
      // Add user card immediately (optimistic)
      appendCard({ type: 'user', id: `local-user-${Date.now()}`, timestamp: Date.now(), text: prompt });
      try {
        console.log(`[sub] start → implicit subscribe (new session)`);
        const response = await sendCommand<ClaudeStartResponsePayload>(
          'claude:start',
          {
            prompt,
            agent: opts?.agent,
            allowedTools: opts?.allowedTools,
            systemPrompt: opts?.systemPrompt,
            model: opts?.model,
            permissionMode: opts?.permissionMode,
            sandboxed: opts?.sandboxed,
            ...(opts?.cwd ? { cwd: opts.cwd } : {}),
          },
          120000,
        );
        if (!response.success) {
          throw new Error(response.error || 'Failed to start session');
        }
        // Pre-populate session state so the indicator flips to "thinking"
        // immediately, without waiting for the async session-updated broadcast.
        // Missing the broadcast (e.g. transient subscribe races) would otherwise
        // leave the indicator stuck on "closed".
        if (response.sessionId) {
          upsertSession({
            sessionId: response.sessionId,
            isActive: true,
            isStreaming: true,
            hasPendingInput: false,
            ...(opts?.agent ? { agent: opts.agent } : {}),
            ...(opts?.permissionMode ? { permissionMode: opts.permissionMode } : {}),
            ...(opts?.cwd ? { cwd: opts.cwd } : {}),
          });
        }
        setActiveSession(response.sessionId ?? null, response.streamId ?? null);
        // Subscribe to card events for the new session immediately.
        // The ClaudePanel navigation effect skips subscription when
        // urlSessionId already equals activeSessionId, so we must
        // subscribe here to avoid missing streamed cards.
        if (response.sessionId) {
          getSessionCards(response.sessionId, 0, 50, opts?.cwd, /* subscribeOnly */ true);
        }
      } catch (error) {
        setStreaming(false);
        setStreamError(error instanceof Error ? error.message : 'Failed to start session');
      }
    },
    [sendCommand, clearCards, setStreaming, setStreamError, setActiveSession, appendCard, upsertSession, getSessionCards]
  );

  const { addStreamId } = useClaudeStore.getState();
  const resumeSession = useCallback(
    async (sessionId: string, prompt: string, cwd?: string) => {
      const wasAlreadyStreaming = useClaudeStore.getState().isStreaming;
      setStreaming(true);
      setStreamError(null);
      appendCard({ type: 'user', id: `local-user-${Date.now()}`, timestamp: Date.now(), text: prompt });
      try {
        console.log(`[sub] resume → implicit subscribe session=${sessionId.slice(0, 8)}`);
        const response = await sendCommand<ClaudeResumeResponsePayload>(
          'claude:resume',
          { sessionId, prompt, ...(cwd ? { cwd } : {}) },
          120000,
        );
        if (!response.success) {
          throw new Error(response.error || 'Failed to resume session');
        }
        const actualSessionId = response.sessionId ?? sessionId;
        // Flip the indicator to "thinking" immediately so we don't rely on the
        // session-updated broadcast being delivered before the user looks at
        // the session list.
        upsertSession({
          sessionId: actualSessionId,
          isActive: true,
          isStreaming: true,
          hasPendingInput: false,
        });
        if (wasAlreadyStreaming) {
          // Hot resume: ADD the new streamId alongside existing ones.
          // Old streamIds stay until their card-stream-end arrives naturally.
          if (response.streamId) addStreamId(response.streamId);
        } else {
          // Cold resume: set as the only active streamId
          setActiveSession(actualSessionId, response.streamId ?? null);
        }
      } catch (error) {
        setStreaming(false);
        setStreamError(error instanceof Error ? error.message : 'Failed to resume session');
      }
    },
    [sendCommand, setStreaming, setStreamError, setActiveSession, appendCard, upsertSession]
  );

  const cancelSession = useCallback(
    async (sessionId: string) => {
      setStreaming(false);
      try {
        await sendCommand<ClaudeCancelResponsePayload>('claude:cancel', { sessionId });
      } catch (error) {
        console.error('Failed to cancel session:', error);
      }
    },
    [sendCommand, setStreaming]
  );

  const closeSession = useCallback(
    async (sessionId: string) => {
      setStreaming(false);
      try {
        await sendCommand<ClaudeCloseResponsePayload>('claude:close', { sessionId });
      } catch (error) {
        console.error('Failed to close session:', error);
      }
    },
    [sendCommand, setStreaming]
  );

  const archiveSession = useCallback(
    async (sessionId: string, cwd: string) => {
      try {
        await sendCommand<SessionUpdateHistoryResponsePayload>(
          'session:update-history',
          { sessionId, cwd, updates: { archived: true } },
        );
      } catch (error) {
        console.error('Failed to archive session:', error);
      }
    },
    [sendCommand],
  );

  const setPreferences = useCallback(
    (prefs: Partial<ClaudePreferences>) => {
      applyPreferences(prefs); // optimistic
      sendCommand<ClaudeSetPreferencesResponsePayload, { preferences: Partial<ClaudePreferences> }>(
        'claude:set-preferences',
        { preferences: prefs },
      ).then((response) => {
        applyPreferences(response.preferences); // confirm with actual applied value
      }).catch(() => { /* broadcast will resync if needed */ });
    },
    [sendCommand, applyPreferences],
  );

  const setSessionPermission = useCallback(
    (sessionId: string, permissionMode: string) => {
      setSelectedPermissionMode(permissionMode);
      sendCommand<ClaudeSetSessionPermissionResponsePayload, { sessionId: string; permissionMode: string }>(
        'claude:set-session-permission',
        { sessionId, permissionMode },
      ).catch(() => {});
    },
    [sendCommand, setSelectedPermissionMode],
  );

  const setSessionConfig = useCallback(
    (sessionId: string, key: string, value: ConfigValue) => {
      setSessionConfigKey(sessionId, key, value); // optimistic
      sendCommand<SessionSetConfigResponsePayload, { sessionId: string; key: string; value: ConfigValue }>(
        'session:set-config',
        { sessionId, key, value },
      ).then((response) => {
        applySessionConfig(sessionId, response.config); // confirm with actual applied config (rolled back on failure)
        if (response.success === false && response.error) {
          // The CLI rejected the change (e.g. set_permission_mode 'auto' not supported for this model/plan).
          // The agent has already rolled back its state and returned the actual current config;
          // applySessionConfig above reconciles the UI. Warn the user so they know why their change was reverted.
          window.alert(`Can't set ${key} to "${String(value)}": ${response.error}`);
        }
      }).catch(() => {});
    },
    [sendCommand, setSessionConfigKey, applySessionConfig],
  );

  const getSessionConfig = useCallback(
    async (sessionId: string) => {
      try {
        const response = await sendCommand<SessionGetConfigResponsePayload, { sessionId: string }>(
          'session:get-config',
          { sessionId },
        );
        applySessionConfig(sessionId, response.config);
      } catch { /* agent may not support this yet */ }
    },
    [sendCommand, applySessionConfig],
  );

  const sendControlRequest = useCallback(
    async (sessionId: string, subtype: string, params?: Record<string, unknown>): Promise<SessionControlRequestResponsePayload> => {
      // Allow a long wall-time budget — server pauses its idle timer during compaction/turn work.
      return sendCommand<SessionControlRequestResponsePayload, SessionControlRequestPayload>(
        'session:control-request',
        { sessionId, subtype, params },
        10 * 60 * 1000,
      );
    },
    [sendCommand],
  );

  const respondToUserInput = useCallback(
    (response: ClaudeUserInputResponsePayload) => {
      sendCommand<void, ClaudeUserInputResponsePayload>(
        'claude:user-input-response',
        response,
      ).catch((err) => {
        console.warn('respondToUserInput failed:', err);
      });
    },
    [sendCommand]
  );

  /**
   * Release the `/sessions/:id/cards` bus subscription for this session. The
   * MessageBusClient refcounts subscriptions, so duplicate calls are safe.
   */
  const unsubscribeSession = useCallback(
    (sessionId: string) => {
      const unsub = cardsUnsubsRef.current.get(sessionId);
      if (!unsub) return;
      cardsUnsubsRef.current.delete(sessionId);
      unsub();
    },
    []
  );

  const listProjectRepos = useCallback(async (cwd: string) => {
    try {
      const response = await sendCommand<ProjectListReposResponsePayload>('project:list-repos', { cwd });
      if (response.error) {
        console.error('Failed to list project repos:', response.error);
        return null;
      }
      return response.repos;
    } catch (error) {
      console.error('Failed to list project repos:', error);
      return null;
    }
  }, [sendCommand]);

  const listProjectSummaries = useCallback(async () => {
    try {
      const response = await sendCommand<ProjectListSummariesResponsePayload>('project:list-summaries', {});
      if (response.error) {
        console.error('Failed to list project summaries:', response.error);
        return null;
      }
      return response.projects;
    } catch (error) {
      console.error('Failed to list project summaries:', error);
      return null;
    }
  }, [sendCommand]);

  return {
    reconcileActiveSessions,
    listSessions,
    getSessionCards,
    startSession,
    resumeSession,
    cancelSession,
    closeSession,
    archiveSession,
    respondToUserInput,
    setPreferences,
    setSessionPermission,
    getSessionConfig,
    setSessionConfig,
    sendControlRequest,
    unsubscribeSession,
    listProjectSummaries,
    listProjectRepos,
  };
}
