import { create } from 'zustand';
import type { Card, CardEvent, ClaudeSessionSummary, ConfigValue } from '@sumicom/quicksave-shared';
import { DEFAULT_MODEL, DEFAULT_PERMISSION_MODE, DEFAULT_REASONING_EFFORT } from '@sumicom/quicksave-shared';

/** Sessions keyed by sessionId for O(1) lookup. */
type SessionMap = Record<string, ClaudeSessionSummary>;

interface ClaudeStore {
  // Session list
  sessions: SessionMap;
  isLoadingSessions: boolean;

  // Active session
  activeSessionId: string | null;
  activeStreamIds: string[];
  isStreaming: boolean;
  streamError: string | null;

  // Cards (current session)
  cards: Card[];
  historyTotal: number;
  historyHasMore: boolean;
  isLoadingHistory: boolean;


  // UI
  promptInput: string;
  isVisible: boolean;

  // Session preferences (defaults for new sessions)
  selectedModel: string;
  selectedPermissionMode: string;
  selectedReasoningEffort: 'low' | 'medium' | 'high' | 'max';
  sandboxEnabled: boolean;

  // Per-session runtime config (keyed by sessionId)
  sessionConfigs: Record<string, Record<string, ConfigValue>>;

  // Actions — sessions
  setSessions: (sessions: ClaudeSessionSummary[]) => void;
  mergeSessions: (incoming: ClaudeSessionSummary[]) => void;
  upsertSession: (session: Partial<ClaudeSessionSummary> & { sessionId: string }) => void;
  setLoadingSessions: (loading: boolean) => void;

  // Actions — active session
  setActiveSession: (sessionId: string | null, streamId?: string | null) => void;
  addStreamId: (streamId: string) => void;
  setStreaming: (streaming: boolean) => void;
  setStreamError: (error: string | null) => void;

  // Actions — cards
  setCards: (cards: Card[]) => void;
  prependCards: (cards: Card[]) => void;
  appendCard: (card: Card) => void;
  handleCardEvent: (event: CardEvent) => void;
  setHistoryMeta: (total: number, hasMore: boolean) => void;
  setLoadingHistory: (loading: boolean) => void;
  clearCards: () => void;

  // Actions — pending input
  clearPendingInput: (requestId: string) => void;

  // Actions — session preferences (new session defaults)
  setSelectedModel: (model: string) => void;
  setSelectedPermissionMode: (mode: string) => void;
  setSelectedReasoningEffort: (effort: 'low' | 'medium' | 'high' | 'max') => void;
  setSandboxEnabled: (enabled: boolean) => void;

  // Actions — per-session runtime config
  setSessionConfigKey: (sessionId: string, key: string, value: ConfigValue) => void;
  applySessionConfig: (sessionId: string, config: Record<string, ConfigValue>) => void;

  // Actions — UI
  setPromptInput: (input: string) => void;
  setVisible: (visible: boolean) => void;

  // Reset
  reset: () => void;
}

export const useClaudeStore = create<ClaudeStore>((set, get) => ({
  // Initial state
  sessions: {},
  isLoadingSessions: false,
  activeSessionId: null,
  activeStreamIds: [],
  isStreaming: false,
  streamError: null,
  cards: [],
  historyTotal: 0,
  historyHasMore: false,
  isLoadingHistory: false,
  promptInput: '',
  isVisible: false,
  selectedModel: DEFAULT_MODEL,
  selectedPermissionMode: DEFAULT_PERMISSION_MODE,
  selectedReasoningEffort: DEFAULT_REASONING_EFFORT,
  sandboxEnabled: false,
  sessionConfigs: {},

  // Sessions
  setSessions: (sessions) => {
    const map: SessionMap = {};
    for (const s of sessions) map[s.sessionId] = s;
    set({ sessions: map });
  },
  mergeSessions: (incoming: ClaudeSessionSummary[]) =>
    set((state) => {
      const merged = { ...state.sessions };
      for (const s of incoming) merged[s.sessionId] = s;
      return { sessions: merged };
    }),
  upsertSession: (partial) =>
    set((state) => ({
      sessions: {
        ...state.sessions,
        [partial.sessionId]: { ...state.sessions[partial.sessionId], ...partial } as ClaudeSessionSummary,
      },
    })),
  setLoadingSessions: (loading) => set({ isLoadingSessions: loading }),

  // Active session
  setActiveSession: (sessionId, streamId = null) => {
    const session = sessionId ? get().sessions[sessionId] : null;
    set({
      activeSessionId: sessionId,
      activeStreamIds: streamId ? [streamId] : [],
      streamError: null,
      selectedPermissionMode: session?.permissionMode ?? 'acceptEdits',
    });
  },
  addStreamId: (streamId: string) => {
    const current = get().activeStreamIds;
    if (!current.includes(streamId)) {
      set({ activeStreamIds: [...current, streamId] });
    }
  },
  setStreaming: (streaming) => set({ isStreaming: streaming, ...(!streaming ? { activeStreamIds: [] } : {}) }),
  setStreamError: (error) => set({ streamError: error, isStreaming: false }),

  // Cards — server returns cards with pendingInput already attached
  setCards: (cards) => set({ cards }),
  prependCards: (newCards) =>
    set((state) => ({ cards: [...newCards, ...state.cards] })),
  appendCard: (card) =>
    set((state) => ({ cards: [...state.cards, card] })),

  handleCardEvent: (event: CardEvent) => {
    set((state) => {
      switch (event.type) {
        case 'add': {
          if (event.afterCardId) {
            const idx = state.cards.findIndex((c) => c.id === event.afterCardId);
            const cards = [...state.cards];
            cards.splice(idx >= 0 ? idx + 1 : cards.length, 0, event.card);
            return { cards };
          }
          // Dedup user cards (multi-tab broadcast)
          if (event.card.type === 'user') {
            const alreadyHas = state.cards.some(
              (c) => c.type === 'user' && c.text === (event.card as any).text
                && Date.now() - c.timestamp < 5000
            );
            if (alreadyHas) return state;
          }
          return { cards: [...state.cards, event.card] };
        }
        case 'update': {
          return {
            cards: state.cards.map((c) =>
              c.id === event.cardId ? { ...c, ...event.patch } as Card : c
            ),
          };
        }
        case 'append_text': {
          return {
            cards: state.cards.map((c) =>
              c.id === event.cardId && 'text' in c
                ? { ...c, text: (c as any).text + event.text } as Card
                : c
            ),
          };
        }
        case 'remove': {
          return { cards: state.cards.filter((c) => c.id !== event.cardId) };
        }
      }
      return state;
    });
  },

  setHistoryMeta: (total, hasMore) => set({ historyTotal: total, historyHasMore: hasMore }),
  setLoadingHistory: (loading) => set({ isLoadingHistory: loading }),
  clearCards: () => set({ cards: [], historyTotal: 0, historyHasMore: false }),

  clearPendingInput: (requestId) =>
    set((state) => {
      const idx = state.cards.findIndex(
        (c) => c.pendingInput?.requestId === requestId
      );
      if (idx === -1) return state;
      const cards = [...state.cards];
      cards[idx] = { ...cards[idx], pendingInput: undefined } as Card;
      return { cards };
    }),

  // Session preferences (new session defaults)
  setSelectedModel: (model) => set({ selectedModel: model }),
  setSelectedPermissionMode: (mode) => set({ selectedPermissionMode: mode }),
  setSelectedReasoningEffort: (effort) => set({ selectedReasoningEffort: effort }),
  setSandboxEnabled: (enabled) => set({ sandboxEnabled: enabled }),

  // Per-session runtime config
  setSessionConfigKey: (sessionId, key, value) =>
    set((state) => ({
      sessionConfigs: {
        ...state.sessionConfigs,
        [sessionId]: { ...state.sessionConfigs[sessionId], [key]: value },
      },
    })),
  applySessionConfig: (sessionId, config) =>
    set((state) => {
      const next: Partial<ClaudeStore> = {
        sessionConfigs: {
          ...state.sessionConfigs,
          [sessionId]: { ...state.sessionConfigs[sessionId], ...config },
        },
      };
      // Sync title into session map so status bar picks it up immediately
      if (typeof config.title === 'string' && state.sessions[sessionId]) {
        next.sessions = {
          ...state.sessions,
          [sessionId]: { ...state.sessions[sessionId], summary: config.title as string },
        };
      }
      return next;
    }),

  // UI
  setPromptInput: (input) => set({ promptInput: input }),
  setVisible: (visible) => set({ isVisible: visible }),

  // Reset
  reset: () =>
    set({
      sessions: {},
      isLoadingSessions: false,
      activeSessionId: null,
      activeStreamIds: [],
      isStreaming: false,
      streamError: null,
      cards: [],
      historyTotal: 0,
      historyHasMore: false,
      isLoadingHistory: false,
      promptInput: '',
      isVisible: false,
    }),
}));

// Debug: expose store on window for console access
if (typeof window !== 'undefined') {
  (window as any).__claudeStore = useClaudeStore;
}
