import { useEffect, useRef, useCallback, useState } from 'react';
import { clsx } from 'clsx';
import { useClaudeStore } from '../stores/claudeStore';
import { useConnectionStore } from '../stores/connectionStore';
import type { ClaudeSessionSummary, ClaudeUserInputResponsePayload } from '@sumicom/quicksave-shared';
import { CardRenderer } from './chat/CardRenderer';
import { SessionList } from './chat/SessionList';
import { NewSessionEmptyState } from './chat/NewSessionEmptyState';
import { getAgentType } from '../lib/claudePresets';

type StartSessionOpts = { agent?: 'claude-code' | 'codex'; allowedTools?: string[]; systemPrompt?: string; model?: string; permissionMode?: string; sandboxed?: boolean };

interface ClaudePanelProps {
  onSelectSession?: (sessionId: string) => void;
  sessionId?: string;
  newSession?: boolean;
  cwd?: string;
  onListSessions: () => Promise<void>;
  onGetSessionCards: (sessionId: string, offset?: number, limit?: number) => Promise<void>;
  onGetSessionConfig?: (sessionId: string) => Promise<void>;
  onStartSession: (prompt: string, opts?: StartSessionOpts) => Promise<void>;
  onResumeSession: (sessionId: string, prompt: string) => Promise<void>;
  onRespondToUserInput?: (response: ClaudeUserInputResponsePayload) => void;
  onUnsubscribeSession?: (sessionId: string) => void;
  onNewSession?: () => void;
}

export function ClaudePanel({
  onSelectSession,
  sessionId: urlSessionId,
  newSession,
  cwd,
  onListSessions,
  onGetSessionCards,
  onGetSessionConfig,
  onStartSession,
  onResumeSession,

  onRespondToUserInput,
  onUnsubscribeSession,
  onNewSession,
}: ClaudePanelProps) {
  const {
    sessions,
    isLoadingSessions,
    activeSessionId,
    isStreaming,
    streamError,
    cards,
    historyHasMore,
    isLoadingHistory,
    historyError,
    promptInput,
    selectedAgent,
    selectedModel,
    selectedPermissionMode,
    sandboxEnabled,
    setSelectedAgent,
    setPromptInput,
    setActiveSession,
    clearCards,
  } = useClaudeStore();

  const activeSession = activeSessionId ? sessions[activeSessionId] : undefined;
  const isInactiveRaw = !!activeSessionId && !!activeSession && activeSession.isActive === false;
  // Stabilize: only update isInactive when the session is actually found in the list.
  // Prevents flicker during session list refresh (where activeSession is briefly undefined).
  const isInactiveRef = useRef(false);
  if (activeSession !== undefined || !activeSessionId) {
    isInactiveRef.current = isInactiveRaw;
  }
  const isInactive = isInactiveRef.current;
  // True during the window between setStreaming(true) and setActiveSession() — new session spinning up
  const isStartingNewSession = isStreaming && !activeSessionId;
  // True during cold resume: set when resuming an inactive session, cleared on first card event.
  const [isResuming, setIsResuming] = useState(false);

  // Clear isResuming when first non-user card arrives (Claude started responding)
  useEffect(() => {
    if (isResuming && cards.length > 0) {
      const last = cards[cards.length - 1];
      if (last.type !== 'user') setIsResuming(false);
    }
  }, [isResuming, cards]);

  const selectedAgentType = getAgentType(selectedAgent);

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

  const connectionState = useConnectionStore((s) => s.state);
  const agentOnline = useConnectionStore((s) => s.agentOnline);

  // Load session messages when navigating to a different session (or away from one)
  useEffect(() => {
    if (urlSessionId === activeSessionId) return;
    if (activeSessionId) {
      console.log(`[sub:panel] switching session: unsub ${activeSessionId.slice(0, 8)} → sub ${urlSessionId?.slice(0, 8) ?? 'null'}`);
      onUnsubscribeSession?.(activeSessionId);
    }
    setActiveSession(urlSessionId ?? null);
    clearCards();
    if (urlSessionId) {
      isAtBottomRef.current = true;
      onGetSessionCards(urlSessionId);
      onGetSessionConfig?.(urlSessionId);
    }
  }, [urlSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-subscribe after agent reconnect: the relay drops all pubsub subscriptions
  // when the agent's WebSocket disconnects. When the agent comes back online and
  // key exchange completes, we must call getCards (which re-subscribes the peer).
  // This covers both full PWA reconnects (connectionState change) and agent-only
  // relay blips (agentOnline flips false→true while connectionState stays 'connected').
  const prevOnlineRef = useRef(agentOnline);
  useEffect(() => {
    const wasOnline = prevOnlineRef.current;
    prevOnlineRef.current = agentOnline;
    if (!urlSessionId || connectionState !== 'connected') return;
    // Agent came back online (was offline or null → true)
    if (agentOnline === true && wasOnline === false) {
      console.log(`[sub:panel] agent reconnected: re-subscribe session=${urlSessionId.slice(0, 8)}`);
      onGetSessionCards(urlSessionId);
      onGetSessionConfig?.(urlSessionId);
    }
    // Initial load: no cards yet
    if (agentOnline === true && wasOnline === null && cards.length === 0) {
      console.log(`[sub:panel] initial load: subscribe session=${urlSessionId.slice(0, 8)}`);
      onGetSessionCards(urlSessionId);
      onGetSessionConfig?.(urlSessionId);
    }
  }, [agentOnline, connectionState]); // eslint-disable-line react-hooks/exhaustive-deps

  // Unsubscribe when leaving session view (navigating to session list)
  useEffect(() => {
    if (!isChat && activeSessionId) {
      console.log(`[sub:panel] leaving chat view: unsub session=${activeSessionId.slice(0, 8)}`);
      onUnsubscribeSession?.(activeSessionId);
    }
    if (!isChat) {
      onListSessions();
    }
  }, [isChat, onListSessions]); // eslint-disable-line react-hooks/exhaustive-deps

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
      // If the last card has a pending request, scroll to its top so the user sees it fully
      const lastCard = cards[cards.length - 1];
      if (lastCard?.pendingInput) {
        const el = container.querySelector(`[data-card-id="${lastCard.id}"]`);
        if (el) {
          el.scrollIntoView({ block: 'start' });
          return;
        }
      }
      container.scrollTop = container.scrollHeight;
    }
  }, [cards, isStreaming]);


  const handleSelectSession = useCallback(async (session: ClaudeSessionSummary) => {
    if (onSelectSession) {
      onSelectSession(session.sessionId);
    } else {
      setActiveSession(session.sessionId);
      clearCards();
      await onGetSessionCards(session.sessionId);
    }
  }, [onSelectSession, setActiveSession, clearCards, onGetSessionCards]);

  const handleNewSession = useCallback(() => {
    if (activeSessionId) {
      console.log(`[sub:panel] new session: unsub session=${activeSessionId.slice(0, 8)}`);
      onUnsubscribeSession?.(activeSessionId);
    }
    setActiveSession(null);
    clearCards();
    if (onNewSession) {
      onNewSession();
    }
  }, [activeSessionId, setActiveSession, clearCards, onNewSession, onUnsubscribeSession]);

  const handleSend = useCallback(async () => {
    const prompt = promptInput.trim();
    if (!prompt) return;

    isAtBottomRef.current = true;
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }

    setPromptInput('');
    if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
    if (draftKey) localStorage.removeItem(draftKey);

    if (activeSessionId) {
      if (isInactive) setIsResuming(true);
      await onResumeSession(activeSessionId, prompt);
    } else {
      await onStartSession(prompt, {
        agent: selectedAgent,
        model: selectedModel,
        permissionMode: selectedPermissionMode,
        sandboxed: sandboxEnabled || undefined,
        ...(selectedAgentType.allowedTools !== undefined ? { allowedTools: selectedAgentType.allowedTools } : {}),
        ...(selectedAgentType.systemPrompt ? { systemPrompt: selectedAgentType.systemPrompt } : {}),
      });
    }
  }, [promptInput, isStreaming, activeSessionId, selectedAgent, selectedModel, selectedPermissionMode, sandboxEnabled, selectedAgentType, setPromptInput, onResumeSession, onStartSession]);

  const handleRespondToInput = useCallback((requestId: string, action: 'allow' | 'deny', response?: string, allowPattern?: string) => {
    if (!onRespondToUserInput) return;
    const card = cards.find((c) => c.pendingInput?.requestId === requestId);
    if (!card?.pendingInput) return;
    onRespondToUserInput({
      sessionId: card.pendingInput.sessionId,
      requestId,
      action: action === 'allow' ? (response ? 'respond' : 'allow') : 'deny',
      response,
      allowPattern,
    });
  }, [cards, onRespondToUserInput]);

  const handleLoadMore = useCallback(async () => {
    // Read isLoadingHistory from live store state (not stale closure) to prevent
    // the IntersectionObserver from firing duplicate requests before React re-renders.
    if (!activeSessionId || useClaudeStore.getState().isLoadingHistory || !historyHasMore) return;
    const container = chatContainerRef.current;
    const prevScrollHeight = container?.scrollHeight ?? 0;
    await onGetSessionCards(activeSessionId, cards.length);
    // Restore scroll position so the viewport doesn't jump to top
    if (container) {
      container.scrollTop = container.scrollHeight - prevScrollHeight;
    }
  }, [activeSessionId, historyHasMore, cards.length, onGetSessionCards]);

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

  const isMobile = 'ontouchstart' in window;
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !isMobile) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend, isMobile]);

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
        <>
          {/* Messages */}
          <div ref={chatContainerRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 select-text overscroll-contain">
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
            {/* Initial history loading spinner (before any cards arrive) */}
            {!newSession && cards.length === 0 && isLoadingHistory && !historyError && (
              <div className="flex items-center justify-center py-12">
                <svg className="w-6 h-6 text-slate-500 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
              </div>
            )}
            {/* History load error with retry */}
            {historyError && cards.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 gap-3">
                <p className="text-sm text-slate-400">{historyError}</p>
                <button
                  onClick={() => urlSessionId && onGetSessionCards(urlSessionId)}
                  className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
                >
                  Retry
                </button>
              </div>
            )}
            {cards.map((card, i) => (
              <div key={card.id} data-card-id={card.id}>
                <CardRenderer
                  card={card}
                  isLast={i === cards.length - 1}
                  onRespondToInput={handleRespondToInput}
                />
              </div>
            ))}
            {streamError && (
              <div className="text-sm text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
                {streamError}
              </div>
            )}
            {(() => {
              // Show bounce dots when in "thinking" state (blue indicator):
              // streaming (from either local state or agent push), not pending permission, not resuming
              const sessionStreaming = isStreaming || !!activeSession?.isStreaming;
              const showDots = sessionStreaming && !isResuming && !activeSession?.hasPendingInput;
              return showDots ? (
                <div className="flex items-center gap-1.5 py-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:0ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:150ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:300ms]" />
                </div>
              ) : null;
            })()}
            {/* New session empty state — inside scrollable container */}
            {newSession && cards.length === 0 && (
              <NewSessionEmptyState cwd={cwd} />
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Session status banner */}
          {(isStartingNewSession || isResuming || isInactive) && (
            <div className="flex items-center gap-2 px-4 py-2 bg-slate-700/50 border-t border-slate-700 text-xs text-slate-400">
              {(isStartingNewSession || isResuming || (isInactive && isStreaming)) ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                  </svg>
                  {isStartingNewSession ? 'Starting session...' : 'Resuming session...'}
                </>
              ) : (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-500 shrink-0" />
                  Session inactive — send a message to resume
                </>
              )}
            </div>
          )}

          {/* Input */}
          <div className="border-t border-slate-700 px-4 pt-3 flex-shrink-0 bg-slate-900 safe-area-bottom-input touch-none">
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={promptInput}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder=""
                className="flex-1 bg-slate-700 rounded-lg px-3 py-2 text-sm resize-none overflow-y-auto focus:outline-none focus:ring-1 focus:ring-blue-500"
                rows={1}
              />
              <button
                onPointerDown={(e) => { e.preventDefault(); handleSend(); }}
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
            </div>
          </div>
        </>
      ) : (
        <SessionList
          sessions={Object.values(sessions)}
          isLoading={isLoadingSessions}
          onSelect={handleSelectSession}
          onNewSession={handleNewSession}
        />
      )}
    </div>
  );
}
