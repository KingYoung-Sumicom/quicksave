import { create } from 'zustand';
import type { TerminalSummary } from '@sumicom/quicksave-shared';

/**
 * Locally-stored terminal summary: extends the shared shape with the agent
 * (machine) the terminal lives on. Needed in multi-agent mode so actions
 * (input, resize, close) target the owning daemon.
 */
export type StoredTerminal = TerminalSummary & { machineAgentId: string };

interface TerminalStore {
  /** terminalId → summary. */
  terminals: Record<string, StoredTerminal>;

  applySnapshot(agentId: string, list: TerminalSummary[]): void;
  upsert(agentId: string, terminal: TerminalSummary): void;
  remove(agentId: string, terminalId: string): void;
  /** Clear every terminal belonging to the given agent (e.g. on disconnect). */
  clearAgent(agentId: string): void;
}

export const useTerminalStore = create<TerminalStore>((set) => ({
  terminals: {},

  applySnapshot: (agentId, list) => set((state) => {
    // Authoritative: drop any terminal on this agent not present in `list`.
    const next: Record<string, StoredTerminal> = {};
    for (const [id, t] of Object.entries(state.terminals)) {
      if (t.machineAgentId !== agentId) next[id] = t;
    }
    for (const t of list) {
      next[t.terminalId] = { ...t, machineAgentId: agentId };
    }
    return { terminals: next };
  }),

  upsert: (agentId, terminal) => set((state) => ({
    terminals: {
      ...state.terminals,
      [terminal.terminalId]: { ...terminal, machineAgentId: agentId },
    },
  })),

  remove: (_agentId, terminalId) => set((state) => {
    if (!state.terminals[terminalId]) return state;
    const { [terminalId]: _gone, ...rest } = state.terminals;
    void _gone;
    return { terminals: rest };
  }),

  clearAgent: (agentId) => set((state) => {
    const next: Record<string, StoredTerminal> = {};
    for (const [id, t] of Object.entries(state.terminals)) {
      if (t.machineAgentId !== agentId) next[id] = t;
    }
    return { terminals: next };
  }),
}));
