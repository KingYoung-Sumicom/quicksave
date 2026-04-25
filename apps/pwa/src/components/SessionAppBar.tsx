import { useNavigate } from 'react-router-dom';
import type { ConfigValue, ProjectRepo, SessionControlRequestResponsePayload } from '@sumicom/quicksave-shared';
import { useClaudeStore } from '../stores/claudeStore';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { StatusDot, sessionStatusKey, type SessionStatusKey } from './SessionStatusBadge';
import { BaseStatusBar, MenuButton, BackButton, DrawerButton } from './BaseStatusBar';
import { AgentSettingsDrawer } from './AgentSettingsDrawer';

interface SessionAppBarProps {
  showSettings: boolean;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
  onOpenMenu: () => void;
  /** Session ID from URL — used as fallback when activeSessionId is null (inactive session) */
  sessionId?: string;
  /** When set, show back arrow navigating to this path instead of hamburger menu (mobile only) */
  backTo?: string;
  /** Project ID from the route — used by the utilities drawer to navigate to project repos. */
  projectId?: string;
  /** Agent ID owning the project — used to look up available repos. */
  agentId?: string;
  /** Project cwd — repos under this path are shown in the utilities drawer. */
  cwd?: string;
  /** Fetches the full per-project repo list (incl. submodules + dirty state)
   *  when the utilities drawer opens. */
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
  // Desktop split-pane already provides nav via the sidebar — drop the redundant
  // back/menu affordance so the bar isn't competing with the sidebar.
  const isDesktop = useMediaQuery('(min-width: 768px)');

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
        right={<DrawerButton onClick={onOpenSettings} />}
      />

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
