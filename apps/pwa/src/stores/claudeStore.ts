import { create } from 'zustand';
import type { AgentId, Card, CardEvent, ClaudeSessionSummary, ConfigValue } from '@sumicom/quicksave-shared';
import {
  DEFAULT_AGENT,
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_SANDBOXED,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_PERMISSION_MODE,
  DEFAULT_CODEX_REASONING_EFFORT,
} from '@sumicom/quicksave-shared';
import { getModelsForAgent } from '../lib/claudePresets';

// --- Per-agent session prefs ---
//
// Each agent (claude-code / codex) keeps its own model / permissionMode /
// reasoningEffort / sandbox so switching agent doesn't clobber the other's
// last-used settings. The store also surfaces flat `selectedModel` etc.
// fields that mirror the *active* agent's prefs, so existing readers
// (ClaudePanel, useSessionConfig, SessionStatusBar, etc.) don't need to
// know about the per-agent map — only writers do.
interface AgentPrefs {
  model: string;
  permissionMode: string;
  reasoningEffort: string;
  sandbox: boolean;
}

type AgentPrefsMap = Record<AgentId, AgentPrefs>;

function defaultPrefsForAgent(agent: AgentId): AgentPrefs {
  if (agent === 'codex') {
    return {
      model: DEFAULT_CODEX_MODEL,
      permissionMode: DEFAULT_CODEX_PERMISSION_MODE,
      reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
      // Codex permission presets bundle sandbox_mode, so this flag is
      // unused for codex sessions. Kept on the prefs object for shape
      // symmetry with claude-code.
      sandbox: false,
    };
  }
  return {
    model: DEFAULT_MODEL,
    permissionMode: DEFAULT_PERMISSION_MODE,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    sandbox: DEFAULT_SANDBOXED,
  };
}

function defaultAgentPrefsMap(): AgentPrefsMap {
  return {
    'claude-code': defaultPrefsForAgent('claude-code'),
    codex: defaultPrefsForAgent('codex'),
  };
}

// --- localStorage persistence for new-session defaults ---
const PREFS_KEY = 'quicksave:session-prefs';

interface PersistedPrefs {
  selectedAgent: AgentId;
  agentPrefs: AgentPrefsMap;
}

/**
 * Load the persisted prefs, transparently migrating from the older flat
 * shape. Older builds wrote `{ selectedModel, selectedAgent, selectedPermissionMode,
 * selectedReasoningEffort, sandboxEnabled }` — we map those into the active
 * agent's bucket and seed the other agent with its defaults.
 */
function loadPrefs(): PersistedPrefs {
  const fallback: PersistedPrefs = {
    selectedAgent: DEFAULT_AGENT,
    agentPrefs: defaultAgentPrefsMap(),
  };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PersistedPrefs> & {
      selectedModel?: string;
      selectedPermissionMode?: string;
      selectedReasoningEffort?: string;
      sandboxEnabled?: boolean;
    };

    const selectedAgent = parsed.selectedAgent ?? DEFAULT_AGENT;
    const merged = defaultAgentPrefsMap();

    if (parsed.agentPrefs) {
      // New shape — overlay saved values on top of defaults so newly added
      // pref keys still get sensible defaults if absent in storage.
      for (const agent of Object.keys(merged) as AgentId[]) {
        merged[agent] = { ...merged[agent], ...(parsed.agentPrefs[agent] ?? {}) };
      }
    } else {
      // Legacy flat shape — migrate values into the previously-active agent.
      merged[selectedAgent] = {
        model: parsed.selectedModel ?? merged[selectedAgent].model,
        permissionMode: parsed.selectedPermissionMode ?? merged[selectedAgent].permissionMode,
        reasoningEffort: parsed.selectedReasoningEffort ?? merged[selectedAgent].reasoningEffort,
        sandbox: parsed.sandboxEnabled ?? merged[selectedAgent].sandbox,
      };
    }

    return { selectedAgent, agentPrefs: merged };
  } catch {
    return fallback;
  }
}

function savePrefs(prefs: PersistedPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch { /* quota exceeded — ignore */ }
}

/** Project an active-agent prefs bundle to the flat `selected*` view fields
 *  the rest of the app reads. Pure — used by setters that need to recompute
 *  the view after a write. */
function flatViewOf(prefs: AgentPrefs) {
  return {
    selectedModel: prefs.model,
    selectedPermissionMode: prefs.permissionMode,
    selectedReasoningEffort: prefs.reasoningEffort,
    sandboxEnabled: prefs.sandbox,
  };
}

const savedPrefs = loadPrefs();

// Validate that the saved Claude model is still recognized by the hardcoded
// model list. Codex models are not validated at module-load time (the dynamic
// list arrives later via the daemon handshake — wrongly resetting `gpt-5.5`
// to a fallback because the hardcoded list isn't current is worse than
// leaving an unknown id alone).
{
  const claudePrefs = savedPrefs.agentPrefs['claude-code'];
  const claudeModels = getModelsForAgent('claude-code');
  if (claudePrefs.model && !claudeModels.some((m) => m.value === claudePrefs.model)) {
    claudePrefs.model = claudeModels[0]?.value ?? DEFAULT_MODEL;
  }
}

/**
 * Locally-stored session summary: extends the shared shape with the agent
 * (machine) that originated the record. Needed for filtering/routing in
 * multi-agent mode — same `cwd` string can exist on multiple machines, and
 * a bus command for this session must target the owning agent.
 */
export type StoredSessionSummary = ClaudeSessionSummary & { machineAgentId?: string };

/** Sessions keyed by sessionId for O(1) lookup. */
type SessionMap = Record<string, StoredSessionSummary>;

interface ClaudeStore {
  // Session list
  sessions: SessionMap;

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

  // Session preferences (defaults for new sessions). The flat fields below
  // mirror `agentPrefs[selectedAgent]` and are kept in sync by the setters.
  // Read either — the flat view is provided so existing components don't
  // need to know about the per-agent map.
  selectedAgent: AgentId;
  agentPrefs: AgentPrefsMap;
  selectedModel: string;
  selectedPermissionMode: string;
  selectedReasoningEffort: string;
  sandboxEnabled: boolean;

  // Per-session runtime config (keyed by sessionId)
  sessionConfigs: Record<string, Record<string, ConfigValue>>;

  // Actions — sessions
  setSessions: (sessions: ClaudeSessionSummary[]) => void;
  upsertSession: (session: Partial<StoredSessionSummary> & { sessionId: string }) => void;
  removeSession: (sessionId: string) => void;
  /** Demote any store-locally-active sessions whose ids are missing from
   *  the authoritative live set FOR THAT AGENT. Called from the
   *  `/sessions/active` bus snap handler, which delivers the complete live
   *  list atomically per agent. Scoped by `machineAgentId` so one agent's
   *  snap doesn't wipe another agent's active sessions. */
  reconcileActiveSessions: (activeSessionIds: Set<string>, machineAgentId: string) => void;
  /** Demote every isActive=true session to closed; called on transport
   *  disconnect so a stale green badge doesn't survive the blip. The next
   *  /sessions/active snap on reconnect restores the truth. */
  clearActiveOnDisconnect: () => void;

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

  // Actions — session preferences (new session defaults).
  // These setters write to the *active* agent's bucket and update the flat
  // view in one go.
  setSelectedModel: (model: string) => void;
  setSelectedAgent: (agent: AgentId) => void;
  setSelectedPermissionMode: (mode: string) => void;
  setSelectedReasoningEffort: (effort: string) => void;
  setSandboxEnabled: (enabled: boolean) => void;
  /** Write a single pref field on a specific agent's bucket regardless of
   *  which agent is currently active. Used by the connection handler when
   *  the daemon pushes claude-scoped preferences — those must land on
   *  claude-code's bucket even if the user is currently viewing Codex. */
  setAgentPref: <K extends keyof AgentPrefs>(
    agent: AgentId,
    key: K,
    value: AgentPrefs[K],
  ) => void;

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
  selectedAgent: savedPrefs.selectedAgent,
  agentPrefs: savedPrefs.agentPrefs,
  ...flatViewOf(savedPrefs.agentPrefs[savedPrefs.selectedAgent]),
  sessionConfigs: {},

  // Sessions
  setSessions: (sessions) => {
    const map: SessionMap = {};
    for (const s of sessions) map[s.sessionId] = s;
    set({ sessions: map });
  },
  upsertSession: (partial) =>
    set((state) => ({
      sessions: {
        ...state.sessions,
        [partial.sessionId]: { ...state.sessions[partial.sessionId], ...partial } as StoredSessionSummary,
      },
    })),
  removeSession: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.sessions)) return state;
      const next = { ...state.sessions };
      delete next[sessionId];
      return { sessions: next };
    }),
  reconcileActiveSessions: (activeSessionIds, machineAgentId) =>
    set((state) => {
      const updated = { ...state.sessions };
      for (const [id, session] of Object.entries(updated)) {
        // Only demote sessions that belong to THIS agent; other agents'
        // active sessions are not in the incoming set and must be untouched.
        if (session.machineAgentId !== machineAgentId) continue;
        if (session.isActive && !activeSessionIds.has(id)) {
          updated[id] = { ...session, isActive: false, isStreaming: false, hasPendingInput: false };
        }
      }
      return { sessions: updated };
    }),
  clearActiveOnDisconnect: () =>
    set((state) => {
      const updated = { ...state.sessions };
      let changed = false;
      for (const [id, session] of Object.entries(updated)) {
        if (session.isActive) {
          updated[id] = { ...session, isActive: false, isStreaming: false, hasPendingInput: false };
          changed = true;
        }
      }
      return changed ? { sessions: updated } : state;
    }),

  // Active session
  setActiveSession: (sessionId, streamId = null) => {
    if (!sessionId) {
      // New Session: restore the active agent's saved prefs from localStorage
      // so prior selections persist across navigation. We re-read storage
      // (rather than relying on store state) because state.selectedAgent may
      // have been temporarily overridden by a prior session view.
      const prefs = loadPrefs();
      set({
        activeSessionId: null,
        activeStreamIds: [],
        streamError: null,
        selectedAgent: prefs.selectedAgent,
        agentPrefs: prefs.agentPrefs,
        ...flatViewOf(prefs.agentPrefs[prefs.selectedAgent]),
      });
      return;
    }
    const session = get().sessions[sessionId];
    const legacyProvider = (session as { provider?: string } | null)?.provider;
    const sessionAgent: AgentId = (session?.agent as AgentId | undefined)
      ?? (legacyProvider === 'codex-mcp' ? 'codex' : legacyProvider ? 'claude-code' : DEFAULT_AGENT);
    set({
      activeSessionId: sessionId,
      activeStreamIds: streamId ? [streamId] : [],
      streamError: null,
      selectedAgent: sessionAgent,
      // Surface the session's permissionMode in the flat view so the chip
      // matches the running session. agentPrefs is *not* mutated — these are
      // session-scoped values, not the user's persisted defaults.
      selectedPermissionMode: session?.permissionMode ?? DEFAULT_PERMISSION_MODE,
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
            cards: state.cards.map((c) => {
              if (c.id !== event.cardId) return c;
              // Wire convention: `null` in a patch means "delete this key".
              // JSON.stringify drops `undefined`, so the agent uses `null` as
              // the clear sentinel (e.g. clearing pendingInput on permission
              // resolution). Strip null values after the spread.
              const merged: Record<string, unknown> = { ...c, ...event.patch };
              for (const [key, value] of Object.entries(event.patch)) {
                if (value === null) delete merged[key];
              }
              return merged as unknown as Card;
            }),
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

  // Session preferences (new session defaults) — persisted to localStorage.
  // Writes go to the active agent's bucket; the flat view is recomputed.
  setSelectedModel: (model) => {
    const { selectedAgent, agentPrefs } = get();
    const updated: AgentPrefsMap = {
      ...agentPrefs,
      [selectedAgent]: { ...agentPrefs[selectedAgent], model },
    };
    set({ agentPrefs: updated, selectedModel: model });
    savePrefs({ selectedAgent, agentPrefs: updated });
  },
  setSelectedAgent: (agent) => {
    const { agentPrefs } = get();
    set({ selectedAgent: agent, ...flatViewOf(agentPrefs[agent]) });
    savePrefs({ selectedAgent: agent, agentPrefs });
  },
  setSelectedPermissionMode: (mode) => {
    const { selectedAgent, agentPrefs } = get();
    const updated: AgentPrefsMap = {
      ...agentPrefs,
      [selectedAgent]: { ...agentPrefs[selectedAgent], permissionMode: mode },
    };
    set({ agentPrefs: updated, selectedPermissionMode: mode });
    savePrefs({ selectedAgent, agentPrefs: updated });
  },
  setSelectedReasoningEffort: (effort) => {
    const { selectedAgent, agentPrefs } = get();
    const updated: AgentPrefsMap = {
      ...agentPrefs,
      [selectedAgent]: { ...agentPrefs[selectedAgent], reasoningEffort: effort },
    };
    set({ agentPrefs: updated, selectedReasoningEffort: effort });
    savePrefs({ selectedAgent, agentPrefs: updated });
  },
  setSandboxEnabled: (enabled) => {
    const { selectedAgent, agentPrefs } = get();
    const updated: AgentPrefsMap = {
      ...agentPrefs,
      [selectedAgent]: { ...agentPrefs[selectedAgent], sandbox: enabled },
    };
    set({ agentPrefs: updated, sandboxEnabled: enabled });
    savePrefs({ selectedAgent, agentPrefs: updated });
  },
  setAgentPref: (agent, key, value) => {
    const { selectedAgent, agentPrefs } = get();
    const updated: AgentPrefsMap = {
      ...agentPrefs,
      [agent]: { ...agentPrefs[agent], [key]: value },
    };
    // If the targeted agent IS the active one, also refresh the flat view
    // so existing readers see the change without a remount.
    set(
      agent === selectedAgent
        ? { agentPrefs: updated, ...flatViewOf(updated[agent]) }
        : { agentPrefs: updated },
    );
    savePrefs({ selectedAgent, agentPrefs: updated });
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
      // Mirror ticket-model fields (subject/stage/blocked/note) into the
      // session map so home-screen ticket cards re-render the moment the agent
      // calls `UpdateSessionStatus`, without waiting for the next history
      // broadcast roundtrip.
      const session = state.sessions[sessionId];
      if (session) {
        const sessionPatch: Partial<typeof session> = {};
        if (typeof config.title === 'string') sessionPatch.summary = config.title;
        if (typeof config.stage === 'string') sessionPatch.stage = config.stage as typeof session.stage;
        if (typeof config.blocked === 'boolean') sessionPatch.blocked = config.blocked;
        if (typeof config.note === 'string') sessionPatch.note = config.note;
        if (Object.keys(sessionPatch).length > 0) {
          next.sessions = {
            ...state.sessions,
            [sessionId]: { ...session, ...sessionPatch },
          };
        }
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
