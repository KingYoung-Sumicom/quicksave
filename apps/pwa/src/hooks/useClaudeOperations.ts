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
  type ConfigValue,
  type SessionGetConfigResponsePayload,
  type SessionSetConfigResponsePayload,
  type SessionConfigUpdatedPayload,
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
    setSessions,
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
    clearCards,
    clearPendingInput,
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

        clientRef.current.send(message);
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
      const { activeSessionId, activeStreamIds } = useClaudeStore.getState();
      // Ignore events for sessions we are not viewing
      if (activeSessionId && event.sessionId !== activeSessionId) {
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
      const { activeSessionId, activeStreamIds } = useClaudeStore.getState();
      if (activeSessionId && payload.sessionId !== activeSessionId) {
        return true;
      }
      // Remove this streamId; only stop streaming if no other streams are active
      const remaining = activeStreamIds.filter((id) => id !== payload.streamId);
      if (remaining.length > 0) {
        useClaudeStore.setState({ activeStreamIds: remaining });
      } else {
        setStreaming(false);
      }
      if (!payload.success) {
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
      // Also set hasPendingInput on the session as a reliable fallback
      // in case the session-updated push is missed.
      const payload = message.payload as { sessionId: string };
      if (payload.sessionId) {
        const { sessions } = useClaudeStore.getState();
        setSessions(sessions.map((s) =>
          s.sessionId === payload.sessionId ? { ...s, hasPendingInput: true } : s
        ));
      }
      // TODO: trigger notification sound/vibration here
      return true;
    }

    if (message.type === 'claude:user-input-resolved') {
      const payload = message.payload as { requestId: string; sessionId: string };
      clearPendingInput(payload.requestId);
      // Also clear hasPendingInput on the session
      if (payload.sessionId) {
        const { sessions } = useClaudeStore.getState();
        setSessions(sessions.map((s) =>
          s.sessionId === payload.sessionId ? { ...s, hasPendingInput: false } : s
        ));
      }
      return true;
    }

    if (message.type === 'claude:session-updated') {
      const payload = message.payload as { sessionId: string; isActive: boolean; isStreaming: boolean; hasPendingInput: boolean; permissionMode?: string };
      const { sessions, activeSessionId } = useClaudeStore.getState();
      const current = sessions.find((s) => s.sessionId === payload.sessionId);
      if (current &&
        current.isActive === payload.isActive &&
        current.isStreaming === payload.isStreaming &&
        current.hasPendingInput === payload.hasPendingInput &&
        current.permissionMode === payload.permissionMode) return true;
      const updated = sessions.map((s) =>
        s.sessionId === payload.sessionId
          ? { ...s, isActive: payload.isActive, isStreaming: payload.isStreaming, hasPendingInput: payload.hasPendingInput, permissionMode: payload.permissionMode }
          : s
      );
      setSessions(updated);
      if (payload.sessionId === activeSessionId) {
        setStreaming(payload.isStreaming);
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
  }, [handleCardEvent, setStreaming, setStreamError, appendCard, clearPendingInput, setSessions, applyPreferences, applySessionConfig, setSelectedPermissionMode]);

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
      setSessions(response.sessions);
    } catch (error) {
      console.error('Failed to list sessions:', error);
    } finally {
      setLoadingSessions(false);
    }
  }, [sendRequest, setSessions, setLoadingSessions]);

  const getSessionCards = useCallback(
    async (sessionId: string, offset = 0, limit = 50, cwd?: string) => {
      setLoadingHistory(true);
      try {
        const message = createMessage<ClaudeGetMessagesRequestPayload>('claude:get-cards', { sessionId, offset, limit, ...(cwd ? { cwd } : {}) });
        const response = await sendRequest<CardHistoryResponse>(message);
        if (response.error) {
          throw new Error(response.error);
        }

        if (offset === 0) {
          setCards(response.cards);
        } else {
          prependCards(response.cards);
        }
        setHistoryMeta(response.total, response.hasMore);
      } catch (error) {
        console.error('Failed to get session cards:', error);
      } finally {
        setLoadingHistory(false);
      }
    },
    [sendRequest, setCards, prependCards, setHistoryMeta, setLoadingHistory]
  );

  const startSession = useCallback(
    async (prompt: string, opts?: { allowedTools?: string[]; systemPrompt?: string; model?: string; permissionMode?: string; cwd?: string }) => {
      clearCards();
      setStreaming(true);
      setStreamError(null);
      // Add user card immediately (optimistic)
      appendCard({ type: 'user', id: `local-user-${Date.now()}`, timestamp: Date.now(), text: prompt });
      try {
        const message = createMessage('claude:start', {
          prompt,
          allowedTools: opts?.allowedTools,
          systemPrompt: opts?.systemPrompt,
          model: opts?.model,
          permissionMode: opts?.permissionMode,
          ...(opts?.cwd ? { cwd: opts.cwd } : {}),
        });
        const response = await sendRequest<ClaudeStartResponsePayload>(message, 120000);
        if (!response.success) {
          throw new Error(response.error || 'Failed to start session');
        }
        setActiveSession(response.sessionId ?? null, response.streamId ?? null);
      } catch (error) {
        setStreaming(false);
        setStreamError(error instanceof Error ? error.message : 'Failed to start session');
      }
    },
    [sendRequest, clearCards, setStreaming, setStreamError, setActiveSession, appendCard]
  );

  const { addStreamId } = useClaudeStore.getState();
  const resumeSession = useCallback(
    async (sessionId: string, prompt: string, cwd?: string) => {
      const wasAlreadyStreaming = useClaudeStore.getState().isStreaming;
      if (wasAlreadyStreaming) {
        // Hot resume: clear stream filter so early events from the new stream aren't dropped
        // before we know its streamId. The response will re-add the correct IDs.
        useClaudeStore.setState({ activeStreamIds: [] });
      }
      setStreaming(true);
      setStreamError(null);
      appendCard({ type: 'user', id: `local-user-${Date.now()}`, timestamp: Date.now(), text: prompt });
      try {
        const message = createMessage('claude:resume', { sessionId, prompt, ...(cwd ? { cwd } : {}) });
        const response = await sendRequest<ClaudeResumeResponsePayload>(message, 120000);
        if (!response.success) {
          throw new Error(response.error || 'Failed to resume session');
        }
        if (wasAlreadyStreaming) {
          // Hot resume: set the new streamId (old stream ended or will end separately)
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
    respondToUserInput,
    setPreferences,
    setSessionPermission,
    getSessionConfig,
    setSessionConfig,
    unsubscribeSession,
  };
}
