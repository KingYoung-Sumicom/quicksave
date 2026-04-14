import { useState, useEffect, useCallback } from 'react';
import { BaseStatusBar, MenuButton } from './BaseStatusBar';
import type { Submodule } from '@sumicom/quicksave-shared';

interface RepoAppBarProps {
  branch?: string | null;
  ahead?: number;
  behind?: number;
  repoPath?: string | null;
  onOpenMenu: () => void;
  onSwitchRepo: (path: string) => Promise<boolean>;
  onListSubmodules: () => Promise<Submodule[]>;
  onOpenGitignore?: () => void;
}

export function RepoAppBar({
  branch,
  ahead = 0,
  behind = 0,
  repoPath,
  onOpenMenu,
  onSwitchRepo,
  onListSubmodules,
  onOpenGitignore,
}: RepoAppBarProps) {
  const [submodules, setSubmodules] = useState<Submodule[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);

  // Fetch submodules when component mounts or repoPath changes
  useEffect(() => {
    let cancelled = false;
    onListSubmodules().then((subs) => {
      if (!cancelled) setSubmodules(subs);
    });
    return () => { cancelled = true; };
  }, [onListSubmodules, repoPath]);

  // Find root repo path (parent of all submodules, or current if no submodules match)
  const rootPath = submodules.length > 0
    ? findRootPath(repoPath, submodules)
    : repoPath;
  const isOnSubmodule = repoPath !== rootPath;

  const handleSwitch = useCallback(async (path: string) => {
    setShowDropdown(false);
    if (path !== repoPath) {
      await onSwitchRepo(path);
    }
  }, [repoPath, onSwitchRepo]);

  return (
    <>
      <BaseStatusBar
        left={<MenuButton onClick={onOpenMenu} />}
        center={
          submodules.length > 0 ? (
            <button
              onClick={() => setShowDropdown((prev) => !prev)}
              className="flex items-center gap-1.5 text-sm font-medium text-slate-300 truncate hover:text-white transition-colors"
            >
              <span className="truncate">
                {isOnSubmodule ? repoPath?.split('/').pop() : rootPath?.split('/').pop()}
              </span>
              <svg className="w-3.5 h-3.5 flex-shrink-0 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          ) : (
            <span className="text-sm font-medium text-slate-300 truncate">
              {repoPath?.split('/').pop()}
            </span>
          )
        }
        below={
          branch ? (
            <BranchBar
              branch={branch}
              ahead={ahead}
              behind={behind}
              onOpenGitignore={onOpenGitignore}
            />
          ) : undefined
        }
      />

      {/* Submodule dropdown */}
      {showDropdown && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowDropdown(false)} />
          <div className="absolute left-4 right-4 top-[52px] z-50 bg-slate-700 rounded-lg shadow-lg border border-slate-600 overflow-hidden safe-area-top">
            {/* Root repo */}
            <button
              onClick={() => handleSwitch(rootPath!)}
              className={`w-full flex items-center gap-2 px-4 py-2.5 text-sm text-left hover:bg-slate-600 transition-colors ${
                !isOnSubmodule ? 'bg-slate-600/50 text-white' : 'text-slate-300'
              }`}
            >
              <svg className="w-4 h-4 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              <span className="truncate">{rootPath?.split('/').pop()}</span>
              <span className="text-xs text-slate-500 flex-shrink-0 ml-auto">root</span>
            </button>

            {/* Submodules */}
            {submodules.map((sub) => (
              <button
                key={sub.path}
                onClick={() => handleSwitch(sub.path)}
                className={`w-full flex items-center gap-2 px-4 py-2.5 text-sm text-left hover:bg-slate-600 transition-colors ${
                  repoPath === sub.path ? 'bg-slate-600/50 text-white' : 'text-slate-300'
                }`}
              >
                <svg className="w-4 h-4 text-blue-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.172 13.828a4 4 0 015.656 0l4-4a4 4 0 00-5.656-5.656l-1.102 1.101" />
                </svg>
                <span className="truncate">{sub.name}</span>
                {sub.branch && (
                  <span className="text-xs text-slate-500 flex-shrink-0 ml-auto">{sub.branch}</span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/** Determine root repo path from submodule paths. */
function findRootPath(currentPath: string | null | undefined, submodules: Submodule[]): string | null {
  if (!currentPath) return null;
  // If current path is a submodule, the root is the parent that contains all submodules
  const sub = submodules.find((s) => s.path === currentPath);
  if (sub) {
    // Walk up from the submodule path to find root
    // Submodule paths are absolute, e.g. /repo/root/packages/sub
    // We need the common ancestor — but we don't know the root directly.
    // The root is the repo that was originally added. Since submodule paths
    // are children of the root, we can find the shortest common prefix.
    const allPaths = submodules.map((s) => s.path);
    const prefix = commonPrefix(allPaths);
    // The root is the prefix (or its parent if prefix ends mid-segment)
    return prefix.endsWith('/') ? prefix.slice(0, -1) : prefix.split('/').slice(0, -1).join('/') || currentPath;
  }
  // Current path is probably the root
  return currentPath;
}

function commonPrefix(paths: string[]): string {
  if (paths.length === 0) return '';
  let prefix = paths[0];
  for (let i = 1; i < paths.length; i++) {
    while (!paths[i].startsWith(prefix)) {
      prefix = prefix.slice(0, prefix.lastIndexOf('/'));
      if (!prefix) return '';
    }
  }
  return prefix;
}

function BranchBar({
  branch,
  ahead,
  behind,
  onOpenGitignore,
}: {
  branch: string;
  ahead: number;
  behind: number;
  onOpenGitignore?: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-2 bg-slate-700/50 text-sm">
      <div className="flex items-center gap-2">
        <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        <span className="font-medium">{branch}</span>

        {(ahead > 0 || behind > 0) && (
          <span className="text-slate-400">
            {ahead > 0 && <span className="text-green-400">&uarr;{ahead}</span>}
            {ahead > 0 && behind > 0 && ' '}
            {behind > 0 && <span className="text-red-400">&darr;{behind}</span>}
          </span>
        )}

        {onOpenGitignore && (
          <button
            onClick={onOpenGitignore}
            className="text-xs px-1.5 py-0.5 text-slate-500 hover:text-slate-300 hover:bg-slate-600 rounded transition-colors font-mono"
            title="Edit .gitignore"
          >
            <svg className="w-3 h-3 inline-block mr-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
            </svg>
            .gitignore
          </button>
        )}
      </div>
    </div>
  );
}
