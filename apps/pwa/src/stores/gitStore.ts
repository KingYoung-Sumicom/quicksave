import { create } from 'zustand';
import type { GitStatus, FileDiff, Commit, Branch, FileChange } from '@quicksave/shared';

interface GitStore {
  // State
  status: GitStatus | null;
  expandedDiffs: Record<string, FileDiff>; // Map of path -> diff for expanded files
  loadingDiffs: Set<string>; // Paths currently being fetched
  commits: Commit[];
  branches: Branch[];
  currentBranch: string | null;
  isLoading: boolean;
  error: string | null;

  // Commit form
  commitMessage: string;
  commitDescription: string;

  // Actions
  setStatus: (status: GitStatus) => void;
  toggleFileExpanded: (path: string) => boolean; // Returns true if now expanded (needs fetch)
  setFileDiff: (path: string, diff: FileDiff) => void;
  setDiffLoading: (path: string, loading: boolean) => void;
  collapseFile: (path: string) => void;
  setCommits: (commits: Commit[]) => void;
  setBranches: (branches: Branch[], current: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setCommitMessage: (message: string) => void;
  setCommitDescription: (description: string) => void;
  clearCommitForm: () => void;
  reset: () => void;
}

export const useGitStore = create<GitStore>((set, get) => ({
  // Initial state
  status: null,
  expandedDiffs: {},
  loadingDiffs: new Set(),
  commits: [],
  branches: [],
  currentBranch: null,
  isLoading: false,
  error: null,
  commitMessage: '',
  commitDescription: '',

  // Actions
  setStatus: (status) => set({ status, error: null }),

  toggleFileExpanded: (path) => {
    const { expandedDiffs } = get();
    if (path in expandedDiffs) {
      // Collapse - remove from expanded
      const newExpanded = { ...expandedDiffs };
      delete newExpanded[path];
      set({ expandedDiffs: newExpanded });
      return false;
    }
    // Expand - will need to fetch diff
    return true;
  },

  setFileDiff: (path, diff) => {
    const { expandedDiffs, loadingDiffs } = get();
    const newLoading = new Set(loadingDiffs);
    newLoading.delete(path);
    set({
      expandedDiffs: { ...expandedDiffs, [path]: diff },
      loadingDiffs: newLoading,
    });
  },

  setDiffLoading: (path, loading) => {
    const { loadingDiffs } = get();
    const newLoading = new Set(loadingDiffs);
    if (loading) {
      newLoading.add(path);
    } else {
      newLoading.delete(path);
    }
    set({ loadingDiffs: newLoading });
  },

  collapseFile: (path) => {
    const { expandedDiffs } = get();
    const newExpanded = { ...expandedDiffs };
    delete newExpanded[path];
    set({ expandedDiffs: newExpanded });
  },

  setCommits: (commits) => set({ commits }),

  setBranches: (branches, current) => set({ branches, currentBranch: current }),

  setLoading: (loading) => set({ isLoading: loading }),

  setError: (error) => set({ error }),

  setCommitMessage: (message) => set({ commitMessage: message }),

  setCommitDescription: (description) => set({ commitDescription: description }),

  clearCommitForm: () => set({ commitMessage: '', commitDescription: '' }),

  reset: () =>
    set({
      status: null,
      expandedDiffs: {},
      loadingDiffs: new Set(),
      commits: [],
      branches: [],
      currentBranch: null,
      isLoading: false,
      error: null,
      commitMessage: '',
      commitDescription: '',
    }),
}));

// Selectors
export const selectStagedFiles = (state: GitStore): FileChange[] =>
  state.status?.staged ?? [];

export const selectUnstagedFiles = (state: GitStore): FileChange[] =>
  state.status?.unstaged ?? [];

export const selectUntrackedFiles = (state: GitStore): string[] =>
  state.status?.untracked ?? [];

export const selectTotalChanges = (state: GitStore): number => {
  if (!state.status) return 0;
  return (
    state.status.staged.length +
    state.status.unstaged.length +
    state.status.untracked.length
  );
};

export const selectCanCommit = (state: GitStore): boolean => {
  return (
    state.status !== null &&
    state.status.staged.length > 0 &&
    state.commitMessage.trim().length > 0
  );
};
