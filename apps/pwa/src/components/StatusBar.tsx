import { useState } from 'react';
import { clsx } from 'clsx';
import type { ConnectionState } from '@sumicom/quicksave-shared';
import { useMachineStore, selectSortedMachines } from '../stores/machineStore';
import { useConnectionStore } from '../stores/connectionStore';

interface StatusBarProps {
  connectionState: ConnectionState;
  branch?: string | null;
  ahead?: number;
  behind?: number;
  repoPath?: string | null;
  onDisconnect: () => void;
  onSwitchMachine?: (agentId: string) => void;
  onSwitchRepo?: () => void;
  onOpenGitignore?: () => void;
}

export function StatusBar({
  connectionState,
  branch,
  ahead = 0,
  behind = 0,
  repoPath,
  onDisconnect,
  onSwitchMachine,
  onSwitchRepo,
  onOpenGitignore,
}: StatusBarProps) {
  const [showSwitcher, setShowSwitcher] = useState(false);
  const machines = useMachineStore(selectSortedMachines);
  const { agentId } = useConnectionStore();

  const isConnected = connectionState === 'connected';
  const currentMachine = machines.find((m) => m.agentId === agentId);
  const hasMultipleMachines = machines.length > 1;

  return (
    <header className="sticky top-0 z-30 bg-slate-800 border-b border-slate-700 safe-area-top">
      <div className="flex items-center justify-between px-4 py-3">
        {/* Left: Back button */}
        <div className="flex items-center w-10">
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
        </div>

        {/* Center: Machine switcher */}
        <div className="flex items-center justify-center flex-1 max-w-xs">
          {hasMultipleMachines ? (
            <button
              onClick={() => setShowSwitcher(!showSwitcher)}
              className={clsx(
                'flex items-center gap-2 hover:bg-slate-700 rounded-md px-2 py-1 transition-colors',
                showSwitcher && 'bg-slate-700'
              )}
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
        <div className="flex items-center justify-end w-10">
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
          <div className="absolute left-1/2 -translate-x-1/2 top-14 w-full max-w-md bg-slate-700 rounded-lg shadow-lg z-20 overflow-hidden">
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
                      onSwitchMachine(machine.agentId);
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
                  onDisconnect();
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

            {/* Gitignore Editor */}
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

          {/* Repo Path - clickable to open repo switcher */}
          {repoPath && (
            <button
              onClick={onSwitchRepo}
              className="flex items-center gap-1 text-slate-400 text-xs truncate max-w-[50%] hover:text-slate-300 transition-colors"
              title={`${repoPath} - Click to switch`}
            >
              <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                />
              </svg>
              <span className="truncate">{repoPath.split('/').pop()}</span>
              <svg className="w-3 h-3 flex-shrink-0 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          )}
        </div>
      )}

      {/* Ad Banner (Free Tier) - disabled for now */}
      {/* {isConnected && !isPro && <AdBanner />} */}
    </header>
  );
}

function ConnectionIndicator({ state }: { state: ConnectionState }) {
  const getColor = () => {
    switch (state) {
      case 'connected':
        return 'text-green-500';
      case 'connecting':
        return 'text-yellow-500';
      case 'error':
        return 'text-red-500';
      default:
        return 'text-slate-500';
    }
  };

  const isAnimating = state === 'connecting';

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
      {state === 'connecting' && (
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
