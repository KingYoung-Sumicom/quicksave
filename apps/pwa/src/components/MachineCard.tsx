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

  return (
    <div className="bg-slate-800 rounded-lg p-4 flex items-center gap-4 relative">
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

      {/* Actions */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={onConnect}
          disabled={isConnecting}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-md text-sm font-medium transition-colors"
        >
          {isConnecting ? '...' : 'Connect'}
        </button>

        {variant === 'full' && (onEdit || onRemove) && (
          <div className="relative">
            <button
              onClick={() => setShowMenu(!showMenu)}
              className="p-2 hover:bg-slate-700 rounded-md transition-colors"
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
                  onClick={() => setShowMenu(false)}
                />
                {/* Menu */}
                <div className="absolute right-0 top-full mt-1 bg-slate-700 rounded-md shadow-lg py-1 z-20 min-w-[120px]">
                  {onEdit && (
                    <button
                      onClick={() => {
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
                      onClick={() => {
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
    </div>
  );
}
