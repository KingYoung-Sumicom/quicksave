import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import type {
  Repository,
  CodingPath,
  BrowseDirectoryResponsePayload,
  DirectoryEntry,
} from '@sumicom/quicksave-shared';
import { useConnectionStore } from '../stores/connectionStore';
import { useMachineStore } from '../stores/machineStore';
import { useProjects } from '../hooks/useProjects';
import { BaseStatusBar, BackButton } from './BaseStatusBar';
import { ChevronIcon } from './ui/ChevronIcon';
import { Spinner } from './ui/Spinner';
import { toProjectId } from '../lib/projectId';

type TabKey = 'project' | 'repo' | 'session';

interface AddNewPageProps {
  onSetActiveAgent: (agentId: string) => void;
  onBrowseDirectory: (path?: string) => Promise<BrowseDirectoryResponsePayload | null>;
  onAddRepo: (path: string) => Promise<Repository | null>;
  onCloneRepo: (url: string, targetDir: string) => Promise<Repository | null>;
  onAddCodingPath: (path: string) => Promise<CodingPath | null>;
}

export function AddNewPage({
  onSetActiveAgent,
  onBrowseDirectory,
  onAddRepo,
  onCloneRepo,
  onAddCodingPath,
}: AddNewPageProps) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>('project');
  const agentConnections = useConnectionStore((s) => s.agentConnections);
  const machines = useMachineStore((s) => s.machines);

  const connectedMachines = useMemo(
    () => machines.filter((m) => agentConnections[m.agentId]?.state === 'connected'),
    [machines, agentConnections]
  );

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(
    () => connectedMachines[0]?.agentId ?? null
  );

  // If the selected machine disconnects or the list changes, fall back to the first available.
  useEffect(() => {
    if (selectedAgentId && connectedMachines.some((m) => m.agentId === selectedAgentId)) return;
    setSelectedAgentId(connectedMachines[0]?.agentId ?? null);
  }, [connectedMachines, selectedAgentId]);

  // Route subsequent browse/add calls to the picked agent.
  useEffect(() => {
    if (selectedAgentId) onSetActiveAgent(selectedAgentId);
  }, [selectedAgentId, onSetActiveAgent]);

  const goBack = useCallback(() => {
    navigate(-1);
  }, [navigate]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <BaseStatusBar
        left={<BackButton onClick={goBack} />}
        center={<span className="text-sm font-medium text-slate-300">Add New</span>}
      />

      <div className="flex border-b border-slate-700 px-2">
        {(['project', 'repo', 'session'] as const).map((key) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={clsx(
              'flex-1 py-3 text-sm font-medium border-b-2 transition-colors',
              tab === key
                ? 'border-blue-500 text-white'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            )}
          >
            {key === 'project' ? 'Project' : key === 'repo' ? 'Git Repo' : 'Session'}
          </button>
        ))}
      </div>

      {(tab === 'project' || tab === 'repo') && connectedMachines.length > 1 && (
        <div className="px-4 py-3 border-b border-slate-700 flex flex-wrap gap-2">
          {connectedMachines.map((m) => (
            <button
              key={m.agentId}
              onClick={() => setSelectedAgentId(m.agentId)}
              className={clsx(
                'px-2.5 py-1 rounded-full text-xs font-medium transition-colors flex items-center gap-1.5',
                selectedAgentId === m.agentId
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
              )}
            >
              <span>{m.icon}</span>
              <span>{m.nickname}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-hidden flex flex-col">
        {tab === 'project' && (
          <ProjectTab
            selectedAgentId={selectedAgentId}
            onBrowseDirectory={onBrowseDirectory}
            onAddCodingPath={onAddCodingPath}
            onDone={(agentId, path) => {
              if (agentId && path) {
                navigate(`/p/${toProjectId(agentId, path)}`);
              } else {
                goBack();
              }
            }}
          />
        )}
        {tab === 'repo' && (
          <RepoTab
            selectedAgentId={selectedAgentId}
            onBrowseDirectory={onBrowseDirectory}
            onAddRepo={onAddRepo}
            onCloneRepo={onCloneRepo}
            onDone={goBack}
          />
        )}
        {tab === 'session' && <SessionTab />}
      </div>
    </div>
  );
}

// ── Shared directory browser hook ───────────────────────────────────────────

function useDirectoryBrowser(
  resetKey: string | null,
  onBrowseDirectory: (path?: string) => Promise<BrowseDirectoryResponsePayload | null>
) {
  const [currentPath, setCurrentPath] = useState<string>('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (path?: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await onBrowseDirectory(path);
        if (res) {
          if (res.error) {
            setError(res.error);
          } else {
            setCurrentPath(res.path);
            setParentPath(res.parentPath);
            setEntries(res.entries);
          }
        }
      } catch {
        setError('Failed to browse directory');
      } finally {
        setLoading(false);
      }
    },
    [onBrowseDirectory]
  );

  // Reload home whenever the routing key (selected agent) changes.
  useEffect(() => {
    if (!resetKey) return;
    setCurrentPath('');
    setParentPath(null);
    setEntries([]);
    load();
  }, [resetKey, load]);

  return { currentPath, parentPath, entries, loading, error, setError, load };
}

// ── Project Tab ─────────────────────────────────────────────────────────────

function ProjectTab({
  selectedAgentId,
  onBrowseDirectory,
  onAddCodingPath,
  onDone,
}: {
  selectedAgentId: string | null;
  onBrowseDirectory: (path?: string) => Promise<BrowseDirectoryResponsePayload | null>;
  onAddCodingPath: (path: string) => Promise<CodingPath | null>;
  onDone: (agentId: string | null, path: string | null) => void;
}) {
  const { currentPath, parentPath, entries, loading, error, setError, load } =
    useDirectoryBrowser(selectedAgentId, onBrowseDirectory);
  const [adding, setAdding] = useState(false);

  if (!selectedAgentId) {
    return <EmptyAgentNotice message="Connect to a machine to add a project." />;
  }

  const handleSelect = async () => {
    if (!currentPath) return;
    setAdding(true);
    setError(null);
    const result = await onAddCodingPath(currentPath);
    setAdding(false);
    if (result) {
      onDone(selectedAgentId, result.path);
    } else {
      setError('Failed to add project');
    }
  };

  return (
    <>
      <div className="px-4 py-2 bg-slate-700/50 border-b border-slate-700 flex items-center gap-2">
        <p className="text-sm text-slate-300 truncate font-mono flex-1">{currentPath || '~'}</p>
        <button
          onClick={handleSelect}
          disabled={adding || !currentPath}
          className="flex-shrink-0 px-3 py-1 text-xs font-medium bg-purple-600 hover:bg-purple-500 disabled:opacity-50 rounded transition-colors"
        >
          {adding ? 'Adding...' : 'Select'}
        </button>
      </div>
      {error && <ErrorBar message={error} />}
      <BrowseList
        loading={loading}
        parentPath={parentPath}
        entries={entries}
        onNavigate={load}
        onSelectEntry={(entry) => entry.isDirectory && load(entry.path)}
        highlightRepos={false}
      />
    </>
  );
}

// ── Repo Tab ────────────────────────────────────────────────────────────────

function RepoTab({
  selectedAgentId,
  onBrowseDirectory,
  onAddRepo,
  onCloneRepo,
  onDone,
}: {
  selectedAgentId: string | null;
  onBrowseDirectory: (path?: string) => Promise<BrowseDirectoryResponsePayload | null>;
  onAddRepo: (path: string) => Promise<Repository | null>;
  onCloneRepo: (url: string, targetDir: string) => Promise<Repository | null>;
  onDone: () => void;
}) {
  const { currentPath, parentPath, entries, loading, error, setError, load } =
    useDirectoryBrowser(selectedAgentId, onBrowseDirectory);
  const availableRepos = useConnectionStore((s) => s.availableRepos);
  const [mode, setMode] = useState<'browse' | 'clone'>('browse');
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloning, setCloning] = useState(false);
  const [addingPath, setAddingPath] = useState<string | null>(null);

  if (!selectedAgentId) {
    return <EmptyAgentNotice message="Connect to a machine to add a repository." />;
  }

  const handleAddRepo = async (path: string) => {
    setAddingPath(path);
    setError(null);
    const repo = await onAddRepo(path);
    setAddingPath(null);
    if (repo) {
      onDone();
    } else {
      setError('Failed to add repository');
    }
  };

  const handleClone = async () => {
    if (!cloneUrl.trim() || !currentPath) return;
    setCloning(true);
    setError(null);
    const trimmed = cloneUrl.trim().replace(/\/+$/, '');
    const repoName = trimmed.split('/').pop()?.replace(/\.git$/, '') || 'repo';
    const target = currentPath + '/' + repoName;
    const repo = await onCloneRepo(trimmed, target);
    setCloning(false);
    if (repo) {
      onDone();
    } else {
      setError('Failed to clone repository');
    }
  };

  return (
    <>
      <div className="px-4 py-2 border-b border-slate-700 flex items-center gap-2">
        <div className="flex rounded-md overflow-hidden border border-slate-600">
          {(['browse', 'clone'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={clsx(
                'px-3 py-1 text-xs font-medium transition-colors',
                mode === m ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300'
              )}
            >
              {m === 'browse' ? 'Browse' : 'Clone'}
            </button>
          ))}
        </div>
      </div>

      {mode === 'clone' && (
        <div className="px-4 py-3 border-b border-slate-700">
          <input
            type="text"
            value={cloneUrl}
            onChange={(e) => setCloneUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleClone();
            }}
            placeholder="https://github.com/user/repo.git"
            className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
            disabled={cloning}
            autoFocus
          />
        </div>
      )}

      <div className="px-4 py-2 bg-slate-700/50 border-b border-slate-700 flex items-center gap-2">
        <p className="text-sm text-slate-300 truncate font-mono flex-1">{currentPath || '~'}</p>
        {mode === 'clone' && currentPath && (
          <button
            onClick={handleClone}
            disabled={cloning || !cloneUrl.trim()}
            className="flex-shrink-0 px-3 py-1 text-xs font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors"
          >
            {cloning ? 'Cloning...' : 'Clone to here'}
          </button>
        )}
      </div>

      {error && <ErrorBar message={error} />}

      <BrowseList
        loading={loading}
        parentPath={parentPath}
        entries={entries}
        onNavigate={load}
        onSelectEntry={(entry) => {
          if (mode === 'clone') {
            if (entry.isDirectory) load(entry.path);
            return;
          }
          if (entry.isGitRepo) {
            const alreadyAdded = availableRepos.some((r) => r.path === entry.path);
            if (alreadyAdded) {
              onDone();
            } else {
              handleAddRepo(entry.path);
            }
          } else if (entry.isDirectory) {
            load(entry.path);
          }
        }}
        highlightRepos={mode === 'browse'}
        addingPath={addingPath}
      />
    </>
  );
}

// ── Session Tab ─────────────────────────────────────────────────────────────

function SessionTab() {
  const projects = useProjects();
  const navigate = useNavigate();

  if (projects.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-6 text-center text-slate-400 text-sm">
        Add a project first to start a new session.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <p className="px-4 pt-3 pb-1 text-xs text-slate-500">Pick a project for the new session</p>
      {projects.map((p) => (
        <button
          key={p.projectId}
          onClick={() => navigate(`/p/${p.projectId}/s/new?new`)}
          disabled={!p.isConnected}
          className={clsx(
            'w-full flex items-center gap-3 px-4 py-3 border-b border-slate-700/50 transition-colors text-left',
            p.isConnected ? 'hover:bg-slate-700' : 'opacity-50 cursor-not-allowed'
          )}
        >
          <div className="w-8 h-8 flex items-center justify-center text-lg">{p.machineIcon}</div>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-white truncate">{p.displayName}</p>
            <p className="text-xs text-slate-500 truncate">
              {p.machineName}
              {!p.isConnected && ' · offline'}
            </p>
          </div>
          <ChevronIcon size="w-4 h-4" className="text-slate-500" />
        </button>
      ))}
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function EmptyAgentNotice({ message }: { message: string }) {
  return (
    <div className="flex-1 flex items-center justify-center p-6 text-center text-slate-400 text-sm">
      {message}
    </div>
  );
}

function ErrorBar({ message }: { message: string }) {
  return (
    <div className="px-4 py-2 bg-red-900/30 border-b border-red-800">
      <p className="text-sm text-red-400">{message}</p>
    </div>
  );
}

function BrowseList({
  loading,
  parentPath,
  entries,
  onNavigate,
  onSelectEntry,
  highlightRepos,
  addingPath,
}: {
  loading: boolean;
  parentPath: string | null;
  entries: DirectoryEntry[];
  onNavigate: (path: string) => void;
  onSelectEntry: (entry: DirectoryEntry) => void;
  highlightRepos: boolean;
  addingPath?: string | null;
}) {
  const availableRepos = useConnectionStore((s) => s.availableRepos);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center py-8">
        <Spinner size="w-8 h-8" color="border-blue-500" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-1">
      {parentPath && (
        <button
          onClick={() => onNavigate(parentPath)}
          className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-slate-700 transition-colors"
        >
          <div className="w-8 h-8 rounded flex items-center justify-center bg-slate-700">
            <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 17l-5-5m0 0l5-5m-5 5h12" />
            </svg>
          </div>
          <span className="text-slate-400">..</span>
        </button>
      )}

      {entries.length === 0 ? (
        <div className="px-4 py-6 text-center text-slate-500">
          <p>Empty directory</p>
        </div>
      ) : (
        entries.map((entry) => {
          const alreadyAdded =
            highlightRepos && entry.isGitRepo && availableRepos.some((r) => r.path === entry.path);
          const isAddingThis = addingPath === entry.path;
          const isSelectable = entry.isDirectory || (highlightRepos && entry.isGitRepo);

          return (
            <button
              key={entry.path}
              onClick={() => onSelectEntry(entry)}
              disabled={!isSelectable || (addingPath !== null && !isAddingThis)}
              className={clsx(
                'w-full flex items-center gap-3 px-4 py-2.5 transition-colors',
                highlightRepos && entry.isGitRepo
                  ? alreadyAdded
                    ? 'bg-green-900/20 hover:bg-green-900/30'
                    : 'bg-blue-900/20 hover:bg-blue-900/30'
                  : entry.isDirectory
                    ? 'hover:bg-slate-700'
                    : 'opacity-50 cursor-not-allowed',
                addingPath && !isAddingThis && 'opacity-50'
              )}
            >
              <div
                className={clsx(
                  'w-8 h-8 rounded flex items-center justify-center',
                  highlightRepos && entry.isGitRepo
                    ? alreadyAdded
                      ? 'bg-green-700'
                      : 'bg-blue-700'
                    : entry.isDirectory
                      ? 'bg-slate-700'
                      : 'bg-slate-800'
                )}
              >
                {isAddingThis ? (
                  <Spinner color="border-white" />
                ) : highlightRepos && entry.isGitRepo ? (
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.6.11.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
                  </svg>
                ) : entry.isDirectory ? (
                  <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                  </svg>
                )}
              </div>

              <div className="flex-1 min-w-0 text-left">
                <p className="truncate">{entry.name}</p>
                {highlightRepos && entry.isGitRepo && (
                  <p className="text-xs text-slate-500">
                    {alreadyAdded ? 'Already added' : 'Git repository — tap to add'}
                  </p>
                )}
              </div>

              {entry.isDirectory && !(highlightRepos && entry.isGitRepo) && (
                <ChevronIcon size="w-4 h-4" className="text-slate-500" />
              )}
            </button>
          );
        })
      )}
    </div>
  );
}
