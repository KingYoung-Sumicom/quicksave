// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTerminalStore } from '../../stores/terminalStore';
import { useTerminalOps } from '../../hooks/useTerminalOps';
import { getBusForAgent } from '../../lib/busRegistry';
import { useProjects, type ProjectEntry } from '../../hooks/useProjects';
import { useMachineStore, type Machine } from '../../stores/machineStore';
import { Spinner } from '../ui/Spinner';
import { toProjectId } from '../../lib/projectId';
import { MachineIcon } from '../icons/MachineIcon';

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/**
 * Flat terminal list for the home page — one row per PTY across every
 * connected machine. Meta row mirrors SessionTicketCard's style: project
 * name + machine pill.
 */
export function TerminalListSection() {
  const navigate = useNavigate();
  const terminals = useTerminalStore((s) => s.terminals);
  const projects = useProjects();
  const machines = useMachineStore((s) => s.machines);
  const targetAgentIdRef = useRef('');
  const { createTerminal } = useTerminalOps(
    useCallback(() => getBusForAgent(targetAgentIdRef.current), []),
  );
  const [picking, setPicking] = useState(false);
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const projectByKey = useMemo(() => {
    const map = new Map<string, ProjectEntry>();
    for (const p of projects) map.set(`${p.agentId}\0${p.cwd}`, p);
    return map;
  }, [projects]);

  const machineByAgent = useMemo(() => {
    const map = new Map<string, typeof machines[number]>();
    for (const m of machines) map.set(m.agentId, m);
    return map;
  }, [machines]);

  const rows = useMemo(() => {
    return Object.values(terminals)
      .filter((t) => t.machineAgentId)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }, [terminals]);

  const handleSpawn = useCallback(async (project: ProjectEntry) => {
    setCreateError(null);
    setCreatingFor(project.projectId);
    targetAgentIdRef.current = project.agentId;
    try {
      const res = await createTerminal({ cwd: project.cwd });
      if (res.success && res.terminal) {
        setPicking(false);
        navigate(`/p/${project.projectId}/t/${res.terminal.terminalId}`);
      } else {
        setCreateError(res.error ?? 'Failed to create terminal');
      }
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingFor(null);
    }
  }, [createTerminal, navigate]);

  const handleNewTerminal = useCallback(() => {
    setCreateError(null);
    setPicking(true);
  }, []);

  return (
    <div className="max-w-lg mx-auto py-4 space-y-4">
      <div className="px-4">
        <button
          onClick={handleNewTerminal}
          disabled={creatingFor !== null}
          className="w-full flex items-center justify-center gap-2 rounded-lg px-3 py-2 bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 text-sm font-medium transition-colors disabled:opacity-50"
        >
          {creatingFor ? (
            <Spinner size="w-4 h-4" color="border-blue-400" />
          ) : (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          )}
          New terminal
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="text-center text-sm text-slate-500 py-12 px-6">
          No terminals yet. Spawn one to run shell commands on any connected machine.
        </p>
      ) : (
        <div className="divide-y divide-slate-700/40">
          {rows.map((t) => {
            const project = projectByKey.get(`${t.machineAgentId}\0${t.cwd}`);
            const projectName = project?.displayName ?? t.cwd.split('/').pop() ?? t.cwd;
            const projectId = project?.projectId ?? toProjectId(t.machineAgentId, t.cwd);
            const machine = machineByAgent.get(t.machineAgentId);
            return (
              <button
                key={t.terminalId}
                onClick={() => navigate(`/p/${projectId}/t/${t.terminalId}`)}
                className="w-full text-left px-4 py-3 hover:bg-slate-700/30 active:bg-slate-700/50 transition-colors flex items-center gap-3"
              >
                <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 9l6 6 6-6M4 5h16" />
                </svg>
                <div className="flex-1 min-w-0">
                  <p className="list-title text-sm truncate">{t.title}</p>
                  <div className="list-meta flex items-center gap-1.5 mt-0.5 text-[11px] text-slate-500 flex-wrap">
                    <span className="text-slate-400">{projectName}</span>
                    {machine?.nickname && (
                      <span className="opacity-70">@ {machine.nickname}</span>
                    )}
                    {t.exited ? (
                      <span className="text-amber-400">· exited{t.exitCode != null ? ` (${t.exitCode})` : ''}</span>
                    ) : (
                      <span className="text-emerald-400">· running</span>
                    )}
                    <span className="opacity-70">· {formatRelativeTime(t.lastActivityAt)}</span>
                  </div>
                </div>
                <svg className="w-4 h-4 text-slate-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            );
          })}
        </div>
      )}

      {picking && (
        <ProjectPickerModal
          machines={machines}
          projects={projects}
          creatingFor={creatingFor}
          createError={createError}
          onPick={handleSpawn}
          onCancel={() => { setPicking(false); setCreateError(null); }}
        />
      )}
    </div>
  );
}

function ProjectPickerModal({
  machines,
  projects,
  creatingFor,
  createError,
  onPick,
  onCancel,
}: {
  machines: Machine[];
  projects: ProjectEntry[];
  creatingFor: string | null;
  createError: string | null;
  onPick: (p: ProjectEntry) => void;
  onCancel: () => void;
}) {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const firstOptionRef = useRef<HTMLButtonElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const selectedMachine = machines.find((m) => m.agentId === selectedAgentId);
  const machineProjects = projects.filter((p) => p.agentId === selectedAgentId);
  const projectCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const project of projects) {
      counts.set(project.agentId, (counts.get(project.agentId) ?? 0) + 1);
    }
    return counts;
  }, [projects]);

  useEffect(() => {
    (firstOptionRef.current ?? backButtonRef.current)?.focus();
  }, [selectedAgentId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && creatingFor === null) onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [creatingFor, onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="New terminal"
      onClick={() => { if (creatingFor === null) onCancel(); }}
    >
      <div
        className="w-full max-w-md bg-slate-800 rounded-t-xl sm:rounded-xl border border-slate-700 max-h-[80dvh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-slate-700">
          <div className="flex items-center gap-2">
            {selectedMachine && (
              <button
                type="button"
                ref={backButtonRef}
                onClick={() => setSelectedAgentId(null)}
                disabled={creatingFor !== null}
                aria-label="Back to machines"
                className="-ml-1 rounded-lg p-1.5 text-slate-400 hover:bg-slate-700 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m15 18-6-6 6-6" />
                </svg>
              </button>
            )}
            <h2 className="text-sm font-semibold text-slate-100">New terminal</h2>
          </div>
          <p className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-blue-400">
            {selectedMachine ? 'Step 2 of 2 · Project' : 'Step 1 of 2 · Machine'}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            {selectedMachine ? selectedMachine.nickname : 'Choose a machine, then a project'}
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {selectedMachine ? (
            machineProjects.length > 0 ? machineProjects.map((p, index) => (
              <button
                key={p.projectId}
                ref={index === 0 ? firstOptionRef : undefined}
                disabled={creatingFor !== null}
                onClick={() => onPick(p)}
                className="w-full min-h-11 text-left px-3 py-2.5 rounded-xl hover:bg-slate-700/70 active:bg-slate-700 flex items-center gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50"
              >
                <div className="flex-1 min-w-0">
                  <p className="list-title text-sm truncate">{p.displayName}</p>
                  <p className="list-meta text-[11px] text-slate-500 truncate">{p.cwd}</p>
                </div>
                {creatingFor === p.projectId ? <Spinner size="w-4 h-4" color="border-blue-400" /> : (
                  <span className="text-slate-500" aria-hidden="true">›</span>
                )}
              </button>
            )) : (
              <p className="px-3 py-8 text-center text-sm text-slate-400">No projects on this machine yet.</p>
            )
          ) : machines.length > 0 ? machines.map((machine, index) => (
            <button
              key={machine.agentId}
              ref={index === 0 ? firstOptionRef : undefined}
              onClick={() => setSelectedAgentId(machine.agentId)}
              className="w-full min-h-11 text-left px-3 py-2.5 rounded-xl hover:bg-slate-700/70 active:bg-slate-700 flex items-center gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              <MachineIcon className="h-4 w-4 shrink-0 text-slate-400" />
              <div className="flex-1 min-w-0">
                <p className="list-title text-sm truncate">{machine.nickname}</p>
                <p className="list-meta text-[11px] text-slate-500">
                  {projectCounts.get(machine.agentId) ?? 0} {(projectCounts.get(machine.agentId) ?? 0) === 1 ? 'project' : 'projects'}
                </p>
              </div>
              <span className="text-slate-500" aria-hidden="true">›</span>
            </button>
          )) : (
            <p className="px-3 py-8 text-center text-sm text-slate-400">Add a machine and project to create a terminal.</p>
          )}
        </div>
        {createError && <p className="px-4 py-2 text-xs text-red-400" role="alert">{createError}</p>}
        <button
          onClick={onCancel}
          disabled={creatingFor !== null}
          className="px-4 py-3 border-t border-slate-700 text-sm text-slate-400 hover:bg-slate-700/40 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
