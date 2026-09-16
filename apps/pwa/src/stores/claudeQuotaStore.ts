// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { create } from 'zustand';
import type { ClaudeQuotaSnapshot } from '@sumicom/quicksave-shared';

interface ClaudeQuotaStore {
  byAgent: Record<string, ClaudeQuotaSnapshot | null>;
  set: (agentId: string, snapshot: ClaudeQuotaSnapshot | null) => void;
  clear: (agentId: string) => void;
  get: (agentId: string | null | undefined) => ClaudeQuotaSnapshot | null | undefined;
}

export const useClaudeQuotaStore = create<ClaudeQuotaStore>((set, get) => ({
  byAgent: {},
  set: (agentId, snapshot) =>
    set((s) => ({ byAgent: { ...s.byAgent, [agentId]: snapshot } })),
  clear: (agentId) =>
    set((s) => {
      const { [agentId]: _drop, ...rest } = s.byAgent;
      void _drop;
      return { byAgent: rest };
    }),
  get: (agentId) => (agentId ? get().byAgent[agentId] : undefined),
}));
