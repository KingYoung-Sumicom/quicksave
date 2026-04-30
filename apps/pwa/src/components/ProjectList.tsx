// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useMemo, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { FormattedMessage } from 'react-intl';
import { useProjects } from '../hooks/useProjects';
import { useClaudeStore } from '../stores/claudeStore';
import { useMachineStore } from '../stores/machineStore';
import { useTerminalStore } from '../stores/terminalStore';
import { DesktopSideMenuAppBar } from './DesktopSideMenuAppBar';
import { SessionTicketCard } from './SessionTicketCard';
import { TerminalListSection } from './terminal/TerminalListSection';
import { FileBrowserSection } from './files/FileBrowserSection';
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
  const machines = useMachineStore((s) => s.machines);
  const terminals = useTerminalStore((s) => s.terminals);
  const terminalCount = useMemo(() => Object.keys(terminals).length, [terminals]);
  const [tab, setTab] = useState<'sessions' | 'terminals' | 'files'>('sessions');

  // Build a cwd → ProjectEntry index so we can attach a project name + route to
  // each session without recomputing per row.
  const projectByCwd = useMemo(() => {
    const map = new Map<string, typeof projects[number]>();
    for (const p of projects) map.set(`${p.agentId}\0${p.cwd}`, p);
    return map;
  }, [projects]);

  // agentId → machine lookup. Covers sessions whose project isn't indexed yet
  // (no cached/known entry) so the machine tag still renders.
  const machineById = useMemo(() => {
    const map = new Map<string, typeof machines[number]>();
    for (const m of machines) map.set(m.agentId, m);
    return map;
  }, [machines]);

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
      <div className={`flex gap-1 px-3 pt-2 border-b border-slate-700/60 bg-slate-900/60 ${compact ? '' : 'justify-center'}`}>
        <TabButton active={tab === 'sessions'} onClick={() => setTab('sessions')} label="Sessions" count={flatSessions.length} />
        <TabButton active={tab === 'terminals'} onClick={() => setTab('terminals')} label="Terminals" count={terminalCount} />
        <TabButton active={tab === 'files'} onClick={() => setTab('files')} label="Files" />
      </div>
      <div className="flex-1 overflow-y-auto">
        {tab === 'sessions' && (
          <div className={`${compact ? '' : 'max-w-lg mx-auto py-4'} space-y-5`}>
            {/* Flat ticket list — every session, sorted by recency. */}
            {flatSessions.length > 0 && (
              <div className="divide-y divide-slate-700/40">
                {flatSessions.map((session) => {
                  const project = projectByCwd.get(`${session.machineAgentId}\0${session.cwd}`);
                  const projectName = project?.displayName ?? session.cwd?.split('/').pop() ?? '';
                  const projectId = project?.projectId ?? toProjectId(session.machineAgentId!, session.cwd!);
                  const machine = session.machineAgentId ? machineById.get(session.machineAgentId) : undefined;
                  return (
                    <SessionTicketCard
                      key={session.sessionId}
                      session={session}
                      isActive={activeSessionId === session.sessionId}
                      compact={compact}
                      projectName={projectName}
                      machineName={machine?.nickname}
                      agent={session.agent}
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
        )}
        {tab === 'terminals' && <TerminalListSection />}
        {tab === 'files' && <FileBrowserSection />}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count?: number }) {
  return (
    <button
      onClick={onClick}
      className={
        'px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ' +
        (active
          ? 'text-blue-400 border-blue-400'
          : 'text-slate-400 border-transparent hover:text-slate-200')
      }
    >
      {label}
      {typeof count === 'number' && count > 0 && (
        <span className={'ml-1.5 text-xs ' + (active ? 'text-blue-300' : 'text-slate-500')}>
          {count}
        </span>
      )}
    </button>
  );
}
