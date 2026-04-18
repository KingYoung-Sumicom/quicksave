import type { SessionHistoryUpdatedPayload, SessionRegistryEntry } from '@sumicom/quicksave-shared';
import { useClaudeStore } from '../stores/claudeStore';

/**
 * Apply a single session-registry entry to the store.
 * Archived entries are removed (the PWA hides archived sessions).
 */
export function applyHistoryEntry(entry: SessionRegistryEntry): void {
  const { removeSession, upsertSession } = useClaudeStore.getState();
  if (entry.archived) {
    removeSession(entry.sessionId);
    return;
  }
  upsertSession({
    sessionId: entry.sessionId,
    summary: entry.title ?? entry.firstPrompt ?? entry.sessionId.slice(0, 8),
    lastModified: entry.lastAccessedAt,
    createdAt: entry.createdAt,
    cwd: entry.cwd,
    agent: entry.agent,
    gitBranch: entry.gitBranch,
    messageCount: entry.messageCount,
    totalCostUsd: entry.totalCostUsd,
    permissionMode: entry.permissionMode,
  });
}

/**
 * Apply an incremental history update from the `/sessions/history` bus path.
 * `action === 'delete'` removes; otherwise delegates to `applyHistoryEntry`.
 */
export function applyHistoryAction(payload: SessionHistoryUpdatedPayload): void {
  if (payload.action === 'delete') {
    useClaudeStore.getState().removeSession(payload.entry.sessionId);
    return;
  }
  applyHistoryEntry(payload.entry);
}
