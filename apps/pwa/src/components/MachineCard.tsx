import { useState } from 'react';
import type { Machine } from '../stores/machineStore';

interface MachineCardProps {
  machine: Machine;
  onConnect: () => void;
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

  const handleCardClick = (e: React.MouseEvent) => {
    // Don't trigger if clicking on menu or its children
    if ((e.target as HTMLElement).closest('[data-menu]')) {
      return;
    }
    if (!isConnecting) {
      onConnect();
    }
  };

  return (
    <div
      onClick={handleCardClick}
      className={`bg-slate-800 rounded-lg p-4 flex items-center gap-4 relative transition-colors ${
        isConnecting ? 'opacity-70 cursor-wait' : 'hover:bg-slate-700 cursor-pointer'
      }`}
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
          {machine.lastRepoPath || 'No repo connected yet'}
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

      {/* Chevron for navigation hint */}
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
  );
}
