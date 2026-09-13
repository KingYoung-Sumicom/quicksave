// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useCallback } from 'react';
import type { ClaudeAuthStatusResponsePayload } from '@sumicom/quicksave-shared';
import { getBusForAgent } from '../lib/busRegistry';
import { useClaudeAuthStore } from '../stores/claudeAuthStore';
import { useConnectionStore } from '../stores/connectionStore';

export function useClaudeAuth(targetAgentId?: string | null) {
  const activeAgentId = useConnectionStore((s) => s.agentId);
  const agentId = targetAgentId === undefined ? activeAgentId : targetAgentId;
  const authState = useClaudeAuthStore((s) => (agentId ? s.byAgent[agentId] : undefined));

  const refreshStatus = useCallback(async () => {
    if (!agentId) return null;
    const targetAgentId = agentId;
    const bus = getBusForAgent(targetAgentId);
    if (!bus) return null;
    const state = await bus.command<ClaudeAuthStatusResponsePayload>(
      'claude:auth-status',
      {},
      { timeoutMs: 10_000, queueWhileDisconnected: false },
    );
    useClaudeAuthStore.getState().set(targetAgentId, state);
    return state;
  }, [agentId]);

  return { authState, refreshStatus };
}
