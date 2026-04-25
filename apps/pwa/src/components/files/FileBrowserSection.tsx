import { useNavigate } from 'react-router-dom';
import { useProjects, type ProjectEntry } from '../../hooks/useProjects';
import { useMachineStore } from '../../stores/machineStore';
import { useMemo } from 'react';

/**
 * Flat list of projects the user can open in the file browser. One row
 * per project → navigates to `/p/:projectId/files` (directory listing
 * at the project root). Mirrors TerminalListSection's row style.
 */
export function FileBrowserSection() {
  const navigate = useNavigate();
  const projects = useProjects();
  const machines = useMachineStore((s) => s.machines);

  const machineByAgent = useMemo(() => {
    const map = new Map<string, typeof machines[number]>();
    for (const m of machines) map.set(m.agentId, m);
    return map;
  }, [machines]);

  return (
    <div className="max-w-lg mx-auto py-4 space-y-4">
      {projects.length === 0 ? (
        <p className="text-center text-sm text-slate-500 py-12 px-6">
          No projects yet. Add a project first to browse its files.
        </p>
      ) : (
        <div className="divide-y divide-slate-700/40">
          {projects.map((p: ProjectEntry) => {
            const machine = machineByAgent.get(p.agentId);
            return (
              <button
                key={p.projectId}
                onClick={() => navigate(`/p/${p.projectId}/files`)}
                className="w-full text-left px-4 py-3 hover:bg-slate-700/30 active:bg-slate-700/50 transition-colors flex items-center gap-3"
              >
                <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                </svg>
                <div className="flex-1 min-w-0">
                  <p className="list-title text-sm truncate">{p.displayName}</p>
                  <div className="list-meta flex items-center gap-1.5 mt-0.5 text-[11px] text-slate-500 flex-wrap">
                    <span className="text-slate-400 truncate">{p.cwd}</span>
                    {machine?.nickname && (
                      <span className="opacity-70">@ {machine.nickname}</span>
                    )}
                    {!p.isConnected && (
                      <span className="text-amber-400">· offline</span>
                    )}
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
    </div>
  );
}
