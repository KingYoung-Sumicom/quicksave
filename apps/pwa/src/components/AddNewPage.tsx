// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { clsx } from 'clsx';
import { FormattedMessage, useIntl } from 'react-intl';
import type {
  Repository,
  CodingPath,
  BrowseDirectoryResponsePayload,
  DirectoryEntry,
  AgentId,
} from '@sumicom/quicksave-shared';
import { useConnectionStore } from '../stores/connectionStore';
import { useMachineStore } from '../stores/machineStore';
import { useClaudeStore } from '../stores/claudeStore';
import { useProjects } from '../hooks/useProjects';
import { BaseStatusBar, BackButton } from './BaseStatusBar';
import { ChevronIcon } from './ui/ChevronIcon';
import { Spinner } from './ui/Spinner';
import { Modal } from './ui/Modal';
import { ErrorBox } from './ui/ErrorBox';
import { QRScanner } from './QRScanner';
import { NewSessionEmptyState } from './chat/NewSessionEmptyState';
import { getAgentType } from '../lib/claudePresets';
import { toProjectId } from '../lib/projectId';

type StartSessionOpts = {
  agent?: AgentId;
  allowedTools?: string[];
  systemPrompt?: string;
  model?: string;
  permissionMode?: string;
  cwd?: string;
  sandboxed?: boolean;
  reasoningEffort?: string;
  contextWindow?: number;
};

type TabKey = 'project' | 'session' | 'machine';

interface AddNewPageProps {
  onSetActiveAgent: (agentId: string) => void;
  onBrowseDirectory: (path?: string) => Promise<BrowseDirectoryResponsePayload | null>;
  onCloneRepo: (url: string, targetDir: string) => Promise<Repository | null>;
  onAddCodingPath: (path: string) => Promise<CodingPath | null>;
  onConnect: (agentId: string, publicKey: string) => void;
  onStartSession: (prompt: string, opts?: StartSessionOpts) => Promise<void>;
}

export function AddNewPage({
  onSetActiveAgent,
  onBrowseDirectory,
  onCloneRepo,
  onAddCodingPath,
  onConnect,
  onStartSession,
}: AddNewPageProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialTab = useMemo<TabKey>(() => {
    const raw = searchParams.get('tab');
    return raw === 'project' || raw === 'session' || raw === 'machine' ? raw : 'session';
    // Only honor the initial URL — subsequent tab clicks shouldn't flip back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const initialProjectId = useMemo(() => searchParams.get('projectId'), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [tab, setTab] = useState<TabKey>(initialTab);
  // Lets the Project tab seed the Session tab's project selection after a
  // successful add — SessionTab mounts fresh on tab switch and reads this
  // as its initialProjectId.
  const [sessionSeedProjectId, setSessionSeedProjectId] = useState<string | null>(initialProjectId);
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

  // Bind agent routing into each request. A useEffect won't work here: child
  // effects (the browse request fired by useDirectoryBrowser on resetKey change)
  // flush before the parent's, so setActiveAgent would race the send. Instead,
  // call setActiveAgent synchronously before each agent-bound call.
  const withAgent = useCallback(
    (agentId: string | null) => {
      if (agentId) onSetActiveAgent(agentId);
    },
    [onSetActiveAgent]
  );

  const boundBrowseDirectory = useCallback(
    (path?: string) => {
      withAgent(selectedAgentId);
      return onBrowseDirectory(path);
    },
    [withAgent, selectedAgentId, onBrowseDirectory]
  );

  const boundCloneRepo = useCallback(
    (url: string, targetDir: string) => {
      withAgent(selectedAgentId);
      return onCloneRepo(url, targetDir);
    },
    [withAgent, selectedAgentId, onCloneRepo]
  );

  const boundAddCodingPath = useCallback(
    (path: string) => {
      withAgent(selectedAgentId);
      return onAddCodingPath(path);
    },
    [withAgent, selectedAgentId, onAddCodingPath]
  );

  const goBack = useCallback(() => {
    navigate(-1);
  }, [navigate]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <BaseStatusBar
        left={<BackButton onClick={goBack} />}
        center={
          <span className="text-sm font-medium text-slate-300">
            <FormattedMessage id="addNew.title" />
          </span>
        }
      />

      <div className="flex border-b border-slate-700 px-2">
        {(['session', 'project', 'machine'] as const).map((key) => (
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
            <FormattedMessage id={`addNew.tab.${key}`} />
          </button>
        ))}
      </div>

      {tab === 'project' && connectedMachines.length > 1 && (
        <div className="px-4 py-3 border-b border-slate-700 flex items-center gap-2">
          <label htmlFor="add-machine-select" className="text-xs text-slate-400 shrink-0">
            <FormattedMessage id="addNew.project.machineLabel" />
          </label>
          <select
            id="add-machine-select"
            value={selectedAgentId ?? ''}
            onChange={(e) => setSelectedAgentId(e.target.value || null)}
            className="flex-1 min-w-0 bg-slate-700 text-slate-200 text-sm rounded-md px-2.5 py-1.5 border border-slate-600 focus:outline-none focus:border-blue-500"
          >
            {connectedMachines.map((m) => (
              <option key={m.agentId} value={m.agentId}>
                {m.icon} {m.nickname}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="flex-1 overflow-hidden flex flex-col">
        {tab === 'project' && (
          <ProjectTab
            selectedAgentId={selectedAgentId}
            onBrowseDirectory={boundBrowseDirectory}
            onAddCodingPath={boundAddCodingPath}
            onCloneRepo={boundCloneRepo}
            onDone={(agentId, path) => {
              if (agentId && path) {
                setSessionSeedProjectId(toProjectId(agentId, path));
                setTab('session');
              } else {
                goBack();
              }
            }}
          />
        )}
        {tab === 'session' && (
          <SessionTab
            initialProjectId={sessionSeedProjectId}
            onSetActiveAgent={onSetActiveAgent}
            onStartSession={onStartSession}
          />
        )}
        {tab === 'machine' && (
          <MachineTab
            onConnect={(agentId, publicKey) => {
              onConnect(agentId, publicKey);
              navigate('/');
            }}
          />
        )}
      </div>
    </div>
  );
}

// ── Shared directory browser hook ───────────────────────────────────────────

function useDirectoryBrowser(
  resetKey: string | null,
  onBrowseDirectory: (path?: string) => Promise<BrowseDirectoryResponsePayload | null>
) {
  const intl = useIntl();
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
        setError(intl.formatMessage({ id: 'addNew.project.browseFailed' }));
      } finally {
        setLoading(false);
      }
    },
    [onBrowseDirectory, intl]
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
  onCloneRepo,
  onDone,
}: {
  selectedAgentId: string | null;
  onBrowseDirectory: (path?: string) => Promise<BrowseDirectoryResponsePayload | null>;
  onAddCodingPath: (path: string) => Promise<CodingPath | null>;
  onCloneRepo: (url: string, targetDir: string) => Promise<Repository | null>;
  onDone: (agentId: string | null, path: string | null) => void;
}) {
  const intl = useIntl();
  const { currentPath, parentPath, entries, loading, error, setError, load } =
    useDirectoryBrowser(selectedAgentId, onBrowseDirectory);
  const [adding, setAdding] = useState(false);
  const [showClone, setShowClone] = useState(false);

  if (!selectedAgentId) {
    return <EmptyAgentNotice message={intl.formatMessage({ id: 'addNew.project.empty' })} />;
  }

  const handleSelect = async () => {
    if (!currentPath || !selectedAgentId) return;
    setAdding(true);
    setError(null);
    const result = await onAddCodingPath(currentPath);
    setAdding(false);
    if (result) {
      // Broadcast: propagate the new coding path to per-agent connection state
      // and the persisted machine cache so the home project list and hash
      // resolver pick it up immediately, without waiting for reconnect.
      useConnectionStore.getState().addAgentCodingPath(selectedAgentId, result);
      useMachineStore.getState().addKnownCodingPath(selectedAgentId, result.path);
      onDone(selectedAgentId, result.path);
    } else {
      setError(intl.formatMessage({ id: 'addNew.project.failed' }));
    }
  };

  const existingNames = useMemo(
    () => new Set(entries.map((e) => e.name)),
    [entries]
  );

  return (
    <>
      <div className="px-4 py-2 bg-slate-700/50 border-b border-slate-700 flex items-center gap-2">
        <p className="text-sm text-slate-300 truncate font-mono flex-1">{currentPath || '~'}</p>
        <button
          onClick={() => setShowClone(true)}
          disabled={!currentPath}
          className="flex-shrink-0 px-3 py-1 text-xs font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded transition-colors"
        >
          <FormattedMessage id="addNew.project.clone" />
        </button>
        <button
          onClick={handleSelect}
          disabled={adding || !currentPath}
          className="flex-shrink-0 px-3 py-1 text-xs font-medium bg-purple-600 hover:bg-purple-500 disabled:opacity-50 rounded transition-colors"
        >
          <FormattedMessage id={adding ? 'addNew.project.adding' : 'addNew.project.addAsProject'} />
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

      {showClone && currentPath && (
        <CloneRepoModal
          currentPath={currentPath}
          existingNames={existingNames}
          onClone={onCloneRepo}
          onClose={() => setShowClone(false)}
          onCloned={() => {
            setShowClone(false);
            load(currentPath);
          }}
        />
      )}
    </>
  );
}

// ── Clone Repo Modal ────────────────────────────────────────────────────────

function CloneRepoModal({
  currentPath,
  existingNames,
  onClone,
  onClose,
  onCloned,
}: {
  currentPath: string;
  existingNames: Set<string>;
  onClone: (url: string, targetDir: string) => Promise<Repository | null>;
  onClose: () => void;
  onCloned: () => void;
}) {
  const intl = useIntl();
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedUrl = url.trim().replace(/\/+$/, '');
  const defaultName = trimmedUrl.split('/').pop()?.replace(/\.git$/, '') || '';
  const effectiveName = name.trim() || defaultName;
  const nameConflict = !!effectiveName && existingNames.has(effectiveName);

  const canClone = !cloning && !!trimmedUrl && !!effectiveName && !nameConflict;

  const handleClone = async () => {
    if (!canClone) return;
    setCloning(true);
    setError(null);
    const target = currentPath + '/' + effectiveName;
    const repo = await onClone(trimmedUrl, target);
    setCloning(false);
    if (repo) {
      onCloned();
    } else {
      setError(intl.formatMessage({ id: 'addNew.clone.failed' }));
    }
  };

  return (
    <Modal title={intl.formatMessage({ id: 'addNew.clone.title' })} onClose={cloning ? () => {} : onClose} backdropClose={!cloning}>
      <div className="p-4 space-y-4">
        <div className="space-y-1">
          <label className="text-xs font-medium text-slate-400 uppercase tracking-wide">
            <FormattedMessage id="addNew.clone.urlLabel" />
          </label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && canClone) handleClone();
            }}
            placeholder={intl.formatMessage({ id: 'addNew.clone.urlPlaceholder' })}
            className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
            disabled={cloning}
            autoFocus
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-slate-400 uppercase tracking-wide">
            <FormattedMessage id="addNew.clone.nameLabel" />{' '}
            <span className="text-slate-500 normal-case font-normal">
              <FormattedMessage id="addNew.clone.nameOptional" />
            </span>
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && canClone) handleClone();
            }}
            placeholder={defaultName || intl.formatMessage({ id: 'addNew.clone.namePlaceholder' })}
            className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
            disabled={cloning}
          />
          {effectiveName && (
            <p className="text-xs text-slate-500 font-mono truncate">
              → {currentPath}/{effectiveName}
            </p>
          )}
          {nameConflict && (
            <p className="text-xs text-red-400">
              <FormattedMessage id="addNew.clone.conflict" values={{ name: effectiveName }} />
            </p>
          )}
        </div>

        {error && <ErrorBox>{error}</ErrorBox>}

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            disabled={cloning}
            className="px-3 py-1.5 text-sm text-slate-300 hover:text-white disabled:opacity-50 transition-colors"
          >
            <FormattedMessage id="common.cancel" />
          </button>
          <button
            onClick={handleClone}
            disabled={!canClone}
            className="px-4 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:cursor-not-allowed rounded transition-colors flex items-center gap-2"
          >
            {cloning && <Spinner color="border-white" />}
            <FormattedMessage id={cloning ? 'addNew.clone.submitting' : 'addNew.clone.submit'} />
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Machine Tab ─────────────────────────────────────────────────────────────

function MachineTab({
  onConnect,
}: {
  onConnect: (agentId: string, publicKey: string) => void;
}) {
  const intl = useIntl();
  const [mode, setMode] = useState<'scan' | 'manual'>('scan');
  const [agentId, setAgentId] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const { addMachine } = useMachineStore();
  const error = useConnectionStore((s) => s.error);
  const state = useConnectionStore((s) => s.state);
  const isConnecting = state === 'connecting';

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const id = agentId.trim();
    const pk = publicKey.trim();
    if (!id || !pk) return;
    addMachine({
      agentId: id,
      publicKey: pk,
      nickname: `Machine ${id.slice(0, 8)}`,
      icon: '',
    });
    onConnect(id, pk);
  };

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="flex mb-4 bg-slate-700 rounded-lg p-1">
        <button
          type="button"
          className={clsx(
            'flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors',
            mode === 'scan' ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-white'
          )}
          onClick={() => setMode('scan')}
        >
          <FormattedMessage id="addNew.machine.scanQr" />
        </button>
        <button
          type="button"
          className={clsx(
            'flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors',
            mode === 'manual' ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-white'
          )}
          onClick={() => setMode('manual')}
        >
          <FormattedMessage id="addNew.machine.manualEntry" />
        </button>
      </div>

      {mode === 'scan' ? (
        <>
          <QRScanner
            onScan={(id, pk, _name, spk) => {
              addMachine({
                agentId: id,
                publicKey: pk,
                signPublicKey: spk,
                nickname: `Machine ${id.slice(0, 8)}`,
                icon: '',
              });
              onConnect(id, pk);
            }}
          />
          {error && <ErrorBox className="mt-4 p-3">{error}</ErrorBox>}
        </>
      ) : (
        <form onSubmit={handleManualSubmit} className="space-y-4">
          <div>
            <label htmlFor="add-agent-id" className="block text-sm font-medium text-slate-300 mb-1">
              <FormattedMessage id="addNew.machine.agentIdLabel" />
            </label>
            <input
              id="add-agent-id"
              type="text"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              placeholder={intl.formatMessage({ id: 'addNew.machine.agentIdPlaceholder' })}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              disabled={isConnecting}
            />
          </div>
          <div>
            <label htmlFor="add-public-key" className="block text-sm font-medium text-slate-300 mb-1">
              <FormattedMessage id="addNew.machine.publicKeyLabel" />
            </label>
            <textarea
              id="add-public-key"
              value={publicKey}
              onChange={(e) => setPublicKey(e.target.value)}
              placeholder={intl.formatMessage({ id: 'addNew.machine.publicKeyPlaceholder' })}
              rows={3}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none font-mono text-sm"
              disabled={isConnecting}
            />
          </div>
          {error && <ErrorBox className="p-3">{error}</ErrorBox>}
          <button
            type="submit"
            disabled={!agentId.trim() || !publicKey.trim() || isConnecting}
            className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-md font-medium text-white transition-colors"
          >
            <FormattedMessage id={isConnecting ? 'addNew.machine.connecting' : 'addNew.machine.submit'} />
          </button>
        </form>
      )}

      <p className="mt-4 text-center text-xs text-slate-500">
        <FormattedMessage
          id="addNew.machine.footer"
          values={{ cmd: <code className="text-slate-400">quicksave</code> }}
        />
      </p>
    </div>
  );
}

// ── Session Tab ─────────────────────────────────────────────────────────────

function SessionTab({
  initialProjectId,
  onSetActiveAgent,
  onStartSession,
}: {
  initialProjectId: string | null;
  onSetActiveAgent: (agentId: string) => void;
  onStartSession: (prompt: string, opts?: StartSessionOpts) => Promise<void>;
}) {
  const intl = useIntl();
  const projects = useProjects();
  const navigate = useNavigate();

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() => {
    if (initialProjectId && projects.some((p) => p.projectId === initialProjectId)) {
      return initialProjectId;
    }
    const firstConnected = projects.find((p) => p.isConnected);
    return firstConnected?.projectId ?? projects[0]?.projectId ?? null;
  });

  // Honor initialProjectId once it appears in the hydrated project list —
  // store rehydration can happen after the first render, so the initial-state
  // guess above may have fallen back to firstConnected.
  const [honoredInitial, setHonoredInitial] = useState(() =>
    !initialProjectId || projects.some((p) => p.projectId === initialProjectId)
  );
  useEffect(() => {
    if (honoredInitial || !initialProjectId) return;
    if (projects.some((p) => p.projectId === initialProjectId)) {
      setSelectedProjectId(initialProjectId);
      setHonoredInitial(true);
    }
  }, [projects, initialProjectId, honoredInitial]);

  // Keep selection valid as the projects list churns (reconnects, additions).
  useEffect(() => {
    if (selectedProjectId && projects.some((p) => p.projectId === selectedProjectId)) return;
    const firstConnected = projects.find((p) => p.isConnected);
    setSelectedProjectId(firstConnected?.projectId ?? projects[0]?.projectId ?? null);
  }, [projects, selectedProjectId]);

  const project = projects.find((p) => p.projectId === selectedProjectId) ?? null;

  const selectedAgent = useClaudeStore((s) => s.selectedAgent);
  const selectedModel = useClaudeStore((s) => s.selectedModel);
  const selectedPermissionMode = useClaudeStore((s) => s.selectedPermissionMode);
  const selectedContextWindow = useClaudeStore((s) => s.selectedContextWindow);
  const selectedReasoningEffort = useClaudeStore((s) => s.selectedReasoningEffort);
  const sandboxEnabled = useClaudeStore((s) => s.sandboxEnabled);

  const [prompt, setPrompt] = useState('');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canStart = !!project?.isConnected && !!prompt.trim() && !starting;

  const handleStart = async () => {
    if (!canStart || !project) return;
    const text = prompt.trim();
    setStarting(true);
    setError(null);
    const agentType = getAgentType(selectedAgent);
    onSetActiveAgent(project.agentId);
    try {
      await onStartSession(text, {
        agent: selectedAgent,
        model: selectedModel,
        permissionMode: selectedPermissionMode,
        sandboxed: sandboxEnabled || undefined,
        cwd: project.cwd,
        // Claude CLI honors contextWindow via CLAUDE_CODE_AUTO_COMPACT_WINDOW;
        // Codex ignores it. Send for both — agent layer narrows.
        ...(selectedContextWindow ? { contextWindow: selectedContextWindow } : {}),
        // Codex honors reasoningEffort; Claude providers ignore it.
        ...(selectedReasoningEffort ? { reasoningEffort: selectedReasoningEffort } : {}),
        ...(agentType.allowedTools !== undefined ? { allowedTools: agentType.allowedTools } : {}),
        ...(agentType.systemPrompt ? { systemPrompt: agentType.systemPrompt } : {}),
      });
      const streamErr = useClaudeStore.getState().streamError;
      if (streamErr) {
        setError(streamErr);
        return;
      }
      const sid = useClaudeStore.getState().activeSessionId;
      setPrompt('');
      if (sid) {
        navigate(`/p/${project.projectId}/s/${sid}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : intl.formatMessage({ id: 'addNew.session.failed' }));
    } finally {
      setStarting(false);
    }
  };

  if (projects.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-6 text-center text-slate-400 text-sm">
        <FormattedMessage id="addNew.session.empty" />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <NewSessionEmptyState
          cwd={project?.cwd}
          projectSelector={{
            projects,
            selectedProjectId,
            onSelect: (id) => setSelectedProjectId(id || null),
          }}
        />
      </div>

      {error && <ErrorBar message={error} />}

      <div className="border-t border-slate-700 px-4 py-3 bg-slate-900 flex items-end gap-2 safe-area-bottom-input">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              handleStart();
            }
          }}
          placeholder={intl.formatMessage({ id: project?.isConnected ? 'addNew.session.promptReady' : 'addNew.session.promptOffline' })}
          className="flex-1 bg-slate-700 rounded-lg px-3 py-2 text-sm resize-none overflow-y-auto focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
          rows={2}
          disabled={!project?.isConnected || starting}
        />
        <button
          onPointerDown={(e) => { e.preventDefault(); handleStart(); }}
          disabled={!canStart}
          className={clsx(
            'p-2 rounded-lg transition-colors flex-shrink-0',
            canStart ? 'bg-blue-600 hover:bg-blue-500' : 'bg-slate-600 text-slate-400',
          )}
          title={intl.formatMessage({ id: 'addNew.session.startTitle' })}
        >
          {starting ? (
            <Spinner color="border-white" />
          ) : (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19V5m0 0l-7 7m7-7l7 7" />
            </svg>
          )}
        </button>
      </div>
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
          <p>
            <FormattedMessage id="addNew.project.browseEmpty" />
          </p>
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
              disabled={!isSelectable || (addingPath != null && !isAddingThis)}
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
                    <FormattedMessage id={alreadyAdded ? 'addNew.project.alreadyAdded' : 'addNew.project.tapToAdd'} />
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
