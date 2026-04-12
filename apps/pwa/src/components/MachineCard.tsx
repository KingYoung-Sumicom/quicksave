import { useState, useCallback } from 'react';
import { clsx } from 'clsx';
import type { Machine } from '../stores/machineStore';
import { useLongPress } from '../hooks/useLongPress';
import { ChevronIcon } from './ui/ChevronIcon';
import { Spinner } from './ui/Spinner';

interface MachineCardProps {
  machine: Machine;
  onConnect: (repoPath?: string) => void;
  onEdit?: () => void;
  onRemove?: () => void;
  variant?: 'compact' | 'full';
  isConnecting?: boolean;
}

export function MachineCard({
  machine,
  onConnect,
  onEdit,
  onRemove,
  variant = 'full',
  isConnecting = false,
}: MachineCardProps) {
  const [showMenu, setShowMenu] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const hasRepos = machine.knownRepos && machine.knownRepos.length > 0;
  const hasMenu = (onEdit || onRemove) && !isConnecting;

  const { handlers: longPressHandlers, wasLongPress } = useLongPress(
    useCallback(() => setShowMenu(true), []),
  );

  const formatLastConnected = (timestamp: number | null): string => {
    if (!timestamp) return 'Never connected';

    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return new Date(timestamp).toLocaleDateString();
  };

  const repoName = (path: string) => path.split('/').pop() || path;

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!hasMenu) return;
    e.preventDefault();
    setShowMenu(true);
  }, [hasMenu]);

  const handleCardClick = (e: React.MouseEvent) => {
    // Don't trigger if long press just fired
    if (wasLongPress()) return;
    // Don't trigger if clicking expand button
    if ((e.target as HTMLElement).closest('[data-expand]')) {
      return;
    }
    if (!isConnecting) {
      // If has repos and full variant, toggle expand instead of connecting
      if (hasRepos && variant === 'full') {
        setExpanded(!expanded);
      } else {
        onConnect();
      }
    }
  };

  const handleRepoClick = (e: React.MouseEvent, repoPath: string) => {
    e.stopPropagation();
    if (!isConnecting) {
      onConnect(repoPath);
    }
  };

  return (
    <div className="bg-slate-800 rounded-lg overflow-hidden">
      {/* Main card row */}
      <div
        onClick={handleCardClick}
        {...(hasMenu ? longPressHandlers : {})}
        onContextMenu={handleContextMenu}
        className={clsx(
          'p-4 flex items-center gap-4 relative transition-colors select-none',
          isConnecting ? 'opacity-70 cursor-wait' : 'hover:bg-slate-700 cursor-pointer'
        )}
      >
        {/* Machine Icon */}
        <div className="w-10 h-10 bg-slate-700 rounded-lg flex items-center justify-center text-xl flex-shrink-0">
          {machine.icon}
        </div>

        {/* Machine Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-medium truncate">{machine.nickname}</h3>
            {machine.isPro && (
              <span className="text-xs bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded flex-shrink-0">
                Pro
              </span>
            )}
          </div>
          <p className="text-sm text-slate-400 truncate">
            {hasRepos
              ? `${machine.knownRepos.length} repo${machine.knownRepos.length > 1 ? 's' : ''}`
              : machine.lastRepoPath || 'No repo connected yet'}
          </p>
          {variant === 'full' && (
            <p className="text-xs text-slate-500">
              {formatLastConnected(machine.lastConnectedAt)}
            </p>
          )}
        </div>

        {/* Connecting indicator */}
        {isConnecting && (
          <div className="flex-shrink-0">
            <Spinner size="w-5 h-5" color="border-blue-500" />
          </div>
        )}

        {/* Expand button for machines with repos */}
        {!isConnecting && hasRepos && variant === 'full' && (
          <button
            data-expand
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
            className="flex-shrink-0 p-2 hover:bg-slate-600 rounded-md transition-colors text-slate-400"
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >
            <svg
              className={clsx('w-5 h-5 transition-transform', expanded && 'rotate-180')}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        )}

        {/* Chevron for navigation hint (compact variant) */}
        {!isConnecting && variant === 'compact' && (
          <div className="flex-shrink-0 text-slate-500">
            <ChevronIcon size="w-5 h-5" />
          </div>
        )}
      </div>

      {/* Expanded repo list */}
      {expanded && hasRepos && (
        <div className="border-t border-slate-700 bg-slate-800/50">
          {machine.knownRepos.map((repoPath) => {
            const isLastConnected = repoPath === machine.lastRepoPath;
            return (
              <button
                key={repoPath}
                onClick={(e) => handleRepoClick(e, repoPath)}
                className={clsx(
                  'w-full flex items-center gap-3 px-4 py-2.5 pl-14 transition-colors',
                  isLastConnected ? 'bg-blue-900/20' : 'hover:bg-slate-700'
                )}
              >
                {/* Folder icon */}
                <div
                  className={clsx(
                    'w-8 h-8 rounded flex items-center justify-center',
                    isLastConnected ? 'bg-blue-700' : 'bg-slate-700'
                  )}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                    />
                  </svg>
                </div>

                {/* Repo info */}
                <div className="flex-1 min-w-0 text-left">
                  <p className="font-medium truncate text-sm">{repoName(repoPath)}</p>
                  <p className="text-xs text-slate-500 truncate">{repoPath}</p>
                </div>

                {/* Last connected indicator */}
                {isLastConnected && (
                  <span className="text-xs text-blue-400 flex-shrink-0">Last used</span>
                )}

                {/* Chevron */}
                <ChevronIcon size="w-4 h-4" className="text-slate-500" />
              </button>
            );
          })}
        </div>
      )}

      {/* Long-press popup menu */}
      {showMenu && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/50"
            onClick={() => setShowMenu(false)}
          />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
            <div className="bg-slate-700 rounded-lg shadow-xl overflow-hidden pointer-events-auto min-w-[200px]">
              {/* Machine name header */}
              <div className="px-4 py-3 border-b border-slate-600">
                <p className="text-sm font-medium text-slate-300 truncate">{machine.nickname}</p>
              </div>
              {onEdit && (
                <button
                  onClick={() => {
                    setShowMenu(false);
                    onEdit();
                  }}
                  className="w-full px-4 py-3 text-left text-sm hover:bg-slate-600 transition-colors flex items-center gap-3"
                >
                  <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                  Rename
                </button>
              )}
              {onRemove && (
                <button
                  onClick={() => {
                    setShowMenu(false);
                    onRemove();
                  }}
                  className="w-full px-4 py-3 text-left text-sm text-red-400 hover:bg-slate-600 transition-colors flex items-center gap-3"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  Delete
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
