import { create } from 'zustand';
import type { GitStatus, FileDiff, Commit, Branch, FileChange, ClaudeModel, TokenUsage } from '@quicksave/shared';

export type SelectionSource = 'staged' | 'unstaged' | 'untracked';

export interface LineSelection {
  hunkIndex: number;
  lineIndex: number; // Index within the hunk content
  type: 'add' | 'remove';
  content: string;
}

// Composite key for file selection that includes source to handle partially staged files
export type SelectionKey = `${string}:${SelectionSource}`;

export function makeSelectionKey(path: string, source: SelectionSource): SelectionKey {
  return `${path}:${source}`;
}

export function parseSelectionKey(key: SelectionKey): { path: string; source: SelectionSource } {
  const lastColonIndex = key.lastIndexOf(':');
  return {
    path: key.slice(0, lastColonIndex),
    source: key.slice(lastColonIndex + 1) as SelectionSource,
  };
}

interface GitStore {
  // State
  status: GitStatus | null;
  expandedDiffs: Record<SelectionKey, FileDiff>; // Map of key (path:source) -> diff for expanded files
  loadingDiffs: Set<SelectionKey>; // Keys currently being fetched
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
  aiTokenUsage: TokenUsage | null;
  aiResultCached: boolean;

  // Selection state - keys are composite (path:source) to handle partially staged files
  selectedFiles: Set<SelectionKey>;
  selectedLines: Map<SelectionKey, LineSelection[]>; // key -> selected lines
  selectionSource: SelectionSource | null;
  isSelectionOperationPending: boolean;

  // Actions
  setStatus: (status: GitStatus) => void;
  toggleFileExpanded: (key: SelectionKey) => boolean; // Returns true if now expanded (needs fetch)
  setFileDiff: (key: SelectionKey, diff: FileDiff) => void;
  setDiffLoading: (key: SelectionKey, loading: boolean) => void;
  collapseFile: (key: SelectionKey) => void;
  setCommits: (commits: Commit[]) => void;
  setBranches: (branches: Branch[], current: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setCommitMessage: (message: string) => void;
  setCommitDescription: (description: string) => void;
  clearCommitForm: () => void;
  reset: () => void;

  // AI Summary actions
  setAiSummary: (summary: string | null, description?: string | null, tokenUsage?: TokenUsage | null, cached?: boolean) => void;
  setGeneratingAiSummary: (loading: boolean) => void;
  setAiSummaryError: (error: string | null) => void;
  clearAiSummary: () => void;
  applyAiSummary: () => void;
  setSelectedModel: (model: ClaudeModel) => void;
  setApiKeyConfigured: (configured: boolean) => void;

  // Selection actions - use composite keys internally
  toggleFileSelection: (key: SelectionKey, source: SelectionSource) => void;
  toggleLineSelection: (key: SelectionKey, line: LineSelection, source: SelectionSource) => void;
  selectAllFiles: (keys: SelectionKey[], source: SelectionSource) => void;
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
  selectedModel: 'claude-haiku-4-5',
  apiKeyConfigured: false,
  aiTokenUsage: null,
  aiResultCached: false,

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

  toggleFileExpanded: (key) => {
    const { expandedDiffs } = get();
    if (key in expandedDiffs) {
      // Collapse - remove from expanded
      const newExpanded = { ...expandedDiffs };
      delete newExpanded[key];
      set({ expandedDiffs: newExpanded });
      return false;
    }
    // Expand - will need to fetch diff
    return true;
  },

  setFileDiff: (key, diff) => {
    const { expandedDiffs, loadingDiffs } = get();
    const newLoading = new Set(loadingDiffs);
    newLoading.delete(key);
    set({
      expandedDiffs: { ...expandedDiffs, [key]: diff },
      loadingDiffs: newLoading,
    });
  },

  setDiffLoading: (key, loading) => {
    const { loadingDiffs } = get();
    const newLoading = new Set(loadingDiffs);
    if (loading) {
      newLoading.add(key);
    } else {
      newLoading.delete(key);
    }
    set({ loadingDiffs: newLoading });
  },

  collapseFile: (key) => {
    const { expandedDiffs } = get();
    const newExpanded = { ...expandedDiffs };
    delete newExpanded[key];
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
  setAiSummary: (summary, description, tokenUsage, cached) =>
    set({
      aiSummary: summary,
      aiDescription: description ?? null,
      aiSummaryError: null,
      aiTokenUsage: tokenUsage ?? null,
      aiResultCached: cached ?? false,
    }),

  setGeneratingAiSummary: (loading) => set({ isGeneratingAiSummary: loading }),

  setAiSummaryError: (error) => set({
    aiSummaryError: error,
    // Only stop generating if there's an actual error
    ...(error !== null && { isGeneratingAiSummary: false })
  }),

  clearAiSummary: () => set({ aiSummary: null, aiDescription: null, aiSummaryError: null, aiTokenUsage: null, aiResultCached: false }),

  applyAiSummary: () => {
    const { aiSummary, aiDescription } = get();
    if (aiSummary) {
      set({
        commitMessage: aiSummary,
        commitDescription: aiDescription ?? '',
        aiSummary: null,
        aiDescription: null,
        aiTokenUsage: null,
        aiResultCached: false,
      });
    }
  },

  setSelectedModel: (model) => set({ selectedModel: model }),

  setApiKeyConfigured: (configured) => set({ apiKeyConfigured: configured }),

  // Selection actions - now use composite keys (path:source)
  toggleFileSelection: (key, source) => {
    const { selectedFiles, selectionSource } = get();

    // If selecting from a different source, clear existing selection
    if (selectionSource !== null && selectionSource !== source) {
      set({
        selectedFiles: new Set([key]),
        selectedLines: new Map(),
        selectionSource: source,
      });
      return;
    }

    const newSelectedFiles = new Set(selectedFiles);
    if (newSelectedFiles.has(key)) {
      newSelectedFiles.delete(key);
    } else {
      newSelectedFiles.add(key);
    }

    // Clear selection source if no files selected
    const newSource = newSelectedFiles.size === 0 ? null : source;
    set({ selectedFiles: newSelectedFiles, selectionSource: newSource });
  },

  toggleLineSelection: (key, line, source) => {
    const { selectedLines, selectionSource, selectedFiles } = get();

    // If selecting from a different source, clear existing selection
    if (selectionSource !== null && selectionSource !== source) {
      const newLines = new Map<SelectionKey, LineSelection[]>();
      newLines.set(key, [line]);
      set({
        selectedFiles: new Set(),
        selectedLines: newLines,
        selectionSource: source,
      });
      return;
    }

    const newSelectedLines = new Map(selectedLines);
    const keyLines = newSelectedLines.get(key) || [];

    // Check if this line is already selected
    const existingIndex = keyLines.findIndex(
      l => l.hunkIndex === line.hunkIndex && l.lineIndex === line.lineIndex
    );

    if (existingIndex >= 0) {
      // Remove the line
      const newKeyLines = [...keyLines];
      newKeyLines.splice(existingIndex, 1);
      if (newKeyLines.length === 0) {
        newSelectedLines.delete(key);
      } else {
        newSelectedLines.set(key, newKeyLines);
      }
    } else {
      // Add the line
      newSelectedLines.set(key, [...keyLines, line]);
    }

    // Clear selection source if no lines and no files selected
    const hasSelection = newSelectedLines.size > 0 || selectedFiles.size > 0;
    const newSource = hasSelection ? source : null;
    set({ selectedLines: newSelectedLines, selectionSource: newSource });
  },

  selectAllFiles: (keys, source) => {
    const { selectedFiles, selectionSource } = get();

    // If selecting from a different source, just select the new files
    if (selectionSource !== null && selectionSource !== source) {
      set({
        selectedFiles: new Set(keys),
        selectedLines: new Map(),
        selectionSource: source,
      });
      return;
    }

    // Check if all files are already selected
    const allSelected = keys.every(k => selectedFiles.has(k));

    if (allSelected) {
      // Deselect all from this source
      const newSelectedFiles = new Set(selectedFiles);
      keys.forEach(k => newSelectedFiles.delete(k));
      const newSource = newSelectedFiles.size === 0 ? null : source;
      set({ selectedFiles: newSelectedFiles, selectionSource: newSource });
    } else {
      // Select all
      const newSelectedFiles = new Set(selectedFiles);
      keys.forEach(k => newSelectedFiles.add(k));
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
      selectedModel: 'claude-haiku-4-5',
      aiTokenUsage: null,
      aiResultCached: false,
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
