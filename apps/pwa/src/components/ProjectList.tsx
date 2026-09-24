// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { FormattedMessage, useIntl } from 'react-intl';
import { useProjects } from '../hooks/useProjects';
import { useSessionStore, type StoredSessionSummary } from '../stores/sessionStore';
import { useMachineStore } from '../stores/machineStore';
import { useTerminalStore } from '../stores/terminalStore';
import { DesktopSideMenuAppBar } from './DesktopSideMenuAppBar';
import { SessionTicketCard } from './SessionTicketCard';
import { isSessionUnread } from './SessionStatusBadge';
import { compareSessionsForList } from '../lib/sessionOrdering';
import { TerminalListSection } from './terminal/TerminalListSection';
import { FileBrowserSection } from './files/FileBrowserSection';
import { toProjectId } from '../lib/projectId';
import { getBusForAgent } from '../lib/busRegistry';

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
  const intl = useIntl();
  const projects = useProjects();
  const navigate = useNavigate();
  const location = useLocation();
  const sessionMatch = location.pathname.match(/\/p\/[^/]+\/s\/([^/?]+)/);
  const activeSessionId = sessionMatch?.[1];

  const sessions = useSessionStore((s) => s.sessions);
  const machines = useMachineStore((s) => s.machines);
  const terminals = useTerminalStore((s) => s.terminals);
  const terminalCount = useMemo(() => Object.keys(terminals).length, [terminals]);
  const [tab, setTab] = useState<'sessions' | 'terminals' | 'files'>('sessions');
  const [missionNow, setMissionNow] = useState(Date.now());
  const [machineFilter, setMachineFilter] = useState<string>('');
  const [projectFilter, setProjectFilter] = useState<string>('');
  const [filtersExpanded, setFiltersExpanded] = useState(false);

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

  const sessionGroups = useMemo(() => {
    const attention: StoredSessionSummary[] = [];
    const active: StoredSessionSummary[] = [];
    const recent: StoredSessionSummary[] = [];
    for (const session of filteredSessions) {
      if (isSessionUnread(session) || session.hasPendingInput) attention.push(session);
      else if (session.isStreaming || session.isActive) active.push(session);
      else recent.push(session);
    }
    return [
      { id: 'attention', sessions: attention },
      { id: 'active', sessions: active },
      { id: 'recent', sessions: recent },
    ].filter((group) => group.sessions.length > 0);
  }, [filteredSessions]);

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

  const runSessionAction = async (session: StoredSessionSummary, verb: 'claude:cancel' | 'claude:end-task') => {
    const bus = session.machineAgentId ? getBusForAgent(session.machineAgentId) : null;
    if (!bus) {
      console.error(`Failed to ${verb} session: machine is not connected`);
      return;
    }
    try {
      const result = await bus.command<{ success: boolean; error?: string }>(
        verb,
        { sessionId: session.sessionId },
        { timeoutMs: 30_000, queueWhileDisconnected: true },
      );
      if (!result.success) throw new Error(result.error ?? 'Session action failed');
      if (useSessionStore.getState().activeSessionId === session.sessionId) {
        useSessionStore.getState().setStreaming(false);
      }
    } catch (error) {
      console.error(`Failed to ${verb} session:`, error);
    }
  };

  useEffect(() => {
    const id = window.setInterval(() => setMissionNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const renderSessionCard = (session: StoredSessionSummary) => {
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
        className={`${compact ? 'px-3 py-3' : 'px-4 py-3.5'} rounded-xl hover:bg-slate-700/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70`}
        projectName={projectName}
        machineName={machine?.nickname}
        agent={session.agent}
        onClick={() => navigate(`/p/${projectId}/s/${session.sessionId}`)}
        onStop={() => { void runSessionAction(session, 'claude:cancel'); }}
        onEndTask={() => { void runSessionAction(session, 'claude:end-task'); }}
      />
    );
  };

  const filters = <>
    <FilterDropdown
      ariaLabel={intl.formatMessage({ id: 'projectList.filter.machineAria' })}
      label={intl.formatMessage({ id: 'projectList.filter.machine' })}
      allLabel={intl.formatMessage({ id: 'projectList.filter.all' })}
      value={machineFilter}
      onChange={handleMachineFilterChange}
      options={machines.map((machine) => ({ value: machine.agentId, label: machine.nickname }))}
    />
    <FilterDropdown
      ariaLabel={intl.formatMessage({ id: 'projectList.filter.projectAria' })}
      label={intl.formatMessage({ id: 'projectList.filter.project' })}
      allLabel={intl.formatMessage({ id: 'projectList.filter.all' })}
      value={projectFilter}
      onChange={setProjectFilter}
      align="right"
      options={filterProjects.map((project) => ({
        value: project.projectId,
        label: machineFilter ? project.displayName : `${project.machineName} · ${project.displayName}`,
      }))}
    />
  </>;

  const clearFiltersButton = (machineFilter || projectFilter) && (
    <button
      type="button"
      onClick={clearFilters}
      aria-label={intl.formatMessage({ id: 'projectList.filter.clear' })}
      title={intl.formatMessage({ id: 'projectList.filter.clear' })}
      className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-100"
    >
      <svg aria-hidden className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 6l12 12M18 6 6 18" />
      </svg>
      <FormattedMessage id="projectList.filter.clear" />
    </button>
  );

  const activeFilterCount = Number(Boolean(machineFilter)) + Number(Boolean(projectFilter));

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
      <div className="border-b border-slate-700/50 px-3 py-3">
        <div className={`${compact ? '' : 'mx-auto max-w-lg'} grid grid-cols-3 gap-1 rounded-xl border border-slate-700/70 bg-slate-900/50 p-1`}>
          <TabButton tab="sessions" active={tab === 'sessions'} onClick={() => setTab('sessions')} label={intl.formatMessage({ id: 'projectList.tab.sessions' })} count={flatSessions.length} />
          <TabButton tab="terminals" active={tab === 'terminals'} onClick={() => setTab('terminals')} label={intl.formatMessage({ id: 'projectList.tab.terminals' })} count={terminalCount} />
          <TabButton tab="files" active={tab === 'files'} onClick={() => setTab('files')} label={intl.formatMessage({ id: 'projectList.tab.files' })} />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {tab === 'sessions' && (
          <div className={compact ? 'pb-5' : 'mx-auto max-w-lg pb-5'}>
            <div className="px-3 pt-3">
              <div className="rounded-xl border border-slate-700/60 bg-slate-800/35">
                <button
                  type="button"
                  aria-expanded={filtersExpanded}
                  aria-controls="session-list-filters"
                  onClick={() => setFiltersExpanded((expanded) => !expanded)}
                  className="flex min-h-10 w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs font-medium text-slate-400 transition-colors hover:bg-slate-700/50 hover:text-slate-200"
                >
                  <svg aria-hidden className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                    <path d="M4 6h16M7 12h10m-7 6h4" />
                  </svg>
                  <span className="flex-1"><FormattedMessage id="projectList.filter.title" /></span>
                  {activeFilterCount > 0 && (
                    <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] text-blue-200">
                      <FormattedMessage id="projectList.filter.activeCount" values={{ count: activeFilterCount }} />
                    </span>
                  )}
                  <svg aria-hidden className={`h-3.5 w-3.5 shrink-0 transition-transform ${filtersExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>
                {filtersExpanded && (
                  <div id="session-list-filters" className="border-t border-slate-700/60 px-2.5 py-3">
                    <div className="grid grid-cols-2 gap-2">{filters}</div>
                    {clearFiltersButton && <div className="flex justify-end pt-2">{clearFiltersButton}</div>}
                  </div>
                )}
              </div>
            </div>

            {filteredSessions.length > 0 && (
              <div className="space-y-5 px-3 pt-3">
                {sessionGroups.map((group) => (
                  <section key={group.id}>
                    <h3 className="flex items-center justify-between px-2 pb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-500">
                      <FormattedMessage id={`projectList.group.${group.id}`} />
                      <span className="font-medium tabular-nums tracking-normal text-slate-500">{group.sessions.length}</span>
                    </h3>
                    <div className="space-y-1">{group.sessions.map(renderSessionCard)}</div>
                  </section>
                ))}
              </div>
            )}

            {filteredSessions.length === 0 && (
              <div className="mx-3 mt-4 rounded-xl border border-dashed border-slate-700 bg-slate-800/40 px-4 py-10 text-center text-sm text-slate-500">
                {machineFilter || projectFilter ? <FormattedMessage id="projectList.empty.noMatchingTasks" /> : <FormattedMessage id="projectList.empty.noTasks" />}
              </div>
            )}
          </div>
        )}
        {tab === 'terminals' && <TerminalListSection />}
        {tab === 'files' && <FileBrowserSection />}
      </div>
    </div>
  );
}

function FilterDropdown({
  ariaLabel,
  label,
  allLabel,
  value,
  onChange,
  options,
  align = 'left',
}: {
  ariaLabel: string;
  label: string;
  allLabel: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listId = useId();
  const allOptions = [{ value: '', label: allLabel }, ...options];
  const selectedLabel = allOptions.find((option) => option.value === value)?.label ?? allLabel;
  const selectedIndex = Math.max(0, allOptions.findIndex((option) => option.value === value));

  useEffect(() => {
    if (!open) return;
    optionRefs.current[selectedIndex]?.focus();
    const closeOnOutside = (event: PointerEvent | FocusEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('focusin', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('focusin', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open, selectedIndex]);

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label={`${ariaLabel}: ${selectedLabel}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={`flex min-h-12 w-full min-w-0 items-center gap-1.5 rounded-lg border px-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 ${open || value
          ? 'border-blue-400/40 bg-blue-500/10 text-slate-100'
          : 'border-slate-600/70 bg-slate-900/50 text-slate-200 hover:border-slate-500 hover:bg-slate-800'}`}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[10px] leading-4 text-slate-400">{label}</span>
          <span className="block truncate text-xs font-medium" title={selectedLabel}>{selectedLabel}</span>
        </span>
        <svg aria-hidden className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          onKeyDown={(event) => {
            const buttons = optionRefs.current.filter((button): button is HTMLButtonElement => button !== null);
            const current = buttons.findIndex((button) => button === document.activeElement);
            let next = current;
            if (event.key === 'ArrowDown') next = (current + 1) % buttons.length;
            else if (event.key === 'ArrowUp') next = (current - 1 + buttons.length) % buttons.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = buttons.length - 1;
            else return;
            event.preventDefault();
            buttons[next]?.focus();
          }}
          className={`absolute top-full z-40 mt-1 max-h-56 w-56 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-slate-600 bg-slate-800 p-1 shadow-2xl ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          {allOptions.map((option, index) => (
            <button
              key={option.value}
              ref={(node) => { optionRefs.current[index] = node; }}
              type="button"
              role="option"
              aria-selected={option.value === value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
                triggerRef.current?.focus();
              }}
              className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 ${option.value === value
                ? 'bg-blue-500/15 text-blue-200'
                : 'text-slate-200 hover:bg-slate-700'}`}
              title={option.label}
            >
              <span className="truncate">{option.label}</span>
              {option.value === value && <span aria-hidden className="text-blue-300">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type ProjectListTab = 'sessions' | 'terminals' | 'files';

function TabIcon({ tab }: { tab: ProjectListTab }) {
  return (
    <svg aria-hidden className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {tab === 'sessions' && <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>}
      {tab === 'terminals' && <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3m5 0h5" /></>}
      {tab === 'files' && <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />}
    </svg>
  );
}

function TabButton({ tab, active, onClick, label, count }: { tab: ProjectListTab; active: boolean; onClick: () => void; label: string; count?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`relative flex min-w-0 flex-col items-center gap-1 rounded-lg px-1 py-2 text-[11px] font-medium transition-colors ${active
        ? 'bg-blue-500/15 text-blue-200 ring-1 ring-blue-400/25'
        : 'text-slate-400 hover:bg-slate-700/70 hover:text-slate-100'}`}
    >
      <TabIcon tab={tab} />
      {label}
      {typeof count === 'number' && count > 0 && (
        <span className={`absolute right-1 top-1 rounded-full px-1 text-[9px] leading-4 tabular-nums ${active ? 'bg-blue-400/15 text-blue-200' : 'bg-slate-700 text-slate-400'}`}>
          {count}
        </span>
      )}
    </button>
  );
}
