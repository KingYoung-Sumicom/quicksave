import { useState, useEffect, useRef, useCallback } from 'react';
import { clsx } from 'clsx';
import { useClaudeStore, type ChatMessage } from '../stores/claudeStore';
import type { ClaudeSessionSummary } from '@sumicom/quicksave-shared';

interface ClaudePanelProps {
  isOpen: boolean;
  onClose: () => void;
  onListSessions: () => Promise<void>;
  onGetSessionMessages: (sessionId: string, offset?: number, limit?: number) => Promise<void>;
  onStartSession: (prompt: string, opts?: { allowedTools?: string[]; systemPrompt?: string; model?: string }) => Promise<void>;
  onResumeSession: (sessionId: string, prompt: string) => Promise<void>;
  onCancelSession: (sessionId: string) => Promise<void>;
}

export function ClaudePanel({
  isOpen,
  onClose,
  onListSessions,
  onGetSessionMessages,
  onStartSession,
  onResumeSession,
  onCancelSession,
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
    setPromptInput,
    setActiveSession,
    clearMessages,
  } = useClaudeStore();

  const [view, setView] = useState<'sessions' | 'chat'>('sessions');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Load sessions when panel opens
  useEffect(() => {
    if (isOpen && view === 'sessions') {
      onListSessions();
    }
  }, [isOpen, view, onListSessions]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (messagesEndRef.current && isStreaming) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isStreaming]);

  // Focus input when chat view opens
  useEffect(() => {
    if (view === 'chat' && inputRef.current && !isStreaming) {
      inputRef.current.focus();
    }
  }, [view, isStreaming]);

  const handleSelectSession = useCallback(async (session: ClaudeSessionSummary) => {
    setActiveSession(session.sessionId);
    clearMessages();
    setView('chat');
    await onGetSessionMessages(session.sessionId);
  }, [setActiveSession, clearMessages, onGetSessionMessages]);

  const handleNewSession = useCallback(() => {
    setActiveSession(null);
    clearMessages();
    setView('chat');
  }, [setActiveSession, clearMessages]);

  const handleSend = useCallback(async () => {
    const prompt = promptInput.trim();
    if (!prompt || isStreaming) return;

    setPromptInput('');

    if (activeSessionId) {
      await onResumeSession(activeSessionId, prompt);
    } else {
      await onStartSession(prompt);
    }
  }, [promptInput, isStreaming, activeSessionId, setPromptInput, onResumeSession, onStartSession]);

  const handleCancel = useCallback(() => {
    if (activeSessionId) {
      onCancelSession(activeSessionId);
    }
  }, [activeSessionId, onCancelSession]);

  const handleLoadMore = useCallback(async () => {
    if (!activeSessionId || isLoadingHistory || !historyHasMore) return;
    await onGetSessionMessages(activeSessionId, messages.length);
  }, [activeSessionId, isLoadingHistory, historyHasMore, messages.length, onGetSessionMessages]);

  const handleBack = useCallback(() => {
    setView('sessions');
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />

      {/* Panel */}
      <div className="fixed inset-x-0 bottom-0 z-50 bg-slate-800 rounded-t-xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 flex-shrink-0">
          <div className="flex items-center gap-2">
            {view === 'chat' && (
              <button onClick={handleBack} className="p-1 hover:bg-slate-700 rounded">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
            )}
            <h2 className="text-lg font-semibold">Claude Code</h2>
            {isStreaming && (
              <span className="text-xs px-2 py-0.5 bg-blue-500/20 text-blue-400 rounded-full animate-pulse">
                streaming
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {view === 'sessions' && (
              <button
                onClick={handleNewSession}
                className="text-sm px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded-md transition-colors"
              >
                New
              </button>
            )}
            <button onClick={onClose} className="p-1 hover:bg-slate-700 rounded">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        {view === 'sessions' ? (
          <SessionList
            sessions={sessions}
            isLoading={isLoadingSessions}
            onSelect={handleSelectSession}
          />
        ) : (
          <div className="flex flex-col flex-1 min-h-0">
            {/* Messages */}
            <div ref={chatContainerRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {historyHasMore && (
                <button
                  onClick={handleLoadMore}
                  disabled={isLoadingHistory}
                  className="w-full text-sm text-slate-400 hover:text-slate-300 py-2"
                >
                  {isLoadingHistory ? 'Loading...' : 'Load older messages'}
                </button>
              )}
              {messages.map((msg, i) => (
                <MessageBubble key={i} message={msg} />
              ))}
              {streamError && (
                <div className="text-sm text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
                  {streamError}
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="border-t border-slate-700 px-4 py-3 flex-shrink-0">
              <div className="flex items-end gap-2">
                <textarea
                  ref={inputRef}
                  value={promptInput}
                  onChange={(e) => setPromptInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={activeSessionId ? 'Continue session...' : 'Start a new session...'}
                  className="flex-1 bg-slate-700 rounded-lg px-3 py-2 text-sm resize-none max-h-32 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
        )}
      </div>
    </>
  );
}

function SessionList({
  sessions,
  isLoading,
  onSelect,
}: {
  sessions: ClaudeSessionSummary[];
  isLoading: boolean;
  onSelect: (session: ClaudeSessionSummary) => void;
}) {
  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center py-12 text-slate-400 text-sm">
        No sessions found. Start a new one!
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {sessions.map((session) => (
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
      ))}
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="bg-blue-600 rounded-lg rounded-br-sm px-3 py-2 max-w-[85%] text-sm whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }

  if (message.role === 'assistant') {
    return (
      <div className="flex justify-start">
        <div className="bg-slate-700 rounded-lg rounded-bl-sm px-3 py-2 max-w-[85%] text-sm whitespace-pre-wrap">
          {message.content || <span className="text-slate-400 animate-pulse">...</span>}
        </div>
      </div>
    );
  }

  if (message.role === 'tool') {
    return (
      <div className="flex justify-start">
        <button
          onClick={() => setExpanded(!expanded)}
          className="bg-slate-700/50 border border-slate-600 rounded-lg px-3 py-1.5 max-w-[85%] text-xs text-slate-300 text-left"
        >
          <div className="flex items-center gap-1.5">
            <svg className="w-3 h-3 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
            </svg>
            <span className="font-mono text-yellow-400 truncate">{message.toolName || 'tool_result'}</span>
            <svg
              className={clsx('w-3 h-3 text-slate-400 transition-transform flex-shrink-0', expanded && 'rotate-180')}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
          {expanded && (
            <pre className="mt-2 text-xs text-slate-400 whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
              {message.content}
            </pre>
          )}
        </button>
      </div>
    );
  }

  // system
  return (
    <div className="text-center text-xs text-slate-500 py-1">
      {message.content}
    </div>
  );
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
