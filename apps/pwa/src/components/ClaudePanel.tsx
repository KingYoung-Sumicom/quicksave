import { useEffect, useRef, useCallback } from 'react';
import { clsx } from 'clsx';
import { useClaudeStore } from '../stores/claudeStore';
import type { ClaudeSessionSummary, ClaudeUserInputResponsePayload } from '@sumicom/quicksave-shared';
import { MessageBubble } from './chat/MessageBubble';
import { formatRelativeTime } from '../lib/formatRelativeTime';

type StartSessionOpts = { allowedTools?: string[]; systemPrompt?: string; model?: string; permissionMode?: string };

interface ClaudePanelProps {
  onSelectSession?: (sessionId: string) => void;
  sessionId?: string;
  newSession?: boolean;
  onListSessions: () => Promise<void>;
  onGetSessionMessages: (sessionId: string, offset?: number, limit?: number) => Promise<void>;
  onStartSession: (prompt: string, opts?: StartSessionOpts) => Promise<void>;
  onResumeSession: (sessionId: string, prompt: string) => Promise<void>;
  onCancelSession: (sessionId: string) => Promise<void>;
  onRespondToUserInput?: (response: ClaudeUserInputResponsePayload) => void;
  onNewSession?: () => void;
}

export function ClaudePanel({
  onSelectSession,
  sessionId: urlSessionId,
  newSession,
  onListSessions,
  onGetSessionMessages,
  onStartSession,
  onResumeSession,
  onCancelSession,
  onRespondToUserInput,
  onNewSession,
}: ClaudePanelProps) {
  const {
    sessions,
    isLoadingSessions,
    activeSessionId,
    isStreaming,
    streamError,
    messages,
    historyHasMore,
    isLoadingHistory,
    promptInput,
    selectedModel,
    selectedPermissionMode,
    setPromptInput,
    setActiveSession,
    clearMessages,
  } = useClaudeStore();

  // View is determined by URL: sessionId present = chat, ?new = new session, absent = sessions list
  const isChat = !!urlSessionId || !!newSession;
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Per-session draft persistence
  const draftKey = urlSessionId ? `qs_draft_${urlSessionId}` : newSession ? 'qs_draft_new' : null;

  // Restore draft when session changes
  useEffect(() => {
    if (!draftKey) return;
    const saved = localStorage.getItem(draftKey) ?? '';
    setPromptInput(saved);
    // Resize textarea to match restored content
    requestAnimationFrame(() => {
      if (inputRef.current) {
        const el = inputRef.current;
        el.style.height = 'auto';
        const lineHeight = parseInt(getComputedStyle(el).lineHeight) || 20;
        el.style.height = `${Math.min(el.scrollHeight, lineHeight * 5)}px`;
      }
    });
  }, [draftKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load session messages when navigating to a different session
  useEffect(() => {
    if (urlSessionId && urlSessionId !== activeSessionId) {
      setActiveSession(urlSessionId);
      clearMessages();
      isAtBottomRef.current = true;
      onGetSessionMessages(urlSessionId);
    }
  }, [urlSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load sessions when showing sessions list
  useEffect(() => {
    if (!isChat) {
      onListSessions();
    }
  }, [isChat, onListSessions]);

  // Auto-scroll: stick to bottom unless user has scrolled up
  const isAtBottomRef = useRef(true);
  useEffect(() => {
    const container = chatContainerRef.current;
    if (!container) return;
    const onScroll = () => {
      const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      isAtBottomRef.current = distFromBottom < 80;
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const container = chatContainerRef.current;
    if (!container) return;
    if (isAtBottomRef.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [messages, isStreaming]);

  // Focus input when chat view opens
  useEffect(() => {
    if (isChat && inputRef.current && !isStreaming) {
      inputRef.current.focus();
    }
  }, [isChat, isStreaming]);

  const handleSelectSession = useCallback(async (session: ClaudeSessionSummary) => {
    if (onSelectSession) {
      onSelectSession(session.sessionId);
    } else {
      setActiveSession(session.sessionId);
      clearMessages();
      await onGetSessionMessages(session.sessionId);
    }
  }, [onSelectSession, setActiveSession, clearMessages, onGetSessionMessages]);

  const handleNewSession = useCallback(() => {
    setActiveSession(null);
    clearMessages();
    if (onNewSession) {
      onNewSession();
    }
  }, [setActiveSession, clearMessages, onNewSession]);

  const handleSend = useCallback(async () => {
    const prompt = promptInput.trim();
    if (!prompt || isStreaming) return;

    isAtBottomRef.current = true;
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }

    setPromptInput('');
    if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
    if (draftKey) localStorage.removeItem(draftKey);

    if (activeSessionId) {
      await onResumeSession(activeSessionId, prompt);
    } else {
      await onStartSession(prompt, { model: selectedModel, permissionMode: selectedPermissionMode });
    }
  }, [promptInput, isStreaming, activeSessionId, selectedModel, selectedPermissionMode, setPromptInput, onResumeSession, onStartSession]);

  const handleCancel = useCallback(() => {
    if (activeSessionId) {
      onCancelSession(activeSessionId);
    }
  }, [activeSessionId, onCancelSession]);

  const handleRespondToInput = useCallback((requestId: string, action: 'allow' | 'deny', response?: string) => {
    if (!onRespondToUserInput) return;
    // Find the pending request from the tagged message
    const msg = messages.find((m) => m.pendingInputRequest?.requestId === requestId);
    if (!msg?.pendingInputRequest) return;
    onRespondToUserInput({
      sessionId: msg.pendingInputRequest.sessionId,
      requestId,
      action: action === 'allow' ? (response ? 'respond' : 'allow') : 'deny',
      response,
    });
  }, [messages, onRespondToUserInput]);

  const handleLoadMore = useCallback(async () => {
    if (!activeSessionId || isLoadingHistory || !historyHasMore) return;
    const container = chatContainerRef.current;
    const prevScrollHeight = container?.scrollHeight ?? 0;
    await onGetSessionMessages(activeSessionId, messages.length);
    // Restore scroll position so the viewport doesn't jump to top
    if (container) {
      container.scrollTop = container.scrollHeight - prevScrollHeight;
    }
  }, [activeSessionId, isLoadingHistory, historyHasMore, messages.length, onGetSessionMessages]);

  // Auto-load older messages when sentinel scrolls into view
  const topSentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = topSentinelRef.current;
    if (!sentinel || !historyHasMore) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) handleLoadMore(); },
      { root: chatContainerRef.current, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [historyHasMore, handleLoadMore]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  // Debounced draft save (3s)
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveDraft = useCallback((value: string) => {
    if (!draftKey) return;
    if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
    draftSaveTimer.current = setTimeout(() => {
      if (value) {
        localStorage.setItem(draftKey, value);
      } else {
        localStorage.removeItem(draftKey);
      }
    }, 3000);
  }, [draftKey]);

  // Auto-resize textarea to fit content, persist draft to localStorage
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setPromptInput(value);
    saveDraft(value);
    const el = e.target;
    el.style.height = 'auto';
    const lineHeight = parseInt(getComputedStyle(el).lineHeight) || 20;
    el.style.height = `${Math.min(el.scrollHeight, lineHeight * 5)}px`;
  }, [saveDraft, setPromptInput]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {isChat ? (
        <div className="flex flex-col flex-1 min-h-0">
          {/* Messages */}
          <div ref={chatContainerRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 select-text">
            {historyHasMore && (
              <div ref={topSentinelRef} className="flex justify-center py-2 h-8">
                {isLoadingHistory && (
                  <svg className="w-5 h-5 text-slate-500 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                  </svg>
                )}
              </div>
            )}
            {messages.map((msg, i) => (
              <MessageBubble
                key={i}
                message={msg}
                nextMessage={messages[i + 1]}
                isLast={i === messages.length - 1}
                onRespondToInput={handleRespondToInput}
              />
            ))}
            {streamError && (
              <div className="text-sm text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
                {streamError}
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="border-t border-slate-700 px-4 pt-3 flex-shrink-0 bg-slate-900" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}>
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={promptInput}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder=""
                className="flex-1 bg-slate-700 rounded-lg px-3 py-2 text-sm resize-none overflow-y-auto focus:outline-none focus:ring-1 focus:ring-blue-500"
                rows={1}
                disabled={isStreaming}
              />
              {isStreaming ? (
                <button
                  onClick={handleCancel}
                  className="p-2 bg-red-600 hover:bg-red-500 rounded-lg transition-colors flex-shrink-0"
                  title="Cancel"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!promptInput.trim()}
                  className={clsx(
                    'p-2 rounded-lg transition-colors flex-shrink-0',
                    promptInput.trim()
                      ? 'bg-blue-600 hover:bg-blue-500'
                      : 'bg-slate-600 text-slate-400'
                  )}
                  title="Send"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19V5m0 0l-7 7m7-7l7 7" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
      ) : (
        <SessionList
          sessions={sessions}
          isLoading={isLoadingSessions}
          onSelect={handleSelectSession}
          onNewSession={handleNewSession}
        />
      )}
    </div>
  );
}

function SessionList({
  sessions,
  isLoading,
  onSelect,
  onNewSession,
}: {
  sessions: ClaudeSessionSummary[];
  isLoading: boolean;
  onSelect: (session: ClaudeSessionSummary) => void;
  onNewSession: () => void;
}) {
  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto safe-area-bottom">
      {/* New session button */}
      <button
        onClick={onNewSession}
        className="w-full text-left px-4 py-3 border-b border-slate-700/50 transition-colors hover:bg-slate-700/50 flex items-center gap-2"
      >
        <svg className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
        <span className="text-sm text-blue-400 font-medium">New Session</span>
      </button>

      {sessions.length === 0 ? (
        <div className="flex items-center justify-center py-12 text-slate-400 text-sm">
          No sessions yet
        </div>
      ) : (
        sessions.map((session) => (
          <button
            key={session.sessionId}
            onClick={() => onSelect(session)}
            className="w-full text-left px-4 py-3 hover:bg-slate-700/50 border-b border-slate-700/50 transition-colors"
          >
            <p className="text-sm font-medium truncate">
              {session.summary || session.sessionId.slice(0, 12)}
            </p>
            <div className="flex items-center gap-2 mt-1 text-xs text-slate-400">
              {session.gitBranch && (
                <span className="flex items-center gap-1">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  {session.gitBranch}
                </span>
              )}
              <span>{formatRelativeTime(session.lastModified)}</span>
            </div>
          </button>
        ))
      )}
    </div>
  );
}

