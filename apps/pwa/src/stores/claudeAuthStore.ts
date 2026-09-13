// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { create } from 'zustand';
import type { ClaudeAuthState } from '@sumicom/quicksave-shared';

interface ClaudeAuthStore {
  byAgent: Record<string, ClaudeAuthState>;
  set: (agentId: string, state: ClaudeAuthState) => void;
  clear: (agentId: string) => void;
}

export const useClaudeAuthStore = create<ClaudeAuthStore>((set) => ({
  byAgent: {},
  set: (agentId, state) => set((s) => ({
    byAgent: { ...s.byAgent, [agentId]: state },
  })),
  clear: (agentId) => set((s) => {
    const { [agentId]: _drop, ...rest } = s.byAgent;
    void _drop;
    return { byAgent: rest };
  }),
}));
