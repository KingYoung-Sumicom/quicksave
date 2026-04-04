import { useState, useEffect, useCallback } from 'react';
import { clsx } from 'clsx';
import type { Repository, ListReposResponsePayload, BrowseDirectoryResponsePayload, DirectoryEntry } from '@sumicom/quicksave-shared';
import { useConnectionStore } from '../stores/connectionStore';

interface RepoSwitcherProps {
  isOpen: boolean;
  onClose: () => void;
  onListRepos: () => Promise<ListReposResponsePayload | null>;
  onSwitchRepo: (path: string) => Promise<boolean>;
  onBrowseDirectory: (path?: string) => Promise<BrowseDirectoryResponsePayload | null>;
  onAddRepo: (path: string) => Promise<Repository | null>;
}

type View = 'repos' | 'browse';

export function RepoSwitcher({
  isOpen,
  onClose,
  onListRepos,
  onSwitchRepo,
  onBrowseDirectory,
  onAddRepo,
}: RepoSwitcherProps) {
  const { repoPath, availableRepos } = useConnectionStore();
  const [view, setView] = useState<View>('repos');
  const [isLoading, setIsLoading] = useState(false);
  const [isSwitching, setSwitching] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repos, setRepos] = useState<Repository[]>(availableRepos);

  // Browser state
  const [currentPath, setCurrentPath] = useState<string>('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);

  // Reset view when drawer opens/closes
  useEffect(() => {
    if (isOpen) {
      // Go directly to browse view if no repos are available
      setView(repos.length === 0 && availableRepos.length === 0 ? 'browse' : 'repos');
    } else {
      setError(null);
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh repo list when drawer opens
  useEffect(() => {
    if (isOpen && view === 'repos') {
      setIsLoading(true);
      setError(null);
      onListRepos()
        .then((response) => {
          if (response) {
            setRepos(response.repos);
          }
        })
        .catch(() => {
          setError('Failed to load repositories');
        })
        .finally(() => {
          setIsLoading(false);
        });
    }
  }, [isOpen, view, onListRepos]);

  // Use availableRepos from store if we haven't loaded fresh data
  useEffect(() => {
    if (availableRepos.length > 0 && repos.length === 0) {
      setRepos(availableRepos);
    }
  }, [availableRepos, repos.length]);

  const loadDirectory = useCallback(
    async (path?: string) => {
      setBrowseLoading(true);
      setError(null);
      try {
        const response = await onBrowseDirectory(path);
        if (response) {
          if (response.error) {
            setError(response.error);
          } else {
            setCurrentPath(response.path);
            setParentPath(response.parentPath);
            setEntries(response.entries);
          }
        }
      } catch {
        setError('Failed to browse directory');
      } finally {
        setBrowseLoading(false);
      }
    },
    [onBrowseDirectory]
  );

  // Load home directory when switching to browse view
  useEffect(() => {
    if (isOpen && view === 'browse' && currentPath === '') {
      loadDirectory();
    }
  }, [isOpen, view, currentPath, loadDirectory]);

  const handleSwitchRepo = async (targetPath: string) => {
    if (targetPath === repoPath) {
      onClose();
      return;
    }

    setSwitching(targetPath);
    setError(null);

    const success = await onSwitchRepo(targetPath);
    if (success) {
      onClose();
    } else {
      setError('Failed to switch repository');
    }
    setSwitching(null);
  };

  const handleAddRepo = async (path: string) => {
    setIsAdding(path);
    setError(null);

    const repo = await onAddRepo(path);
    if (repo) {
      // Switch to the newly added repo (use resolved root path)
      const success = await onSwitchRepo(repo.path);
      if (success) {
        onClose();
      } else {
        // Still added, just couldn't switch
        setView('repos');
      }
    } else {
      setError('Failed to add repository');
    }
    setIsAdding(null);
  };

  const handleEntryClick = (entry: DirectoryEntry) => {
    if (entry.isGitRepo) {
      // Check if already added
      const alreadyAdded = repos.some((r) => r.path === entry.path);
      if (alreadyAdded) {
        handleSwitchRepo(entry.path);
      } else {
        handleAddRepo(entry.path);
      }
    } else if (entry.isDirectory) {
      loadDirectory(entry.path);
    }
  };

  if (!isOpen) return null;

  const repoName = (path: string) => path.split('/').pop() || path;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />

      {/* Drawer - slides up from bottom */}
      <div className="fixed inset-x-0 bottom-0 z-50 bg-slate-800 rounded-t-2xl max-h-[80vh] flex flex-col safe-area-bottom">
        {/* Handle */}
        <div className="flex justify-center py-3">
          <div className="w-10 h-1 bg-slate-600 rounded-full" />
        </div>

        {/* Header with View Toggle */}
        <div className="px-4 pb-3 border-b border-slate-700">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-lg font-semibold">
              {view === 'repos' ? 'Switch Repository' : 'Add Repository'}
            </h2>
            {view === 'browse' && (
              <button
                onClick={() => setView('repos')}
                className="text-sm text-blue-400 hover:text-blue-300"
              >
                Back to list
              </button>
            )}
          </div>
          <p className="text-sm text-slate-400">
            {view === 'repos'
              ? 'Select a repository to work with'
              : 'Browse to find a git repository'}
          </p>
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 py-2 bg-red-900/30 border-b border-red-800">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {view === 'repos' ? (
            // Repos View
            isLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
              </div>
            ) : repos.length === 0 ? (
              <div className="px-4 py-8 text-center text-slate-400">
                <p>No repositories available</p>
                <p className="text-sm mt-1">Add a repository to get started</p>
              </div>
            ) : (
              <div className="py-2">
                {repos.map((repo) => {
                  const isActive = repo.path === repoPath;
                  const isSwitchingThis = isSwitching === repo.path;

                  return (
                    <button
                      key={repo.path}
                      onClick={() => handleSwitchRepo(repo.path)}
                      disabled={isSwitching !== null}
                      className={clsx(
                        'w-full flex items-center gap-3 px-4 py-3 transition-colors',
                        isActive ? 'bg-blue-900/30' : 'hover:bg-slate-700',
                        isSwitching !== null && !isSwitchingThis && 'opacity-50'
                      )}
                    >
                      {/* Folder Icon */}
                      <div
                        className={clsx(
                          'w-10 h-10 rounded-lg flex items-center justify-center',
                          isActive ? 'bg-blue-600' : 'bg-slate-700'
                        )}
                      >
                        {isSwitchingThis ? (
                          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white" />
                        ) : (
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                            />
                          </svg>
                        )}
                      </div>

                      {/* Repo Info */}
                      <div className="flex-1 min-w-0 text-left">
                        <p className="font-medium truncate">{repoName(repo.path)}</p>
                        <p className="text-xs text-slate-400 truncate">{repo.path}</p>
                        {repo.currentBranch && (
                          <p className="text-xs text-slate-500 flex items-center gap-1 mt-0.5">
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M13 10V3L4 14h7v7l9-11h-7z"
                              />
                            </svg>
                            {repo.currentBranch}
                          </p>
                        )}
                      </div>

                      {/* Active Indicator */}
                      {isActive && (
                        <div className="text-blue-400">
                          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
                          </svg>
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            )
          ) : (
            // Browse View
            <div>
              {/* Current Path */}
              <div className="px-4 py-2 bg-slate-700/50 border-b border-slate-700">
                <p className="text-sm text-slate-300 truncate font-mono">{currentPath || '~'}</p>
              </div>

              {browseLoading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
                </div>
              ) : (
                <div className="py-1">
                  {/* Parent Directory */}
                  {parentPath && (
                    <button
                      onClick={() => loadDirectory(parentPath)}
                      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-slate-700 transition-colors"
                    >
                      <div className="w-8 h-8 rounded flex items-center justify-center bg-slate-700">
                        <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 17l-5-5m0 0l5-5m-5 5h12" />
                        </svg>
                      </div>
                      <span className="text-slate-400">..</span>
                    </button>
                  )}

                  {/* Directory Entries */}
                  {entries.length === 0 && !browseLoading ? (
                    <div className="px-4 py-6 text-center text-slate-500">
                      <p>Empty directory</p>
                    </div>
                  ) : (
                    entries.map((entry) => {
                      const alreadyAdded = entry.isGitRepo && repos.some((r) => r.path === entry.path);
                      const isAddingThis = isAdding === entry.path;

                      return (
                        <button
                          key={entry.path}
                          onClick={() => handleEntryClick(entry)}
                          disabled={isAdding !== null && !isAddingThis}
                          className={clsx(
                            'w-full flex items-center gap-3 px-4 py-2.5 transition-colors',
                            entry.isGitRepo
                              ? alreadyAdded
                                ? 'bg-green-900/20 hover:bg-green-900/30'
                                : 'bg-blue-900/20 hover:bg-blue-900/30'
                              : entry.isDirectory
                                ? 'hover:bg-slate-700'
                                : 'opacity-50 cursor-not-allowed',
                            isAdding !== null && !isAddingThis && 'opacity-50'
                          )}
                        >
                          {/* Icon */}
                          <div
                            className={clsx(
                              'w-8 h-8 rounded flex items-center justify-center',
                              entry.isGitRepo
                                ? alreadyAdded
                                  ? 'bg-green-700'
                                  : 'bg-blue-700'
                                : entry.isDirectory
                                  ? 'bg-slate-700'
                                  : 'bg-slate-800'
                            )}
                          >
                            {isAddingThis ? (
                              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                            ) : entry.isGitRepo ? (
                              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.6.11.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
                              </svg>
                            ) : entry.isDirectory ? (
                              <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                                />
                              </svg>
                            ) : (
                              <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"
                                />
                              </svg>
                            )}
                          </div>

                          {/* Name */}
                          <div className="flex-1 min-w-0 text-left">
                            <p className="truncate">{entry.name}</p>
                            {entry.isGitRepo && (
                              <p className="text-xs text-slate-500">
                                {alreadyAdded ? 'Already added - tap to switch' : 'Git repository - tap to add'}
                              </p>
                            )}
                          </div>

                          {/* Chevron for directories */}
                          {entry.isDirectory && !entry.isGitRepo && (
                            <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                            </svg>
                          )}

                          {/* Checkmark for added repos */}
                          {alreadyAdded && (
                            <svg className="w-4 h-4 text-green-400" fill="currentColor" viewBox="0 0 24 24">
                              <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
                            </svg>
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-slate-700 flex gap-2">
          {view === 'repos' && (
            <button
              onClick={() => setView('browse')}
              className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add Repository
            </button>
          )}
          <button
            onClick={onClose}
            className={clsx(
              'py-2.5 bg-slate-700 hover:bg-slate-600 rounded-lg font-medium transition-colors',
              view === 'repos' ? 'flex-1' : 'w-full'
            )}
          >
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}
