import type { BroadcastSessionEntry, SessionHistoryUpdatedPayload } from '@sumicom/quicksave-shared';
import { useClaudeStore } from '../stores/claudeStore';

/**
 * Apply a single session-registry entry to the store.
 * Archived entries are removed (the PWA hides archived sessions).
 */
export function applyHistoryEntry(entry: BroadcastSessionEntry, machineAgentId: string): void {
  const { removeSession, upsertSession } = useClaudeStore.getState();
  if (entry.archived) {
    removeSession(entry.sessionId);
    return;
  }
  upsertSession({
    sessionId: entry.sessionId,
    machineAgentId,
    summary: entry.title ?? entry.firstPrompt ?? entry.sessionId.slice(0, 8),
    lastModified: entry.lastAccessedAt,
    createdAt: entry.createdAt,
    cwd: entry.cwd,
    agent: entry.agent,
    gitBranch: entry.gitBranch,
    messageCount: entry.messageCount,
    totalCostUsd: entry.totalCostUsd,
    permissionMode: entry.permissionMode,
    // Runtime-enriched from the event store at broadcast time so inactive
    // sessions still get cache / context usage — otherwise `SessionStatsBar`
    // renders nothing until the session is hot-resumed.
    lastPromptAt: entry.lastPromptAt,
    lastTurnEndedAt: entry.lastTurnEndedAt,
    turnCount: entry.turnCount,
    totalInputTokens: entry.totalInputTokens,
    totalOutputTokens: entry.totalOutputTokens,
    lastTurnInputTokens: entry.lastTurnInputTokens,
    lastTurnCacheCreationTokens: entry.lastTurnCacheCreationTokens,
    lastTurnCacheReadTokens: entry.lastTurnCacheReadTokens,
    lastTurnContextUsage: entry.lastTurnContextUsage,
  });
}

/**
 * Apply an incremental history update from the `/sessions/history` bus path.
 * `action === 'delete'` removes; otherwise delegates to `applyHistoryEntry`.
 */
export function applyHistoryAction(payload: SessionHistoryUpdatedPayload, machineAgentId: string): void {
  if (payload.action === 'delete') {
    useClaudeStore.getState().removeSession(payload.entry.sessionId);
    return;
  }
  applyHistoryEntry(payload.entry, machineAgentId);
}
