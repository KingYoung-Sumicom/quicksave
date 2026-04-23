import { useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { FormattedMessage } from 'react-intl';
import { useProjects } from '../hooks/useProjects';
import { useClaudeStore } from '../stores/claudeStore';
import { DesktopSideMenuAppBar } from './DesktopSideMenuAppBar';
import { SessionTicketCard } from './SessionTicketCard';
import { toProjectId } from '../lib/projectId';

interface ProjectListProps {
  compact?: boolean;
  onOpenSettings?: () => void;
  onOpenAddNew?: () => void;
  onAddMachine?: () => void;
}

/**
 * Home screen — flat ticket list across all projects/machines, sorted by
 * recency. Project context lives on each ticket (project-name pill in the
 * meta line).
 */
export function ProjectList({ compact, onOpenSettings, onOpenAddNew, onAddMachine }: ProjectListProps) {
  const projects = useProjects();
  const navigate = useNavigate();
  const location = useLocation();
  const sessionMatch = location.pathname.match(/\/p\/[^/]+\/s\/([^/?]+)/);
  const activeSessionId = sessionMatch?.[1];

  const sessions = useClaudeStore((s) => s.sessions);

  // Build a cwd → ProjectEntry index so we can attach a project name + route to
  // each session without recomputing per row.
  const projectByCwd = useMemo(() => {
    const map = new Map<string, typeof projects[number]>();
    for (const p of projects) map.set(`${p.agentId}\0${p.cwd}`, p);
    return map;
  }, [projects]);

  const flatSessions = useMemo(() => {
    return Object.values(sessions)
      .filter((s) => s.cwd && s.machineAgentId && !s.archived)
      .sort((a, b) => {
        const rankA = a.isStreaming ? 2 : a.isActive ? 1 : 0;
        const rankB = b.isStreaming ? 2 : b.isActive ? 1 : 0;
        if (rankA !== rankB) return rankB - rankA;
        const tsA = a.lastPromptAt ?? a.lastModified;
        const tsB = b.lastPromptAt ?? b.lastModified;
        return tsB - tsA;
      });
  }, [sessions]);

  if (projects.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <DesktopSideMenuAppBar onOpenSettings={onOpenSettings} onOpenAddNew={onOpenAddNew} />
        <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
          <p className="text-slate-400 text-sm mb-4">
            <FormattedMessage id="projectList.empty.noProjects" />
          </p>
          {onAddMachine && (
            <button
              onClick={onAddMachine}
              className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
            >
              <FormattedMessage id="projectList.empty.addMachine" />
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <DesktopSideMenuAppBar onOpenSettings={onOpenSettings} onOpenAddNew={onOpenAddNew} />
      <div className="flex-1 overflow-y-auto">
        <div className={`${compact ? '' : 'max-w-lg mx-auto py-4'} space-y-5`}>
          {/* Flat ticket list — every session, sorted by recency. */}
          {flatSessions.length > 0 && (
            <div className="divide-y divide-slate-700/40">
              {flatSessions.map((session) => {
                const project = projectByCwd.get(`${session.machineAgentId}\0${session.cwd}`);
                const projectName = project?.displayName ?? session.cwd?.split('/').pop() ?? '';
                const projectId = project?.projectId ?? toProjectId(session.machineAgentId!, session.cwd!);
                return (
                  <SessionTicketCard
                    key={session.sessionId}
                    session={session}
                    isActive={activeSessionId === session.sessionId}
                    compact={compact}
                    projectName={projectName}
                    onClick={() => navigate(`/p/${projectId}/s/${session.sessionId}`)}
                  />
                );
              })}
            </div>
          )}

          {flatSessions.length === 0 && (
            <p className="text-center text-sm text-slate-500 py-12">
              <FormattedMessage id="projectList.empty.noTasks" />
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
