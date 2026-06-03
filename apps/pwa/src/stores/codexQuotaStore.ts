// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { create } from 'zustand';
import type { CodexQuotaSnapshot } from '@sumicom/quicksave-shared';

interface CodexQuotaStore {
  byAgent: Record<string, CodexQuotaSnapshot | null>;
  set: (agentId: string, snapshot: CodexQuotaSnapshot | null) => void;
  clear: (agentId: string) => void;
  get: (agentId: string | null | undefined) => CodexQuotaSnapshot | null | undefined;
}

export const useCodexQuotaStore = create<CodexQuotaStore>((set, get) => ({
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
