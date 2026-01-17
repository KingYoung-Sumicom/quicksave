import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface Machine {
  // Core identity
  agentId: string;
  publicKey: string;

  // User-friendly metadata
  nickname: string;
  icon: string;

  // Connection metadata
  addedAt: number;
  lastConnectedAt: number | null;
  lastRepoPath: string | null;
  isPro: boolean;
}

interface MachineStore {
  // State
  machines: Machine[];

  // Actions
  addMachine: (machine: Pick<Machine, 'agentId' | 'publicKey' | 'nickname' | 'icon'>) => void;
  updateMachine: (agentId: string, updates: Partial<Omit<Machine, 'agentId'>>) => void;
  removeMachine: (agentId: string) => void;
  recordConnection: (agentId: string, repoPath: string, isPro: boolean) => void;
  getMachine: (agentId: string) => Machine | undefined;
  hasMachine: (agentId: string) => boolean;
}

export const useMachineStore = create<MachineStore>()(
  persist(
    (set, get) => ({
      machines: [],

      addMachine: (machine) =>
        set((state) => {
          // Don't add duplicate machines
          if (state.machines.some((m) => m.agentId === machine.agentId)) {
            return state;
          }
          return {
            machines: [
              ...state.machines,
              {
                ...machine,
                addedAt: Date.now(),
                lastConnectedAt: null,
                lastRepoPath: null,
                isPro: false,
              },
            ],
          };
        }),

      updateMachine: (agentId, updates) =>
        set((state) => ({
          machines: state.machines.map((m) =>
            m.agentId === agentId ? { ...m, ...updates } : m
          ),
        })),

      removeMachine: (agentId) =>
        set((state) => ({
          machines: state.machines.filter((m) => m.agentId !== agentId),
        })),

      recordConnection: (agentId, repoPath, isPro) =>
        set((state) => ({
          machines: state.machines.map((m) =>
            m.agentId === agentId
              ? { ...m, lastConnectedAt: Date.now(), lastRepoPath: repoPath, isPro }
              : m
          ),
        })),

      getMachine: (agentId) => get().machines.find((m) => m.agentId === agentId),

      hasMachine: (agentId) => get().machines.some((m) => m.agentId === agentId),
    }),
    {
      name: 'quicksave-machines',
      version: 1,
    }
  )
);

// Selectors
export const selectSortedMachines = (state: MachineStore): Machine[] =>
  [...state.machines].sort((a, b) => {
    // Sort by: recently connected first, then by name
    if (a.lastConnectedAt && b.lastConnectedAt) {
      return b.lastConnectedAt - a.lastConnectedAt;
    }
    if (a.lastConnectedAt) return -1;
    if (b.lastConnectedAt) return 1;
    return a.nickname.localeCompare(b.nickname);
  });

export const selectRecentMachines = (limit: number) => (state: MachineStore): Machine[] =>
  [...state.machines]
    .filter((m) => m.lastConnectedAt !== null)
    .sort((a, b) => (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0))
    .slice(0, limit);
