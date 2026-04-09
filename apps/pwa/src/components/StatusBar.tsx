import { useState } from 'react';
import { useLocation, useMatch } from 'react-router-dom';
import { clsx } from 'clsx';
import { type ConnectionState, type ClaudePreferences } from '@sumicom/quicksave-shared';
import { useClaudeStore } from '../stores/claudeStore';
import { StatusDot, sessionStatusKey, type SessionStatusKey } from './SessionStatusBadge';
import { MODELS, PERMISSION_MODES } from '../lib/claudePresets';

interface StatusBarProps {
  connectionState: ConnectionState;
  branch?: string | null;
  ahead?: number;
  behind?: number;
  repoPath?: string | null;
  onOpenMenu?: () => void;
  onSwitchRepo?: () => void;
  onOpenGitignore?: () => void;
  onSetPreferences?: (prefs: Partial<ClaudePreferences>) => void;
  onSetSessionPermission?: (sessionId: string, mode: string) => void;
  onCloseSession?: () => void;
  onCancelSession?: () => void;
  onOpenSettings?: () => void;
  title?: string;
}

export function StatusBar({
  connectionState,
  branch,
  ahead = 0,
  behind = 0,
  repoPath,
  onOpenMenu,
  onSwitchRepo,
  onOpenGitignore,
  onSetPreferences,
  onSetSessionPermission,
  onCloseSession,
  onCancelSession,
  onOpenSettings,
  title,
}: StatusBarProps) {
  const location = useLocation();
  const isOnRepoPage = location.pathname.includes('/repo/');

  const isConnected = connectionState === 'connected';

  return (
    <header className="sticky top-0 z-30 bg-slate-800 border-b border-slate-700 safe-area-top touch-none">
      <div className="relative flex items-center px-4 py-3 min-h-[52px]">
        {/* Left: Menu button */}
        <div className="flex items-center w-10 shrink-0">
          {isConnected && onOpenMenu && (
            <button
              onClick={onOpenMenu}
              className="p-2 -ml-2 hover:bg-slate-700 rounded-md transition-colors"
              aria-label="Menu"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          )}
        </div>

        {/* Center: Session status or page title */}
        <div className="absolute left-14 right-20 inset-y-0 flex items-center justify-center py-2 overflow-hidden">
          <SessionStatusIndicator title={title} />
        </div>

        {/* Right: Stop button (streaming) + Settings gear */}
        <div className="ml-auto shrink-0 flex items-center gap-1">
          <StopButton onCancelSession={onCancelSession} />
          <SessionSettingsMenu onSetPreferences={onSetPreferences} onSetSessionPermission={onSetSessionPermission} onCloseSession={onCloseSession} />
          {onOpenSettings && (
            <button
              onClick={onOpenSettings}
              className="p-1.5 rounded-md transition-colors hover:bg-slate-700 text-slate-400"
              aria-label="Settings"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Branch Info — only on repo pages */}
      {isConnected && isOnRepoPage && branch && (
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


function StopButton({ onCancelSession }: { onCancelSession?: () => void }) {
  const isOnSessionPage = !!useMatch('/agent/:agentId/coding/:pathHash/:sessionId');
  const isStreaming = useClaudeStore((s) => s.isStreaming);

  if (!isOnSessionPage || !onCancelSession) return null;

  return (
    <button
      onClick={onCancelSession}
      className={clsx(
        'p-1.5 rounded-md transition-colors hover:bg-slate-700',
        isStreaming ? 'text-slate-200' : 'text-slate-500',
      )}
      title="Stop"
    >
      <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
        <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zM9 9h6v6H9z" />
      </svg>
    </button>
  );
}

function SessionStatusIndicator({ title }: { title?: string }) {
  const isOnSessionPage = !!useMatch('/agent/:agentId/coding/:pathHash/:sessionId');
  const activeSessionId = useClaudeStore((s) => s.activeSessionId);
  const sessions = useClaudeStore((s) => s.sessions);

  if (!isOnSessionPage || !activeSessionId) {
    if (!title) return null;
    return <span className="text-sm font-medium text-slate-300 truncate">{title}</span>;
  }

  const session = sessions.find((s) => s.sessionId === activeSessionId);
  if (!session) return null;

  const statusKey: SessionStatusKey = sessionStatusKey(session);

  return (
    <div className="flex items-center justify-center gap-2">
      <StatusDot statusKey={statusKey} />
      {session.summary && (
        <span className="text-sm text-slate-300 line-clamp-2 min-w-0">{session.summary}</span>
      )}
    </div>
  );
}



function SessionSettingsMenu({
  onSetPreferences,
  onSetSessionPermission,
  onCloseSession,
}: {
  onSetPreferences?: (prefs: Partial<ClaudePreferences>) => void;
  onSetSessionPermission?: (sessionId: string, mode: string) => void;
  onCloseSession?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const activeSessionId = useClaudeStore((s) => s.activeSessionId);
  const selectedModel = useClaudeStore((s) => s.selectedModel);
  const selectedPermissionMode = useClaudeStore((s) => s.selectedPermissionMode);

  if (!activeSessionId) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={clsx(
          'p-1.5 rounded-md transition-colors',
          open ? 'bg-slate-600' : 'hover:bg-slate-700'
        )}
        aria-label="Session settings"
      >
        <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-10 w-48 bg-slate-700 rounded-lg shadow-lg z-20 overflow-hidden border border-slate-600">
            {/* Model */}
            {onSetPreferences && (
              <div className="px-2.5 pt-2 pb-1">
                <span className="text-[10px] text-slate-500 uppercase tracking-wide">Model</span>
                <div className="mt-1 flex flex-col gap-0.5">
                  {MODELS.map((m) => (
                    <button
                      key={m.value}
                      onClick={() => { onSetPreferences({ model: m.value }); }}
                      className={clsx(
                        'text-left text-xs px-2 py-1 rounded transition-colors',
                        selectedModel === m.value ? 'bg-blue-600/30 text-blue-300' : 'text-slate-300 hover:bg-slate-600'
                      )}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Permission mode */}
            {onSetSessionPermission && (
              <div className="px-2.5 pt-2 pb-1 border-t border-slate-600">
                <span className="text-[10px] text-slate-500 uppercase tracking-wide">Permission</span>
                <div className="mt-1 flex flex-col gap-0.5">
                  {PERMISSION_MODES.map((p) => (
                    <button
                      key={p.value}
                      onClick={() => { onSetSessionPermission(activeSessionId, p.value); }}
                      className={clsx(
                        'text-left text-xs px-2 py-1 rounded transition-colors',
                        selectedPermissionMode === p.value ? 'bg-blue-600/30 text-blue-300' : 'text-slate-300 hover:bg-slate-600'
                      )}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* End session */}
            <div className="px-1.5 py-1.5 border-t border-slate-600">
              <button
                onClick={() => {
                  setOpen(false);
                  onCloseSession?.();
                }}
                className="w-full text-left text-xs px-2.5 py-1.5 rounded-md text-red-400 hover:bg-red-500/20 transition-colors"
              >
                End session
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

