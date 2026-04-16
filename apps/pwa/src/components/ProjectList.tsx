import { useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useProjects } from '../hooks/useProjects';
import { useClaudeStore } from '../stores/claudeStore';
import { ProjectCard } from './ProjectCard';
import { BaseStatusBar, SettingsGearButton } from './BaseStatusBar';
import type { ClaudeSessionSummary } from '@sumicom/quicksave-shared';

interface ProjectListProps {
  compact?: boolean;
  onOpenSettings?: () => void;
  onAddMachine?: () => void;
}

export function ProjectList({ compact, onOpenSettings, onAddMachine }: ProjectListProps) {
  const projects = useProjects();
  const navigate = useNavigate();
  const location = useLocation();
  // Extract active project and session IDs from URL: /p/:projectId or /p/:projectId/s/:sessionId
  // Use location.pathname instead of useParams because in desktop layout the sidebar
  // is rendered outside the <Routes> that define :projectId.
  const projectMatch = location.pathname.match(/\/p\/([^/]+)/);
  const activeProjectId = projectMatch?.[1];
  const sessionMatch = location.pathname.match(/\/p\/[^/]+\/s\/([^/?]+)/);
  const activeSessionId = sessionMatch?.[1];

  // Get live sessions grouped by cwd (from all connected agents)
  const sessions = useClaudeStore((s) => s.sessions);

  const sessionsByCwd = useMemo(() => {
    const map = new Map<string, ClaudeSessionSummary[]>();
    for (const session of Object.values(sessions)) {
      if (!session.cwd) continue;
      let list = map.get(session.cwd);
      if (!list) {
        list = [];
        map.set(session.cwd, list);
      }
      list.push(session);
    }
    return map;
  }, [sessions]);

  if (projects.length === 0) {
    return (
      <div className="flex flex-col h-full">
        {!compact && (
          <BaseStatusBar
            center={<span className="text-sm font-medium text-slate-300">Quicksave</span>}
            right={onOpenSettings ? <SettingsGearButton onClick={onOpenSettings} /> : undefined}
          />
        )}
        <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
          <p className="text-slate-400 text-sm mb-4">No projects yet</p>
          {onAddMachine && (
            <button
              onClick={onAddMachine}
              className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
            >
              + Add Machine
            </button>
          )}
        </div>
      </div>
    );
  }

  // Group: pinned vs unpinned with sessions vs without sessions
  const pinned = projects.filter((p) => p.isPinned);
  const withSessions = projects.filter((p) => !p.isPinned && p.sessionCount > 0);
  const withoutSessions = projects.filter((p) => !p.isPinned && p.sessionCount === 0);

  const renderGroup = (items: typeof projects, label?: string) => {
    if (items.length === 0) return null;
    return (
      <div>
        {label && (
          <p className={`text-[12px] font-medium text-slate-500 uppercase tracking-wider ${compact ? 'px-3' : 'px-1'} mb-1.5`}>
            {label}
          </p>
        )}
        <div className="divide-y divide-slate-700/40">
          {items.map((project) => {
            const cwdSessions = project.isConnected
              ? sessionsByCwd.get(project.cwd)
              : undefined;

            return (
              <ProjectCard
                key={project.projectId}
                project={project}
                sessions={cwdSessions}
                isActive={activeProjectId === project.projectId}
                activeSessionId={activeProjectId === project.projectId ? activeSessionId : undefined}
                onClick={() => navigate(`/p/${project.projectId}`)}
                onSessionClick={(sessionId) => navigate(`/p/${project.projectId}/s/${sessionId}`)}
                bare
              />
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {!compact && (
        <BaseStatusBar
          center={<span className="text-sm font-medium text-slate-300">Quicksave</span>}
          right={onOpenSettings ? <SettingsGearButton onClick={onOpenSettings} /> : undefined}
        />
      )}
      <div className="flex-1 overflow-y-auto">
        <div className={`${compact ? 'px-2 py-3' : 'max-w-lg mx-auto px-4 py-4'} space-y-5`}>
          {renderGroup(pinned, pinned.length > 0 ? 'Pinned' : undefined)}
          {renderGroup(withSessions)}
          {renderGroup(withoutSessions, withoutSessions.length > 0 && (pinned.length > 0 || withSessions.length > 0) ? 'No Sessions' : undefined)}
        </div>
      </div>
    </div>
  );
}
