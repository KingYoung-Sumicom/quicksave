import { create } from 'zustand';
import type { Card, CardEvent, ClaudeSessionSummary } from '@sumicom/quicksave-shared';

interface ClaudeStore {
  // Session list
  sessions: ClaudeSessionSummary[];
  isLoadingSessions: boolean;

  // Active session
  activeSessionId: string | null;
  activeStreamId: string | null;
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

  // Session preferences (applied on next session start)
  selectedModel: string;
  selectedPermissionMode: string;

  // Actions — sessions
  setSessions: (sessions: ClaudeSessionSummary[]) => void;
  setLoadingSessions: (loading: boolean) => void;

  // Actions — active session
  setActiveSession: (sessionId: string | null, streamId?: string | null) => void;
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

  // Actions — session preferences
  setSelectedModel: (model: string) => void;
  setSelectedPermissionMode: (mode: string) => void;

  // Actions — UI
  setPromptInput: (input: string) => void;
  setVisible: (visible: boolean) => void;

  // Reset
  reset: () => void;
}

export const useClaudeStore = create<ClaudeStore>((set, get) => ({
  // Initial state
  sessions: [],
  isLoadingSessions: false,
  activeSessionId: null,
  activeStreamId: null,
  isStreaming: false,
  streamError: null,
  cards: [],
  historyTotal: 0,
  historyHasMore: false,
  isLoadingHistory: false,
  promptInput: '',
  isVisible: false,
  selectedModel: 'claude-sonnet-4-6',
  selectedPermissionMode: 'acceptEdits',

  // Sessions
  setSessions: (sessions) => set({ sessions }),
  setLoadingSessions: (loading) => set({ isLoadingSessions: loading }),

  // Active session
  setActiveSession: (sessionId, streamId = null) => {
    const session = sessionId ? get().sessions.find((s) => s.sessionId === sessionId) : null;
    set({
      activeSessionId: sessionId,
      activeStreamId: streamId,
      streamError: null,
      selectedPermissionMode: session?.permissionMode ?? 'acceptEdits',
    });
  },
  setStreaming: (streaming) => set({ isStreaming: streaming, ...(!streaming ? { activeStreamId: null } : {}) }),
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

  // Session preferences
  setSelectedModel: (model) => set({ selectedModel: model }),
  setSelectedPermissionMode: (mode) => set({ selectedPermissionMode: mode }),

  // UI
  setPromptInput: (input) => set({ promptInput: input }),
  setVisible: (visible) => set({ isVisible: visible }),

  // Reset
  reset: () =>
    set({
      sessions: [],
      isLoadingSessions: false,
      activeSessionId: null,
      activeStreamId: null,
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
