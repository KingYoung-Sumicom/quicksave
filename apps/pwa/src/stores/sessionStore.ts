// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { create } from 'zustand';
import type { AgentId, Card, CardEvent, SessionMetadata, SessionSummary, ConfigValue } from '@sumicom/quicksave-shared';
import {
  DEFAULT_AGENT,
  DEFAULT_MODEL,
  DEFAULT_CONTEXT_WINDOW,
} from '@sumicom/quicksave-shared';
import { clampContextWindowForModel } from '../lib/agentPresets';
import { getAgentProvider } from '../lib/agentProvider';
import { appendCardToBuckets, flattenCardBuckets, indexCardBuckets, replaceCardBucket } from './cardBuckets';

// --- Per-agent session prefs ---
//
// Each agent keeps its own `model` plus a KV `settings` bag keyed by
// SettingDescriptor.key. Adding a new agent or setting only requires a new
// AgentProvider class — no changes to this interface or the setters below.
export interface AgentPrefs {
  model: string;
  settings: Record<string, unknown>;
}

type AgentPrefsMap = Record<AgentId, AgentPrefs>;

function defaultPrefsForAgent(agent: AgentId): AgentPrefs {
  const provider = getAgentProvider(agent);
  const settings: Record<string, unknown> = {};
  for (const desc of provider.getSettings()) {
    settings[desc.key] = desc.default;
  }
  return { model: provider.defaultModel, settings };
}

function defaultAgentPrefsMap(): AgentPrefsMap {
  return {
    'claude-code': defaultPrefsForAgent('claude-code'),
    'claude-terminal': defaultPrefsForAgent('claude-terminal'),
    codex: defaultPrefsForAgent('codex'),
    opencode: defaultPrefsForAgent('opencode'),
    pi: defaultPrefsForAgent('pi'),
  };
}

// --- localStorage persistence for new-session defaults ---
const PREFS_KEY = 'quicksave:session-prefs';

interface PersistedPrefs {
  selectedAgent: AgentId;
  agentPrefs: AgentPrefsMap;
  /** Ordered list of provider ids sorted by last chosen (most recent first).
   *  Used to sort the provider picker in the two-level model selector. */
  lastChosenProviders?: string[];
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
    lastChosenProviders: [],
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
      for (const agent of Object.keys(merged) as AgentId[]) {
        const saved = parsed.agentPrefs[agent] as any;
        if (!saved) continue;
        if ('settings' in saved && typeof saved.settings === 'object') {
          // Current shape — overlay saved settings on defaults.
          merged[agent] = {
            model: saved.model ?? merged[agent].model,
            settings: { ...merged[agent].settings, ...saved.settings },
          };
        } else {
          // Previous shape (flat fields) — migrate into settings bag.
          merged[agent] = {
            model: saved.model ?? merged[agent].model,
            settings: {
              ...merged[agent].settings,
              ...(saved.permissionMode !== undefined ? { permissionMode: saved.permissionMode } : {}),
              ...(saved.reasoningEffort !== undefined ? { reasoningEffort: saved.reasoningEffort } : {}),
              ...(saved.sandbox !== undefined ? { sandbox: saved.sandbox } : {}),
              ...(saved.contextWindow !== undefined ? { contextWindow: saved.contextWindow } : {}),
            },
          };
        }
      }
    } else {
      // Legacy flat store shape — migrate into the previously-active agent.
      merged[selectedAgent] = {
        model: parsed.selectedModel ?? merged[selectedAgent].model,
        settings: {
          ...merged[selectedAgent].settings,
          ...(parsed.selectedPermissionMode !== undefined ? { permissionMode: parsed.selectedPermissionMode } : {}),
          ...(parsed.selectedReasoningEffort !== undefined ? { reasoningEffort: parsed.selectedReasoningEffort } : {}),
          ...(parsed.sandboxEnabled !== undefined ? { sandbox: parsed.sandboxEnabled } : {}),
        },
      };
    }

    // Migrate the legacy `[1m]` suffix: strip from model id, promote to contextWindow.
    for (const agent of Object.keys(merged) as AgentId[]) {
      const bucket = merged[agent];
      const m = bucket.model ?? '';
      const suffixMatch = /\[1m\]$/i.test(m);
      const baseModel = suffixMatch ? m.replace(/\[1m\]$/i, '') : m;
      const cw = suffixMatch ? 1_000_000 : (bucket.settings['contextWindow'] as number | undefined);
      merged[agent] = {
        model: baseModel,
        settings: {
          ...bucket.settings,
          contextWindow: clampContextWindowForModel(baseModel, cw),
        },
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

function findLatestIntermediateTurnId(cards: Card[]): string | null {
  for (let i = cards.length - 1; i >= 0; i--) {
    if (cards[i].isTurnIntermediate && cards[i].turnId) return cards[i].turnId!;
  }
  return null;
}

function findCardCompletedTurnIds(cards: Card[]): Record<string, true> {
  const ids: Record<string, true> = {};
  for (const card of cards) if (card.turnCompleted && card.turnId) ids[card.turnId] = true;
  return ids;
}

function isSubagentSourceCard(card: Card): boolean {
  return card.type === 'subagent' || (card.type === 'system' && /^Sub-agent (started|active|interrupted):\s*(.+)$/i.test(card.text.trim()));
}

/** Project an active-agent prefs bundle to the flat `selected*` view fields
 *  the rest of the app reads. Pure — used by setters that need to recompute
 *  the view after a write. */
function flatViewOf(prefs: AgentPrefs) {
  const s = prefs.settings;
  return {
    selectedModel: prefs.model,
    selectedPermissionMode: (s['permissionMode'] as string) ?? '',
    selectedReasoningEffort: (s['reasoningEffort'] as string) ?? '',
    selectedFastMode: (s['fastMode'] as boolean) ?? false,
    sandboxEnabled: (s['sandbox'] as boolean) ?? false,
    selectedContextWindow: (s['contextWindow'] as number) ?? DEFAULT_CONTEXT_WINDOW,
  };
}

const savedPrefs = loadPrefs();

// Validate that the saved Claude model is still in the known model list.
{
  const claudePrefs = savedPrefs.agentPrefs['claude-code'];
  const claudeModels = getAgentProvider('claude-code').getModels();
  if (claudePrefs.model && !claudeModels.some((m) => m.value === claudePrefs.model)) {
    claudePrefs.model = claudeModels[0]?.value ?? DEFAULT_MODEL;
  }
}

// opencode requires `provider/model` ids (e.g. `opencode/big-pickle`).
// Legacy persisted prefs occasionally hold a leaked Claude model id like
// `claude-opus-4-7`, which then gets shipped to the daemon and silently
// fails ("Unexpected server error"). Clear anything that doesn't fit the
// format so the agent falls through to opencode's configured default.
{
  const ocPrefs = savedPrefs.agentPrefs['opencode'];
  if (ocPrefs.model && !/^[^/\s]+\/\S(?:.*\S)?$/.test(ocPrefs.model)) {
    ocPrefs.model = '';
  }
}

// One-shot cleanup: an early version of `setAgentSetting` wrote `model` into
// the per-agent `settings` bag (in addition to the top-level `model`). The
// stale entry survives in localStorage and, on spread into the values map
// (settings spread → explicit `model`), would override the real selection
// with an empty string and leave the picker visually blank. Strip it on
// load so old installs heal themselves; new writes go through the
// model-aware short-circuit so this can't be re-introduced.
for (const bucket of Object.values(savedPrefs.agentPrefs)) {
  if (bucket?.settings && 'model' in bucket.settings) {
    delete (bucket.settings as Record<string, unknown>).model;
  }
}

/**
 * Locally-stored session summary: extends the shared shape with the agent
 * (machine) that originated the record. Needed for filtering/routing in
 * multi-agent mode — same `cwd` string can exist on multiple machines, and
 * a bus command for this session must target the owning agent.
 */
export type StoredSessionSummary = SessionSummary & { machineAgentId?: string };

/** Sessions keyed by sessionId for O(1) lookup. */
type SessionMap = Record<string, StoredSessionSummary>;

interface SessionStore {
  // Session list
  sessions: SessionMap;

  /** sessionId currently being attended (visible+focused tab on its page).
   *  The attention hook keeps this in sync; bus-side `session:mark-read`
   *  resend logic uses it to know when to push a fresh viewedAt to the agent
   *  without spamming for sessions the user isn't actually on. `null` means
   *  no session is attended. */
  attendedSessionId: string | null;

  // Active session
  activeSessionId: string | null;
  isStreaming: boolean;
  streamError: string | null;

  // Cards (current session)
  cards: Card[];
  /** Narrow projection so the agent panel ignores unrelated stream chunks. */
  subagentCards: Card[];
  /** Transcript-facing ordered turn segments. Segment boundaries preserve legacy/interleaved order. */
  cardBuckets: ReturnType<typeof indexCardBuckets>;
  cardCount: number;
  latestIntermediateTurnId: string | null;
  historyTotal: number | null;
  historyHasMore: boolean;
  /** Opaque agent-issued cursor for the next older persisted history page. */
  historyCursor: string | null;
  isLoadingHistory: boolean;
  historyError: string | null;
  /** Turn ids that have emitted stream-end during the current live view. */
  completedTurnIds: Record<string, true>;
  /** Completed turns carried by persisted cards (separate from live stream-end markers). */
  cardCompletedTurnIds: Record<string, true>;
  /** Text chunks that arrived before their card-add event. */
  pendingCardText: Record<string, string>;


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
  selectedFastMode: boolean;
  sandboxEnabled: boolean;
  selectedContextWindow: number;
  /** Ordered list of provider ids sorted by last chosen (most recent first). */
  lastChosenProviders: string[];

  // Per-session runtime config (keyed by sessionId)
  sessionConfigs: Record<string, Record<string, ConfigValue>>;
  sessionMetadata: Record<string, SessionMetadata>;

  // Actions — sessions
  setSessions: (sessions: SessionSummary[]) => void;
  upsertSession: (session: Partial<StoredSessionSummary> & { sessionId: string }) => void;
  removeSession: (sessionId: string) => void;
  /** Demote any store-locally-active sessions whose ids are missing from
   *  the authoritative live set FOR THAT AGENT. Called from the
   *  `/sessions/active` bus snap handler, which delivers the complete live
   *  list atomically per agent. Scoped by `machineAgentId` so one agent's
   *  snap doesn't wipe another agent's active sessions. */
  reconcileActiveSessions: (activeSessionIds: Set<string>, machineAgentId: string) => void;
  /** Replace the historical projection for one machine while preserving
   * sessions owned by other connected agents. */
  reconcileHistorySessions: (sessionIds: Set<string>, machineAgentId: string) => void;
  /** Demote active sessions to closed after a transport disconnect. When an
   *  agent id is supplied, leave sessions on other machines untouched. */
  clearActiveOnDisconnect: (machineAgentId?: string) => void;

  /** Track which session is currently being attended (visible+focused tab on
   *  its page). Pass `null` when attention is released. The attention hook
   *  uses this to drive `session:mark-read` resends when an attended
   *  session's `lastTurnEndedAt` advances mid-view. */
  setAttendedSession: (sessionId: string | null) => void;

  // Actions — active session
  setActiveSession: (sessionId: string | null) => void;
  setStreaming: (streaming: boolean) => void;
  setStreamError: (error: string | null) => void;

  // Actions — cards
  setCards: (cards: Card[]) => void;
  prependCards: (cards: Card[]) => void;
  appendCard: (card: Card) => void;
  handleCardEvent: (event: CardEvent) => void;
  setHistoryMeta: (total: number | undefined, hasMore: boolean, nextCursor?: string | null) => void;
  setLoadingHistory: (loading: boolean) => void;
  setHistoryError: (error: string | null) => void;
  markTurnCompleted: (turnId: string) => void;
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
  setSelectedFastMode: (enabled: boolean) => void;
  setSandboxEnabled: (enabled: boolean) => void;
  setSelectedContextWindow: (contextWindow: number) => void;
  /** Toggle the billed-1M opt-in. Flipping off re-clamps every Claude-code
   *  agent bucket so a stale 1M Sonnet setting can't sneak through. */
  /** Write a setting (or 'model') on the active agent's prefs.
   *  Used by provider renderSettings onChange callbacks. */
  setAgentSetting: (key: string, value: unknown) => void;
  /** Write a pref on a specific agent's bucket regardless of the active agent.
   *  Used by the connection handler when the daemon pushes agent-scoped prefs. */
  setAgentPref: (agent: AgentId, key: string, value: unknown) => void;
  /** Record a provider choice — moves it to the front of lastChosenProviders. */
  recordProviderChoice: (providerId: string) => void;

  // Actions — per-session runtime config
  setSessionConfigKey: (sessionId: string, key: string, value: ConfigValue) => void;
  applySessionConfig: (sessionId: string, config: Record<string, ConfigValue>) => void;
  setSessionMetadata: (metadata: SessionMetadata) => void;

  // Actions — UI
  setPromptInput: (input: string) => void;
  setVisible: (visible: boolean) => void;

  // Reset
  reset: () => void;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  // Initial state
  sessions: {},
  attendedSessionId: null,
  activeSessionId: null,
  isStreaming: false,
  streamError: null,
  cards: [],
  subagentCards: [],
  cardBuckets: indexCardBuckets([]),
  cardCount: 0,
  latestIntermediateTurnId: null,
  historyTotal: 0,
  historyHasMore: false,
  historyCursor: null,
  isLoadingHistory: false,
  historyError: null,
  completedTurnIds: {},
  cardCompletedTurnIds: {},
  pendingCardText: {},
  promptInput: '',
  isVisible: false,
  selectedAgent: savedPrefs.selectedAgent,
  agentPrefs: savedPrefs.agentPrefs,
  ...flatViewOf(savedPrefs.agentPrefs[savedPrefs.selectedAgent]),
  lastChosenProviders: savedPrefs.lastChosenProviders ?? [],
  sessionConfigs: {},
  sessionMetadata: {},

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
          updated[id] = { ...session, isActive: false, isStreaming: false, isCompacting: false, hasPendingInput: false, queueState: null };
        }
      }
      return { sessions: updated };
    }),
  reconcileHistorySessions: (sessionIds, machineAgentId) =>
    set((state) => {
      const updated = { ...state.sessions };
      let changed = false;
      for (const [id, session] of Object.entries(updated)) {
        if (session.machineAgentId !== machineAgentId || sessionIds.has(id)) continue;
        delete updated[id];
        changed = true;
      }
      return changed ? { sessions: updated } : state;
    }),
  clearActiveOnDisconnect: (machineAgentId) =>
    set((state) => {
      const updated = { ...state.sessions };
      let changed = false;
      for (const [id, session] of Object.entries(updated)) {
        if (machineAgentId && session.machineAgentId !== machineAgentId) continue;
        if (session.isActive) {
          updated[id] = { ...session, isActive: false, isStreaming: false, isCompacting: false, hasPendingInput: false, queueState: null };
          changed = true;
        }
      }
      return changed ? { sessions: updated } : state;
    }),

  setAttendedSession: (sessionId) =>
    set((state) => (state.attendedSessionId === sessionId ? state : { attendedSessionId: sessionId })),

  // Active session
  setActiveSession: (sessionId) => {
    if (!sessionId) {
      // New Session: restore the active agent's saved prefs from localStorage
      // so prior selections persist across navigation. We re-read storage
      // (rather than relying on store state) because state.selectedAgent may
      // have been temporarily overridden by a prior session view.
      const prefs = loadPrefs();
      set({
        activeSessionId: null,
        streamError: null,
        isStreaming: false,
        completedTurnIds: {},
        selectedAgent: prefs.selectedAgent,
        agentPrefs: prefs.agentPrefs,
        ...flatViewOf(prefs.agentPrefs[prefs.selectedAgent] ?? defaultPrefsForAgent(prefs.selectedAgent)),
      });
      return;
    }
    const session = get().sessions[sessionId];
    const legacyProvider = (session as { provider?: string } | null)?.provider;
    const sessionAgent: AgentId = (session?.agent as AgentId | undefined)
      ?? (legacyProvider === 'codex-mcp' ? 'codex' : legacyProvider ? 'claude-code' : DEFAULT_AGENT);
    // Reset the flat view to the picked agent's saved defaults *before* layering
    // the session-scoped permissionMode on top. Without this, the previous
    // session's selectedModel / selectedReasoningEffort / sandboxEnabled would
    // linger — e.g. switching from a Codex/gpt-5 session to a Claude session
    // would leave the model selector showing 'gpt-5' until the daemon's
    // /sessions/config snapshot landed (and forever for sessions whose configs
    // aren't yet in memory). useSessionConfig still overlays sessionConfigs
    // on top, so the displayed value remains session-scoped when available.
    const { agentPrefs } = get();
    const agentPrefsForSession = agentPrefs[sessionAgent] ?? defaultPrefsForAgent(sessionAgent);
    set({
      activeSessionId: sessionId,
      streamError: null,
      // Sync the local streaming flag to the target session's state. Without
      // this, navigating from a streaming session to an idle one leaves
      // isStreaming=true, so the chat keeps rendering the blue cursor and
      // bouncing dots even though the status badge correctly shows green.
      // startSession / resumeSession call upsertSession({isStreaming: true})
      // immediately before this, so prompt-sending paths still see true.
      isStreaming: session?.isStreaming ?? false,
      completedTurnIds: {},
      pendingCardText: {},
      selectedAgent: sessionAgent,
      ...flatViewOf(agentPrefsForSession),
      // Surface the session's permissionMode in the flat view so the chip
      // matches the running session. agentPrefs is *not* mutated — these are
      // session-scoped values, not the user's persisted defaults.
      selectedPermissionMode: session?.permissionMode ?? (agentPrefsForSession.settings['permissionMode'] as string | undefined) ?? '',
    });
  },
  setStreaming: (streaming) => set({ isStreaming: streaming }),
  setStreamError: (error) => set({ streamError: error, isStreaming: false }),

  // Cards — server returns cards with pendingInput already attached
  setCards: (cards) => {
    const nextCards = cards ?? [];
    set({ cards: nextCards, subagentCards: nextCards.filter(isSubagentSourceCard), cardBuckets: indexCardBuckets(nextCards), cardCount: nextCards.length, latestIntermediateTurnId: findLatestIntermediateTurnId(nextCards), cardCompletedTurnIds: findCardCompletedTurnIds(nextCards), completedTurnIds: {}, pendingCardText: {} });
  },
  prependCards: (newCards) =>
    set((state) => {
      const existingIds = new Set(state.cards.map((c) => c.id));
      const deduped = newCards.filter((c) => !existingIds.has(c.id));
      if (deduped.length === 0) return state;
      const cards = [...deduped, ...state.cards];
      return { cards, subagentCards: [...deduped.filter(isSubagentSourceCard), ...state.subagentCards], cardBuckets: indexCardBuckets(cards), cardCount: cards.length, latestIntermediateTurnId: findLatestIntermediateTurnId(cards), cardCompletedTurnIds: findCardCompletedTurnIds(cards) };
    }),
  appendCard: (card) =>
    set((state) => {
      const cards = [...state.cards, card];
      return { cards, ...(isSubagentSourceCard(card) ? { subagentCards: [...state.subagentCards, card] } : {}), cardBuckets: appendCardToBuckets(state.cardBuckets, card), cardCount: cards.length, latestIntermediateTurnId: card.isTurnIntermediate && card.turnId ? card.turnId : state.latestIntermediateTurnId, ...(card.turnCompleted && card.turnId ? { cardCompletedTurnIds: { ...state.cardCompletedTurnIds, [card.turnId]: true } } : {}) };
    }),

  handleCardEvent: (event: CardEvent) => {
    set((state) => {
      switch (event.type) {
        case 'add': {
          const pendingText = state.pendingCardText[event.card.id];
          const card = pendingText && 'text' in event.card
            ? { ...event.card, text: (event.card as { text: string }).text + pendingText } as Card
            : event.card;
          const pendingCardText = { ...state.pendingCardText };
          delete pendingCardText[event.card.id];
          if (event.afterCardId) {
            const idx = state.cards.findIndex((c) => c.id === event.afterCardId);
            const cards = [...state.cards];
            cards.splice(idx >= 0 ? idx + 1 : cards.length, 0, card);
            return { cards, subagentCards: cards.filter(isSubagentSourceCard), cardBuckets: indexCardBuckets(cards), cardCount: cards.length, latestIntermediateTurnId: findLatestIntermediateTurnId(cards), cardCompletedTurnIds: findCardCompletedTurnIds(cards), pendingCardText };
          }
          // Dedup user cards (multi-tab broadcast). Match by text + a sorted
          // attachment-id signature so that two attachment-only follow-ups
          // with empty text don't collide.
          if (event.card.type === 'user') {
            const incoming = card as { text: string; attachments?: { id: string }[] };
            const incomingSig = (incoming.attachments ?? []).map((a) => a.id).sort().join(',');
            const alreadyHas = state.cards.some((c) => {
              if (c.type !== 'user') return false;
              if (c.text !== incoming.text) return false;
              if (Date.now() - c.timestamp >= 5000) return false;
              const existingSig = (c.attachments ?? []).map((a) => a.id).sort().join(',');
              return existingSig === incomingSig;
            });
            if (alreadyHas) return state;
          }
          const cards = [...state.cards, card];
          return { cards, ...(isSubagentSourceCard(card) ? { subagentCards: [...state.subagentCards, card] } : {}), cardBuckets: appendCardToBuckets(state.cardBuckets, card), cardCount: cards.length, latestIntermediateTurnId: card.isTurnIntermediate && card.turnId ? card.turnId : state.latestIntermediateTurnId, cardCompletedTurnIds: card.turnCompleted && card.turnId ? { ...state.cardCompletedTurnIds, [card.turnId]: true } : state.cardCompletedTurnIds, pendingCardText };
        }
        case 'update': {
          const bucketId = state.cardBuckets.cardToBucket.get(event.cardId);
          const bucket = bucketId ? state.cardBuckets.byId.get(bucketId) : undefined;
          if (!bucket) return state;
          const updatedBucket = bucket.cards.map((c) => {
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
            });
          const updatedCard = updatedBucket.find((c) => c.id === event.cardId)!;
          const cards = state.cards.map((c) => c.id === event.cardId ? updatedCard : c);
          const subagentCards = state.subagentCards.some((c) => c.id === event.cardId)
            ? state.subagentCards.map((c) => c.id === event.cardId ? updatedCard : c)
            : isSubagentSourceCard(updatedCard) ? [...state.subagentCards, updatedCard] : state.subagentCards;
          return { cards, subagentCards, cardBuckets: replaceCardBucket(state.cardBuckets, bucketId!, updatedBucket), ...(Object.prototype.hasOwnProperty.call(event.patch, 'turnCompleted') || Object.prototype.hasOwnProperty.call(event.patch, 'turnId') ? { cardCompletedTurnIds: findCardCompletedTurnIds(cards) } : {}) };
        }
        case 'append_text': {
          const bucketId = state.cardBuckets.cardToBucket.get(event.cardId);
          const bucket = bucketId ? state.cardBuckets.byId.get(bucketId) : undefined;
          if (!bucket) {
            return {
              pendingCardText: {
                ...state.pendingCardText,
                [event.cardId]: (state.pendingCardText[event.cardId] ?? '') + event.text,
              },
            };
          }
          const updatedBucket = bucket.cards.map((c) =>
            c.id === event.cardId && 'text' in c
              ? { ...c, text: (c as any).text + event.text } as Card
              : c
          );
          if (updatedBucket.every((c, i) => c === bucket.cards[i])) return state;
          const updatedCard = updatedBucket.find((c) => c.id === event.cardId)!;
          const cards = state.cards.map((c) => c.id === event.cardId ? updatedCard : c);
          const subagentIndex = state.subagentCards.findIndex((c) => c.id === event.cardId);
          const subagentCards = subagentIndex >= 0
            ? state.subagentCards.map((c, i) => i === subagentIndex ? updatedCard : c)
            : isSubagentSourceCard(updatedCard) ? [...state.subagentCards, updatedCard] : state.subagentCards;
          return { cards, subagentCards, cardBuckets: replaceCardBucket(state.cardBuckets, bucketId!, updatedBucket) };
        }
        case 'remove': {
          const bucketId = state.cardBuckets.cardToBucket.get(event.cardId);
          const bucket = bucketId ? state.cardBuckets.byId.get(bucketId) : undefined;
          if (!bucket) return state;
          const updatedBucket = bucket.cards.filter((c) => c.id !== event.cardId);
          const cardBuckets = replaceCardBucket(state.cardBuckets, bucketId!, updatedBucket);
          const cards = flattenCardBuckets(cardBuckets);
          return { cards, subagentCards: state.subagentCards.filter((c) => c.id !== event.cardId), cardBuckets, cardCount: state.cardCount - 1, latestIntermediateTurnId: findLatestIntermediateTurnId(cards), cardCompletedTurnIds: findCardCompletedTurnIds(cards) };
        }
      }
      return state;
    });
  },

  setHistoryMeta: (total, hasMore, nextCursor = null) => set({
    historyTotal: total ?? null,
    historyHasMore: hasMore,
    historyCursor: nextCursor,
  }),
  setLoadingHistory: (loading) => set({ isLoadingHistory: loading }),
  setHistoryError: (error) => set({ historyError: error }),
  markTurnCompleted: (turnId) => set((state) => {
    const bucketIds = state.cardBuckets.order.filter((id) => state.cardBuckets.byId.get(id)?.turnId === turnId);
    for (const id of bucketIds) {
      const bucket = state.cardBuckets.byId.get(id)!;
      state.cardBuckets.byId.set(id, { ...bucket, hot: false, completed: true });
      state.cardBuckets.hotOrder = state.cardBuckets.hotOrder.filter((hotId) => hotId !== id);
    }
    return { completedTurnIds: { ...state.completedTurnIds, [turnId]: true } };
  }),
  clearCards: () => set({
    cards: [],
    subagentCards: [],
    cardBuckets: indexCardBuckets([]),
    cardCount: 0,
    latestIntermediateTurnId: null,
    completedTurnIds: {},
    cardCompletedTurnIds: {},
    historyTotal: 0,
    historyHasMore: false,
    historyCursor: null,
    historyError: null,
    pendingCardText: {},
  }),

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
    const prevCw = agentPrefs[selectedAgent].settings['contextWindow'] as number | undefined;
    const nextCw = selectedAgent === 'claude-code'
      ? clampContextWindowForModel(model, prevCw)
      : prevCw ?? DEFAULT_CONTEXT_WINDOW;
    const updated: AgentPrefsMap = {
      ...agentPrefs,
      [selectedAgent]: {
        model,
        settings: { ...agentPrefs[selectedAgent].settings, contextWindow: nextCw },
      },
    };
    set({ agentPrefs: updated, selectedModel: model, selectedContextWindow: nextCw });
    savePrefs({ selectedAgent, agentPrefs: updated });
  },
  setSelectedAgent: (agent) => {
    const { agentPrefs } = get();
    const prefs = agentPrefs[agent] ?? defaultPrefsForAgent(agent);
    set({ selectedAgent: agent, ...flatViewOf(prefs) });
    savePrefs({ selectedAgent: agent, agentPrefs });
  },
  setSelectedPermissionMode: (mode) => {
    const { selectedAgent, agentPrefs } = get();
    const updated: AgentPrefsMap = {
      ...agentPrefs,
      [selectedAgent]: { ...agentPrefs[selectedAgent], settings: { ...agentPrefs[selectedAgent].settings, permissionMode: mode } },
    };
    set({ agentPrefs: updated, selectedPermissionMode: mode });
    savePrefs({ selectedAgent, agentPrefs: updated });
  },
  setSelectedReasoningEffort: (effort) => {
    const { selectedAgent, agentPrefs } = get();
    const updated: AgentPrefsMap = {
      ...agentPrefs,
      [selectedAgent]: { ...agentPrefs[selectedAgent], settings: { ...agentPrefs[selectedAgent].settings, reasoningEffort: effort } },
    };
    set({ agentPrefs: updated, selectedReasoningEffort: effort });
    savePrefs({ selectedAgent, agentPrefs: updated });
  },
  setSandboxEnabled: (enabled) => {
    const { selectedAgent, agentPrefs } = get();
    const updated: AgentPrefsMap = {
      ...agentPrefs,
      [selectedAgent]: { ...agentPrefs[selectedAgent], settings: { ...agentPrefs[selectedAgent].settings, sandbox: enabled } },
    };
    set({ agentPrefs: updated, sandboxEnabled: enabled });
    savePrefs({ selectedAgent, agentPrefs: updated });
  },
  setSelectedContextWindow: (contextWindow) => {
    const { selectedAgent, agentPrefs } = get();
    const clamped = selectedAgent === 'claude-code'
      ? clampContextWindowForModel(agentPrefs[selectedAgent].model, contextWindow)
      : contextWindow;
    const updated: AgentPrefsMap = {
      ...agentPrefs,
      [selectedAgent]: { ...agentPrefs[selectedAgent], settings: { ...agentPrefs[selectedAgent].settings, contextWindow: clamped } },
    };
    set({ agentPrefs: updated, selectedContextWindow: clamped });
    savePrefs({ selectedAgent, agentPrefs: updated });
  },
  setSelectedFastMode: (enabled) => {
    const { selectedAgent, agentPrefs } = get();
    const updated: AgentPrefsMap = {
      ...agentPrefs,
      [selectedAgent]: { ...agentPrefs[selectedAgent], settings: { ...agentPrefs[selectedAgent].settings, fastMode: enabled } },
    };
    set({ agentPrefs: updated, selectedFastMode: enabled });
    savePrefs({ selectedAgent, agentPrefs: updated });
  },
  setAgentSetting: (key, value) => {
    if (key === 'model') { get().setSelectedModel(value as string); return; }
    const { selectedAgent, agentPrefs } = get();
    const updated: AgentPrefsMap = {
      ...agentPrefs,
      [selectedAgent]: { ...agentPrefs[selectedAgent], settings: { ...agentPrefs[selectedAgent].settings, [key]: value } },
    };
    const flatPatch: Record<string, unknown> = {};
    if (key === 'permissionMode') flatPatch.selectedPermissionMode = value;
    else if (key === 'reasoningEffort') flatPatch.selectedReasoningEffort = value;
    else if (key === 'fastMode') flatPatch.selectedFastMode = value;
    else if (key === 'sandbox') flatPatch.sandboxEnabled = value;
    else if (key === 'contextWindow') flatPatch.selectedContextWindow = value;
    set({ agentPrefs: updated, ...flatPatch });
    savePrefs({ selectedAgent, agentPrefs: updated });
  },
  setAgentPref: (agent, key, value) => {
    const { selectedAgent, agentPrefs } = get();
    let updated: AgentPrefsMap;
    if (key === 'model') {
      updated = { ...agentPrefs, [agent]: { ...agentPrefs[agent], model: value as string } };
    } else {
      updated = { ...agentPrefs, [agent]: { ...agentPrefs[agent], settings: { ...agentPrefs[agent].settings, [key]: value } } };
    }
    set(
      agent === selectedAgent
        ? { agentPrefs: updated, ...flatViewOf(updated[agent]) }
        : { agentPrefs: updated },
    );
    savePrefs({ selectedAgent, agentPrefs: updated });
  },
  recordProviderChoice: (providerId) => {
    const { lastChosenProviders } = get();
    const filtered = lastChosenProviders.filter((id) => id !== providerId);
    const updated = [providerId, ...filtered];
    set({ lastChosenProviders: updated });
    const { selectedAgent, agentPrefs } = get();
    savePrefs({ selectedAgent, agentPrefs, lastChosenProviders: updated });
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
      const next: Partial<SessionStore> = {
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
        if (typeof config.pendingMissionLabel === 'string' && typeof config.pendingMissionUntil === 'number') {
          sessionPatch.pendingMission = {
            label: config.pendingMissionLabel,
            until: config.pendingMissionUntil,
            ...(typeof config.pendingMissionDismissedAt === 'number' ? { dismissedAt: config.pendingMissionDismissedAt } : {}),
          };
        } else if (config.pendingMissionLabel === null || config.pendingMissionUntil === null) {
          sessionPatch.pendingMission = undefined;
        }
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
        next.selectedAgent =
          configAgent === 'codex-mcp' || configAgent === 'codex' ? 'codex'
          : configAgent === 'opencode' ? 'opencode'
          : configAgent === 'pi' ? 'pi'
          : 'claude-code';
      }
      return next;
    }),
  setSessionMetadata: (metadata) =>
    set((state) => {
      const session = state.sessions[metadata.sessionId];
      const sessionPatch: Partial<StoredSessionSummary> = {};
      if (metadata.agent !== undefined) sessionPatch.agent = metadata.agent;
      if (metadata.model !== undefined) sessionPatch.model = metadata.model;
      if (metadata.permissionMode !== undefined) sessionPatch.permissionMode = metadata.permissionMode;
      if (metadata.lastTurnInputTokens !== undefined) sessionPatch.lastTurnInputTokens = metadata.lastTurnInputTokens;
      if (metadata.lastTurnCacheCreationTokens !== undefined) sessionPatch.lastTurnCacheCreationTokens = metadata.lastTurnCacheCreationTokens;
      if (metadata.lastTurnCacheReadTokens !== undefined) sessionPatch.lastTurnCacheReadTokens = metadata.lastTurnCacheReadTokens;
      if (metadata.lastTurnContextUsage !== undefined) sessionPatch.lastTurnContextUsage = metadata.lastTurnContextUsage;
      if (metadata.lastTurnEndedAt !== undefined) sessionPatch.lastTurnEndedAt = metadata.lastTurnEndedAt;
      if (metadata.lastCacheTouchAt !== undefined) sessionPatch.lastCacheTouchAt = metadata.lastCacheTouchAt;
      return {
        sessionMetadata: { ...state.sessionMetadata, [metadata.sessionId]: metadata },
        ...(session && Object.keys(sessionPatch).length > 0
          ? { sessions: { ...state.sessions, [metadata.sessionId]: { ...session, ...sessionPatch } } }
          : {}),
      };
    }),

  // UI
  setPromptInput: (input) => set({ promptInput: input }),
  setVisible: (visible) => set({ isVisible: visible }),

  // Reset
  reset: () =>
    set({
      sessions: {},
      attendedSessionId: null,
      activeSessionId: null,
      isStreaming: false,
      streamError: null,
      cards: [],
      subagentCards: [],
      cardBuckets: indexCardBuckets([]),
      cardCount: 0,
      latestIntermediateTurnId: null,
      historyTotal: 0,
      historyHasMore: false,
      historyCursor: null,
      isLoadingHistory: false,
      historyError: null,
      completedTurnIds: {},
      cardCompletedTurnIds: {},
      sessionMetadata: {},
      promptInput: '',
      isVisible: false,
    }),
}));

// Debug: expose store on window for console access
if (typeof window !== 'undefined') {
  (window as any).__sessionStore = useSessionStore;
}
