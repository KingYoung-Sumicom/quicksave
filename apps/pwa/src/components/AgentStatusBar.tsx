import { useLocation, useMatch } from 'react-router-dom';
import type { ClaudePreferences } from '@sumicom/quicksave-shared';
import { useClaudeStore } from '../stores/claudeStore';
import { StatusDot, sessionStatusKey, type SessionStatusKey } from './SessionStatusBadge';
import { BaseStatusBar, SettingsGearButton } from './BaseStatusBar';
import { AgentSettingsDrawer } from './AgentSettingsDrawer';

interface AgentStatusBarProps {
  branch?: string | null;
  ahead?: number;
  behind?: number;
  repoPath?: string | null;
  showSettings: boolean;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
  onOpenMenu: () => void;
  onSwitchRepo?: () => void;
  onOpenGitignore?: () => void;
  onSetPreferences?: (prefs: Partial<ClaudePreferences>) => void;
  onSetSessionPermission?: (sessionId: string, mode: string) => void;
  onCloseSession?: () => void;
  onCancelSession?: () => void;
  onCheckAgentUpdate?: () => Promise<{ currentVersion: string; latestVersion?: string; updateAvailable: boolean; error?: string }>;
  onUpdateAgent?: () => Promise<{ success: boolean; previousVersion: string; newVersion?: string; restarting: boolean; error?: string }>;
}

export function AgentStatusBar({
  branch,
  ahead = 0,
  behind = 0,
  repoPath,
  showSettings,
  onOpenSettings,
  onCloseSettings,
  onOpenMenu,
  onSwitchRepo,
  onOpenGitignore,
  onSetPreferences,
  onSetSessionPermission,
  onCloseSession,
  onCancelSession,
  onCheckAgentUpdate,
  onUpdateAgent,
}: AgentStatusBarProps) {
  const location = useLocation();
  const isOnRepoPage = location.pathname.includes('/repo/');

  return (
    <>
      <BaseStatusBar
        left={
          <button
            onClick={onOpenMenu}
            className="p-2 -ml-2 hover:bg-slate-700 rounded-md transition-colors"
            aria-label="Menu"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        }
        center={<SessionStatusIndicator />}
        right={<SettingsGearButton onClick={onOpenSettings} />}
        below={
          isOnRepoPage && branch ? (
            <BranchBar
              branch={branch}
              ahead={ahead}
              behind={behind}
              repoPath={repoPath}
              onSwitchRepo={onSwitchRepo}
              onOpenGitignore={onOpenGitignore}
            />
          ) : undefined
        }
      />

      <AgentSettingsDrawer
        isOpen={showSettings}
        onClose={onCloseSettings}
        onSetPreferences={onSetPreferences}
        onSetSessionPermission={onSetSessionPermission}
        onCancelSession={onCancelSession}
        onCloseSession={onCloseSession}
        onCheckAgentUpdate={onCheckAgentUpdate}
        onUpdateAgent={onUpdateAgent}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SessionStatusIndicator() {
  const isOnSessionPage = !!useMatch('/agent/:agentId/coding/:pathHash/:sessionId');
  const activeSessionId = useClaudeStore((s) => s.activeSessionId);
  const sessions = useClaudeStore((s) => s.sessions);

  if (!isOnSessionPage || !activeSessionId) return null;

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

function BranchBar({
  branch,
  ahead,
  behind,
  repoPath,
  onSwitchRepo,
  onOpenGitignore,
}: {
  branch: string;
  ahead: number;
  behind: number;
  repoPath?: string | null;
  onSwitchRepo?: () => void;
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
            {ahead > 0 && <span className="text-green-400">↑{ahead}</span>}
            {ahead > 0 && behind > 0 && ' '}
            {behind > 0 && <span className="text-red-400">↓{behind}</span>}
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

      {repoPath && (
        <button
          onClick={onSwitchRepo}
          className="flex items-center gap-1 text-slate-400 text-xs truncate max-w-[50%] hover:text-slate-300 transition-colors"
          title={`${repoPath} - Click to switch`}
        >
          <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
          <span className="truncate">{repoPath.split('/').pop()}</span>
          <svg className="w-3 h-3 flex-shrink-0 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      )}
    </div>
  );
}
