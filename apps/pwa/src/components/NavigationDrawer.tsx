import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConnectionStore } from '../stores/connectionStore';
import { useClaudeStore } from '../stores/claudeStore';
import { agentUrl } from '../lib/pathHash';
import type { Repository, CodingPath, ClaudeSessionSummary } from '@sumicom/quicksave-shared';

interface NavigationDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  agentId: string;
  currentRepoPath: string | null;
  onOpenRepoSwitcher: () => void;
  onListSessions: (cwd?: string) => Promise<void>;
  onBackToFleet: () => void;
}

export function NavigationDrawer({
  isOpen,
  onClose,
  agentId,
  currentRepoPath,
  onOpenRepoSwitcher,
  onListSessions,
  onBackToFleet,
}: NavigationDrawerProps) {
  const navigate = useNavigate();
  const { availableRepos, availableCodingPaths } = useConnectionStore();
  const [sessionsByPath, setSessionsByPath] = useState<Map<string, ClaudeSessionSummary[]>>(new Map());

  // Fetch sessions for each coding path when drawer opens
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    const fetchAll = async () => {
      for (const cp of availableCodingPaths) {
        if (cancelled) return;
        try {
          await onListSessions(cp.path);
          const { sessions } = useClaudeStore.getState();
          if (!cancelled) {
            setSessionsByPath((prev) => {
              const next = new Map(prev);
              next.set(cp.path, sessions.filter((s) => s.cwd === cp.path || !s.cwd));
              return next;
            });
          }
        } catch {
          // ignore
        }
      }
    };
    fetchAll();
    return () => { cancelled = true; };
  }, [isOpen, availableCodingPaths, onListSessions]);

  if (!isOpen) return null;

  const handleNavigate = (url: string) => {
    onClose();
    navigate(url);
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/50"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="fixed inset-y-0 left-0 z-50 w-72 max-w-[80vw] bg-slate-800 flex flex-col animate-slide-in-left safe-area-top">
        {/* Header */}
        <div className="px-4 py-4 border-b border-slate-700">
          <button
            onClick={() => handleNavigate(`/agent/${agentId}`)}
            className="text-lg font-bold hover:text-blue-400 transition-colors"
          >
            Dashboard
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto py-3">
          {/* Repositories */}
          <SectionHeader title="Repositories" onAdd={onOpenRepoSwitcher} />
          {availableRepos.map((repo) => (
            <RepoItem
              key={repo.path}
              repo={repo}
              active={repo.path === currentRepoPath}
              onClick={() => handleNavigate(agentUrl(agentId, 'repo', repo.path))}
            />
          ))}
          {availableRepos.length === 0 && (
            <p className="px-4 py-2 text-xs text-slate-500">No repos</p>
          )}

          {/* Coding */}
          <SectionHeader title="Coding" />
          {availableCodingPaths.map((cp) => {
            const sessions = sessionsByPath.get(cp.path) || [];
            return (
              <div key={cp.path}>
                <CodingItem
                  codingPath={cp}
                  onClick={() => handleNavigate(agentUrl(agentId, 'coding', cp.path))}
                />
                {sessions.slice(0, 3).map((session) => (
                  <button
                    key={session.sessionId}
                    onClick={() => handleNavigate(agentUrl(agentId, 'coding', cp.path, session.sessionId))}
                    className="w-full flex items-center gap-2 pl-10 pr-4 py-1.5 text-left text-xs text-slate-400 hover:bg-slate-700 transition-colors"
                  >
                    <span className="truncate">
                      {session.summary || session.sessionId.slice(0, 12)}
                    </span>
                    <span className="text-slate-600 flex-shrink-0 ml-auto">
                      {formatRelativeTime(session.lastModified)}
                    </span>
                  </button>
                ))}
              </div>
            );
          })}
          {availableCodingPaths.length === 0 && (
            <p className="px-4 py-2 text-xs text-slate-500">No coding paths</p>
          )}

        </div>

        {/* Footer — sticky bottom */}
        <div className="px-4 py-3 border-t border-slate-700 safe-area-bottom">
          <button
            onClick={() => { onClose(); onBackToFleet(); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back to Fleet
          </button>
        </div>
      </div>
    </>
  );
}

function SectionHeader({ title, onAdd }: { title: string; onAdd?: () => void }) {
  return (
    <div className="flex items-center justify-between px-4 pt-4 pb-1">
      <h3 className="text-xs font-medium text-slate-400 uppercase tracking-wide">{title}</h3>
      {onAdd && (
        <button onClick={onAdd} className="text-xs text-blue-400 hover:text-blue-300">
          + Add
        </button>
      )}
    </div>
  );
}

function RepoItem({ repo, active, onClick }: { repo: Repository; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-4 py-2 text-left text-sm hover:bg-slate-700 transition-colors ${
        active ? 'bg-slate-700/60 text-white' : 'text-slate-300'
      }`}
    >
      <svg className="w-4 h-4 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
      </svg>
      <span className="truncate">{repo.name}</span>
      {repo.currentBranch && (
        <span className="text-xs text-slate-500 flex-shrink-0 ml-auto">{repo.currentBranch}</span>
      )}
    </button>
  );
}

function CodingItem({ codingPath, onClick }: { codingPath: CodingPath; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-4 py-2 text-left text-sm text-slate-300 hover:bg-slate-700 transition-colors"
    >
      <svg className="w-4 h-4 text-purple-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
      <span className="truncate">{codingPath.name}</span>
    </button>
  );
}


function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
