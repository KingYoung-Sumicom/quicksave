// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { create } from 'zustand';
import type { CodexLoginState } from '@sumicom/quicksave-shared';

/**
 * Mirror of the daemon's Codex OAuth device-auth state, keyed by agentId.
 * The PWA subscribes to `/codex/login` on each connected agent's bus; the
 * snapshot + updates flow into this store so components can react without
 * caring which agent is currently active.
 */

export type CodexLoginEntry = CodexLoginState;

interface CodexLoginStore {
  byAgent: Record<string, CodexLoginEntry>;
  set: (agentId: string, state: CodexLoginEntry) => void;
  clear: (agentId: string) => void;
  get: (agentId: string | null | undefined) => CodexLoginEntry | undefined;
}

export const useCodexLoginStore = create<CodexLoginStore>((set, get) => ({
  byAgent: {},
  set: (agentId, state) =>
    set((s) => ({ byAgent: { ...s.byAgent, [agentId]: state } })),
  clear: (agentId) =>
    set((s) => {
      const { [agentId]: _drop, ...rest } = s.byAgent;
      void _drop;
      return { byAgent: rest };
    }),
  get: (agentId) => (agentId ? get().byAgent[agentId] : undefined),
}));
