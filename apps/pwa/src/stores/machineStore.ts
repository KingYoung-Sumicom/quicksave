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
  // Core identity (synced)
  agentId: string;
  publicKey: string;
  signPublicKey?: string;

  // User-friendly metadata (synced)
  nickname: string;
  icon: string;

  // Last modification to synced fields. Used for LWW merge between devices.
  updatedAt: number;

  // Connection metadata (local-only, not synced)
  addedAt: number;
  lastConnectedAt: number | null;
  lastRepoPath: string | null;
  knownRepos: string[];
  knownCodingPaths: string[];
  isPro: boolean;

  // Cached project summaries keyed by cwd (local-only, not synced)
  cachedProjects: Record<string, CachedProjectData>;
}

/** Fields that participate in device-to-device sync. Changes here bump updatedAt. */
const SYNCED_MACHINE_FIELDS = new Set<keyof Machine>([
  'publicKey',
  'signPublicKey',
  'nickname',
  'icon',
]);

/** Keep tombstones this long before garbage-collecting. */
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface MachineStore {
  // State
  machines: Machine[];
  /** agentId → deletedAt (ms). Pruned after TOMBSTONE_TTL_MS. */
  machineTombstones: Record<string, number>;

  // Actions
  addMachine: (machine: Pick<Machine, 'agentId' | 'publicKey' | 'nickname' | 'icon'> & { signPublicKey?: string }) => void;
  updateMachine: (agentId: string, updates: Partial<Omit<Machine, 'agentId'>>) => void;
  removeMachine: (agentId: string) => void;
  recordConnection: (agentId: string, repoPath: string, isPro: boolean, availableRepos?: string[], availableCodingPaths?: string[]) => void;
  addKnownRepo: (agentId: string, repoPath: string) => void;
  addKnownCodingPath: (agentId: string, codingPath: string) => void;
  syncKnownRepos: (agentId: string, repoPaths: string[]) => void;
  overwriteMachines: (machines: Machine[]) => void;
  getMachine: (agentId: string) => Machine | undefined;
  hasMachine: (agentId: string) => boolean;
  cacheProjectData: (agentId: string, cwd: string, data: CachedProjectData) => void;
  cacheAllProjects: (agentId: string, projects: Array<{ cwd: string } & CachedProjectData>, managedPaths?: string[]) => void;
  cacheProjectRepos: (agentId: string, cwd: string, repos: CachedRepoInfo[]) => void;
  removeProject: (agentId: string, cwd: string) => void;
  pruneTombstones: () => void;
  /**
   * Replace the synced slices (machines, machineTombstones) in one atomic
   * update. Used after merging a remote sync payload.
   */
  applySyncedState: (state: {
    machines: Machine[];
    machineTombstones: Record<string, number>;
  }) => void;
}

export const useMachineStore = create<MachineStore>()(
  persist(
    (set, get) => ({
      machines: [],
      machineTombstones: {},

      addMachine: (machine) =>
        set((state) => {
          if (state.machines.some((m) => m.agentId === machine.agentId)) {
            return state;
          }
          const now = Date.now();
          // Clear any prior tombstone — re-adding this agentId revives it.
          const { [machine.agentId]: _deleted, ...remainingTombstones } = state.machineTombstones;
          return {
            machines: [
              ...state.machines,
              {
                ...machine,
                addedAt: now,
                updatedAt: now,
                lastConnectedAt: null,
                lastRepoPath: null,
                knownRepos: [],
                knownCodingPaths: [],
                isPro: false,
                cachedProjects: {},
              },
            ],
            machineTombstones: remainingTombstones,
          };
        }),

      updateMachine: (agentId, updates) =>
        set((state) => {
          const touchesSynced = Object.keys(updates).some((k) =>
            SYNCED_MACHINE_FIELDS.has(k as keyof Machine)
          );
          return {
            machines: state.machines.map((m) =>
              m.agentId === agentId
                ? { ...m, ...updates, ...(touchesSynced ? { updatedAt: Date.now() } : {}) }
                : m
            ),
          };
        }),

      removeMachine: (agentId) =>
        set((state) => ({
          machines: state.machines.filter((m) => m.agentId !== agentId),
          machineTombstones: {
            ...state.machineTombstones,
            [agentId]: Date.now(),
          },
        })),

      recordConnection: (agentId, repoPath, isPro, availableRepos, availableCodingPaths) =>
        set((state) => ({
          machines: state.machines.map((m) => {
            if (m.agentId !== agentId) return m;

            const existingRepos = m.knownRepos || [];
            const newRepos = availableRepos || [];
            const allRepos = [...new Set([...existingRepos, ...newRepos, repoPath])];

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

      addKnownCodingPath: (agentId, codingPath) =>
        set((state) => ({
          machines: state.machines.map((m) =>
            m.agentId === agentId && !m.knownCodingPaths?.includes(codingPath)
              ? { ...m, knownCodingPaths: [...(m.knownCodingPaths || []), codingPath] }
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
            // Only store session-bearing projects in cachedProjects. 0-session
            // managed paths are surfaced via knownCodingPaths in useProjects.
            const cached: Record<string, CachedProjectData> = {};
            for (const p of projects) {
              if (p.sessionCount > 0) {
                cached[p.cwd] = {
                  lastActivityAt: p.lastActivityAt,
                  sessionCount: p.sessionCount,
                  lastSessionTitle: p.lastSessionTitle,
                };
              }
            }
            // Rebuild knownCodingPaths from the agent's authoritative view:
            // every project it knows about (sessions + managed). This prunes
            // stale paths the agent has forgotten while preserving managed
            // paths even when they have no sessions.
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

      applySyncedState: (next) =>
        set(() => ({
          machines: next.machines,
          machineTombstones: next.machineTombstones,
        })),

      pruneTombstones: () =>
        set((state) => {
          const cutoff = Date.now() - TOMBSTONE_TTL_MS;
          const kept: Record<string, number> = {};
          for (const [agentId, deletedAt] of Object.entries(state.machineTombstones)) {
            if (deletedAt >= cutoff) kept[agentId] = deletedAt;
          }
          return { machineTombstones: kept };
        }),
    }),
    {
      name: 'quicksave-machines',
      version: 5,
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as {
          machines: Machine[];
          pinnedProjects?: unknown;
          machineTombstones?: Record<string, number>;
        };
        if (version < 2) {
          state.machines = state.machines.map((m) => ({
            ...m,
            knownCodingPaths: (m as Machine).knownCodingPaths || [],
          }));
        }
        if (version < 3) {
          state.machines = state.machines.map((m) => ({
            ...m,
            cachedProjects: (m as Machine).cachedProjects || {},
          }));
        }
        if (version < 4) {
          state.machines = state.machines.map((m) => ({
            ...m,
            updatedAt: (m as Machine).updatedAt ?? m.addedAt ?? 0,
          }));
          state.machineTombstones = state.machineTombstones || {};
        }
        if (version < 5) {
          delete state.pinnedProjects;
        }
        return state;
      },
    }
  )
);

// Selectors
export const selectSortedMachines = (state: MachineStore): Machine[] =>
  [...state.machines].sort((a, b) => {
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
