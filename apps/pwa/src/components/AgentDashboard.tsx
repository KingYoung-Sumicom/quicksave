import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConnectionStore } from '../stores/connectionStore';
import type { Repository, CodingPath, ClaudeSessionSummary } from '@sumicom/quicksave-shared';
import { agentUrl } from '../lib/pathHash';
import { SESSION_STATUS, sessionStatusKey } from './SessionStatusBadge';
import { formatRelativeTime } from '../lib/formatRelativeTime';

interface AgentDashboardProps {
  agentId: string;
  onListSessions: (cwd?: string) => Promise<void>;
  onAddRepo: () => void;
}

export function AgentDashboard({
  agentId,
  onListSessions,
  onAddRepo,
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
          // We need to get sessions via the store — listSessions updates the store
          // For now we call it per path; the store holds the latest result
          await onListSessions(cp.path);
          // Read sessions from store after call (they'll be in claudeStore.sessions)
          // Since the hook updates the global sessions, we snapshot them per path
          const { sessions } = await import('../stores/claudeStore').then((m) => m.useClaudeStore.getState());
          if (!cancelled) {
            setSessionsByPath((prev) => {
              const next = new Map(prev);
              next.set(cp.path, sessions.filter((s) => s.cwd === cp.path || !s.cwd));
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
    navigate(agentUrl(agentId, 'repo', repo.path));
  }, [agentId, navigate]);

  const handleCodingPathClick = useCallback((cp: CodingPath) => {
    navigate(agentUrl(agentId, 'coding', cp.path));
  }, [agentId, navigate]);

  const handleSessionClick = useCallback((cp: CodingPath, sessionId: string) => {
    navigate(agentUrl(agentId, 'coding', cp.path, sessionId));
  }, [agentId, navigate]);

  return (
    <div className="flex-1 overflow-y-auto safe-area-bottom">
      <div className="px-4 py-6 max-w-lg mx-auto space-y-6">
        {/* Repositories */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-slate-400 uppercase tracking-wide">
              Repositories
            </h2>
            <button
              onClick={onAddRepo}
              className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
            >
              + Add
            </button>
          </div>
          {availableRepos.length === 0 ? (
            <p className="text-sm text-slate-500">No repositories. Add one to get started.</p>
          ) : (
            <div className="space-y-1">
              {availableRepos.map((repo) => (
                <button
                  key={repo.path}
                  onClick={() => handleRepoClick(repo)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors text-left"
                >
                  <svg className="w-5 h-5 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{repo.name}</p>
                    <p className="text-xs text-slate-500 truncate">{repo.path}</p>
                  </div>
                  {repo.currentBranch && (
                    <span className="text-xs text-slate-400 flex-shrink-0">{repo.currentBranch}</span>
                  )}
                  <svg className="w-4 h-4 text-slate-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
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
                    <button
                      onClick={() => handleCodingPathClick(cp)}
                      className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-slate-700 transition-colors text-left"
                    >
                      <svg className="w-5 h-5 text-purple-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{cp.name}</p>
                        <p className="text-xs text-slate-500 truncate">{cp.path}</p>
                      </div>
                      <span className="text-xs text-blue-400 flex-shrink-0">New Session</span>
                    </button>

                    {/* Sessions under this path */}
                    {isLoading ? (
                      <div className="px-3 py-2 border-t border-slate-700">
                        <div className="animate-pulse text-xs text-slate-500">Loading sessions...</div>
                      </div>
                    ) : sessions.length > 0 ? (
                      <div className="border-t border-slate-700">
                        {sessions.slice(0, 5).map((session) => (
                          <button
                            key={session.sessionId}
                            onClick={() => handleSessionClick(cp, session.sessionId)}
                            className="w-full flex items-center gap-2 px-3 py-2 hover:bg-slate-700/50 transition-colors text-left"
                          >
                            {(() => {
                              const sk = sessionStatusKey(session);
                              const s = SESSION_STATUS[sk];
                              return <span className={`w-2 h-2 rounded-full flex-shrink-0 ${s.dotColor}${s.pulse ? ' animate-pulse' : ''}`} />;
                            })()}
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
    </div>
  );
}

