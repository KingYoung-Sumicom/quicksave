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
        {/* Left: Back button, Machine name */}
        <div className="flex items-center gap-2">
          {/* Back button */}
          {isConnected && (
            <button
              onClick={onDisconnect}
              className="p-2 -ml-2 hover:bg-slate-700 rounded-md transition-colors"
              aria-label="Back"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )}

          {hasMultipleMachines ? (
            <button
              onClick={() => setShowSwitcher(!showSwitcher)}
              className="flex items-center gap-2 hover:bg-slate-700 rounded-md px-2 py-1 transition-colors"
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
        </div>

        {/* Right: Connection indicator */}
        <div className="flex items-center gap-2">
          <ConnectionIndicator state={connectionState} />
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
        return 'text-green-500';
      case 'connecting':
      case 'signaling':
        return 'text-yellow-500';
      case 'error':
        return 'text-red-500';
      default:
        return 'text-slate-500';
    }
  };

  const isAnimating = state === 'connecting' || state === 'signaling';

  // Connected: solid signal icon
  // Connecting/Signaling: animated signal icon
  // Error: X icon
  // Disconnected: signal with slash
  return (
    <div className={clsx('w-5 h-5', getColor(), isAnimating && 'animate-pulse')}>
      {state === 'connected' && (
        // Two connected nodes icon
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-5 h-5">
          <circle cx="6" cy="12" r="3" strokeWidth={2} />
          <circle cx="18" cy="12" r="3" strokeWidth={2} />
          <path strokeLinecap="round" strokeWidth={2} d="M9 12h6" />
        </svg>
      )}
      {(state === 'connecting' || state === 'signaling') && (
        // Connecting animation - signal waves
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-5 h-5">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0" />
        </svg>
      )}
      {state === 'error' && (
        // Error X icon
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-5 h-5">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      )}
      {(state === 'disconnected' || !state) && (
        // Disconnected - broken link
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" className="w-5 h-5">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
        </svg>
      )}
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
