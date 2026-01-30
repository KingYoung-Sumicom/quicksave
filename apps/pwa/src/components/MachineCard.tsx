import { useState } from 'react';
import { clsx } from 'clsx';
import type { Machine } from '../stores/machineStore';

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

  const handleCardClick = (e: React.MouseEvent) => {
    // Don't trigger if clicking on menu or its children
    if ((e.target as HTMLElement).closest('[data-menu]')) {
      return;
    }
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
        className={clsx(
          'p-4 flex items-center gap-4 relative transition-colors',
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
            <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
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

        {/* Chevron for navigation hint (compact variant without repos) */}
        {!isConnecting && variant === 'compact' && (
          <div className="flex-shrink-0 text-slate-500">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </div>
        )}

        {/* Menu for full variant */}
        {variant === 'full' && (onEdit || onRemove) && !isConnecting && (
          <div className="relative flex-shrink-0" data-menu>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowMenu(!showMenu);
              }}
              className="p-2 hover:bg-slate-600 rounded-md transition-colors"
              aria-label="More options"
            >
              <svg className="w-5 h-5 text-slate-400" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />
              </svg>
            </button>

            {showMenu && (
              <>
                {/* Backdrop to close menu */}
                <div
                  className="fixed inset-0 z-10"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowMenu(false);
                  }}
                />
                {/* Menu */}
                <div className="absolute right-0 top-full mt-1 bg-slate-700 rounded-md shadow-lg py-1 z-20 min-w-[120px]">
                  {onEdit && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowMenu(false);
                        onEdit();
                      }}
                      className="w-full px-4 py-2 text-left text-sm hover:bg-slate-600 transition-colors"
                    >
                      Edit
                    </button>
                  )}
                  {onRemove && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowMenu(false);
                        onRemove();
                      }}
                      className="w-full px-4 py-2 text-left text-sm text-red-400 hover:bg-slate-600 transition-colors"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </>
            )}
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
                <svg className="w-4 h-4 text-slate-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
