import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useClaudeStore } from './claudeStore';
import type { Card, CardEvent } from '@sumicom/quicksave-shared';

// Mock localStorage for the module-level savedPrefs initialization
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock });

function makeCard(overrides: Partial<Card> & { type: Card['type'] }): Card {
  const base = { id: `card-${Math.random().toString(36).slice(2)}`, timestamp: Date.now() };
  if (overrides.type === 'user') return { ...base, type: 'user', text: 'hello', ...overrides } as Card;
  if (overrides.type === 'assistant_text') return { ...base, type: 'assistant_text', text: '', ...overrides } as Card;
  if (overrides.type === 'system') return { ...base, type: 'system', text: '', ...overrides } as Card;
  return { ...base, ...overrides } as Card;
}

describe('claudeStore', () => {
  beforeEach(() => {
    useClaudeStore.getState().reset();
    useClaudeStore.setState({ cards: [], historyTotal: 0, historyHasMore: false, historyError: null });
  });

  // ── handleCardEvent ────────────────────────────────────────────────────

  describe('handleCardEvent', () => {
    it('adds a card to the end when no afterCardId', () => {
      const existing = makeCard({ type: 'assistant_text', id: 'c1', text: 'first' });
      useClaudeStore.setState({ cards: [existing] });

      const newCard = makeCard({ type: 'assistant_text', id: 'c2', text: 'second' });
      const event: CardEvent = { type: 'add', sessionId: 'sess1', card: newCard };
      useClaudeStore.getState().handleCardEvent(event);

      const cards = useClaudeStore.getState().cards;
      expect(cards).toHaveLength(2);
      expect(cards[1].id).toBe('c2');
    });

    it('inserts a card after afterCardId', () => {
      const c1 = makeCard({ type: 'assistant_text', id: 'c1', text: 'first' });
      const c3 = makeCard({ type: 'assistant_text', id: 'c3', text: 'third' });
      useClaudeStore.setState({ cards: [c1, c3] });

      const c2 = makeCard({ type: 'assistant_text', id: 'c2', text: 'second' });
      const event: CardEvent = { type: 'add', sessionId: 'sess1', card: c2, afterCardId: 'c1' };
      useClaudeStore.getState().handleCardEvent(event);

      const ids = useClaudeStore.getState().cards.map((c) => c.id);
      expect(ids).toEqual(['c1', 'c2', 'c3']);
    });

    it('appends when afterCardId is not found', () => {
      const c1 = makeCard({ type: 'assistant_text', id: 'c1', text: 'first' });
      useClaudeStore.setState({ cards: [c1] });

      const c2 = makeCard({ type: 'assistant_text', id: 'c2', text: 'second' });
      const event: CardEvent = { type: 'add', sessionId: 'sess1', card: c2, afterCardId: 'nonexistent' };
      useClaudeStore.getState().handleCardEvent(event);

      const ids = useClaudeStore.getState().cards.map((c) => c.id);
      expect(ids).toEqual(['c1', 'c2']);
    });

    it('deduplicates user cards within 5s window', () => {
      const existing = makeCard({ type: 'user', id: 'u1', text: 'hello', timestamp: Date.now() });
      useClaudeStore.setState({ cards: [existing] });

      const duplicate = makeCard({ type: 'user', id: 'u2', text: 'hello', timestamp: Date.now() });
      const event: CardEvent = { type: 'add', sessionId: 'sess1', card: duplicate };
      useClaudeStore.getState().handleCardEvent(event);

      expect(useClaudeStore.getState().cards).toHaveLength(1);
    });

    it('does NOT dedup user cards outside 5s window', () => {
      const existing = makeCard({ type: 'user', id: 'u1', text: 'hello', timestamp: Date.now() - 6000 });
      useClaudeStore.setState({ cards: [existing] });

      const duplicate = makeCard({ type: 'user', id: 'u2', text: 'hello', timestamp: Date.now() });
      const event: CardEvent = { type: 'add', sessionId: 'sess1', card: duplicate };
      useClaudeStore.getState().handleCardEvent(event);

      expect(useClaudeStore.getState().cards).toHaveLength(2);
    });

    it('does NOT dedup user cards with different text', () => {
      const existing = makeCard({ type: 'user', id: 'u1', text: 'hello', timestamp: Date.now() });
      useClaudeStore.setState({ cards: [existing] });

      const different = makeCard({ type: 'user', id: 'u2', text: 'goodbye', timestamp: Date.now() });
      const event: CardEvent = { type: 'add', sessionId: 'sess1', card: different };
      useClaudeStore.getState().handleCardEvent(event);

      expect(useClaudeStore.getState().cards).toHaveLength(2);
    });

    it('does NOT dedup non-user cards', () => {
      const existing = makeCard({ type: 'assistant_text', id: 'a1', text: 'hello', timestamp: Date.now() });
      useClaudeStore.setState({ cards: [existing] });

      const newCard = makeCard({ type: 'assistant_text', id: 'a2', text: 'hello', timestamp: Date.now() });
      const event: CardEvent = { type: 'add', sessionId: 'sess1', card: newCard };
      useClaudeStore.getState().handleCardEvent(event);

      expect(useClaudeStore.getState().cards).toHaveLength(2);
    });

    it('updates a card with patch', () => {
      const card = makeCard({ type: 'assistant_text', id: 'c1', text: 'original' });
      useClaudeStore.setState({ cards: [card] });

      const event: CardEvent = {
        type: 'update', sessionId: 'sess1',
        cardId: 'c1', patch: { text: 'updated', streaming: false },
      };
      useClaudeStore.getState().handleCardEvent(event);

      const updated = useClaudeStore.getState().cards[0];
      expect((updated as any).text).toBe('updated');
      expect((updated as any).streaming).toBe(false);
    });

    it('update ignores non-existent cardId', () => {
      const card = makeCard({ type: 'assistant_text', id: 'c1', text: 'original' });
      useClaudeStore.setState({ cards: [card] });

      const event: CardEvent = {
        type: 'update', sessionId: 'sess1',
        cardId: 'nonexistent', patch: { text: 'updated' },
      };
      useClaudeStore.getState().handleCardEvent(event);

      expect((useClaudeStore.getState().cards[0] as any).text).toBe('original');
    });

    it('appends text to existing card', () => {
      const card = makeCard({ type: 'assistant_text', id: 'c1', text: 'Hello' });
      useClaudeStore.setState({ cards: [card] });

      const event: CardEvent = {
        type: 'append_text', sessionId: 'sess1',
        cardId: 'c1', text: ' World',
      };
      useClaudeStore.getState().handleCardEvent(event);

      expect((useClaudeStore.getState().cards[0] as any).text).toBe('Hello World');
    });

    it('append_text ignores cards without text field', () => {
      const card = makeCard({ type: 'tool_call', id: 'tc1', toolName: 'bash', toolInput: {}, toolUseId: 'tu1' } as any);
      useClaudeStore.setState({ cards: [card] });

      const event: CardEvent = {
        type: 'append_text', sessionId: 'sess1',
        cardId: 'tc1', text: 'appended',
      };
      useClaudeStore.getState().handleCardEvent(event);

      // ToolCallCard does not have a text property at the top level, so it should remain unchanged
      expect((useClaudeStore.getState().cards[0] as any).text).toBeUndefined();
    });

    it('removes a card by id', () => {
      const c1 = makeCard({ type: 'assistant_text', id: 'c1', text: 'first' });
      const c2 = makeCard({ type: 'assistant_text', id: 'c2', text: 'second' });
      useClaudeStore.setState({ cards: [c1, c2] });

      const event: CardEvent = { type: 'remove', sessionId: 'sess1', cardId: 'c1' };
      useClaudeStore.getState().handleCardEvent(event);

      const cards = useClaudeStore.getState().cards;
      expect(cards).toHaveLength(1);
      expect(cards[0].id).toBe('c2');
    });

    it('remove with nonexistent id is a no-op', () => {
      const c1 = makeCard({ type: 'assistant_text', id: 'c1', text: 'first' });
      useClaudeStore.setState({ cards: [c1] });

      const event: CardEvent = { type: 'remove', sessionId: 'sess1', cardId: 'nonexistent' };
      useClaudeStore.getState().handleCardEvent(event);

      expect(useClaudeStore.getState().cards).toHaveLength(1);
    });

    it('update patch with null value deletes the key (wire convention)', () => {
      // Regression: the agent sends `{ pendingInput: null }` to clear the
      // permission dialog — JSON.stringify drops `undefined`, so null is the
      // wire sentinel for "clear this key". The store must delete it post-spread.
      const card = makeCard({
        type: 'tool_call',
        id: 'c1',
        toolName: 'Bash',
        toolInput: {},
        toolUseId: 'tu1',
        pendingInput: {
          sessionId: 'sess1',
          requestId: 'req-1',
          inputType: 'permission',
          title: 'Run Bash?',
        },
      } as any);
      useClaudeStore.setState({ cards: [card] });

      const event: CardEvent = {
        type: 'update', sessionId: 'sess1',
        cardId: 'c1', patch: { pendingInput: null } as any,
      };
      useClaudeStore.getState().handleCardEvent(event);

      const updated = useClaudeStore.getState().cards[0] as any;
      expect(updated.pendingInput).toBeUndefined();
      expect('pendingInput' in updated).toBe(false);
    });
  });

  // ── setActiveSession ───────────────────────────────────────────────────

  describe('setActiveSession', () => {
    it('sets activeSessionId', () => {
      useClaudeStore.getState().setActiveSession('sess1');
      expect(useClaudeStore.getState().activeSessionId).toBe('sess1');
    });

    it('sets null activeSessionId', () => {
      useClaudeStore.getState().setActiveSession('sess1');
      useClaudeStore.getState().setActiveSession(null);
      expect(useClaudeStore.getState().activeSessionId).toBeNull();
    });

    it('clears streamError', () => {
      useClaudeStore.setState({ streamError: 'old error' });
      useClaudeStore.getState().setActiveSession('sess1');
      expect(useClaudeStore.getState().streamError).toBeNull();
    });

    it('restores saved permission/agent defaults when switching to New Session', () => {
      localStorageMock.setItem(
        'quicksave:session-prefs',
        JSON.stringify({ selectedAgent: 'codex', selectedPermissionMode: 'bypassPermissions' })
      );
      // Simulate opening an existing session that overrides current selections.
      useClaudeStore.setState({
        sessions: {
          sess1: { sessionId: 'sess1', agent: 'claude-code', permissionMode: 'plan' } as any,
        },
      });
      useClaudeStore.getState().setActiveSession('sess1');
      expect(useClaudeStore.getState().selectedPermissionMode).toBe('plan');
      expect(useClaudeStore.getState().selectedAgent).toBe('claude-code');

      useClaudeStore.getState().setActiveSession(null);
      expect(useClaudeStore.getState().selectedPermissionMode).toBe('bypassPermissions');
      expect(useClaudeStore.getState().selectedAgent).toBe('codex');

      localStorageMock.removeItem('quicksave:session-prefs');
    });

    it('syncs isStreaming to the target session\'s state when navigating', () => {
      // Regression: navigating from a streaming session to an idle one used to
      // leave local isStreaming=true, so the chat kept rendering the blue
      // cursor and bouncing dots even though the green status badge correctly
      // showed the new session as idle.
      useClaudeStore.setState({
        sessions: {
          streamingSess: { sessionId: 'streamingSess', isStreaming: true } as any,
          idleSess: { sessionId: 'idleSess', isStreaming: false } as any,
        },
        isStreaming: true,
      });
      useClaudeStore.getState().setActiveSession('idleSess');
      expect(useClaudeStore.getState().isStreaming).toBe(false);

      useClaudeStore.getState().setActiveSession('streamingSess');
      expect(useClaudeStore.getState().isStreaming).toBe(true);
    });

    it('clears isStreaming when switching to New Session', () => {
      // Without this, navigating from a streaming session to the new-session
      // page would keep isStreaming=true, which makes ClaudePanel render the
      // "Starting task..." banner spuriously (isStartingNewSession =
      // isStreaming && !activeSessionId).
      useClaudeStore.setState({ isStreaming: true });
      useClaudeStore.getState().setActiveSession(null);
      expect(useClaudeStore.getState().isStreaming).toBe(false);
    });

    it('defaults isStreaming to false when target session is unknown', () => {
      useClaudeStore.setState({ isStreaming: true, sessions: {} });
      useClaudeStore.getState().setActiveSession('unknownSess');
      expect(useClaudeStore.getState().isStreaming).toBe(false);
    });

    it('refreshes flat view to the new session\'s agent prefs (no model leak across agents)', () => {
      // Regression: switching from a Codex session with gpt-5 selected to a
      // Claude session must not leave selectedModel='gpt-5' lingering — the
      // chat panel's model selector reads from useSessionConfig which falls
      // back to the flat view when sessionConfigs is empty (e.g. session not
      // yet resumed this daemon lifetime).
      const { setSelectedAgent, setSelectedModel } = useClaudeStore.getState();
      setSelectedAgent('claude-code');
      setSelectedModel('claude-opus-4-7');
      setSelectedAgent('codex');
      setSelectedModel('gpt-5');

      useClaudeStore.setState({
        sessions: {
          claudeSess: { sessionId: 'claudeSess', agent: 'claude-code', permissionMode: 'plan' } as any,
          codexSess: { sessionId: 'codexSess', agent: 'codex', permissionMode: 'full-access' } as any,
        },
      });

      // Open codex session — flat view tracks codex prefs.
      useClaudeStore.getState().setActiveSession('codexSess');
      expect(useClaudeStore.getState().selectedAgent).toBe('codex');
      expect(useClaudeStore.getState().selectedModel).toBe('gpt-5');

      // Open claude session — flat view must reset to claude prefs, not retain gpt-5.
      useClaudeStore.getState().setActiveSession('claudeSess');
      expect(useClaudeStore.getState().selectedAgent).toBe('claude-code');
      expect(useClaudeStore.getState().selectedModel).toBe('claude-opus-4-7');
      expect(useClaudeStore.getState().selectedPermissionMode).toBe('plan');
    });
  });

  // ── per-agent pref isolation ───────────────────────────────────────────

  describe('per-agent prefs', () => {
    it('keeps each agent\'s prefs independent across switches', () => {
      const { setSelectedAgent, setSelectedModel, setSelectedPermissionMode } = useClaudeStore.getState();

      // Configure claude bucket.
      setSelectedAgent('claude-code');
      setSelectedModel('claude-opus-4-7');
      setSelectedPermissionMode('plan');
      // Configure codex bucket.
      setSelectedAgent('codex');
      setSelectedModel('gpt-5.5');
      setSelectedPermissionMode('full-access');

      // Switching back to claude must restore claude's values, not retain codex's.
      setSelectedAgent('claude-code');
      expect(useClaudeStore.getState().selectedModel).toBe('claude-opus-4-7');
      expect(useClaudeStore.getState().selectedPermissionMode).toBe('plan');

      // And codex's bucket is still intact.
      setSelectedAgent('codex');
      expect(useClaudeStore.getState().selectedModel).toBe('gpt-5.5');
      expect(useClaudeStore.getState().selectedPermissionMode).toBe('full-access');
    });

    it('setAgentPref writes to a specific bucket without disturbing the active flat view', () => {
      const { setSelectedAgent, setAgentPref } = useClaudeStore.getState();
      setSelectedAgent('codex');
      const beforeFlat = useClaudeStore.getState().selectedModel;

      // Server-pushed Claude prefs should NOT change what the user sees on Codex.
      setAgentPref('claude-code', 'model', 'claude-opus-4-7');
      expect(useClaudeStore.getState().selectedModel).toBe(beforeFlat);
      expect(useClaudeStore.getState().agentPrefs['claude-code'].model).toBe('claude-opus-4-7');
    });

    it('migrates legacy flat localStorage shape into the active agent\'s bucket', () => {
      localStorageMock.setItem(
        'quicksave:session-prefs',
        JSON.stringify({
          selectedAgent: 'codex',
          selectedModel: 'gpt-5.5',
          selectedPermissionMode: 'full-access',
          selectedReasoningEffort: 'high',
          sandboxEnabled: false,
        }),
      );

      // setActiveSession(null) re-reads localStorage via loadPrefs(), so it
      // exercises the migration path without remounting the store.
      useClaudeStore.getState().setActiveSession(null);

      const state = useClaudeStore.getState();
      expect(state.selectedAgent).toBe('codex');
      expect(state.selectedModel).toBe('gpt-5.5');
      expect(state.selectedPermissionMode).toBe('full-access');
      expect(state.agentPrefs.codex.reasoningEffort).toBe('high');
      // Other agent untouched (defaults).
      expect(state.agentPrefs['claude-code'].model).toBeTruthy();

      localStorageMock.removeItem('quicksave:session-prefs');
    });
  });

  // ── setStreaming ───────────────────────────────────────────────────────

  describe('setStreaming', () => {
    it('sets isStreaming true', () => {
      useClaudeStore.getState().setStreaming(true);
      expect(useClaudeStore.getState().isStreaming).toBe(true);
    });

    it('sets isStreaming false', () => {
      useClaudeStore.setState({ isStreaming: true });
      useClaudeStore.getState().setStreaming(false);
      expect(useClaudeStore.getState().isStreaming).toBe(false);
    });
  });

  // ── clearCards ─────────────────────────────────────────────────────────

  describe('clearCards', () => {
    it('resets cards and history meta', () => {
      useClaudeStore.setState({
        cards: [makeCard({ type: 'user', text: 'test' })],
        historyTotal: 42,
        historyHasMore: true,
        historyError: 'some error',
      });
      useClaudeStore.getState().clearCards();
      const state = useClaudeStore.getState();
      expect(state.cards).toEqual([]);
      expect(state.historyTotal).toBe(0);
      expect(state.historyHasMore).toBe(false);
      expect(state.historyError).toBeNull();
    });
  });

  // ── prependCards ───────────────────────────────────────────────────────

  describe('prependCards', () => {
    it('prepends cards and deduplicates', () => {
      const c2 = makeCard({ type: 'assistant_text', id: 'c2', text: 'existing' });
      useClaudeStore.setState({ cards: [c2] });

      const c1 = makeCard({ type: 'assistant_text', id: 'c1', text: 'prepended' });
      const c2Dup = makeCard({ type: 'assistant_text', id: 'c2', text: 'duplicate' });
      useClaudeStore.getState().prependCards([c1, c2Dup]);

      const ids = useClaudeStore.getState().cards.map((c) => c.id);
      expect(ids).toEqual(['c1', 'c2']);
    });
  });

  // ── session isolation (new session page must not see other channels) ────

  describe('session isolation — new session page', () => {
    /**
     * Cards are gated by sessionId match alone (the bus subscription is
     * already keyed per-session, so the active-session guard is just a
     * navigation-race safety net):
     *
     *   if (activeSessionId && event.sessionId !== activeSessionId) return; // drop
     *   if (!activeSessionId && !isStreaming) return;                       // drop
     *
     * The new-session page has activeSessionId=null and isStreaming=false,
     * so any card event — regardless of sessionId — must be discarded.
     */
    function shouldAcceptCardEvent(
      state: { activeSessionId: string | null; isStreaming: boolean },
      event: CardEvent,
    ): boolean {
      if (state.activeSessionId && event.sessionId !== state.activeSessionId) return false;
      if (!state.activeSessionId && !state.isStreaming) return false;
      return true;
    }

    it('rejects card events from other sessions when on new session page (activeSessionId=null, isStreaming=false)', () => {
      useClaudeStore.setState({ activeSessionId: null, isStreaming: false });
      const state = useClaudeStore.getState();

      const event: CardEvent = {
        type: 'add', sessionId: 'session-other',
        card: makeCard({ type: 'assistant_text', id: 'leaked', text: 'should not appear' }),
      };

      expect(shouldAcceptCardEvent(state, event)).toBe(false);

      // Verify that if we skip the guard (incorrectly), the card WOULD be added
      useClaudeStore.getState().handleCardEvent(event);
      expect(useClaudeStore.getState().cards).toHaveLength(1); // store has no guard itself

      // Reset and confirm: with the guard, cards stay empty
      useClaudeStore.setState({ cards: [] });
      if (shouldAcceptCardEvent(state, event)) {
        useClaudeStore.getState().handleCardEvent(event);
      }
      expect(useClaudeStore.getState().cards).toHaveLength(0);
    });

    it('rejects card events from a mismatched session when viewing a specific session', () => {
      useClaudeStore.setState({ activeSessionId: 'session-A', isStreaming: true });
      const state = useClaudeStore.getState();

      const event: CardEvent = {
        type: 'add', sessionId: 'session-B',
        card: makeCard({ type: 'user', id: 'leaked', text: 'wrong session' }),
      };

      expect(shouldAcceptCardEvent(state, event)).toBe(false);
    });

    it('accepts card events for the active session', () => {
      useClaudeStore.setState({ activeSessionId: 'session-A', isStreaming: true });
      const state = useClaudeStore.getState();

      const event: CardEvent = {
        type: 'add', sessionId: 'session-A',
        card: makeCard({ type: 'assistant_text', id: 'ok', text: 'correct session' }),
      };

      expect(shouldAcceptCardEvent(state, event)).toBe(true);
    });

    it('accepts card events when a new session is starting (activeSessionId=null, isStreaming=true)', () => {
      useClaudeStore.setState({ activeSessionId: null, isStreaming: true });
      const state = useClaudeStore.getState();

      const event: CardEvent = {
        type: 'add', sessionId: 'new-session',
        card: makeCard({ type: 'assistant_text', id: 'first', text: 'starting up' }),
      };

      expect(shouldAcceptCardEvent(state, event)).toBe(true);
    });

  });

  // ── setSessions / upsertSession ────────────────────────

  describe('session management', () => {
    it('setSessions replaces all sessions as a map', () => {
      useClaudeStore.getState().setSessions([
        { sessionId: 's1', summary: 'A', lastModified: 1 } as any,
        { sessionId: 's2', summary: 'B', lastModified: 2 } as any,
      ]);
      const sessions = useClaudeStore.getState().sessions;
      expect(Object.keys(sessions)).toEqual(['s1', 's2']);
      expect(sessions['s1'].summary).toBe('A');
    });

    it('upsertSession merges partial into existing', () => {
      useClaudeStore.getState().setSessions([
        { sessionId: 's1', summary: 'old', lastModified: 1, isActive: false } as any,
      ]);
      useClaudeStore.getState().upsertSession({ sessionId: 's1', isActive: true } as any);
      const s = useClaudeStore.getState().sessions['s1'];
      expect(s.isActive).toBe(true);
      expect(s.summary).toBe('old');
    });
  });
});
