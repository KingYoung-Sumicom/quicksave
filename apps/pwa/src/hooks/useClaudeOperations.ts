import { useCallback, useRef } from 'react';
import {
  createMessage,
  type Message,
  type ClaudeListSessionsResponsePayload,
  type ClaudeStartResponsePayload,
  type ClaudeResumeResponsePayload,
  type ClaudeCancelResponsePayload,
  type ClaudeCloseResponsePayload,
  type ClaudeGetMessagesResponsePayload,
  type ClaudeStreamPayload,
  type ClaudeStreamEndPayload,
} from '@sumicom/quicksave-shared';
import { useClaudeStore, type ChatMessage } from '../stores/claudeStore';
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
    setMessages,
    setHistoryMeta,
    setLoadingHistory,
    clearMessages,
    handleStreamEvent,
    appendMessage,
  } = useClaudeStore();

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

  // Handle server-pushed messages (claude:stream, claude:stream:end)
  const handlePushMessage = useCallback((message: Message): boolean => {
    if (message.type === 'claude:stream') {
      const payload = message.payload as ClaudeStreamPayload;
      handleStreamEvent(payload.eventType, payload.content, payload.toolName, payload.toolInput);
      return true;
    }

    if (message.type === 'claude:stream:end') {
      const payload = message.payload as ClaudeStreamEndPayload;
      setStreaming(false);
      if (!payload.success) {
        setStreamError(payload.error || 'Session ended with error');
      }
      // Append cost info as system message if available
      if (payload.totalCostUsd !== undefined || payload.tokenUsage) {
        const parts: string[] = [];
        if (payload.totalCostUsd !== undefined) {
          parts.push(`Cost: $${payload.totalCostUsd.toFixed(4)}`);
        }
        if (payload.tokenUsage) {
          parts.push(`Tokens: ${payload.tokenUsage.input}in/${payload.tokenUsage.output}out`);
        }
        appendMessage({
          role: 'system',
          content: parts.join(' | '),
          timestamp: Date.now(),
        });
      }
      return true;
    }

    return false;
  }, [handleStreamEvent, setStreaming, setStreamError, appendMessage]);

  // Combined message handler — returns true if message was consumed
  const handleMessage = useCallback((message: Message): boolean => {
    // Try push messages first (no pending request ID)
    if (handlePushMessage(message)) return true;
    // Then try request-response
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

  const getSessionMessages = useCallback(
    async (sessionId: string, offset = 0, limit = 50, cwd?: string) => {
      setLoadingHistory(true);
      try {
        const message = createMessage('claude:get-messages', { sessionId, offset, limit, ...(cwd ? { cwd } : {}) });
        const response = await sendRequest<ClaudeGetMessagesResponsePayload>(message);
        if (response.error) {
          throw new Error(response.error);
        }
        // Convert history messages to chat messages
        const chatMessages = response.messages
          .map((m): ChatMessage | null => {
            // Tool use (assistant message with toolName) → show as tool bubble
            if (m.toolName) {
              return {
                role: 'tool',
                content: m.toolInput || '',
                toolName: m.toolName,
                toolInput: m.toolInput,
                timestamp: Date.now(),
              };
            }
            // Tool result with no text content → skip (noise)
            if (!m.content && m.toolResult) {
              return null;
            }
            // Empty message → skip
            if (!m.content) {
              return null;
            }
            return {
              role: m.role as 'user' | 'assistant',
              content: m.content,
              timestamp: Date.now(),
            };
          })
          .filter((m): m is ChatMessage => m !== null);

        if (offset === 0) {
          setMessages(chatMessages);
        } else {
          // Prepend older messages (infinite scroll)
          useClaudeStore.getState().prependMessages(chatMessages);
        }
        setHistoryMeta(response.total, response.hasMore);
      } catch (error) {
        console.error('Failed to get session messages:', error);
      } finally {
        setLoadingHistory(false);
      }
    },
    [sendRequest, setMessages, setHistoryMeta, setLoadingHistory]
  );

  const startSession = useCallback(
    async (prompt: string, opts?: { allowedTools?: string[]; systemPrompt?: string; model?: string; cwd?: string }) => {
      clearMessages();
      setStreaming(true);
      setStreamError(null);
      // Add user message immediately
      appendMessage({ role: 'user', content: prompt, timestamp: Date.now() });
      try {
        const message = createMessage('claude:start', {
          prompt,
          allowedTools: opts?.allowedTools,
          systemPrompt: opts?.systemPrompt,
          model: opts?.model,
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
    [sendRequest, clearMessages, setStreaming, setStreamError, setActiveSession, appendMessage]
  );

  const resumeSession = useCallback(
    async (sessionId: string, prompt: string, cwd?: string) => {
      setStreaming(true);
      setStreamError(null);
      appendMessage({ role: 'user', content: prompt, timestamp: Date.now() });
      try {
        const message = createMessage('claude:resume', { sessionId, prompt, ...(cwd ? { cwd } : {}) });
        const response = await sendRequest<ClaudeResumeResponsePayload>(message, 120000);
        if (!response.success) {
          throw new Error(response.error || 'Failed to resume session');
        }
        setActiveSession(response.sessionId ?? sessionId, response.streamId ?? null);
      } catch (error) {
        setStreaming(false);
        setStreamError(error instanceof Error ? error.message : 'Failed to resume session');
      }
    },
    [sendRequest, setStreaming, setStreamError, setActiveSession, appendMessage]
  );

  const cancelSession = useCallback(
    async (sessionId: string) => {
      try {
        const message = createMessage('claude:cancel', { sessionId });
        const response = await sendRequest<ClaudeCancelResponsePayload>(message);
        if (!response.success) {
          throw new Error(response.error || 'Failed to cancel session');
        }
        setStreaming(false);
      } catch (error) {
        console.error('Failed to cancel session:', error);
      }
    },
    [sendRequest, setStreaming]
  );

  const closeSession = useCallback(
    async (sessionId: string) => {
      try {
        const message = createMessage('claude:close', { sessionId });
        const response = await sendRequest<ClaudeCloseResponsePayload>(message);
        if (!response.success) {
          throw new Error(response.error || 'Failed to close session');
        }
        setActiveSession(null, null);
        setStreaming(false);
      } catch (error) {
        console.error('Failed to close session:', error);
      }
    },
    [sendRequest, setActiveSession, setStreaming]
  );

  return {
    handleMessage,
    listSessions,
    getSessionMessages,
    startSession,
    resumeSession,
    cancelSession,
    closeSession,
  };
}
