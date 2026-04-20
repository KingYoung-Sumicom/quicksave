import type { AgentId, SessionUpdatePayload } from '@sumicom/quicksave-shared';
import { useClaudeStore } from '../stores/claudeStore';

/**
 * Apply a single session-updated payload from the agent.
 *
 * Shared by the `/sessions/active` bus snapshot (called per entry) and each
 * subsequent `/sessions/active` update. Performs an idempotency check against
 * the current store state before writing, and syncs the streaming/agent/
 * permission-mode UI refs when the updated session is the active one.
 */
export function applySessionUpdate(payload: SessionUpdatePayload, machineAgentId: string): void {
  const {
    sessions,
    activeSessionId,
    upsertSession,
    setStreaming,
    setSelectedAgent,
    setSelectedPermissionMode,
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
    current.agent === agent &&
    current.permissionMode === payload.permissionMode &&
    current.lastPromptAt === payload.lastPromptAt &&
    current.lastTurnEndedAt === payload.lastTurnEndedAt &&
    current.turnCount === payload.turnCount &&
    current.totalInputTokens === payload.totalInputTokens &&
    current.totalOutputTokens === payload.totalOutputTokens &&
    current.totalCostUsd === payload.totalCostUsd &&
    current.lastTurnInputTokens === payload.lastTurnInputTokens &&
    current.lastTurnCacheCreationTokens === payload.lastTurnCacheCreationTokens &&
    current.lastTurnCacheReadTokens === payload.lastTurnCacheReadTokens &&
    current.lastTurnContextUsage?.capturedAt === payload.lastTurnContextUsage?.capturedAt
  ) {
    return;
  }

  upsertSession({
    sessionId: payload.sessionId,
    machineAgentId,
    isActive: payload.isActive,
    archived: payload.archived,
    isStreaming: payload.isStreaming,
    hasPendingInput: payload.hasPendingInput,
    agent,
    permissionMode: payload.permissionMode,
    lastPromptAt: payload.lastPromptAt,
    lastTurnEndedAt: payload.lastTurnEndedAt,
    turnCount: payload.turnCount,
    totalInputTokens: payload.totalInputTokens,
    totalOutputTokens: payload.totalOutputTokens,
    totalCostUsd: payload.totalCostUsd,
    lastTurnInputTokens: payload.lastTurnInputTokens,
    lastTurnCacheCreationTokens: payload.lastTurnCacheCreationTokens,
    lastTurnCacheReadTokens: payload.lastTurnCacheReadTokens,
    lastTurnContextUsage: payload.lastTurnContextUsage,
  });

  if (payload.sessionId === activeSessionId) {
    setStreaming(payload.isStreaming);
    if (agent) setSelectedAgent(agent);
    if (payload.permissionMode) setSelectedPermissionMode(payload.permissionMode);
  }
}
