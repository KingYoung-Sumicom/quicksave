import { create } from 'zustand';
import type { GitStatus, FileDiff, Commit, Branch, FileChange, ClaudeModel } from '@quicksave/shared';

export type SelectionSource = 'staged' | 'unstaged' | 'untracked';

export interface LineSelection {
  hunkIndex: number;
  lineIndex: number; // Index within the hunk content
  type: 'add' | 'remove';
  content: string;
}

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

  // AI Summary state
  aiSummary: string | null;
  aiDescription: string | null;
  isGeneratingAiSummary: boolean;
  aiSummaryError: string | null;
  selectedModel: ClaudeModel;
  apiKeyConfigured: boolean;

  // Selection state
  selectedFiles: Set<string>;
  selectedLines: Map<string, LineSelection[]>; // path -> selected lines
  selectionSource: SelectionSource | null;
  isSelectionOperationPending: boolean;

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

  // AI Summary actions
  setAiSummary: (summary: string | null, description?: string | null) => void;
  setGeneratingAiSummary: (loading: boolean) => void;
  setAiSummaryError: (error: string | null) => void;
  clearAiSummary: () => void;
  applyAiSummary: () => void;
  setSelectedModel: (model: ClaudeModel) => void;
  setApiKeyConfigured: (configured: boolean) => void;

  // Selection actions
  toggleFileSelection: (path: string, source: SelectionSource) => void;
  toggleLineSelection: (path: string, line: LineSelection, source: SelectionSource) => void;
  selectAllFiles: (paths: string[], source: SelectionSource) => void;
  clearSelection: () => void;
  setSelectionOperationPending: (pending: boolean) => void;
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

  // AI Summary state
  aiSummary: null,
  aiDescription: null,
  isGeneratingAiSummary: false,
  aiSummaryError: null,
  selectedModel: 'claude-sonnet-4-20250514',
  apiKeyConfigured: false,

  // Selection state
  selectedFiles: new Set(),
  selectedLines: new Map(),
  selectionSource: null,
  isSelectionOperationPending: false,

  // Actions
  setStatus: (status) => {
    // Clear selection when status changes to avoid stale selections
    set({ status, error: null, selectedFiles: new Set(), selectedLines: new Map(), selectionSource: null });
  },

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

  // AI Summary actions
  setAiSummary: (summary, description) =>
    set({ aiSummary: summary, aiDescription: description ?? null, aiSummaryError: null }),

  setGeneratingAiSummary: (loading) => set({ isGeneratingAiSummary: loading }),

  setAiSummaryError: (error) => set({ aiSummaryError: error, isGeneratingAiSummary: false }),

  clearAiSummary: () => set({ aiSummary: null, aiDescription: null, aiSummaryError: null }),

  applyAiSummary: () => {
    const { aiSummary, aiDescription } = get();
    if (aiSummary) {
      set({
        commitMessage: aiSummary,
        commitDescription: aiDescription ?? '',
        aiSummary: null,
        aiDescription: null,
      });
    }
  },

  setSelectedModel: (model) => set({ selectedModel: model }),

  setApiKeyConfigured: (configured) => set({ apiKeyConfigured: configured }),

  // Selection actions
  toggleFileSelection: (path, source) => {
    const { selectedFiles, selectionSource } = get();

    // If selecting from a different source, clear existing selection
    if (selectionSource !== null && selectionSource !== source) {
      set({
        selectedFiles: new Set([path]),
        selectedLines: new Map(),
        selectionSource: source,
      });
      return;
    }

    const newSelectedFiles = new Set(selectedFiles);
    if (newSelectedFiles.has(path)) {
      newSelectedFiles.delete(path);
    } else {
      newSelectedFiles.add(path);
    }

    // Clear selection source if no files selected
    const newSource = newSelectedFiles.size === 0 ? null : source;
    set({ selectedFiles: newSelectedFiles, selectionSource: newSource });
  },

  toggleLineSelection: (path, line, source) => {
    const { selectedLines, selectionSource, selectedFiles } = get();

    // If selecting from a different source, clear existing selection
    if (selectionSource !== null && selectionSource !== source) {
      const newLines = new Map<string, LineSelection[]>();
      newLines.set(path, [line]);
      set({
        selectedFiles: new Set(),
        selectedLines: newLines,
        selectionSource: source,
      });
      return;
    }

    const newSelectedLines = new Map(selectedLines);
    const pathLines = newSelectedLines.get(path) || [];

    // Check if this line is already selected
    const existingIndex = pathLines.findIndex(
      l => l.hunkIndex === line.hunkIndex && l.lineIndex === line.lineIndex
    );

    if (existingIndex >= 0) {
      // Remove the line
      const newPathLines = [...pathLines];
      newPathLines.splice(existingIndex, 1);
      if (newPathLines.length === 0) {
        newSelectedLines.delete(path);
      } else {
        newSelectedLines.set(path, newPathLines);
      }
    } else {
      // Add the line
      newSelectedLines.set(path, [...pathLines, line]);
    }

    // Clear selection source if no lines and no files selected
    const hasSelection = newSelectedLines.size > 0 || selectedFiles.size > 0;
    const newSource = hasSelection ? source : null;
    set({ selectedLines: newSelectedLines, selectionSource: newSource });
  },

  selectAllFiles: (paths, source) => {
    const { selectedFiles, selectionSource } = get();

    // If selecting from a different source, just select the new files
    if (selectionSource !== null && selectionSource !== source) {
      set({
        selectedFiles: new Set(paths),
        selectedLines: new Map(),
        selectionSource: source,
      });
      return;
    }

    // Check if all files are already selected
    const allSelected = paths.every(p => selectedFiles.has(p));

    if (allSelected) {
      // Deselect all from this source
      const newSelectedFiles = new Set(selectedFiles);
      paths.forEach(p => newSelectedFiles.delete(p));
      const newSource = newSelectedFiles.size === 0 ? null : source;
      set({ selectedFiles: newSelectedFiles, selectionSource: newSource });
    } else {
      // Select all
      const newSelectedFiles = new Set(selectedFiles);
      paths.forEach(p => newSelectedFiles.add(p));
      set({ selectedFiles: newSelectedFiles, selectionSource: source });
    }
  },

  clearSelection: () => set({
    selectedFiles: new Set(),
    selectedLines: new Map(),
    selectionSource: null,
  }),

  setSelectionOperationPending: (pending) => set({ isSelectionOperationPending: pending }),

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
      aiSummary: null,
      aiDescription: null,
      isGeneratingAiSummary: false,
      aiSummaryError: null,
      selectedModel: 'claude-sonnet-4-20250514',
      // Note: apiKeyConfigured is not reset as it's a global setting
      selectedFiles: new Set(),
      selectedLines: new Map(),
      selectionSource: null,
      isSelectionOperationPending: false,
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

// Selection selectors
export const selectHasSelection = (state: GitStore): boolean => {
  return state.selectedFiles.size > 0 || state.selectedLines.size > 0;
};

export const selectTotalSelectedCount = (state: GitStore): number => {
  let count = state.selectedFiles.size;
  state.selectedLines.forEach((lines) => {
    count += lines.length;
  });
  return count;
};

export const selectSelectionSummary = (state: GitStore): string => {
  const fileCount = state.selectedFiles.size;
  let lineCount = 0;
  state.selectedLines.forEach((lines) => {
    lineCount += lines.length;
  });

  const parts: string[] = [];
  if (fileCount > 0) {
    parts.push(`${fileCount} file${fileCount !== 1 ? 's' : ''}`);
  }
  if (lineCount > 0) {
    parts.push(`${lineCount} line${lineCount !== 1 ? 's' : ''}`);
  }

  return parts.join(', ');
};
