import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { SESSION_STATUS, sessionStatusKey } from './SessionStatusBadge';
import { useConnectionStore } from '../stores/connectionStore';
import { SwipeableDrawer } from './SwipeableDrawer';
import { useClaudeStore } from '../stores/claudeStore';
import { useMachineStore, selectSortedMachines } from '../stores/machineStore';
import { agentUrl } from '../lib/pathHash';
import { formatRelativeTimeCompact as formatRelativeTime } from '../lib/formatRelativeTime';
import type { Repository, CodingPath, ClaudeSessionSummary } from '@sumicom/quicksave-shared';

interface NavigationDrawerProps {
  isOpen: boolean;
  persistent?: boolean;
  onClose: () => void;
  agentId: string;
  currentRepoPath: string | null;
  onAddRepo: () => void;
  onAddWorkspace: () => void;
  onListSessions: (cwd?: string) => Promise<void>;
  onBackToFleet: () => void;
  onSwitchMachine?: (agentId: string) => void;
  onOpen?: () => void;
}

export function NavigationDrawer({
  isOpen,
  persistent,
  onClose,
  agentId,
  currentRepoPath,
  onAddRepo,
  onAddWorkspace,
  onListSessions,
  onBackToFleet,
  onSwitchMachine,
  onOpen,
}: NavigationDrawerProps) {
  const navigate = useNavigate();
  const { availableRepos, availableCodingPaths } = useConnectionStore();
  const { agentId: connectedAgentId } = useConnectionStore();
  const machines = useMachineStore(selectSortedMachines);
  const activeSessionId = useClaudeStore((s) => s.activeSessionId);
  const storeSessions = useClaudeStore((s) => s.sessions);
  const [sessionsByPath, setSessionsByPath] = useState<Map<string, ClaudeSessionSummary[]>>(new Map());
  const [showMachineSwitcher, setShowMachineSwitcher] = useState(false);


  const currentMachine = machines.find((m) => m.agentId === connectedAgentId);
  const hasMultipleMachines = machines.length > 1;

  // Fetch sessions for each coding path when drawer opens or a session starts/ends
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
              next.set(cp.path, Object.values(sessions).filter((s) => s.cwd === cp.path || !s.cwd));
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
  }, [isOpen, availableCodingPaths, onListSessions, activeSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleNavigate = (url: string) => {
    if (!persistent) onClose();
    navigate(url);
  };

  const handleNewSession = (codingPath: string) => {
    const { setActiveSession, clearCards, setPromptInput } = useClaudeStore.getState();
    setActiveSession(null);
    clearCards();
    setPromptInput('');
    handleNavigate(agentUrl(agentId, 'coding', codingPath) + '?new');
  };

  // Persistent desktop sidebar
  if (persistent) {
    if (!isOpen) return null;

    return (
      <div className="w-64 flex-shrink-0 border-r border-slate-700 bg-slate-800 flex flex-col overflow-hidden">
        {/* Header: Machine switcher */}
        <div className="px-3 py-3 border-b border-slate-700 relative">
          <div className={clsx('flex items-center rounded-md', showMachineSwitcher && 'bg-slate-700')}>
            <button
              onClick={() => handleNavigate(`/agent/${agentId}`)}
              className="flex-1 flex items-center gap-2 px-2 py-1.5 hover:bg-slate-700 rounded-l-md transition-colors min-w-0"
            >
              <span className="text-lg">{currentMachine?.icon || '💻'}</span>
              <span className="font-semibold truncate">{currentMachine?.nickname || 'quicksave'}</span>
            </button>
            {hasMultipleMachines && (
              <button
                onClick={() => setShowMachineSwitcher(!showMachineSwitcher)}
                className="px-2 py-1.5 hover:bg-slate-700 rounded-r-md transition-colors flex-shrink-0"
              >
                <svg
                  className={clsx('w-4 h-4 text-slate-400 transition-transform', showMachineSwitcher && 'rotate-180')}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            )}
          </div>
          {showMachineSwitcher && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowMachineSwitcher(false)} />
              <div className="absolute left-2 right-2 top-full mt-1 bg-slate-700 rounded-lg shadow-lg z-20 overflow-hidden border border-slate-600">
                <div className="p-2 border-b border-slate-600">
                  <p className="text-xs text-slate-400 px-2">Switch Machine</p>
                </div>
                <div className="max-h-48 overflow-y-auto">
                  {machines.map((machine) => (
                    <button
                      key={machine.agentId}
                      onClick={() => {
                        setShowMachineSwitcher(false);
                        if (machine.agentId !== connectedAgentId && onSwitchMachine) {
                          onSwitchMachine(machine.agentId);
                        }
                      }}
                      className={clsx(
                        'w-full flex items-center gap-3 px-4 py-2.5 hover:bg-slate-600 transition-colors',
                        machine.agentId === connectedAgentId && 'bg-slate-600/50'
                      )}
                    >
                      <span className="text-lg">{machine.icon}</span>
                      <div className="flex-1 text-left min-w-0">
                        <p className="text-sm font-medium truncate">{machine.nickname}</p>
                        <p className="text-xs text-slate-400 truncate">{machine.lastRepoPath || 'No repo'}</p>
                      </div>
                      {machine.agentId === connectedAgentId && (
                        <span className="text-green-400 text-xs flex-shrink-0">Connected</span>
                      )}
                    </button>
                  ))}
                </div>
                <div className="p-2 border-t border-slate-600">
                  <button
                    onClick={() => { setShowMachineSwitcher(false); onBackToFleet(); }}
                    className="w-full px-4 py-2 text-sm text-blue-400 hover:bg-slate-600 rounded-md transition-colors text-left"
                  >
                    Manage Machines...
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto py-3">
          <SectionHeader title="Repositories" onAdd={onAddRepo} />
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

          <SectionHeader title="Coding" onAdd={onAddWorkspace} />
          {availableCodingPaths.map((cp) => {
            const baseSessions = sessionsByPath.get(cp.path) || [];
            // Merge live state from store (push-updated) into fetched sessions
            const sessions = baseSessions.map((s) => {
              const live = storeSessions[s.sessionId];
              return live ? { ...s, isActive: live.isActive, isStreaming: live.isStreaming, hasPendingInput: live.hasPendingInput } : s;
            });
            const sorted = [...sessions].sort((a, b) => {
              const rank = (ss: ClaudeSessionSummary) => ss.isStreaming ? 2 : ss.isActive ? 1 : 0;
              return rank(b) - rank(a);
            });
            return (
              <div key={cp.path}>
                <CodingItem
                  codingPath={cp}
                  onClick={() => handleNavigate(agentUrl(agentId, 'coding', cp.path))}
                  onNewSession={() => handleNewSession(cp.path)}
                />
                {sorted.slice(0, 5).map((session) => (
                  <SessionItem
                    key={session.sessionId}
                    session={session}
                    onClick={() => handleNavigate(agentUrl(agentId, 'coding', cp.path, session.sessionId))}
                  />
                ))}
              </div>
            );
          })}
          {availableCodingPaths.length === 0 && (
            <p className="px-4 py-2 text-xs text-slate-500">No coding paths</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-slate-700">
          <button
            onClick={onBackToFleet}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back
          </button>
        </div>
      </div>
    );
  }

  // Mobile overlay drawer
  return (
    <SwipeableDrawer
      isOpen={isOpen}
      onClose={onClose}
      onOpen={onOpen}
      side="left"
      drawerWidth={288}
      className="w-72 max-w-[80vw] bg-slate-800 flex flex-col safe-area-top"
    >
        {/* Header: Machine switcher */}
        <div className="px-3 py-3 border-b border-slate-700 relative">
          <div className={clsx('flex items-center rounded-md', showMachineSwitcher && 'bg-slate-700')}>
            <button
              onClick={() => handleNavigate(`/agent/${agentId}`)}
              className="flex-1 flex items-center gap-2 px-2 py-1.5 hover:bg-slate-700 rounded-l-md transition-colors min-w-0"
            >
              <span className="text-lg">{currentMachine?.icon || '💻'}</span>
              <span className="font-semibold truncate">{currentMachine?.nickname || 'quicksave'}</span>
            </button>
            {hasMultipleMachines && (
              <button
                onClick={() => setShowMachineSwitcher(!showMachineSwitcher)}
                className="px-2 py-1.5 hover:bg-slate-700 rounded-r-md transition-colors flex-shrink-0"
              >
                <svg
                  className={clsx('w-4 h-4 text-slate-400 transition-transform', showMachineSwitcher && 'rotate-180')}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            )}
          </div>
          {showMachineSwitcher && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowMachineSwitcher(false)} />
              <div className="absolute left-2 right-2 top-full mt-1 bg-slate-700 rounded-lg shadow-lg z-20 overflow-hidden border border-slate-600">
                <div className="p-2 border-b border-slate-600">
                  <p className="text-xs text-slate-400 px-2">Switch Machine</p>
                </div>
                <div className="max-h-48 overflow-y-auto">
                  {machines.map((machine) => (
                    <button
                      key={machine.agentId}
                      onClick={() => {
                        setShowMachineSwitcher(false);
                        if (machine.agentId !== connectedAgentId && onSwitchMachine) {
                          onSwitchMachine(machine.agentId);
                        }
                      }}
                      className={clsx(
                        'w-full flex items-center gap-3 px-4 py-2.5 hover:bg-slate-600 transition-colors',
                        machine.agentId === connectedAgentId && 'bg-slate-600/50'
                      )}
                    >
                      <span className="text-lg">{machine.icon}</span>
                      <div className="flex-1 text-left min-w-0">
                        <p className="text-sm font-medium truncate">{machine.nickname}</p>
                        <p className="text-xs text-slate-400 truncate">{machine.lastRepoPath || 'No repo'}</p>
                      </div>
                      {machine.agentId === connectedAgentId && (
                        <span className="text-green-400 text-xs flex-shrink-0">Connected</span>
                      )}
                    </button>
                  ))}
                </div>
                <div className="p-2 border-t border-slate-600">
                  <button
                    onClick={() => { setShowMachineSwitcher(false); onBackToFleet(); }}
                    className="w-full px-4 py-2 text-sm text-blue-400 hover:bg-slate-600 rounded-md transition-colors text-left"
                  >
                    Manage Machines...
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto py-3">
          <SectionHeader title="Repositories" onAdd={onAddRepo} />
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

          <SectionHeader title="Coding" onAdd={onAddWorkspace} />
          {availableCodingPaths.map((cp) => {
            const baseSessions = sessionsByPath.get(cp.path) || [];
            // Merge live state from store (push-updated) into fetched sessions
            const sessions = baseSessions.map((s) => {
              const live = storeSessions[s.sessionId];
              return live ? { ...s, isActive: live.isActive, isStreaming: live.isStreaming, hasPendingInput: live.hasPendingInput } : s;
            });
            const sorted = [...sessions].sort((a, b) => {
              const rank = (ss: ClaudeSessionSummary) => ss.isStreaming ? 2 : ss.isActive ? 1 : 0;
              return rank(b) - rank(a);
            });
            return (
              <div key={cp.path}>
                <CodingItem
                  codingPath={cp}
                  onClick={() => handleNavigate(agentUrl(agentId, 'coding', cp.path))}
                  onNewSession={() => handleNewSession(cp.path)}
                />
                {sorted.slice(0, 5).map((session) => (
                  <SessionItem
                    key={session.sessionId}
                    session={session}
                    onClick={() => handleNavigate(agentUrl(agentId, 'coding', cp.path, session.sessionId))}
                  />
                ))}
              </div>
            );
          })}
          {availableCodingPaths.length === 0 && (
            <p className="px-4 py-2 text-xs text-slate-500">No coding paths</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-slate-700 safe-area-bottom">
          <button
            onClick={() => { onClose(); onBackToFleet(); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back
          </button>
        </div>
    </SwipeableDrawer>
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

function CodingItem({ codingPath, onClick, onNewSession }: { codingPath: CodingPath; onClick: () => void; onNewSession: () => void }) {
  return (
    <div className="flex items-center hover:bg-slate-700 transition-colors">
      <button
        onClick={onClick}
        className="flex-1 flex items-center gap-2 px-4 py-2 text-left text-sm text-slate-300 min-w-0"
      >
        <svg className="w-4 h-4 text-purple-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        <span className="truncate">{codingPath.name}</span>
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onNewSession(); }}
        title="New session"
        className="px-2 py-1 mr-2 text-slate-500 hover:text-purple-400 transition-colors"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
      </button>
    </div>
  );
}

function SessionItem({ session, onClick }: { session: ClaudeSessionSummary; onClick: () => void }) {
  const statusKey = sessionStatusKey(session);
  const dotColor = SESSION_STATUS[statusKey].dotColor;
  const pulse = SESSION_STATUS[statusKey].pulse;

  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 pl-10 pr-4 py-1.5 text-left text-xs hover:bg-slate-700 transition-colors ${
        session.isActive ? 'text-white' : 'text-slate-400'
      }`}
    >
      <span className={clsx('w-1.5 h-1.5 rounded-full flex-shrink-0', dotColor, pulse && 'animate-pulse')} />
      <span className="truncate flex-1 min-w-0">
        {session.summary || session.sessionId.slice(0, 12)}
      </span>
      <span className="flex-shrink-0 text-slate-600">{formatRelativeTime(session.lastModified)}</span>
    </button>
  );
}

