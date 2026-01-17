import { useState } from 'react';
import { clsx } from 'clsx';
import type { ConnectionState } from '@quicksave/shared';
import { useMachineStore, selectSortedMachines } from '../stores/machineStore';
import { useConnectionStore } from '../stores/connectionStore';

interface StatusBarProps {
  connectionState: ConnectionState;
  branch?: string | null;
  ahead?: number;
  behind?: number;
  repoPath?: string | null;
  isPro: boolean;
  onDisconnect: () => void;
  onSwitchMachine?: () => void;
}

export function StatusBar({
  connectionState,
  branch,
  ahead = 0,
  behind = 0,
  repoPath,
  isPro,
  onDisconnect,
  onSwitchMachine,
}: StatusBarProps) {
  const [showSwitcher, setShowSwitcher] = useState(false);
  const machines = useMachineStore(selectSortedMachines);
  const { agentId } = useConnectionStore();

  const isConnected = connectionState === 'connected';
  const currentMachine = machines.find((m) => m.agentId === agentId);
  const hasMultipleMachines = machines.length > 1;

  return (
    <header className="bg-slate-800 border-b border-slate-700 safe-area-top">
      <div className="flex items-center justify-between px-4 py-3">
        {/* Left: Machine name & Status */}
        <div className="flex items-center gap-3">
          {hasMultipleMachines ? (
            <button
              onClick={() => setShowSwitcher(!showSwitcher)}
              className="flex items-center gap-2 hover:bg-slate-700 rounded-md px-2 py-1 -ml-2 transition-colors"
            >
              <span className="text-lg">{currentMachine?.icon || '💻'}</span>
              <span className="text-lg font-bold truncate max-w-[150px]">
                {currentMachine?.nickname || 'quicksave'}
              </span>
              <svg
                className={clsx('w-4 h-4 text-slate-400 transition-transform', showSwitcher && 'rotate-180')}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          ) : (
            <div className="flex items-center gap-2">
              {currentMachine && <span className="text-lg">{currentMachine.icon}</span>}
              <h1 className="text-lg font-bold">
                {currentMachine?.nickname || 'quicksave'}
              </h1>
            </div>
          )}
          <ConnectionIndicator state={connectionState} />
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-2">
          {isConnected && (
            <button
              onClick={onDisconnect}
              className="p-2 hover:bg-slate-700 rounded-md transition-colors"
              aria-label="Disconnect"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Machine Switcher Dropdown */}
      {showSwitcher && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setShowSwitcher(false)}
          />
          {/* Dropdown */}
          <div className="absolute left-4 right-4 top-14 bg-slate-700 rounded-lg shadow-lg z-20 overflow-hidden">
            <div className="p-2 border-b border-slate-600">
              <p className="text-xs text-slate-400 px-2">Switch Machine</p>
            </div>
            <div className="max-h-64 overflow-y-auto">
              {machines.map((machine) => (
                <button
                  key={machine.agentId}
                  onClick={() => {
                    setShowSwitcher(false);
                    if (machine.agentId !== agentId && onSwitchMachine) {
                      onSwitchMachine();
                    }
                  }}
                  className={clsx(
                    'w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-600 transition-colors',
                    machine.agentId === agentId && 'bg-slate-600/50'
                  )}
                >
                  <span className="text-lg">{machine.icon}</span>
                  <div className="flex-1 text-left min-w-0">
                    <p className="font-medium truncate">{machine.nickname}</p>
                    <p className="text-xs text-slate-400 truncate">
                      {machine.lastRepoPath || 'No repo'}
                    </p>
                  </div>
                  {machine.agentId === agentId && (
                    <span className="text-green-400 text-sm">Connected</span>
                  )}
                </button>
              ))}
            </div>
            <div className="p-2 border-t border-slate-600">
              <button
                onClick={() => {
                  setShowSwitcher(false);
                  if (onSwitchMachine) onSwitchMachine();
                }}
                className="w-full px-4 py-2 text-sm text-blue-400 hover:bg-slate-600 rounded-md transition-colors text-left"
              >
                Manage Machines...
              </button>
            </div>
          </div>
        </>
      )}

      {/* Branch Info */}
      {isConnected && branch && (
        <div className="flex items-center justify-between px-4 py-2 bg-slate-700/50 text-sm">
          <div className="flex items-center gap-2">
            {/* Branch Icon */}
            <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 10V3L4 14h7v7l9-11h-7z"
              />
            </svg>
            <span className="font-medium">{branch}</span>

            {/* Ahead/Behind */}
            {(ahead > 0 || behind > 0) && (
              <span className="text-slate-400">
                {ahead > 0 && <span className="text-green-400">↑{ahead}</span>}
                {ahead > 0 && behind > 0 && ' '}
                {behind > 0 && <span className="text-red-400">↓{behind}</span>}
              </span>
            )}
          </div>

          {/* Repo Path */}
          {repoPath && (
            <span className="text-slate-400 text-xs truncate max-w-[50%]" title={repoPath}>
              {repoPath}
            </span>
          )}
        </div>
      )}

      {/* Ad Banner (Free Tier) */}
      {isConnected && !isPro && <AdBanner />}
    </header>
  );
}

function ConnectionIndicator({ state }: { state: ConnectionState }) {
  const getColor = () => {
    switch (state) {
      case 'connected':
        return 'bg-green-500';
      case 'connecting':
      case 'signaling':
        return 'bg-yellow-500 animate-pulse';
      case 'error':
        return 'bg-red-500';
      default:
        return 'bg-slate-500';
    }
  };

  const getLabel = () => {
    switch (state) {
      case 'connected':
        return 'Connected';
      case 'connecting':
        return 'Connecting...';
      case 'signaling':
        return 'Establishing...';
      case 'error':
        return 'Error';
      default:
        return 'Disconnected';
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      <span className={clsx('w-2 h-2 rounded-full', getColor())} />
      <span className="text-xs text-slate-400">{getLabel()}</span>
    </div>
  );
}

function AdBanner() {
  return (
    <div className="px-4 py-2 bg-slate-700/30 border-t border-slate-700">
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-400">
          Support Quicksave - <a href="/upgrade" className="text-blue-400 hover:underline">Remove ads for $15</a>
        </span>
        <span className="text-xs text-slate-500">Ad</span>
      </div>
    </div>
  );
}
