// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type {
  AgentId,
  BroadcastSessionEntry,
  SessionRegistryEntry,
} from '@sumicom/quicksave-shared';
import { getEventStore } from '../storage/eventStore.js';
import { normalizeStoredContextUsage } from '../service/contextUsage.js';

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
  const agent = normalizeAgentForBroadcast(entry.agent)
    ?? normalizeAgentForBroadcast((entry as { provider?: string }).provider)
    ?? normalizeAgentForBroadcast(eventStore.getSessionAgent(entry.sessionId));
  return {
    ...entry,
    ...(agent ? { agent } : {}),
    lastPromptAt: stats.lastPromptAt ?? undefined,
    lastTurnEndedAt: stats.lastTurnEndedAt ?? undefined,
    lastCacheTouchAt: stats.lastCacheTouchAt ?? undefined,
    turnCount: stats.turnCount || undefined,
    totalInputTokens: stats.totalInputTokens || undefined,
    totalOutputTokens: stats.totalOutputTokens || undefined,
    lastTurnInputTokens: lastTurn?.inputTokens,
    lastTurnCacheCreationTokens: lastTurn?.cacheCreationTokens,
    lastTurnCacheReadTokens: lastTurn?.cacheReadTokens,
    lastTurnContextUsage: normalizeStoredContextUsage(lastTurn?.contextUsage),
  };
}

function normalizeAgentForBroadcast(value: unknown): AgentId | undefined {
  if (value === 'claude-code' || value === 'claude-cli' || value === 'claude-sdk') {
    return 'claude-code';
  }
  if (value === 'claude-terminal') return 'claude-terminal';
  if (value === 'codex' || value === 'codex-mcp') return 'codex';
  if (value === 'opencode') return 'opencode';
  if (value === 'pi') return 'pi';
  return undefined;
}
