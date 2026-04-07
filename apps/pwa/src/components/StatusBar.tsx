import { useState } from 'react';
import { useLocation, useMatch } from 'react-router-dom';
import { clsx } from 'clsx';
import { CLAUDE_MODELS, type ConnectionState, type ClaudePreferences } from '@sumicom/quicksave-shared';
import { useClaudeStore } from '../stores/claudeStore';
import { StatusDot, sessionStatusKey, type SessionStatusKey } from './SessionStatusBadge';

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

        {/* Center: Session title + status badge (absolute so it's truly centered) */}
        <div className="absolute inset-x-14 inset-y-0 flex items-center justify-center py-2">
          <SessionStatusIndicator />
        </div>

        {/* Right: Stop button (streaming) + Settings gear */}
        <div className="ml-auto shrink-0 flex items-center gap-1">
          <StopButton onCancelSession={onCancelSession} />
          <SessionSettingsMenu onCloseSession={onCloseSession} onSetPreferences={onSetPreferences} onSetSessionPermission={onSetSessionPermission} />
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

  if (!isOnSessionPage || !isStreaming || !onCancelSession) return null;

  return (
    <button
      onClick={onCancelSession}
      className="w-7 h-7 rounded-full bg-red-600 hover:bg-red-500 transition-colors flex items-center justify-center"
      title="Stop"
    >
      <svg className="w-3 h-3" fill="white" viewBox="0 0 12 12">
        <rect x="2" y="2" width="8" height="8" />
      </svg>
    </button>
  );
}

function SessionStatusIndicator() {
  const isOnSessionPage = !!useMatch('/agent/:agentId/coding/:pathHash/:sessionId');
  const activeSessionId = useClaudeStore((s) => s.activeSessionId);
  const sessions = useClaudeStore((s) => s.sessions);

  if (!isOnSessionPage || !activeSessionId) return null;

  const session = sessions.find((s) => s.sessionId === activeSessionId);
  if (!session) return null;

  const statusKey: SessionStatusKey = sessionStatusKey(session);

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center">
      <StatusDot statusKey={statusKey} />
      {session.summary && (
        <span className="text-sm text-slate-300 break-words">{session.summary}</span>
      )}
    </div>
  );
}


const PERMISSION_MODES = [
  { id: 'acceptEdits', label: 'Accept Edits', desc: 'Approve file writes' },
  { id: 'bypassPermissions', label: 'Bypass', desc: 'Auto-approve all' },
  { id: 'plan', label: 'Plan', desc: 'Read-only planning' },
] as const;

function SessionSettingsMenu({ onCloseSession, onSetPreferences, onSetSessionPermission }: { onCloseSession?: () => void; onSetPreferences?: (prefs: Partial<ClaudePreferences>) => void; onSetSessionPermission?: (sessionId: string, mode: string) => void }) {
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
          <div className="absolute right-0 top-10 w-56 bg-slate-700 rounded-lg shadow-lg z-20 overflow-hidden border border-slate-600">
            {/* Model selector */}
            <div className="px-3 pt-2.5 pb-1">
              <p className="text-[10px] uppercase tracking-wider text-slate-400 font-medium">Model</p>
            </div>
            <div className="px-1.5 pb-1.5">
              {CLAUDE_MODELS.map((m) => (
                <button
                  key={m.id}
                  onClick={() => onSetPreferences?.({ model: m.id })}
                  className={clsx(
                    'w-full text-left text-xs px-2.5 py-1.5 rounded-md transition-colors',
                    selectedModel === m.id
                      ? 'bg-blue-600/30 text-blue-300'
                      : 'text-slate-300 hover:bg-slate-600'
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>

            <div className="border-t border-slate-600" />

            {/* Permission mode selector */}
            <div className="px-3 pt-2.5 pb-1">
              <p className="text-[10px] uppercase tracking-wider text-slate-400 font-medium">Permissions</p>
            </div>
            <div className="px-1.5 pb-1.5">
              {PERMISSION_MODES.map((pm) => (
                <button
                  key={pm.id}
                  onClick={() => activeSessionId && onSetSessionPermission?.(activeSessionId, pm.id)}
                  className={clsx(
                    'w-full text-left text-xs px-2.5 py-1.5 rounded-md transition-colors',
                    selectedPermissionMode === pm.id
                      ? 'bg-blue-600/30 text-blue-300'
                      : 'text-slate-300 hover:bg-slate-600'
                  )}
                >
                  <span>{pm.label}</span>
                  <span className="text-slate-500 ml-1.5">{pm.desc}</span>
                </button>
              ))}
            </div>

            <div className="border-t border-slate-600" />

            {/* End session */}
            <div className="px-1.5 py-1.5">
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

