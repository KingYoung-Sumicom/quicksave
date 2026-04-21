import { describe, it, expect, beforeEach } from 'vitest';
import type { Card, CardEvent, CardHistoryResponse, SessionCardsUpdate } from '@sumicom/quicksave-shared';
import { applySessionCardsSnapshot, applySessionCardsUpdate } from './applySessionCards';
import { useClaudeStore } from '../stores/claudeStore';

// localStorage shim — claudeStore reads it at module init for prefs.
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

function makePermissionToolCard(sessionId: string, requestId: string, cardId: string): Card {
  return {
    id: cardId,
    type: 'tool_call',
    timestamp: Date.now(),
    toolName: 'Bash',
    toolInput: { command: 'echo hi' },
    toolUseId: `tu-${cardId}`,
    pendingInput: {
      sessionId,
      requestId,
      inputType: 'permission',
      title: 'Run Bash?',
    },
  } as any;
}

function clearPendingEvent(sessionId: string, cardId: string, streamId = 'stream-x'): SessionCardsUpdate {
  const event: CardEvent = {
    type: 'update',
    sessionId,
    streamId,
    cardId,
    patch: { pendingInput: null } as any,
  };
  return { kind: 'card', event };
}

describe('applySessionCards (multi-session permission resolve)', () => {
  beforeEach(() => {
    useClaudeStore.getState().reset();
    useClaudeStore.setState({
      cards: [],
      activeSessionId: null,
      activeStreamIds: [],
      isStreaming: false,
      historyTotal: 0,
      historyHasMore: false,
      historyError: null,
    });
  });

  it('clears pending input when the update sessionId matches activeSessionId', () => {
    // Baseline: viewing session A, A's update arrives — pendingInput must clear.
    const card = makePermissionToolCard('sess-A', 'req-A1', 'cA');
    useClaudeStore.setState({ cards: [card], activeSessionId: 'sess-A', activeStreamIds: [] });

    applySessionCardsUpdate('sess-A', clearPendingEvent('sess-A', 'cA'));

    const updated = useClaudeStore.getState().cards[0] as any;
    expect(updated.pendingInput).toBeUndefined();
  });

  it('drops the update when sessionId does NOT match activeSessionId', () => {
    // The PWA only renders one session at a time. A leaked card-event from
    // session B while viewing session A must NOT mutate A's cards. (Bus
    // routing on the agent should prevent this from being delivered in the
    // first place, but the receiver also defends.)
    const aCard = makePermissionToolCard('sess-A', 'req-A1', 'cA');
    useClaudeStore.setState({ cards: [aCard], activeSessionId: 'sess-A', activeStreamIds: [] });

    // A stale update for session B (e.g. from a still-mounted leaked subscription).
    applySessionCardsUpdate('sess-B', clearPendingEvent('sess-B', 'cA'));

    // A's pending must remain — the stale B-update did not clobber it.
    const aAfter = useClaudeStore.getState().cards[0] as any;
    expect(aAfter.pendingInput).toBeDefined();
    expect(aAfter.pendingInput.requestId).toBe('req-A1');
  });

  it('after navigating from A to B, B`s clear update applies (regression: same-agent two-session resolve)', () => {
    // The reported bug: with two sessions on the same agent, both holding a
    // pending permission, resolving A works but resolving B "has no reaction".
    // This walks the full PWA-side sequence:
    //   1. View A; A's pending card is loaded.
    //   2. Resolve A → A's clear update applies.
    //   3. Navigate to B → snapshot replaces cards with B's pending card.
    //   4. Resolve B → B's clear update must apply (this is what the bug
    //      report says doesn't happen).

    // Step 1: view A.
    const cardA = makePermissionToolCard('sess-A', 'req-A', 'cA');
    useClaudeStore.setState({
      cards: [cardA],
      activeSessionId: 'sess-A',
      activeStreamIds: [],
      isStreaming: false,
    });

    // Step 2: agent emits A's clear; A's bus subscription delivers it.
    applySessionCardsUpdate('sess-A', clearPendingEvent('sess-A', 'cA'));
    expect((useClaudeStore.getState().cards[0] as any).pendingInput).toBeUndefined();

    // Step 3: navigate to B. ClaudePanel calls clearCards() then subscribes
    // to /sessions/sess-B/cards; the snapshot arrives with B's pending card.
    useClaudeStore.getState().clearCards();
    useClaudeStore.getState().setActiveSession('sess-B');
    const cardB = makePermissionToolCard('sess-B', 'req-B', 'cB');
    const snapshot: CardHistoryResponse = { cards: [cardB], total: 1, hasMore: false };
    applySessionCardsSnapshot('sess-B', snapshot);
    expect(useClaudeStore.getState().cards).toHaveLength(1);
    expect((useClaudeStore.getState().cards[0] as any).pendingInput?.requestId).toBe('req-B');

    // Step 4: resolve B — the bug-report failure mode is that this does
    // nothing. The store must end up with B's pending input cleared.
    applySessionCardsUpdate('sess-B', clearPendingEvent('sess-B', 'cB'));
    const cardAfter = useClaudeStore.getState().cards[0] as any;
    expect(cardAfter.pendingInput).toBeUndefined();
    expect('pendingInput' in cardAfter).toBe(false);
  });

  it('a leaked update for the previous session (A) after navigating to B is dropped', () => {
    // Race: user navigates A → B, but a late card-event from A's old
    // subscription arrives at the receiver. activeSessionId is now B, so
    // the A-stamped update must be silently discarded — not mutate B's cards.
    const cardB = makePermissionToolCard('sess-B', 'req-B', 'cB');
    useClaudeStore.setState({
      cards: [cardB],
      activeSessionId: 'sess-B',
      activeStreamIds: [],
      isStreaming: false,
    });

    // Late A-clear arrives — must be ignored.
    applySessionCardsUpdate('sess-A', clearPendingEvent('sess-A', 'cB'));

    const after = useClaudeStore.getState().cards[0] as any;
    expect(after.pendingInput).toBeDefined();
    expect(after.pendingInput.requestId).toBe('req-B');
  });

  it('snapshot is dropped when sessionId does not match activeSessionId (out-of-order navigation)', () => {
    // Race: user navigates B → C while B's snapshot is still in flight.
    // When B's snapshot arrives, activeSessionId is already 'sess-C', so the
    // snapshot must NOT replace C's cards.
    const cardC = makePermissionToolCard('sess-C', 'req-C', 'cC');
    useClaudeStore.setState({ cards: [cardC], activeSessionId: 'sess-C' });

    const lateBSnapshot: CardHistoryResponse = {
      cards: [makePermissionToolCard('sess-B', 'req-B', 'cB')],
      total: 1,
      hasMore: false,
    };
    applySessionCardsSnapshot('sess-B', lateBSnapshot);

    expect(useClaudeStore.getState().cards).toHaveLength(1);
    expect(useClaudeStore.getState().cards[0].id).toBe('cC');
  });
});
