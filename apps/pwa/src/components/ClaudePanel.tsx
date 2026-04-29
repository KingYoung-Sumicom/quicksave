import { useEffect, useMemo, useRef, useCallback, useState } from 'react';
import { clsx } from 'clsx';
import { useClaudeStore } from '../stores/claudeStore';
import { useConnectionStore } from '../stores/connectionStore';
import type {
  ClaudeSessionSummary,
  ClaudeUserInputResponsePayload,
  ConfigValue,
  SessionControlRequestResponsePayload,
} from '@sumicom/quicksave-shared';
import { CardRenderer } from './chat/CardRenderer';
import { SessionList } from './chat/SessionList';
import { NewSessionEmptyState } from './chat/NewSessionEmptyState';
import { SessionStatusBar } from './chat/SessionStatusBar';
import { SessionStatsBar } from './chat/SessionStatsBar';
import { StreamingReconnectIndicator } from './chat/StreamingReconnectIndicator';
import { getAgentType } from '../lib/claudePresets';

type StartSessionOpts = { agent?: 'claude-code' | 'codex'; allowedTools?: string[]; systemPrompt?: string; model?: string; permissionMode?: string; sandboxed?: boolean };

interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

interface ClaudePanelProps {
  onSelectSession?: (sessionId: string) => void;
  sessionId?: string;
  newSession?: boolean;
  cwd?: string;
  onGetSessionCards: (sessionId: string, offset?: number, limit?: number) => Promise<void>;
  onSetSessionConfig?: (sessionId: string, key: string, value: ConfigValue) => void;
  onSendControlRequest?: (
    sessionId: string,
    subtype: string,
    params?: Record<string, unknown>,
  ) => Promise<SessionControlRequestResponsePayload>;
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
  onGetSessionCards,
  onSetSessionConfig,
  onSendControlRequest,
  onStartSession,
  onResumeSession,

  onRespondToUserInput,
  onUnsubscribeSession,
  onNewSession,
}: ClaudePanelProps) {
  const {
    sessions,
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
    selectedReasoningEffort,
    sandboxEnabled,
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

  // iOS mitigation: the first real focus on a textarea reports
  // visualViewport.height without subtracting the keyboard accessory bar,
  // so the bar overlaps the input. Pre-focus+blur once on mount to prime
  // WebKit's cached accessory-bar height before the user taps in.
  const hasPrimedFocusRef = useRef(false);
  useEffect(() => {
    if (hasPrimedFocusRef.current) return;
    if (!isChat) return;
    const el = inputRef.current;
    if (!el) return;
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints ?? 0) > 1);
    if (!isIOS) return;
    hasPrimedFocusRef.current = true;
    el.focus({ preventScroll: true });
    el.blur();
  }, [isChat]);

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
    }
    // Initial load: no cards yet
    if (agentOnline === true && wasOnline === null && cards.length === 0) {
      console.log(`[sub:panel] initial load: subscribe session=${urlSessionId.slice(0, 8)}`);
      onGetSessionCards(urlSessionId);
    }
  }, [agentOnline, connectionState]); // eslint-disable-line react-hooks/exhaustive-deps

  // Unsubscribe when leaving session view (navigating to session list)
  useEffect(() => {
    if (!isChat && activeSessionId) {
      console.log(`[sub:panel] leaving chat view: unsub session=${activeSessionId.slice(0, 8)}`);
      onUnsubscribeSession?.(activeSessionId);
    }
  }, [isChat]); // eslint-disable-line react-hooks/exhaustive-deps

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
        // Codex honors reasoningEffort; Claude providers ignore it. Send for both
        // — the agent layer narrows by provider.
        ...(selectedReasoningEffort ? { reasoningEffort: selectedReasoningEffort } : {}),
        ...(selectedAgentType.allowedTools !== undefined ? { allowedTools: selectedAgentType.allowedTools } : {}),
        ...(selectedAgentType.systemPrompt ? { systemPrompt: selectedAgentType.systemPrompt } : {}),
      });
    }
  }, [promptInput, isStreaming, activeSessionId, selectedAgent, selectedModel, selectedPermissionMode, sandboxEnabled, selectedReasoningEffort, selectedAgentType, setPromptInput, onResumeSession, onStartSession]);

  const handleRespondToInput = useCallback((requestId: string, action: 'allow' | 'deny', response?: string, allowPattern?: string) => {
    if (!onRespondToUserInput) return;
    // Read cards from the live store rather than the closure so this
    // callback reference stays stable across re-renders — required for
    // CardRenderer's memoization to actually skip re-renders on keystrokes.
    const card = useClaudeStore.getState().cards.find((c) => c.pendingInput?.requestId === requestId);
    if (!card?.pendingInput) return;
    onRespondToUserInput({
      sessionId: card.pendingInput.sessionId,
      requestId,
      action: action === 'allow' ? (response ? 'respond' : 'allow') : 'deny',
      response,
      allowPattern,
    });
  }, [onRespondToUserInput]);

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

  // ── Slash-command autocomplete ──
  // Source: `reload_plugins` control_request → `commands: [{name, description, argumentHint}]`.
  // Cached per active session (the list is per-CLI-process and rarely changes). New-session
  // view has no CLI to ask, so the popover stays dormant until the session starts.
  const [slashCommands, setSlashCommands] = useState<SlashCommand[] | null>(null);
  const slashCommandsSessionIdRef = useRef<string | null>(null);
  const slashCommandsFetchingRef = useRef(false);
  const [slashIndex, setSlashIndex] = useState(0);

  const slashQuery = useMemo(() => {
    const m = /^\s*\/(\w*)$/.exec(promptInput);
    return m ? m[1] : null;
  }, [promptInput]);
  const slashOpen = slashQuery !== null;

  const filteredSlashCommands = useMemo(() => {
    if (slashQuery === null || !slashCommands) return [];
    const q = slashQuery.toLowerCase();
    if (!q) return slashCommands;
    return slashCommands.filter((c) => c.name.toLowerCase().includes(q));
  }, [slashQuery, slashCommands]);

  // Reset selection whenever the filtered list changes shape.
  useEffect(() => { setSlashIndex(0); }, [slashQuery, filteredSlashCommands.length]);

  // Keep the highlighted row visible when navigating with arrow keys.
  const slashListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!slashOpen) return;
    const el = slashListRef.current?.children[slashIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [slashIndex, slashOpen]);

  // Lazy-fetch the command list the first time the popover opens for a session.
  useEffect(() => {
    if (!slashOpen) return;
    if (!activeSessionId || !onSendControlRequest) return;
    if (slashCommandsSessionIdRef.current === activeSessionId && slashCommands) return;
    if (slashCommandsFetchingRef.current) return;
    slashCommandsFetchingRef.current = true;
    onSendControlRequest(activeSessionId, 'reload_plugins')
      .then((resp) => {
        if (!resp.success) return;
        const commands = (resp.response as { commands?: SlashCommand[] } | undefined)?.commands;
        if (Array.isArray(commands)) {
          slashCommandsSessionIdRef.current = activeSessionId;
          setSlashCommands(commands);
        }
      })
      .catch((err) => {
        console.warn('[slash] reload_plugins failed:', err);
      })
      .finally(() => {
        slashCommandsFetchingRef.current = false;
      });
  }, [slashOpen, activeSessionId, onSendControlRequest, slashCommands]);

  // Drop the cache when switching sessions; the new session has its own command set.
  useEffect(() => {
    if (slashCommandsSessionIdRef.current && slashCommandsSessionIdRef.current !== activeSessionId) {
      slashCommandsSessionIdRef.current = null;
      setSlashCommands(null);
    }
  }, [activeSessionId]);

  const insertSlashCommand = useCallback((cmd: SlashCommand) => {
    setPromptInput(`/${cmd.name} `);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const pos = el.value.length;
      el.setSelectionRange(pos, pos);
      el.style.height = 'auto';
      const lineHeight = parseInt(getComputedStyle(el).lineHeight) || 20;
      el.style.height = `${Math.min(el.scrollHeight, lineHeight * 5)}px`;
    });
  }, [setPromptInput]);

  const isMobile = 'ontouchstart' in window;
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Slash-command popover swallows nav keys before send/newline handling.
    if (slashOpen && filteredSlashCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % filteredSlashCommands.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + filteredSlashCommands.length) % filteredSlashCommands.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) {
        e.preventDefault();
        const cmd = filteredSlashCommands[slashIndex];
        if (cmd) insertSlashCommand(cmd);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setPromptInput('');
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !isMobile) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend, isMobile, slashOpen, filteredSlashCommands, slashIndex, insertSlashCommand, setPromptInput]);

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
              // streaming (from either local state or agent push), not pending permission, not resuming.
              // While the link's status is uncertain (reconnecting / agent
              // offline / fully dropped), swap to StreamingReconnectIndicator
              // so the user sees we're waiting on connectivity rather than on
              // the model — without prematurely tearing down the in-flight
              // stream, which would happen if we treated WS blips as
              // "session ended."
              const sessionStreaming = isStreaming || !!activeSession?.isStreaming;
              const showDots = sessionStreaming && !isResuming && !activeSession?.hasPendingInput;
              if (!showDots) return null;
              const linkUncertain = connectionState !== 'connected' || agentOnline === false;
              return linkUncertain ? (
                <StreamingReconnectIndicator />
              ) : (
                <div className="flex items-center gap-1.5 py-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:0ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:150ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:300ms]" />
                </div>
              );
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
                  {isStartingNewSession ? 'Starting task...' : 'Resuming task...'}
                </>
              ) : (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-500 shrink-0" />
                  Task inactive — send a message to resume
                </>
              )}
            </div>
          )}

          {/* Input */}
          <div className="border-t border-slate-700 px-4 pt-3 flex-shrink-0 bg-slate-900 safe-area-bottom-input touch-none">
            {activeSessionId && (
              <SessionStatusBar
                sessionId={activeSessionId}
                onSetSessionConfig={onSetSessionConfig}
              >
                <SessionStatsBar
                  sessionId={activeSessionId}
                  onCompact={() => onResumeSession(activeSessionId, '/compact')}
                  onClear={handleNewSession}
                />
              </SessionStatusBar>
            )}
            <div className="relative flex items-end gap-2">
              {slashOpen && filteredSlashCommands.length > 0 && (
                <div ref={slashListRef} className="absolute left-0 right-0 bottom-full mb-2 max-h-56 overflow-y-auto rounded-lg border border-slate-700 bg-slate-800 shadow-lg z-10">
                  {filteredSlashCommands.map((cmd, i) => (
                    <button
                      key={cmd.name}
                      type="button"
                      onPointerDown={(e) => { e.preventDefault(); insertSlashCommand(cmd); }}
                      onMouseEnter={() => setSlashIndex(i)}
                      className={clsx(
                        'w-full text-left px-3 py-1.5 flex items-baseline gap-2 text-sm',
                        i === slashIndex ? 'bg-slate-700' : 'hover:bg-slate-700/60',
                      )}
                    >
                      <span className="font-mono text-blue-300 shrink-0">/{cmd.name}</span>
                      {cmd.argumentHint && (
                        <span className="font-mono text-slate-500 shrink-0 text-xs">{cmd.argumentHint}</span>
                      )}
                      {cmd.description && (
                        <span className="text-slate-400 truncate text-xs">— {cmd.description}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
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
          sessions={Object.values(sessions).filter((s) => s.cwd === cwd)}
          onSelect={handleSelectSession}
          onNewSession={handleNewSession}
        />
      )}
    </div>
  );
}
