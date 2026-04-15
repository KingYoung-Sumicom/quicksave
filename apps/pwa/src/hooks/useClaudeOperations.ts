import { useCallback, useRef } from 'react';
import {
  createMessage,
  type Message,
  type CardEvent,
  type CardHistoryResponse,
  type CardStreamEnd,
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
  type SessionGetConfigResponsePayload,
  type SessionSetConfigResponsePayload,
  type SessionConfigUpdatedPayload,
  type SessionUpdateHistoryResponsePayload,
} from '@sumicom/quicksave-shared';
import { useClaudeStore } from '../stores/claudeStore';
import { WebSocketClient } from '../lib/websocket';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export function useClaudeOperations(clientRef: React.RefObject<WebSocketClient | null>) {
  const pendingRequests = useRef<Map<string, PendingRequest>>(new Map());
  const {
    mergeSessions,
    upsertSession,
    setLoadingSessions,
    setActiveSession,
    setStreaming,
    setStreamError,
    setCards,
    prependCards,
    appendCard,
    handleCardEvent,
    setHistoryMeta,
    setLoadingHistory,
    setHistoryError,
    clearCards,
    clearPendingInput,
    setSelectedModel,
    setSelectedAgent,
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

  const sendRequest = useCallback(
    <T>(message: Message, timeoutMs = 30000): Promise<T> => {
      return new Promise((resolve, reject) => {
        if (!clientRef.current) {
          reject(new Error('Not connected'));
          return;
        }

        const timeout = setTimeout(() => {
          pendingRequests.current.delete(message.id);
          reject(new Error('Request timeout'));
        }, timeoutMs);

        pendingRequests.current.set(message.id, {
          resolve: resolve as (value: unknown) => void,
          reject,
          timeout,
        });

        try {
          clientRef.current.send(message);
        } catch (err) {
          clearTimeout(timeout);
          pendingRequests.current.delete(message.id);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    [clientRef]
  );

  // Handle request-response messages (matched by message ID)
  const handleResponse = useCallback((message: Message) => {
    const pending = pendingRequests.current.get(message.id);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingRequests.current.delete(message.id);

      if (message.type === 'error') {
        pending.reject(new Error((message.payload as { message: string }).message));
      } else {
        pending.resolve(message.payload);
      }
      return true;
    }
    return false;
  }, []);

  // Handle server-pushed messages
  const handlePushMessage = useCallback((message: Message): boolean => {
    // Card-based protocol
    if (message.type === 'claude:card-event') {
      const event = message.payload as CardEvent;
      const { activeSessionId, activeStreamIds, isStreaming } = useClaudeStore.getState();
      // Ignore events for sessions we are not viewing.
      // When isStreaming && !activeSessionId, a new session is starting up —
      // activeSessionId will be set once the start response arrives, so let events through.
      if (activeSessionId && event.sessionId !== activeSessionId) {
        return true;
      }
      if (!activeSessionId && !isStreaming) {
        return true;
      }
      if (activeStreamIds.length > 0 && event.streamId && !activeStreamIds.includes(event.streamId)) {
        return true; // consume but discard stale events
      }
      handleCardEvent(event);
      return true;
    }

    if (message.type === 'claude:card-stream-end') {
      const payload = message.payload as CardStreamEnd;
      const { activeSessionId, activeStreamIds, isStreaming } = useClaudeStore.getState();
      if (activeSessionId && payload.sessionId !== activeSessionId) {
        return true;
      }
      if (!activeSessionId && !isStreaming) {
        return true;
      }
      // Remove this streamId; only stop streaming if no other streams are active
      const remaining = activeStreamIds.filter((id) => id !== payload.streamId);
      if (remaining.length > 0) {
        useClaudeStore.setState({ activeStreamIds: remaining });
      } else {
        setStreaming(false);
      }
      if (!payload.success && !payload.interrupted) {
        setStreamError(payload.error || 'Session ended with error');
      }
      // Append cost info as system card if available
      if (payload.totalCostUsd !== undefined || payload.tokenUsage) {
        const parts: string[] = [];
        if (payload.totalCostUsd !== undefined) {
          parts.push(`Cost: $${payload.totalCostUsd.toFixed(4)}`);
        }
        if (payload.tokenUsage) {
          parts.push(`Tokens: ${payload.tokenUsage.input}in/${payload.tokenUsage.output}out`);
        }
        appendCard({
          type: 'system',
          id: `cost-${Date.now()}`,
          timestamp: Date.now(),
          text: parts.join(' | '),
          subtype: 'cost',
        });
      }
      return true;
    }

    if (message.type === 'claude:user-input-request') {
      const payload = message.payload as { sessionId: string };
      if (payload.sessionId) {
        upsertSession({ sessionId: payload.sessionId, hasPendingInput: true });
      }
      return true;
    }

    if (message.type === 'claude:user-input-resolved') {
      const payload = message.payload as { requestId: string; sessionId: string };
      clearPendingInput(payload.requestId);
      if (payload.sessionId) {
        upsertSession({ sessionId: payload.sessionId, hasPendingInput: false });
      }
      return true;
    }

    if (message.type === 'claude:session-updated') {
      const payload = message.payload as { sessionId: string; isActive: boolean; isStreaming: boolean; hasPendingInput: boolean; agent?: AgentId; permissionMode?: string; sandboxed?: boolean; provider?: string };
      const agent = payload.agent ?? (payload.provider === 'codex-mcp' ? 'codex' : payload.provider ? 'claude-code' : undefined);
      const { sessions, activeSessionId } = useClaudeStore.getState();
      const current = sessions[payload.sessionId];
      if (current &&
        current.isActive === payload.isActive &&
        current.isStreaming === payload.isStreaming &&
        current.hasPendingInput === payload.hasPendingInput &&
        current.agent === agent &&
        current.permissionMode === payload.permissionMode) return true;
      upsertSession({
        sessionId: payload.sessionId,
        isActive: payload.isActive,
        isStreaming: payload.isStreaming,
        hasPendingInput: payload.hasPendingInput,
        agent,
        permissionMode: payload.permissionMode,
      });
      if (payload.sessionId === activeSessionId) {
        setStreaming(payload.isStreaming);
        if (agent) setSelectedAgent(agent);
        if (payload.permissionMode) setSelectedPermissionMode(payload.permissionMode);
      }
      return true;
    }

    if (message.type === 'claude:preferences-updated') {
      applyPreferences(message.payload as ClaudePreferences);
      return true;
    }

    if (message.type === 'session:config-updated') {
      const { sessionId, config } = message.payload as SessionConfigUpdatedPayload;
      applySessionConfig(sessionId, config);
      return true;
    }

    return false;
  }, [handleCardEvent, setStreaming, setStreamError, appendCard, clearPendingInput, upsertSession, applyPreferences, applySessionConfig, setSelectedPermissionMode, setSelectedAgent]);

  // Combined message handler
  const handleMessage = useCallback((message: Message): boolean => {
    if (handlePushMessage(message)) return true;
    return handleResponse(message);
  }, [handlePushMessage, handleResponse]);

  const listSessions = useCallback(async (cwd?: string) => {
    setLoadingSessions(true);
    try {
      const message = createMessage('claude:list-sessions', { ...(cwd ? { cwd } : {}) });
      const response = await sendRequest<ClaudeListSessionsResponsePayload>(message);
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
  }, [sendRequest, mergeSessions, setLoadingSessions]);

  // Dedup initial subscribe (offset=0): skip if already in-flight for same session.
  // Prevents double-fire from React StrictMode or competing effects.
  const subscribeInFlightRef = useRef<string | null>(null);

  const getSessionCards = useCallback(
    async (sessionId: string, offset = 0, limit = 50, cwd?: string) => {
      if (offset === 0 && subscribeInFlightRef.current === sessionId) {
        console.log(`[sub] get-cards → deduped session=${sessionId.slice(0, 8)}`);
        return;
      }
      if (offset === 0) subscribeInFlightRef.current = sessionId;
      setLoadingHistory(true);
      setHistoryError(null);
      try {
        const message = createMessage<ClaudeGetMessagesRequestPayload>('claude:get-cards', { sessionId, offset, limit, ...(cwd ? { cwd } : {}) });
        console.log(`[sub] get-cards → implicit subscribe session=${sessionId.slice(0, 8)} offset=${offset}`);
        const response = await sendRequest<CardHistoryResponse>(message);
        if (response.error) {
          throw new Error(response.error);
        }

        if (offset === 0) {
          setCards(response.cards);
          // Apply title from getCards response (available on initial load / reconnect)
          if (response.title) {
            applySessionConfig(sessionId, { title: response.title });
          }
        } else {
          prependCards(response.cards);
        }
        setHistoryMeta(response.total, response.hasMore);
      } catch (error) {
        console.error('Failed to get session cards:', error);
        setHistoryError(error instanceof Error ? error.message : 'Failed to load history');
      } finally {
        if (offset === 0) subscribeInFlightRef.current = null;
        setLoadingHistory(false);
      }
    },
    [sendRequest, setCards, prependCards, setHistoryMeta, setLoadingHistory, setHistoryError, applySessionConfig]
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
        const message = createMessage('claude:start', {
          prompt,
          agent: opts?.agent,
          allowedTools: opts?.allowedTools,
          systemPrompt: opts?.systemPrompt,
          model: opts?.model,
          permissionMode: opts?.permissionMode,
          sandboxed: opts?.sandboxed,
          ...(opts?.cwd ? { cwd: opts.cwd } : {}),
        });
        const response = await sendRequest<ClaudeStartResponsePayload>(message, 120000);
        if (!response.success) {
          throw new Error(response.error || 'Failed to start session');
        }
        // Pre-populate session with the requested agent so setActiveSession
        // picks it up before the async session-updated event arrives.
        if (response.sessionId && opts?.agent) {
          upsertSession({ sessionId: response.sessionId, agent: opts.agent });
        }
        setActiveSession(response.sessionId ?? null, response.streamId ?? null);
      } catch (error) {
        setStreaming(false);
        setStreamError(error instanceof Error ? error.message : 'Failed to start session');
      }
    },
    [sendRequest, clearCards, setStreaming, setStreamError, setActiveSession, appendCard, upsertSession]
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
        const message = createMessage('claude:resume', { sessionId, prompt, ...(cwd ? { cwd } : {}) });
        const response = await sendRequest<ClaudeResumeResponsePayload>(message, 120000);
        if (!response.success) {
          throw new Error(response.error || 'Failed to resume session');
        }
        if (wasAlreadyStreaming) {
          // Hot resume: ADD the new streamId alongside existing ones.
          // Old streamIds stay until their card-stream-end arrives naturally.
          if (response.streamId) addStreamId(response.streamId);
        } else {
          // Cold resume: set as the only active streamId
          setActiveSession(response.sessionId ?? sessionId, response.streamId ?? null);
        }
      } catch (error) {
        setStreaming(false);
        setStreamError(error instanceof Error ? error.message : 'Failed to resume session');
      }
    },
    [sendRequest, setStreaming, setStreamError, setActiveSession, appendCard]
  );

  const cancelSession = useCallback(
    async (sessionId: string) => {
      setStreaming(false);
      try {
        const message = createMessage('claude:cancel', { sessionId });
        await sendRequest<ClaudeCancelResponsePayload>(message);
      } catch (error) {
        console.error('Failed to cancel session:', error);
      }
    },
    [sendRequest, setStreaming]
  );

  const closeSession = useCallback(
    async (sessionId: string) => {
      setStreaming(false);
      try {
        const message = createMessage('claude:close', { sessionId });
        await sendRequest<ClaudeCloseResponsePayload>(message);
      } catch (error) {
        console.error('Failed to close session:', error);
      }
    },
    [sendRequest, setStreaming]
  );

  const archiveSession = useCallback(
    async (sessionId: string, cwd: string) => {
      try {
        const message = createMessage('session:update-history', { sessionId, cwd, updates: { archived: true } });
        await sendRequest<SessionUpdateHistoryResponsePayload>(message);
      } catch (error) {
        console.error('Failed to archive session:', error);
      }
    },
    [sendRequest],
  );

  const setPreferences = useCallback(
    (prefs: Partial<ClaudePreferences>) => {
      applyPreferences(prefs); // optimistic
      const message = createMessage<{ preferences: Partial<ClaudePreferences> }>('claude:set-preferences', { preferences: prefs });
      sendRequest<ClaudeSetPreferencesResponsePayload>(message).then((response) => {
        applyPreferences(response.preferences); // confirm with actual applied value
      }).catch(() => { /* broadcast will resync if needed */ });
    },
    [sendRequest, applyPreferences],
  );

  const setSessionPermission = useCallback(
    (sessionId: string, permissionMode: string) => {
      setSelectedPermissionMode(permissionMode);
      const message = createMessage<{ sessionId: string; permissionMode: string }>('claude:set-session-permission', { sessionId, permissionMode });
      sendRequest<ClaudeSetSessionPermissionResponsePayload>(message).catch(() => {});
    },
    [sendRequest, setSelectedPermissionMode],
  );

  const setSessionConfig = useCallback(
    (sessionId: string, key: string, value: ConfigValue) => {
      setSessionConfigKey(sessionId, key, value); // optimistic
      const message = createMessage<{ sessionId: string; key: string; value: ConfigValue }>('session:set-config', { sessionId, key, value });
      sendRequest<SessionSetConfigResponsePayload>(message).then((response) => {
        applySessionConfig(sessionId, response.config); // confirm with actual applied config
      }).catch(() => {});
    },
    [sendRequest, setSessionConfigKey, applySessionConfig],
  );

  const getSessionConfig = useCallback(
    async (sessionId: string) => {
      try {
        const message = createMessage<{ sessionId: string }>('session:get-config', { sessionId });
        const response = await sendRequest<SessionGetConfigResponsePayload>(message);
        applySessionConfig(sessionId, response.config);
      } catch { /* agent may not support this yet */ }
    },
    [sendRequest, applySessionConfig],
  );

  const respondToUserInput = useCallback(
    (response: ClaudeUserInputResponsePayload) => {
      clearPendingInput(response.requestId);
      const message = createMessage<ClaudeUserInputResponsePayload>('claude:user-input-response', response);
      clientRef.current?.send(message);
    },
    [clientRef, clearPendingInput]
  );

  const unsubscribeSession = useCallback(
    (sessionId: string) => {
      console.log(`[unsub] unsubscribe session=${sessionId.slice(0, 8)}`);
      const message = createMessage('claude:unsubscribe', { sessionId });
      clientRef.current?.send(message);
    },
    [clientRef]
  );

  return {
    handleMessage,
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
    unsubscribeSession,
  };
}
