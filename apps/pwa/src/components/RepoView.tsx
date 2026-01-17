import { useEffect } from 'react';
import { useGitStore, selectStagedFiles, selectUnstagedFiles, selectUntrackedFiles } from '../stores/gitStore';
import { FileList } from './FileList';
import { CommitForm } from './CommitForm';

interface RepoViewProps {
  onRefresh: () => void;
  onFetchDiff: (path: string, staged: boolean) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onDiscard: (paths: string[]) => void;
  onCommit: (message: string, description?: string) => Promise<void>;
}

export function RepoView({
  onRefresh,
  onFetchDiff,
  onStage,
  onUnstage,
  onDiscard: _onDiscard,
  onCommit,
}: RepoViewProps) {
  // TODO: Add discard UI (onDiscard will be used in future)
  void _onDiscard;
  const { expandedDiffs, loadingDiffs, toggleFileExpanded, collapseFile, isLoading, error } = useGitStore();
  const staged = useGitStore(selectStagedFiles);
  const unstaged = useGitStore(selectUnstagedFiles);
  const untracked = useGitStore(selectUntrackedFiles);

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
    </div>
  );
}
