import { create } from 'zustand';
import type { GitStatus, FileDiff, Commit, Branch, FileChange } from '@quicksave/shared';

interface GitStore {
  // State
  status: GitStatus | null;
  selectedFile: string | null;
  selectedDiff: FileDiff | null;
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
  setSelectedFile: (path: string | null) => void;
  setSelectedDiff: (diff: FileDiff | null) => void;
  setCommits: (commits: Commit[]) => void;
  setBranches: (branches: Branch[], current: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setCommitMessage: (message: string) => void;
  setCommitDescription: (description: string) => void;
  clearCommitForm: () => void;
  reset: () => void;
}

export const useGitStore = create<GitStore>((set) => ({
  // Initial state
  status: null,
  selectedFile: null,
  selectedDiff: null,
  commits: [],
  branches: [],
  currentBranch: null,
  isLoading: false,
  error: null,
  commitMessage: '',
  commitDescription: '',

  // Actions
  setStatus: (status) => set({ status, error: null }),

  setSelectedFile: (path) => set({ selectedFile: path }),

  setSelectedDiff: (diff) => set({ selectedDiff: diff }),

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
      selectedFile: null,
      selectedDiff: null,
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
