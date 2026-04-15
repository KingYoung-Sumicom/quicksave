import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConnectionStore } from '../stores/connectionStore';
import type { Repository, CodingPath, ClaudeSessionSummary } from '@sumicom/quicksave-shared';
import { agentUrl } from '../lib/pathHash';
import { ChevronIcon } from './ui/ChevronIcon';
import { StatusDot, sessionStatusKey } from './SessionStatusBadge';
import { formatRelativeTime } from '../lib/formatRelativeTime';
import { ConfirmModal } from './ui/ConfirmModal';

interface AgentDashboardProps {
  agentId: string;
  editing: boolean;
  onListSessions: (cwd?: string) => Promise<void>;
  onAddRepo: () => void;
  onRemoveRepo: (path: string) => Promise<boolean>;
  onRemoveCodingPath: (path: string) => Promise<boolean>;
  onArchiveSession: (sessionId: string, cwd: string) => Promise<void>;
}

function RemoveButton({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      onClick={onClick}
      className="px-2 flex-shrink-0 text-red-500 hover:text-red-400 transition-colors"
    >
      <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM6.75 9.25a.75.75 0 000 1.5h6.5a.75.75 0 000-1.5h-6.5z" clipRule="evenodd" />
      </svg>
    </button>
  );
}

export function AgentDashboard({
  agentId,
  editing,
  onListSessions,
  onAddRepo,
  onRemoveRepo,
  onRemoveCodingPath,
  onArchiveSession,
}: AgentDashboardProps) {
  const navigate = useNavigate();
  const { availableRepos, availableCodingPaths } = useConnectionStore();
  const [sessionsByPath, setSessionsByPath] = useState<Map<string, ClaudeSessionSummary[]>>(new Map());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());

  // Fetch sessions for each coding path on mount
  useEffect(() => {
    let cancelled = false;
    const fetchAll = async () => {
      for (const cp of availableCodingPaths) {
        if (cancelled) return;
        setLoadingPaths((prev) => new Set(prev).add(cp.path));
        try {
          await onListSessions(cp.path);
          const { sessions } = await import('../stores/claudeStore').then((m) => m.useClaudeStore.getState());
          if (!cancelled) {
            setSessionsByPath((prev) => {
              const next = new Map(prev);
              next.set(cp.path, Object.values(sessions).filter((s) => s.cwd === cp.path));
              return next;
            });
          }
        } catch {
          // ignore
        } finally {
          if (!cancelled) {
            setLoadingPaths((prev) => {
              const next = new Set(prev);
              next.delete(cp.path);
              return next;
            });
          }
        }
      }
    };
    fetchAll();
    return () => { cancelled = true; };
  }, [availableCodingPaths, onListSessions]);

  const handleRepoClick = useCallback((repo: Repository) => {
    if (editing) return;
    navigate(agentUrl(agentId, 'repo', repo.path));
  }, [agentId, navigate, editing]);

  const handleCodingPathClick = useCallback((cp: CodingPath) => {
    if (editing) return;
    navigate(agentUrl(agentId, 'coding', cp.path));
  }, [agentId, navigate, editing]);

  const handleNewSessionClick = useCallback((cp: CodingPath) => {
    navigate(`${agentUrl(agentId, 'coding', cp.path)}?new`);
  }, [agentId, navigate]);

  const handleSessionClick = useCallback((cp: CodingPath, sessionId: string) => {
    if (editing) return;
    navigate(agentUrl(agentId, 'coding', cp.path, sessionId));
  }, [agentId, navigate, editing]);

  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    message: string;
    label: string;
    onConfirm: () => void;
  } | null>(null);

  const handleRemoveRepo = useCallback((e: React.MouseEvent, repo: Repository) => {
    e.stopPropagation();
    setConfirmAction({
      title: `Remove "${repo.name}"?`,
      message: 'This only removes it from the tracking list — the repo itself is not deleted.',
      label: 'Remove',
      onConfirm: () => { onRemoveRepo(repo.path); setConfirmAction(null); },
    });
  }, [onRemoveRepo]);

  const handleRemoveCodingPath = useCallback((e: React.MouseEvent, cp: CodingPath) => {
    e.stopPropagation();
    setConfirmAction({
      title: `Remove "${cp.name}"?`,
      message: 'This only removes it from the tracking list — the directory itself is not deleted.',
      label: 'Remove',
      onConfirm: () => { onRemoveCodingPath(cp.path); setConfirmAction(null); },
    });
  }, [onRemoveCodingPath]);

  const handleArchiveSession = useCallback((e: React.MouseEvent, cp: CodingPath, session: ClaudeSessionSummary) => {
    e.stopPropagation();
    setConfirmAction({
      title: 'Archive session?',
      message: `"${session.summary || session.sessionId.slice(0, 12)}" will be archived.`,
      label: 'Archive',
      onConfirm: () => {
        onArchiveSession(session.sessionId, cp.path);
        setSessionsByPath((prev) => {
          const next = new Map(prev);
          const sessions = next.get(cp.path) || [];
          next.set(cp.path, sessions.filter((s) => s.sessionId !== session.sessionId));
          return next;
        });
        setConfirmAction(null);
      },
    });
  }, [onArchiveSession]);

  return (
    <div className="flex-1 overflow-y-auto safe-area-bottom">
      <div className="px-4 py-6 max-w-lg mx-auto space-y-6">
        {/* Repositories */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-slate-400 uppercase tracking-wide">
              Repositories
            </h2>
            {!editing && (
              <button
                onClick={onAddRepo}
                className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
              >
                + Add
              </button>
            )}
          </div>
          {availableRepos.length === 0 ? (
            <p className="text-sm text-slate-500">No repositories. Add one to get started.</p>
          ) : (
            <div className="space-y-1">
              {availableRepos.map((repo) => (
                <div key={repo.path} className="flex items-center bg-slate-800 rounded-lg overflow-hidden">
                  {editing && <RemoveButton onClick={(e) => handleRemoveRepo(e, repo)} />}
                  <button
                    onClick={() => handleRepoClick(repo)}
                    className={`flex-1 flex items-center gap-3 px-3 py-2.5 transition-colors text-left min-w-0 ${
                      editing ? 'cursor-default' : 'hover:bg-slate-700'
                    }`}
                  >
                    <svg className="w-5 h-5 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                    </svg>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{repo.name}</p>
                      <p className="text-xs text-slate-500 truncate">{repo.path}</p>
                    </div>
                    {!editing && repo.currentBranch && (
                      <span className="text-xs text-slate-400 flex-shrink-0">{repo.currentBranch}</span>
                    )}
                    {!editing && <ChevronIcon size="w-4 h-4" className="text-slate-500" />}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Coding Paths */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-slate-400 uppercase tracking-wide">
              Coding
            </h2>
          </div>
          {availableCodingPaths.length === 0 ? (
            <p className="text-sm text-slate-500">No coding paths available.</p>
          ) : (
            <div className="space-y-4">
              {availableCodingPaths.map((cp) => {
                const sessions = sessionsByPath.get(cp.path) || [];
                const isLoading = loadingPaths.has(cp.path);
                return (
                  <div key={cp.path} className="bg-slate-800 rounded-lg overflow-hidden">
                    {/* Path header */}
                    <div className="flex items-center">
                      {editing && <RemoveButton onClick={(e) => handleRemoveCodingPath(e, cp)} />}
                      <button
                        onClick={() => handleCodingPathClick(cp)}
                        className={`flex-1 flex items-center gap-3 px-3 py-2.5 transition-colors text-left min-w-0 ${
                          editing ? 'cursor-default' : 'hover:bg-slate-700'
                        }`}
                      >
                        <svg className="w-5 h-5 text-purple-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{cp.name}</p>
                          <p className="text-xs text-slate-500 truncate">{cp.path}</p>
                        </div>
                        {!editing && <ChevronIcon size="w-4 h-4" className="text-slate-500" />}
                      </button>
                    </div>

                    {!editing && (
                      <div className="flex items-center justify-end px-3 py-2 border-t border-slate-700/80 bg-slate-800/80">
                        <button
                          onClick={() => handleNewSessionClick(cp)}
                          className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                        >
                          New Session
                        </button>
                      </div>
                    )}

                    {/* Sessions under this path */}
                    {isLoading ? (
                      <div className="px-3 py-2 border-t border-slate-700">
                        <div className="animate-pulse text-xs text-slate-500">Loading sessions...</div>
                      </div>
                    ) : sessions.length > 0 ? (
                      <div className="border-t border-slate-700">
                        {sessions.slice(0, editing ? 20 : 5).map((session) => (
                            <div
                              key={session.sessionId}
                              className="flex items-center hover:bg-slate-700/50 transition-colors"
                            >
                              {editing && (
                                <RemoveButton onClick={(e) => handleArchiveSession(e, cp, session)} />
                              )}
                              <button
                                onClick={() => handleSessionClick(cp, session.sessionId)}
                                className={`flex-1 flex items-center gap-2 px-3 py-2 text-left min-w-0 ${
                                  editing ? 'cursor-default' : ''
                                }`}
                              >
                                <StatusDot statusKey={sessionStatusKey(session)} />
                                <div className="flex-1 min-w-0">
                                  <p className="text-xs text-slate-300 truncate">
                                    {session.summary || session.sessionId.slice(0, 12)}
                                  </p>
                                  <p className="text-xs text-slate-500">
                                    {formatRelativeTime(session.lastModified)}
                                    {session.gitBranch && ` · ${session.gitBranch}`}
                                  </p>
                                </div>
                              </button>
                            </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </section>

      </div>

      {confirmAction && (
        <ConfirmModal
          title={confirmAction.title}
          message={confirmAction.message}
          confirmLabel={confirmAction.label}
          onConfirm={confirmAction.onConfirm}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </div>
  );
}
