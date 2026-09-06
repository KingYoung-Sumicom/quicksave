// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { FormattedMessage } from 'react-intl';
import { useProjects } from '../hooks/useProjects';
import { useClaudeStore } from '../stores/claudeStore';
import { useMachineStore } from '../stores/machineStore';
import { useTerminalStore } from '../stores/terminalStore';
import { DesktopSideMenuAppBar } from './DesktopSideMenuAppBar';
import { SessionTicketCard } from './SessionTicketCard';
import { isSessionUnread } from './SessionStatusBadge';
import { compareSessionsForList } from '../lib/sessionOrdering';
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
  const [missionNow, setMissionNow] = useState(Date.now());
  const [machineFilter, setMachineFilter] = useState<string>('');
  const [projectFilter, setProjectFilter] = useState<string>('');

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

  // Sort tiers (highest first):
  //   4 — unread: lastReadAt missing or older than lastTurnEndedAt (active
  //       sessions only — see `isSessionUnread`). Cross-device synchronized
  //       via the agent so reading on phone clears it on desktop too.
  //   3 — hasPendingInput (read): still waiting on user, but viewed.
  //   2 — isStreaming, 1 — isActive, 0 — closed.
  // Within a tier, most-recent-first.
  const flatSessions = useMemo(() => {
    return Object.values(sessions)
      .filter((s) => s.cwd && s.machineAgentId && !s.archived)
      .sort((a, b) => compareSessionsForList(a, b, missionNow));
  }, [sessions, missionNow]);

  const filterProjects = useMemo(
    () => machineFilter ? projects.filter((project) => project.agentId === machineFilter) : projects,
    [machineFilter, projects],
  );

  const filteredSessions = useMemo(
    () => flatSessions.filter((session) => {
      if (machineFilter && session.machineAgentId !== machineFilter) return false;
      if (!projectFilter) return true;
      const project = projectByCwd.get(`${session.machineAgentId}\0${session.cwd}`);
      return project?.projectId === projectFilter;
    }),
    [flatSessions, machineFilter, projectByCwd, projectFilter],
  );

  const handleMachineFilterChange = (agentId: string) => {
    setMachineFilter(agentId);
    if (projectFilter && !projects.some((project) => project.projectId === projectFilter && (!agentId || project.agentId === agentId))) {
      setProjectFilter('');
    }
  };

  const clearFilters = () => {
    setMachineFilter('');
    setProjectFilter('');
  };

  useEffect(() => {
    const id = window.setInterval(() => setMissionNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

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
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2 px-3">
              <FilterPill
                ariaLabel="Filter sessions by machine"
                label="Machine"
                value={machineFilter}
                onChange={handleMachineFilterChange}
                options={machines.map((machine) => ({ value: machine.agentId, label: machine.nickname }))}
              />
              <FilterPill
                ariaLabel="Filter sessions by project"
                label="Project"
                value={projectFilter}
                onChange={setProjectFilter}
                options={filterProjects.map((project) => ({
                  value: project.projectId,
                  label: machineFilter ? project.displayName : `${project.machineName} · ${project.displayName}`,
                }))}
              />
              <button
                type="button"
                onClick={clearFilters}
                disabled={!machineFilter && !projectFilter}
                className="rounded-full px-2.5 py-1.5 text-xs font-medium text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-100 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-400"
              >
                Clear
              </button>
            </div>

            {/* Flat ticket list — filtered sessions, sorted by recency. */}
            {filteredSessions.length > 0 && (
              <div className="divide-y divide-slate-700/40">
                {filteredSessions.map((session) => {
                  const project = projectByCwd.get(`${session.machineAgentId}\0${session.cwd}`);
                  const projectName = project?.displayName ?? session.cwd?.split('/').pop() ?? '';
                  const projectId = project?.projectId ?? toProjectId(session.machineAgentId!, session.cwd!);
                  const machine = session.machineAgentId ? machineById.get(session.machineAgentId) : undefined;
                  return (
                    <SessionTicketCard
                      key={session.sessionId}
                      session={session}
                      isActive={activeSessionId === session.sessionId}
                      isUnread={isSessionUnread(session)}
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

            {filteredSessions.length === 0 && (
              <p className="text-center text-sm text-slate-500 py-12">
                {machineFilter || projectFilter ? 'No matching tasks.' : <FormattedMessage id="projectList.empty.noTasks" />}
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

function FilterPill({
  ariaLabel,
  label,
  value,
  onChange,
  options,
}: {
  ariaLabel: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="relative inline-flex min-w-0 w-full items-center rounded-full border border-slate-600 bg-slate-800 text-xs text-slate-300 transition-colors hover:border-slate-500 focus-within:border-blue-400 focus-within:ring-1 focus-within:ring-blue-400">
      <span className="pointer-events-none shrink-0 pl-3 font-medium text-slate-400">{label}</span>
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-0 flex-1 cursor-pointer appearance-none bg-transparent py-1.5 pl-1 pr-7 text-slate-100 outline-none"
      >
        <option value="">All</option>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <svg aria-hidden className="pointer-events-none absolute right-2 h-3 w-3 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m6 9 6 6 6-6" />
      </svg>
    </label>
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
