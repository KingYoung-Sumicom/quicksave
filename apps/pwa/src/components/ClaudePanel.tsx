import { useEffect, useRef, useCallback, useState } from 'react';
import { clsx } from 'clsx';
import { useClaudeStore } from '../stores/claudeStore';
import { useConnectionStore } from '../stores/connectionStore';
import type { ClaudeSessionSummary, ClaudeUserInputResponsePayload } from '@sumicom/quicksave-shared';
import { StatusDot, sessionStatusKey } from './SessionStatusBadge';
import { CardRenderer } from './chat/CardRenderer';
import { formatRelativeTime } from '../lib/formatRelativeTime';
import { MODELS, PERMISSION_MODES, AGENT_TYPES, type AgentType } from '../lib/claudePresets';

const REASONING_EFFORTS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
];

type StartSessionOpts = { allowedTools?: string[]; systemPrompt?: string; model?: string; permissionMode?: string };

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
    promptInput,
    selectedModel,
    selectedPermissionMode,
    setPromptInput,
    setActiveSession,
    clearCards,
  } = useClaudeStore();

  const activeSession = sessions.find((s) => s.sessionId === activeSessionId);
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

  // Agent type for new sessions (local — doesn't persist after session starts)
  const [selectedAgentType, setSelectedAgentType] = useState<AgentType>(AGENT_TYPES[0]);

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

  // Load session messages when navigating to a different session
  useEffect(() => {
    if (urlSessionId && urlSessionId !== activeSessionId) {
      // Unsubscribe from previous session before switching
      if (activeSessionId) {
        onUnsubscribeSession?.(activeSessionId);
      }
      setActiveSession(urlSessionId);
      clearCards();
      isAtBottomRef.current = true;
      onGetSessionCards(urlSessionId);
      onGetSessionConfig?.(urlSessionId);
    }
  }, [urlSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Retry loading cards after reconnect (e.g. page reload before WS was ready)
  useEffect(() => {
    if (connectionState === 'connected' && urlSessionId && cards.length === 0 && !isLoadingHistory) {
      onGetSessionCards(urlSessionId);
      onGetSessionConfig?.(urlSessionId);
    }
  }, [connectionState]); // eslint-disable-line react-hooks/exhaustive-deps

  // Unsubscribe when leaving session view (navigating to session list)
  useEffect(() => {
    if (!isChat && activeSessionId) {
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
        model: selectedModel,
        permissionMode: selectedPermissionMode,
        ...(selectedAgentType.allowedTools !== undefined ? { allowedTools: selectedAgentType.allowedTools } : {}),
        ...(selectedAgentType.systemPrompt ? { systemPrompt: selectedAgentType.systemPrompt } : {}),
      });
    }
  }, [promptInput, isStreaming, activeSessionId, selectedModel, selectedPermissionMode, selectedAgentType, setPromptInput, onResumeSession, onStartSession]);

  const handleRespondToInput = useCallback((requestId: string, action: 'allow' | 'deny', response?: string) => {
    if (!onRespondToUserInput) return;
    const card = cards.find((c) => c.pendingInput?.requestId === requestId);
    if (!card?.pendingInput) return;
    onRespondToUserInput({
      sessionId: card.pendingInput.sessionId,
      requestId,
      action: action === 'allow' ? (response ? 'respond' : 'allow') : 'deny',
      response,
    });
  }, [cards, onRespondToUserInput]);

  const handleLoadMore = useCallback(async () => {
    if (!activeSessionId || isLoadingHistory || !historyHasMore) return;
    const container = chatContainerRef.current;
    const prevScrollHeight = container?.scrollHeight ?? 0;
    await onGetSessionCards(activeSessionId, cards.length);
    // Restore scroll position so the viewport doesn't jump to top
    if (container) {
      container.scrollTop = container.scrollHeight - prevScrollHeight;
    }
  }, [activeSessionId, isLoadingHistory, historyHasMore, cards.length, onGetSessionCards]);

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
            {cards.map((card, i) => (
              <CardRenderer
                key={card.id}
                card={card}
                isLast={i === cards.length - 1}
                onRespondToInput={handleRespondToInput}
              />
            ))}
            {streamError && (
              <div className="text-sm text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
                {streamError}
              </div>
            )}
            {(() => {
              const lastCard = cards[cards.length - 1];
              const lastIsEmptyText = lastCard?.type === 'assistant_text' && !(lastCard as any).text;
              const showDots = isStreaming && !isResuming && (
                isStartingNewSession ||
                !lastCard ||
                lastCard.type !== 'assistant_text' ||
                lastIsEmptyText
              );
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
              <NewSessionEmptyState
                cwd={cwd}
                selectedAgentType={selectedAgentType}
                onSelectAgentType={setSelectedAgentType}
              />
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
          sessions={sessions}
          isLoading={isLoadingSessions}
          onSelect={handleSelectSession}
          onNewSession={handleNewSession}
        />
      )}
    </div>
  );
}

function SelectorRow<T extends { value: string; label: string }>({ label, options, value, onSelect }: {
  label: string;
  options: T[];
  value: string;
  onSelect: (opt: T) => void;
}) {
  return (
    <div>
      <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-1.5">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onSelect(opt)}
            className={clsx(
              'text-xs px-2.5 py-1 rounded-lg border transition-colors',
              value === opt.value
                ? 'bg-blue-600/30 border-blue-500/60 text-blue-300'
                : 'bg-slate-700/60 border-slate-600/50 text-slate-400 hover:border-slate-500 hover:text-slate-300'
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function NewSessionEmptyState({ cwd, selectedAgentType, onSelectAgentType }: {
  cwd?: string;
  selectedAgentType: AgentType;
  onSelectAgentType: (agent: AgentType) => void;
}) {
  const { selectedModel, selectedPermissionMode, selectedReasoningEffort, setSelectedModel, setSelectedPermissionMode, setSelectedReasoningEffort } = useClaudeStore();

  return (
    <div className="px-4 pt-4 pb-2 flex justify-start">
      <div className="bg-slate-800/50 rounded-xl p-4 space-y-4 border border-slate-700/50 inline-block min-w-0">
        {/* Title + path */}
        <div>
          <h2 className="text-sm font-semibold text-slate-200">New Session</h2>
          {cwd && (
            <p className="mt-0.5 text-xs text-slate-500 flex items-center gap-1 min-w-0">
              <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
              </svg>
              <span className="truncate">{cwd}</span>
            </p>
          )}
        </div>

        {/* Selectors */}
        <SelectorRow
          label="Agent"
          options={AGENT_TYPES}
          value={selectedAgentType.value}
          onSelect={onSelectAgentType}
        />
        <SelectorRow
          label="Model"
          options={MODELS}
          value={selectedModel}
          onSelect={(m) => setSelectedModel(m.value)}
        />
        <SelectorRow
          label="Reasoning Effort"
          options={REASONING_EFFORTS}
          value={selectedReasoningEffort}
          onSelect={(e) => setSelectedReasoningEffort(e.value as 'low' | 'medium' | 'high' | 'max')}
        />
        <SelectorRow
          label="Permission"
          options={PERMISSION_MODES}
          value={selectedPermissionMode}
          onSelect={(p) => setSelectedPermissionMode(p.value)}
        />

        {/* Hint */}
        <p className="text-xs text-slate-600">
          Type a message below to start the session
        </p>
      </div>
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
            className="w-full text-left px-4 py-3 hover:bg-slate-700/50 border-b border-slate-700/50 transition-colors flex items-start gap-3"
          >
            <div className="mt-1 shrink-0">
              <StatusDot statusKey={sessionStatusKey(session)} />
            </div>
            <div className="flex-1 min-w-0">
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
            </div>
          </button>
        ))
      )}
    </div>
  );
}

