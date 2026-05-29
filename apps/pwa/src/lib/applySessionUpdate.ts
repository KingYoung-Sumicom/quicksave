// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { AgentId, SessionUpdatePayload } from '@sumicom/quicksave-shared';
import { useClaudeStore } from '../stores/claudeStore';

function sameStringArray(a?: readonly string[], b?: readonly string[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

/**
 * Apply a single session-updated payload from the agent.
 *
 * Shared by the `/sessions/active` bus snapshot (called per entry) and each
 * subsequent `/sessions/active` update. Performs an idempotency check against
 * the current store state before writing, and reprojects active-session UI
 * refs when the updated session is the active one.
 */
export function applySessionUpdate(payload: SessionUpdatePayload, machineAgentId: string): void {
  const {
    sessions,
    activeSessionId,
    upsertSession,
    setActiveSession,
  } = useClaudeStore.getState();

  const agent: AgentId | undefined = payload.agent;
  const current = sessions[payload.sessionId];
  if (
    current &&
    current.machineAgentId === machineAgentId &&
    current.isActive === payload.isActive &&
    current.archived === payload.archived &&
    current.isStreaming === payload.isStreaming &&
    current.hasPendingInput === payload.hasPendingInput &&
    current.queueState?.pendingUserMessages === payload.queueState?.pendingUserMessages &&
    current.queueState?.latestPromptPreview === payload.queueState?.latestPromptPreview &&
    sameStringArray(current.queueState?.queuedPromptPreviews, payload.queueState?.queuedPromptPreviews) &&
    current.queueState?.canInterruptCurrentTurn === payload.queueState?.canInterruptCurrentTurn &&
    current.queueState?.optimisticUntil === payload.queueState?.optimisticUntil &&
    current.agent === agent &&
    current.permissionMode === payload.permissionMode &&
    current.lastPromptAt === payload.lastPromptAt &&
    current.lastTurnEndedAt === payload.lastTurnEndedAt &&
    current.lastCacheTouchAt === payload.lastCacheTouchAt &&
    current.turnCount === payload.turnCount &&
    current.totalInputTokens === payload.totalInputTokens &&
    current.totalOutputTokens === payload.totalOutputTokens &&
    current.totalCostUsd === payload.totalCostUsd &&
    current.lastTurnInputTokens === payload.lastTurnInputTokens &&
    current.lastTurnCacheCreationTokens === payload.lastTurnCacheCreationTokens &&
    current.lastTurnCacheReadTokens === payload.lastTurnCacheReadTokens &&
    current.lastTurnContextUsage?.capturedAt === payload.lastTurnContextUsage?.capturedAt &&
    current.lastReadAt === payload.lastReadAt &&
    current.pendingMission?.label === payload.pendingMission?.label &&
    current.pendingMission?.until === payload.pendingMission?.until &&
    current.pendingMission?.startedAt === payload.pendingMission?.startedAt &&
    current.pendingMission?.dismissedAt === payload.pendingMission?.dismissedAt
  ) {
    return;
  }

  const queueState = payload.queueState
    ?? (current?.queueState?.optimisticUntil && current.queueState.optimisticUntil > Date.now() && payload.isStreaming
      ? current.queueState
      : null);

  upsertSession({
    sessionId: payload.sessionId,
    machineAgentId,
    isActive: payload.isActive,
    archived: payload.archived,
    isStreaming: payload.isStreaming,
    hasPendingInput: payload.hasPendingInput,
    queueState,
    agent,
    permissionMode: payload.permissionMode,
    lastPromptAt: payload.lastPromptAt,
    lastTurnEndedAt: payload.lastTurnEndedAt,
    lastCacheTouchAt: payload.lastCacheTouchAt,
    turnCount: payload.turnCount,
    totalInputTokens: payload.totalInputTokens,
    totalOutputTokens: payload.totalOutputTokens,
    totalCostUsd: payload.totalCostUsd,
    lastTurnInputTokens: payload.lastTurnInputTokens,
    lastTurnCacheCreationTokens: payload.lastTurnCacheCreationTokens,
    lastTurnCacheReadTokens: payload.lastTurnCacheReadTokens,
    lastTurnContextUsage: payload.lastTurnContextUsage,
    lastReadAt: payload.lastReadAt,
    pendingMission: payload.pendingMission,
  });

  if (payload.sessionId === activeSessionId) {
    // Re-project the active session into the flat UI fields without calling
    // persisted new-session preference setters. Opening or receiving updates
    // for an existing session must not overwrite the user's saved defaults
    // for the next new session.
    setActiveSession(payload.sessionId);
  }
}
