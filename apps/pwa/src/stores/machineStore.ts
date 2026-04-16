import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface CachedRepoInfo {
  path: string;
  name: string;
  currentBranch?: string;
  isSubmodule?: boolean;
}

export interface CachedProjectData {
  lastActivityAt: number;
  sessionCount: number;
  lastSessionTitle?: string;
  repos?: CachedRepoInfo[];
}

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
  knownRepos: string[];
  knownCodingPaths: string[];
  isPro: boolean;

  // Cached project summaries (keyed by cwd)
  cachedProjects: Record<string, CachedProjectData>;
}

interface MachineStore {
  // State
  machines: Machine[];
  pinnedProjects: string[]; // array of projectIds

  // Actions
  addMachine: (machine: Pick<Machine, 'agentId' | 'publicKey' | 'nickname' | 'icon'>) => void;
  updateMachine: (agentId: string, updates: Partial<Omit<Machine, 'agentId'>>) => void;
  removeMachine: (agentId: string) => void;
  recordConnection: (agentId: string, repoPath: string, isPro: boolean, availableRepos?: string[], availableCodingPaths?: string[]) => void;
  addKnownRepo: (agentId: string, repoPath: string) => void;
  syncKnownRepos: (agentId: string, repoPaths: string[]) => void;
  overwriteMachines: (machines: Machine[]) => void;
  getMachine: (agentId: string) => Machine | undefined;
  hasMachine: (agentId: string) => boolean;
  cacheProjectData: (agentId: string, cwd: string, data: CachedProjectData) => void;
  cacheAllProjects: (agentId: string, projects: Array<{ cwd: string } & CachedProjectData>, managedPaths?: string[]) => void;
  cacheProjectRepos: (agentId: string, cwd: string, repos: CachedRepoInfo[]) => void;
  pinProject: (projectId: string) => void;
  unpinProject: (projectId: string) => void;
  removeProject: (agentId: string, cwd: string) => void;
}

export const useMachineStore = create<MachineStore>()(
  persist(
    (set, get) => ({
      machines: [],
      pinnedProjects: [],

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
                knownRepos: [],
                knownCodingPaths: [],
                isPro: false,
                cachedProjects: {},
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

      recordConnection: (agentId, repoPath, isPro, availableRepos, availableCodingPaths) =>
        set((state) => ({
          machines: state.machines.map((m) => {
            if (m.agentId !== agentId) return m;

            // Merge available repos with existing known repos
            const existingRepos = m.knownRepos || [];
            const newRepos = availableRepos || [];
            const allRepos = [...new Set([...existingRepos, ...newRepos, repoPath])];

            // Merge coding paths
            const existingCodingPaths = m.knownCodingPaths || [];
            const newCodingPaths = availableCodingPaths || [];
            const allCodingPaths = [...new Set([...existingCodingPaths, ...newCodingPaths])];

            return {
              ...m,
              lastConnectedAt: Date.now(),
              lastRepoPath: repoPath,
              knownRepos: allRepos,
              knownCodingPaths: allCodingPaths,
              isPro,
            };
          }),
        })),

      addKnownRepo: (agentId, repoPath) =>
        set((state) => ({
          machines: state.machines.map((m) =>
            m.agentId === agentId && !m.knownRepos?.includes(repoPath)
              ? { ...m, knownRepos: [...(m.knownRepos || []), repoPath] }
              : m
          ),
        })),

      syncKnownRepos: (agentId, repoPaths) =>
        set((state) => ({
          machines: state.machines.map((m) => {
            if (m.agentId !== agentId) return m;
            const existingRepos = m.knownRepos || [];
            const allRepos = [...new Set([...existingRepos, ...repoPaths])];
            return { ...m, knownRepos: allRepos };
          }),
        })),

      overwriteMachines: (machines) => set({ machines }),

      getMachine: (agentId) => get().machines.find((m) => m.agentId === agentId),

      hasMachine: (agentId) => get().machines.some((m) => m.agentId === agentId),

      cacheProjectData: (agentId, cwd, data) =>
        set((state) => ({
          machines: state.machines.map((m) => {
            if (m.agentId !== agentId) return m;
            return {
              ...m,
              cachedProjects: { ...m.cachedProjects, [cwd]: data },
            };
          }),
        })),

      cacheAllProjects: (agentId, projects, managedPaths) =>
        set((state) => ({
          machines: state.machines.map((m) => {
            if (m.agentId !== agentId) return m;
            const cached: Record<string, CachedProjectData> = {};
            for (const p of projects) {
              cached[p.cwd] = {
                lastActivityAt: p.lastActivityAt,
                sessionCount: p.sessionCount,
                lastSessionTitle: p.lastSessionTitle,
              };
            }
            // Rebuild knownCodingPaths: only keep managed paths + paths with sessions.
            // This cleans up stale entries (e.g. test temp dirs no longer on the agent).
            const projectCwds = new Set(projects.map((p) => p.cwd));
            const managed = new Set(managedPaths || []);
            const allPaths = [...new Set([...projectCwds, ...managed])];
            return { ...m, cachedProjects: cached, knownCodingPaths: allPaths };
          }),
        })),

      cacheProjectRepos: (agentId, cwd, repos) =>
        set((state) => ({
          machines: state.machines.map((m) => {
            if (m.agentId !== agentId) return m;
            const existing = m.cachedProjects[cwd];
            return {
              ...m,
              cachedProjects: {
                ...m.cachedProjects,
                [cwd]: { ...existing, repos },
              },
            };
          }),
        })),

      pinProject: (projectId) =>
        set((state) => ({
          pinnedProjects: state.pinnedProjects.includes(projectId)
            ? state.pinnedProjects
            : [...state.pinnedProjects, projectId],
        })),

      unpinProject: (projectId) =>
        set((state) => ({
          pinnedProjects: state.pinnedProjects.filter((id) => id !== projectId),
        })),

      removeProject: (agentId, cwd) =>
        set((state) => ({
          machines: state.machines.map((m) => {
            if (m.agentId !== agentId) return m;
            const { [cwd]: _, ...remainingProjects } = m.cachedProjects;
            return {
              ...m,
              knownCodingPaths: m.knownCodingPaths.filter((p) => p !== cwd),
              cachedProjects: remainingProjects,
            };
          }),
        })),
    }),
    {
      name: 'quicksave-machines',
      version: 3,
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as { machines: Machine[]; pinnedProjects?: string[] };
        if (version < 2) {
          // Add knownCodingPaths to existing machines
          state.machines = state.machines.map((m) => ({
            ...m,
            knownCodingPaths: (m as Machine).knownCodingPaths || [],
          }));
        }
        if (version < 3) {
          // Add cachedProjects to existing machines + pinnedProjects to store
          state.machines = state.machines.map((m) => ({
            ...m,
            cachedProjects: (m as Machine).cachedProjects || {},
          }));
          state.pinnedProjects = state.pinnedProjects || [];
        }
        return state;
      },
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
