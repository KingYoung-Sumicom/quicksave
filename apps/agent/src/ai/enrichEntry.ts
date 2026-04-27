import type {
  BroadcastSessionEntry,
  ContextUsageBreakdown,
  SessionRegistryEntry,
} from '@sumicom/quicksave-shared';
import { getEventStore } from '../storage/eventStore.js';

/**
 * Join runtime event-store stats onto a registry entry for broadcast on
 * `/sessions/history` (and on-demand fetches like `session:list-archived`).
 * Cache / context fields live only in SQLite; we enrich here so inactive
 * sessions render the same info that `/sessions/active` delivers for live
 * ones. Safe for sessions with zero events — every added field is optional
 * and simply stays undefined.
 */
export function enrichEntry(entry: SessionRegistryEntry): BroadcastSessionEntry {
  const eventStore = getEventStore();
  const stats = eventStore.getSessionStats(entry.sessionId);
  const lastTurn = eventStore.getLastTurn(entry.sessionId);
  return {
    ...entry,
    lastPromptAt: stats.lastPromptAt ?? undefined,
    lastTurnEndedAt: stats.lastTurnEndedAt ?? undefined,
    lastCacheTouchAt: stats.lastCacheTouchAt ?? undefined,
    turnCount: stats.turnCount || undefined,
    totalInputTokens: stats.totalInputTokens || undefined,
    totalOutputTokens: stats.totalOutputTokens || undefined,
    lastTurnInputTokens: lastTurn?.inputTokens,
    lastTurnCacheCreationTokens: lastTurn?.cacheCreationTokens,
    lastTurnCacheReadTokens: lastTurn?.cacheReadTokens,
    lastTurnContextUsage: lastTurn?.contextUsage as ContextUsageBreakdown | undefined,
  };
}
