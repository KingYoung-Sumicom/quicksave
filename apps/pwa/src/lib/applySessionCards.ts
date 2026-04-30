// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { CardHistoryResponse, SessionCardsUpdate } from '@sumicom/quicksave-shared';
import { useClaudeStore } from '../stores/claudeStore';

/**
 * Apply a `/sessions/:sessionId/cards` snapshot: replaces the current card
 * list with the initial page and reconciles history metadata + title.
 */
export function applySessionCardsSnapshot(sessionId: string, snap: CardHistoryResponse): void {
  const { activeSessionId, setCards, setHistoryMeta, applySessionConfig } = useClaudeStore.getState();
  if (sessionId !== activeSessionId) return;
  setCards(snap.cards);
  setHistoryMeta(snap.total, snap.hasMore);
  if (snap.title) applySessionConfig(sessionId, { title: snap.title });
}

/**
 * Apply a `/sessions/:sessionId/cards` update: either a CardEvent (add,
 * update, append_text, remove) or a CardStreamEnd marking a turn complete.
 * Silently drops updates for sessions the PWA is not currently viewing.
 *
 * Cards are gated by sessionId match alone — the bus subscription is keyed
 * by sessionId so cross-session events can't reach this handler in the
 * first place, and the active-session guard covers the brief race where a
 * late event arrives after navigation. The local `isStreaming` flag is
 * driven by `/sessions/active` session-updated broadcasts via
 * {@link applySessionUpdate}, which carry the agent's authoritative view.
 */
export function applySessionCardsUpdate(sessionId: string, update: SessionCardsUpdate): void {
  const state = useClaudeStore.getState();
  if (sessionId !== state.activeSessionId && !(state.isStreaming && !state.activeSessionId)) {
    return;
  }
  if (update.kind === 'card') {
    state.handleCardEvent(update.event);
    return;
  }
  // update.kind === 'stream-end'
  const payload = update.result;
  if (!payload.success && !payload.interrupted) {
    state.setStreamError(payload.error || 'Session ended with error');
  }
  if (payload.totalCostUsd !== undefined || payload.tokenUsage) {
    const parts: string[] = [];
    if (payload.totalCostUsd !== undefined) {
      parts.push(`Cost: $${payload.totalCostUsd.toFixed(4)}`);
    }
    if (payload.tokenUsage) {
      parts.push(`Tokens: ${payload.tokenUsage.input}in/${payload.tokenUsage.output}out`);
    }
    state.appendCard({
      type: 'system',
      id: `cost-${Date.now()}`,
      timestamp: Date.now(),
      text: parts.join(' | '),
      subtype: 'cost',
    });
  }
}
