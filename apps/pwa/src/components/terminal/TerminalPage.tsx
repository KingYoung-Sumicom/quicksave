// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { BaseStatusBar, BackButton } from '../BaseStatusBar';
import { useTerminalStore } from '../../stores/terminalStore';
import { useTerminalOps } from '../../hooks/useTerminalOps';
import { getBusForAgent } from '../../lib/busRegistry';
import { fromProjectId } from '../../lib/projectId';
import { TerminalView } from './TerminalView';

interface Params extends Record<string, string | undefined> {
  projectId: string;
  terminalId: string;
}

export function TerminalPage() {
  const { projectId, terminalId } = useParams<Params>();
  const navigate = useNavigate();
  const location = useLocation();
  const terminal = useTerminalStore((s) =>
    terminalId ? s.terminals[terminalId] : undefined,
  );
  // Resolve which agent owns this terminal from the URL — the terminal
  // store row also has machineAgentId, but on a deep-link / fresh PWA
  // session the store may not be hydrated yet, so the URL is the only
  // reliable source.
  const ownerAgentId = useMemo(() => {
    if (terminal?.machineAgentId) return terminal.machineAgentId;
    return projectId ? fromProjectId(projectId).agentId : null;
  }, [projectId, terminal?.machineAgentId]);
  // Bind ops to the owner agent's bus, NOT getActiveBus. The active agent
  // can change between visits (user switches workspaces), and querying the
  // wrong agent's bus for a terminal subscription returns null → renders
  // "[terminal not found]" even though the terminal is alive elsewhere.
  const getBus = useCallback(
    () => (ownerAgentId ? getBusForAgent(ownerAgentId) : null),
    [ownerAgentId],
  );
  const { closeTerminal, renameTerminal } = useTerminalOps(getBus);
  const [showMenu, setShowMenu] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');

  useEffect(() => {
    if (terminal) setDraftTitle(terminal.title);
  }, [terminal?.title]); // eslint-disable-line react-hooks/exhaustive-deps

  const projectBasePath = projectId ? `/p/${projectId}` : '/';

  // Prefer history-back so the user lands wherever they came from (home tab,
  // session, etc.). Fall back to projectBasePath only on a deep-link / refresh
  // where there's no prior entry to pop (`location.key === 'default'`).
  const goBack = useCallback(() => {
    if (location.key !== 'default') navigate(-1);
    else navigate(projectBasePath, { replace: true });
  }, [location.key, navigate, projectBasePath]);

  const handleClose = useCallback(async () => {
    if (!terminalId) return;
    try {
      await closeTerminal(terminalId, true);
    } catch (err) {
      console.warn('[terminal] close failed:', err);
    }
    goBack();
  }, [terminalId, closeTerminal, goBack]);

  const handleRename = useCallback(async () => {
    if (!terminalId || !draftTitle.trim()) {
      setEditingTitle(false);
      return;
    }
    try {
      await renameTerminal(terminalId, draftTitle);
    } catch (err) {
      console.warn('[terminal] rename failed:', err);
    }
    setEditingTitle(false);
  }, [terminalId, draftTitle, renameTerminal]);

  if (!terminalId) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
        No terminal selected.
      </div>
    );
  }

  const title = terminal?.title ?? terminalId.slice(0, 10);
  const subtitle = terminal?.exited
    ? `exited${terminal.exitCode != null ? ` (${terminal.exitCode})` : ''}`
    : terminal?.cwd;

  return (
    <div className="flex flex-col h-full overflow-hidden bg-slate-900">
      <BaseStatusBar
        left={<BackButton onClick={goBack} />}
        center={
          editingTitle ? (
            <input
              autoFocus
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onBlur={handleRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRename();
                if (e.key === 'Escape') {
                  setDraftTitle(terminal?.title ?? '');
                  setEditingTitle(false);
                }
              }}
              className="bg-slate-800 border border-slate-600 rounded px-2 py-0.5 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          ) : (
            <button
              className="flex flex-col items-center min-w-0"
              onClick={() => setEditingTitle(true)}
              title="Rename terminal"
            >
              <span className="text-sm font-medium text-slate-200 truncate max-w-[60vw]">{title}</span>
              {subtitle && (
                <span className="text-[11px] text-slate-500 truncate max-w-[60vw]">{subtitle}</span>
              )}
            </button>
          )
        }
        right={
          <div className="relative">
            <button
              onClick={() => setShowMenu((v) => !v)}
              className="p-1.5 rounded-md transition-colors hover:bg-slate-700 text-slate-400"
              aria-label="Terminal actions"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01" />
              </svg>
            </button>
            {showMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
                <div className="absolute right-0 top-full mt-1 z-50 w-44 bg-slate-700 rounded-lg shadow-xl border border-slate-600 py-1">
                  <button
                    onClick={() => { setShowMenu(false); setEditingTitle(true); }}
                    className="w-full text-left px-4 py-2 text-sm text-slate-300 hover:bg-slate-600 transition-colors"
                  >
                    Rename
                  </button>
                  <button
                    onClick={() => { setShowMenu(false); void handleClose(); }}
                    className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-slate-600 transition-colors"
                  >
                    Kill terminal
                  </button>
                </div>
              </>
            )}
          </div>
        }
      />
      <div className="flex-1 min-h-0">
        <TerminalView terminalId={terminalId} getBus={getBus} onExit={goBack} />
      </div>
    </div>
  );
}
