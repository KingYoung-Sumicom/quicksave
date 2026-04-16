import { create } from 'zustand';
import type { AgentId, Card, CardEvent, ClaudeSessionSummary, ConfigValue } from '@sumicom/quicksave-shared';
import {
  DEFAULT_AGENT,
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_REASONING_EFFORT,
} from '@sumicom/quicksave-shared';
import { getModelsForAgent } from '../lib/claudePresets';

// --- localStorage persistence for new-session defaults ---
const PREFS_KEY = 'quicksave:session-prefs';

interface SessionPrefs {
  selectedModel: string;
  selectedAgent: AgentId;
  selectedPermissionMode: string;
  selectedReasoningEffort: 'low' | 'medium' | 'high' | 'max';
  sandboxEnabled: boolean;
}

function loadPrefs(): Partial<SessionPrefs> {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function savePrefs(prefs: SessionPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch { /* quota exceeded — ignore */ }
}

const savedPrefs = loadPrefs();

// Validate that the saved model is compatible with the saved agent
if (savedPrefs.selectedAgent && savedPrefs.selectedModel) {
  const models = getModelsForAgent(savedPrefs.selectedAgent);
  if (!models.some((m) => m.value === savedPrefs.selectedModel)) {
    savedPrefs.selectedModel = models[0]?.value ?? DEFAULT_MODEL;
  }
}

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
  historyError: string | null;


  // UI
  promptInput: string;
  isVisible: boolean;

  // Session preferences (defaults for new sessions)
  selectedModel: string;
  selectedAgent: AgentId;
  selectedPermissionMode: string;
  selectedReasoningEffort: 'low' | 'medium' | 'high' | 'max';
  sandboxEnabled: boolean;

  // Per-session runtime config (keyed by sessionId)
  sessionConfigs: Record<string, Record<string, ConfigValue>>;

  // Actions — sessions
  setSessions: (sessions: ClaudeSessionSummary[]) => void;
  mergeSessions: (incoming: ClaudeSessionSummary[], cwd?: string) => void;
  upsertSession: (session: Partial<ClaudeSessionSummary> & { sessionId: string }) => void;
  /** Reconcile session states with agent's actual active sessions after reconnect */
  reconcileActiveSessions: (activeSessionIds: Set<string>) => void;
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
  setHistoryError: (error: string | null) => void;
  clearCards: () => void;

  // Actions — pending input
  clearPendingInput: (requestId: string) => void;

  // Actions — session preferences (new session defaults)
  setSelectedModel: (model: string) => void;
  setSelectedAgent: (agent: AgentId) => void;
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
  historyError: null,
  promptInput: '',
  isVisible: false,
  selectedModel: savedPrefs.selectedModel ?? DEFAULT_MODEL,
  selectedAgent: savedPrefs.selectedAgent ?? DEFAULT_AGENT,
  selectedPermissionMode: savedPrefs.selectedPermissionMode ?? DEFAULT_PERMISSION_MODE,
  selectedReasoningEffort: savedPrefs.selectedReasoningEffort ?? DEFAULT_REASONING_EFFORT,
  sandboxEnabled: savedPrefs.sandboxEnabled ?? false,
  sessionConfigs: {},

  // Sessions
  setSessions: (sessions) => {
    const map: SessionMap = {};
    for (const s of sessions) map[s.sessionId] = s;
    set({ sessions: map });
  },
  mergeSessions: (incoming: ClaudeSessionSummary[], cwd?: string) =>
    set((state) => {
      const merged = { ...state.sessions };
      // Remove stale sessions for this cwd (e.g. archived ones no longer returned)
      if (cwd) {
        const incomingIds = new Set(incoming.map(s => s.sessionId));
        for (const [id, s] of Object.entries(merged)) {
          if (s.cwd === cwd && !incomingIds.has(id)) delete merged[id];
        }
      }
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
  reconcileActiveSessions: (activeSessionIds) =>
    set((state) => {
      const updated = { ...state.sessions };
      for (const [id, session] of Object.entries(updated)) {
        if (session.isActive && !activeSessionIds.has(id)) {
          updated[id] = { ...session, isActive: false, isStreaming: false, hasPendingInput: false };
        }
      }
      return { sessions: updated };
    }),
  setLoadingSessions: (loading) => set({ isLoadingSessions: loading }),

  // Active session
  setActiveSession: (sessionId, streamId = null) => {
    const session = sessionId ? get().sessions[sessionId] : null;
    const legacyProvider = (session as { provider?: string } | null)?.provider;
    set({
      activeSessionId: sessionId,
      activeStreamIds: streamId ? [streamId] : [],
      streamError: null,
      selectedAgent: (session?.agent as AgentId | undefined)
        ?? (legacyProvider === 'codex-mcp' ? 'codex' : legacyProvider ? 'claude-code' : DEFAULT_AGENT),
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
    set((state) => {
      const existingIds = new Set(state.cards.map((c) => c.id));
      const deduped = newCards.filter((c) => !existingIds.has(c.id));
      return { cards: [...deduped, ...state.cards] };
    }),
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
  setHistoryError: (error) => set({ historyError: error }),
  clearCards: () => set({ cards: [], historyTotal: 0, historyHasMore: false, historyError: null }),

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

  // Session preferences (new session defaults) — persisted to localStorage
  setSelectedModel: (model) => {
    set({ selectedModel: model });
    savePrefs({ ...get(), selectedModel: model });
  },
  setSelectedAgent: (agent) => {
    const state = get();
    const models = getModelsForAgent(agent);
    const modelValid = models.some((m) => m.value === state.selectedModel);
    const nextModel = modelValid ? state.selectedModel : models[0]?.value ?? DEFAULT_MODEL;
    set({ selectedAgent: agent, selectedModel: nextModel });
    savePrefs({ ...state, selectedAgent: agent, selectedModel: nextModel });
  },
  setSelectedPermissionMode: (mode) => {
    set({ selectedPermissionMode: mode });
    savePrefs({ ...get(), selectedPermissionMode: mode });
  },
  setSelectedReasoningEffort: (effort) => {
    set({ selectedReasoningEffort: effort });
    savePrefs({ ...get(), selectedReasoningEffort: effort });
  },
  setSandboxEnabled: (enabled) => {
    set({ sandboxEnabled: enabled });
    savePrefs({ ...get(), sandboxEnabled: enabled });
  },

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
      const configAgent = typeof config.agent === 'string'
        ? config.agent
        : typeof (config as Record<string, ConfigValue>).provider === 'string'
          ? (config as Record<string, ConfigValue>).provider
          : undefined;
      if (configAgent && state.activeSessionId === sessionId) {
        next.selectedAgent = (
          configAgent === 'codex-mcp' || configAgent === 'codex'
            ? 'codex'
            : 'claude-code'
        ) as AgentId;
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
      historyError: null,
      promptInput: '',
      isVisible: false,
    }),
}));

// Debug: expose store on window for console access
if (typeof window !== 'undefined') {
  (window as any).__claudeStore = useClaudeStore;
}
