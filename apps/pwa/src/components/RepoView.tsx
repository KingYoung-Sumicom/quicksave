import { useEffect, useCallback } from 'react';
import {
  useGitStore,
  selectStagedFiles,
  selectUnstagedFiles,
  selectUntrackedFiles,
  selectHasSelection,
  selectSelectionSummary,
  type LineSelection,
} from '../stores/gitStore';
import type { FileDiff } from '@quicksave/shared';
import { FileList } from './FileList';
import { CommitForm } from './CommitForm';
import { FloatingActionButton } from './FloatingActionButton';

interface RepoViewProps {
  onRefresh: () => void;
  onFetchDiff: (path: string, staged: boolean) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onStagePatch: (patch: string) => void;
  onUnstagePatch: (patch: string) => void;
  onDiscard: (paths: string[]) => void;
  onCommit: (message: string, description?: string) => Promise<void>;
}

// Helper to generate a patch from selected lines
function generatePatch(
  path: string,
  diff: FileDiff,
  selectedLines: LineSelection[]
): string {
  if (selectedLines.length === 0) return '';

  const lines: string[] = [];
  lines.push(`diff --git a/${path} b/${path}`);
  lines.push(`--- a/${path}`);
  lines.push(`+++ b/${path}`);

  // Group selected lines by hunk
  const linesByHunk = new Map<number, LineSelection[]>();
  for (const line of selectedLines) {
    const existing = linesByHunk.get(line.hunkIndex) || [];
    existing.push(line);
    linesByHunk.set(line.hunkIndex, existing);
  }

  // Process each hunk that has selected lines
  for (const [hunkIndex, hunkSelectedLines] of linesByHunk.entries()) {
    const hunk = diff.hunks[hunkIndex];
    if (!hunk) continue;

    const hunkLines = hunk.content.split('\n');
    const selectedLineIndices = new Set(hunkSelectedLines.map(l => l.lineIndex));

    // Build the new hunk with only selected changes + context
    const newHunkLines: string[] = [];
    let oldLineCount = 0;
    let newLineCount = 0;

    for (let i = 0; i < hunkLines.length; i++) {
      const line = hunkLines[i];
      if (line.startsWith('@@')) continue;

      const lineType = line.charAt(0);

      if (lineType === '+') {
        if (selectedLineIndices.has(i)) {
          newHunkLines.push(line);
          newLineCount++;
        }
      } else if (lineType === '-') {
        if (selectedLineIndices.has(i)) {
          newHunkLines.push(line);
          oldLineCount++;
        } else {
          // Convert unselected removals to context
          newHunkLines.push(' ' + line.slice(1));
          oldLineCount++;
          newLineCount++;
        }
      } else {
        // Context line
        newHunkLines.push(line);
        oldLineCount++;
        newLineCount++;
      }
    }

    if (newHunkLines.length > 0) {
      lines.push(`@@ -${hunk.oldStart},${oldLineCount} +${hunk.newStart},${newLineCount} @@`);
      lines.push(...newHunkLines);
    }
  }

  return lines.join('\n') + '\n';
}

export function RepoView({
  onRefresh,
  onFetchDiff,
  onStage,
  onUnstage,
  onStagePatch,
  onUnstagePatch,
  onDiscard: _onDiscard,
  onCommit,
}: RepoViewProps) {
  // TODO: Add discard UI (onDiscard will be used in future)
  void _onDiscard;
  const {
    expandedDiffs,
    loadingDiffs,
    toggleFileExpanded,
    collapseFile,
    isLoading,
    error,
    selectedFiles,
    selectedLines,
    selectionSource,
    isSelectionOperationPending,
    toggleFileSelection,
    toggleLineSelection,
    selectAllFiles,
    clearSelection,
    setSelectionOperationPending,
  } = useGitStore();
  const staged = useGitStore(selectStagedFiles);
  const unstaged = useGitStore(selectUnstagedFiles);
  const untracked = useGitStore(selectUntrackedFiles);
  const hasSelection = useGitStore(selectHasSelection);
  const selectionSummary = useGitStore(selectSelectionSummary);

  // Refresh on mount
  useEffect(() => {
    onRefresh();
  }, [onRefresh]);

  const handleFileClick = (path: string, isStaged: boolean) => {
    const needsFetch = toggleFileExpanded(path);
    if (needsFetch) {
      onFetchDiff(path, isStaged);
    }
  };

  const handleCloseDiff = (path: string) => {
    collapseFile(path);
  };

  // Handle selection action (stage/unstage)
  const handleSelectionAction = useCallback(async () => {
    if (!selectionSource) return;

    setSelectionOperationPending(true);
    try {
      // If there are selected files, stage/unstage them
      if (selectedFiles.size > 0) {
        const paths = Array.from(selectedFiles);
        if (selectionSource === 'staged') {
          await onUnstage(paths);
        } else {
          await onStage(paths);
        }
      }

      // If there are selected lines, generate and apply patches
      if (selectedLines.size > 0) {
        for (const [path, lines] of selectedLines.entries()) {
          const diff = expandedDiffs[path];
          if (!diff) continue;

          const patch = generatePatch(path, diff, lines);
          if (patch) {
            if (selectionSource === 'staged') {
              await onUnstagePatch(patch);
            } else {
              await onStagePatch(patch);
            }
          }
        }
      }

      clearSelection();
    } finally {
      setSelectionOperationPending(false);
    }
  }, [
    selectionSource,
    selectedFiles,
    selectedLines,
    expandedDiffs,
    onStage,
    onUnstage,
    onStagePatch,
    onUnstagePatch,
    clearSelection,
    setSelectionOperationPending,
  ]);

  const totalChanges = staged.length + unstaged.length + untracked.length;

  return (
    <div className="flex-1 overflow-auto safe-area-bottom">
      <div className="p-4 space-y-4">
        {/* Error Display */}
        {error && (
          <div className="p-3 bg-red-500/20 border border-red-500/50 rounded-lg">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {/* Loading Indicator */}
        {isLoading && (
          <div className="flex items-center justify-center py-4">
            <div className="flex gap-1">
              <span className="loading-dot w-2 h-2 bg-blue-500 rounded-full" />
              <span className="loading-dot w-2 h-2 bg-blue-500 rounded-full" />
              <span className="loading-dot w-2 h-2 bg-blue-500 rounded-full" />
            </div>
          </div>
        )}

        {/* No Changes */}
        {!isLoading && totalChanges === 0 && (
          <div className="text-center py-12">
            <svg
              className="w-16 h-16 mx-auto text-slate-600 mb-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <h3 className="text-lg font-medium text-slate-300 mb-1">Working tree clean</h3>
            <p className="text-sm text-slate-500">No changes to commit</p>
            <button
              onClick={onRefresh}
              className="mt-4 px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-md text-sm transition-colors"
            >
              Refresh
            </button>
          </div>
        )}

        {/* Staged Files */}
        <FileList
          title="Staged"
          files={staged}
          type="staged"
          onFileClick={(path) => handleFileClick(path, true)}
          onAction={onUnstage}
          actionLabel="Unstage"
          expandedDiffs={expandedDiffs}
          loadingDiffs={loadingDiffs}
          onCloseDiff={handleCloseDiff}
          selectedFiles={selectedFiles}
          selectedLines={selectedLines}
          onToggleFileSelection={toggleFileSelection}
          onToggleLineSelection={toggleLineSelection}
          onSelectAllFiles={selectAllFiles}
        />

        {/* Unstaged Files */}
        <FileList
          title="Changed"
          files={unstaged}
          type="unstaged"
          onFileClick={(path) => handleFileClick(path, false)}
          onAction={onStage}
          actionLabel="Stage"
          expandedDiffs={expandedDiffs}
          loadingDiffs={loadingDiffs}
          onCloseDiff={handleCloseDiff}
          selectedFiles={selectedFiles}
          selectedLines={selectedLines}
          onToggleFileSelection={toggleFileSelection}
          onToggleLineSelection={toggleLineSelection}
          onSelectAllFiles={selectAllFiles}
        />

        {/* Untracked Files */}
        <FileList
          title="Untracked"
          files={untracked.map((path) => ({ path, status: 'added' as const }))}
          type="untracked"
          onFileClick={(path) => handleFileClick(path, false)}
          onAction={onStage}
          actionLabel="Stage"
          expandedDiffs={expandedDiffs}
          loadingDiffs={loadingDiffs}
          onCloseDiff={handleCloseDiff}
          selectedFiles={selectedFiles}
          selectedLines={selectedLines}
          onToggleFileSelection={toggleFileSelection}
          onToggleLineSelection={toggleLineSelection}
          onSelectAllFiles={selectAllFiles}
        />

        {/* Commit Form */}
        <CommitForm onCommit={onCommit} stagedCount={staged.length} />

        {/* Refresh Button */}
        {totalChanges > 0 && (
          <div className="text-center pt-4">
            <button
              onClick={onRefresh}
              disabled={isLoading}
              className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors"
            >
              ↻ Refresh
            </button>
          </div>
        )}
      </div>

      {/* Floating Action Button for Selection */}
      <FloatingActionButton
        hasSelection={hasSelection}
        selectionSummary={selectionSummary}
        selectionSource={selectionSource}
        isLoading={isSelectionOperationPending}
        onAction={handleSelectionAction}
        onClear={clearSelection}
      />
    </div>
  );
}
