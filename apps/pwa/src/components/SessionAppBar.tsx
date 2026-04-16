import { useNavigate } from 'react-router-dom';
import type { ConfigValue } from '@sumicom/quicksave-shared';
import { useClaudeStore } from '../stores/claudeStore';
import { StatusDot, sessionStatusKey, type SessionStatusKey } from './SessionStatusBadge';
import { BaseStatusBar, MenuButton, BackButton, SettingsGearButton } from './BaseStatusBar';
import { AgentSettingsDrawer } from './AgentSettingsDrawer';

interface SessionAppBarProps {
  showSettings: boolean;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
  onOpenMenu: () => void;
  /** Session ID from URL — used as fallback when activeSessionId is null (inactive session) */
  sessionId?: string;
  /** When set, show back arrow navigating to this path instead of hamburger menu */
  backTo?: string;
  onSetSessionConfig?: (key: string, value: ConfigValue) => void;
  onCloseSession?: () => void;
  onArchiveSession?: () => void;
  onCancelSession?: () => void;
  onCheckAgentUpdate?: () => Promise<{ currentVersion: string; latestVersion?: string; updateAvailable: boolean; error?: string }>;
  onUpdateAgent?: () => Promise<{ success: boolean; previousVersion: string; newVersion?: string; restarting: boolean; error?: string }>;
  onRestartAgent?: () => Promise<{ success: boolean; error?: string }>;
}

export function SessionAppBar({
  showSettings,
  onOpenSettings,
  onCloseSettings,
  onOpenMenu,
  sessionId,
  backTo,
  onSetSessionConfig,
  onCloseSession,
  onArchiveSession,
  onCancelSession,
  onCheckAgentUpdate,
  onUpdateAgent,
  onRestartAgent,
}: SessionAppBarProps) {
  const navigate = useNavigate();

  return (
    <>
      <BaseStatusBar
        left={backTo
          ? <BackButton onClick={() => navigate(backTo)} />
          : <MenuButton onClick={onOpenMenu} />
        }
        center={<SessionStatusIndicator />}
        right={<SettingsGearButton onClick={onOpenSettings} />}
      />

      <AgentSettingsDrawer
        isOpen={showSettings}
        onClose={onCloseSettings}
        sessionId={sessionId}
        onSetSessionConfig={onSetSessionConfig}
        onCancelSession={onCancelSession}
        onCloseSession={onCloseSession}
        onArchiveSession={onArchiveSession}
        onCheckAgentUpdate={onCheckAgentUpdate}
        onUpdateAgent={onUpdateAgent}
        onRestartAgent={onRestartAgent}
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
