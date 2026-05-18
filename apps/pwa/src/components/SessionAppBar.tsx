// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useNavigate } from 'react-router-dom';
import type { ConfigValue, ProjectRepo, SessionControlRequestResponsePayload } from '@sumicom/quicksave-shared';
import { useClaudeStore } from '../stores/claudeStore';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { StatusDot, sessionStatusKey, type SessionStatusKey } from './SessionStatusBadge';
import { BaseStatusBar, MenuButton, BackButton, DrawerButton } from './BaseStatusBar';
import { AgentSettingsDrawer } from './AgentSettingsDrawer';
import { useSessionRightPanelStore, selectPanelMode } from '../stores/sessionRightPanelStore';

interface SessionAppBarProps {
  showSettings: boolean;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
  onOpenMenu: () => void;
  sessionId?: string;
  backTo?: string;
  projectId?: string;
  agentId?: string;
  cwd?: string;
  onListProjectRepos?: (cwd: string) => Promise<ProjectRepo[] | null>;
  onSetSessionConfig?: (key: string, value: ConfigValue) => void;
  onSendControlRequest?: (sessionId: string, subtype: string, params?: Record<string, unknown>) => Promise<SessionControlRequestResponsePayload>;
  onCloseSession?: () => void;
  onEndSession?: () => void;
  onCancelSession?: () => void;
}

export function SessionAppBar({
  showSettings,
  onOpenSettings,
  onCloseSettings,
  onOpenMenu,
  sessionId,
  backTo,
  projectId,
  agentId,
  cwd,
  onListProjectRepos,
  onSetSessionConfig,
  onSendControlRequest,
  onCloseSession,
  onEndSession,
  onCancelSession,
}: SessionAppBarProps) {
  const navigate = useNavigate();
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const panelMode = useSessionRightPanelStore(selectPanelMode);
  const togglePanel = useSessionRightPanelStore((s) => s.toggle);

  // Desktop right area: three panel-toggle icons when panel is closed, nothing
  // extra when it's open (panel tab bar handles mode switching).
  const desktopRight = isDesktop ? (
    panelMode === null ? (
      <div className="flex items-center gap-0.5">
        <button
          onClick={() => togglePanel('files')}
          className="p-1.5 rounded transition-colors text-slate-400 hover:text-slate-200 hover:bg-slate-700/60"
          aria-label="Open file browser"
          title="Files"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
          </svg>
        </button>
        <button
          onClick={() => togglePanel('git')}
          className="p-1.5 rounded transition-colors text-slate-400 hover:text-slate-200 hover:bg-slate-700/60"
          aria-label="Open git panel"
          title="Git"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <circle cx="18" cy="18" r="3" strokeWidth={1.5} />
            <circle cx="6" cy="6" r="3" strokeWidth={1.5} />
            <circle cx="6" cy="18" r="3" strokeWidth={1.5} />
            <path strokeLinecap="round" strokeWidth={1.5} d="M6 9v6M9 6h3a3 3 0 013 3v6" />
          </svg>
        </button>
        <button
          onClick={() => togglePanel('settings')}
          className="p-1.5 rounded transition-colors text-slate-400 hover:text-slate-200 hover:bg-slate-700/60"
          aria-label="Open settings panel"
          title="Settings"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </div>
    ) : null  // panel open → its own tab bar handles navigation; header stays clean
  ) : (
    // Mobile: keep the drawer button
    <DrawerButton onClick={onOpenSettings} />
  );

  return (
    <>
      <BaseStatusBar
        left={isDesktop
          ? null
          : backTo
            ? <BackButton onClick={() => navigate(-1)} />
            : <MenuButton onClick={onOpenMenu} />
        }
        center={<SessionStatusIndicator />}
        right={desktopRight}
      />

      {/* Mobile-only drawer — desktop uses the right panel */}
      {!isDesktop && (
        <AgentSettingsDrawer
          isOpen={showSettings}
          onClose={onCloseSettings}
          sessionId={sessionId}
          projectId={projectId}
          agentId={agentId}
          cwd={cwd}
          onListProjectRepos={onListProjectRepos}
          onSetSessionConfig={onSetSessionConfig}
          onSendControlRequest={onSendControlRequest}
          onCancelSession={onCancelSession}
          onCloseSession={onCloseSession}
          onEndSession={onEndSession}
        />
      )}
    </>
  );
}

function SessionStatusIndicator() {
  const activeSessionId = useClaudeStore((s) => s.activeSessionId);
  const sessions = useClaudeStore((s) => s.sessions);
  const sessionConfigs = useClaudeStore((s) => s.sessionConfigs);

  if (!activeSessionId) return null;

  const session = sessions[activeSessionId];
  const statusKey: SessionStatusKey = session ? sessionStatusKey(session) : 'thinking';
  const title = (sessionConfigs[activeSessionId]?.title as string) || session?.summary;

  return (
    <div className="flex items-center justify-center gap-2">
      <StatusDot statusKey={statusKey} />
      {title && (
        <span className="text-sm text-slate-300 line-clamp-2 min-w-0">{title}</span>
      )}
    </div>
  );
}
