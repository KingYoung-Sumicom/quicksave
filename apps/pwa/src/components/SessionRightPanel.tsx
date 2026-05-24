// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileEntry, FilesListResponsePayload } from '@sumicom/quicksave-shared';
import {
  useSessionRightPanelStore,
  selectPanelMode,
  selectFilesPreview,
  selectFilesRelPath,
  selectGitRepoOverride,
  SESSION_PANEL_MIN,
  SESSION_PANEL_MAX,
} from '../stores/sessionRightPanelStore';
import { useGitStore } from '../stores/gitStore';
import { useGitOps } from '../contexts/gitOpsContext';
import { useFileOps } from '../hooks/useFileOps';
import { getBusForAgent } from '../lib/busRegistry';
import { FileViewerPane } from './files/FilePreviewModal';
import { RepoView } from './RepoView';
import { SettingsPanelContent, type SettingsPanelContentProps } from './AgentSettingsDrawer';
import { Spinner } from './ui/Spinner';

export type SessionOps = Omit<SettingsPanelContentProps, 'onClose' | 'onOpenFiles'>;

interface SessionRightPanelProps {
  sessionId: string;
  agentId: string;
  cwd: string;
  sessionOps: SessionOps;
}

export function SessionRightPanel({ sessionId, agentId, cwd, sessionOps }: SessionRightPanelProps) {
  const mode = useSessionRightPanelStore(selectPanelMode);
  const panelWidth = useSessionRightPanelStore((s) => s.panelWidth);
  const setPanelWidth = useSessionRightPanelStore((s) => s.setPanelWidth);
  const close = useSessionRightPanelStore((s) => s.close);
  const toggle = useSessionRightPanelStore((s) => s.toggle);
  const setActiveSession = useSessionRightPanelStore((s) => s.setActiveSession);
  const draggingRef = useRef(false);

  // Register this session as active; on unmount set null so paddingRight clears.
  useEffect(() => {
    setActiveSession(sessionId);
    return () => { useSessionRightPanelStore.getState().setActiveSession(null); };
  }, [sessionId, setActiveSession]);

  if (!mode) return null;

  return (
    <div
      className="fixed inset-y-0 right-0 z-30 border-l border-slate-700 bg-slate-900 shadow-2xl flex flex-col"
      style={{ width: panelWidth }}
    >
      {/* Drag handle — left edge, same pattern as FilePreviewModal's DesktopSidePanel */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={SESSION_PANEL_MIN}
        aria-valuemax={SESSION_PANEL_MAX}
        aria-valuenow={panelWidth}
        title="Drag to resize"
        onPointerDown={(e) => {
          e.preventDefault();
          draggingRef.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
        }}
        onPointerMove={(e) => {
          if (!draggingRef.current) return;
          setPanelWidth(window.innerWidth - e.clientX);
        }}
        onPointerUp={(e) => {
          if (!draggingRef.current) return;
          draggingRef.current = false;
          try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        }}
        onPointerCancel={() => {
          draggingRef.current = false;
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        }}
        className="absolute top-0 left-0 h-full w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-blue-500/30 active:bg-blue-500/50 transition-colors z-10"
      />

      {/* Tab header */}
      <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-slate-700 shrink-0 bg-slate-800/80">
        <PanelTab
          label="Files"
          active={mode === 'files'}
          onClick={() => toggle('files')}
          icon={
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
            </svg>
          }
        />
        <PanelTab
          label="Git"
          active={mode === 'git'}
          onClick={() => toggle('git')}
          icon={
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <circle cx="18" cy="18" r="3" strokeWidth={1.5} />
              <circle cx="6" cy="6" r="3" strokeWidth={1.5} />
              <circle cx="6" cy="18" r="3" strokeWidth={1.5} />
              <path strokeLinecap="round" strokeWidth={1.5} d="M6 9v6M9 6h3a3 3 0 013 3v6" />
            </svg>
          }
        />
        <PanelTab
          label="Settings"
          active={mode === 'settings'}
          onClick={() => toggle('settings')}
          icon={
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          }
        />
        <div className="flex-1" />
        <button
          onClick={close}
          className="p-1 hover:bg-slate-700 rounded transition-colors text-slate-400 hover:text-slate-200"
          aria-label="Close panel"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {mode === 'files' && <FilesPanel agentId={agentId} cwd={cwd} />}
        {mode === 'git' && <GitPanel cwd={cwd} />}
        {mode === 'settings' && <SettingsPanel sessionOps={sessionOps} />}
      </div>
    </div>
  );
}

function PanelTab({
  label,
  active,
  onClick,
  icon,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
        active
          ? 'bg-slate-700 text-slate-100'
          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

// ── Files panel ───────────────────────────────────────────────────────────────

function FilesPanel({ agentId, cwd }: { agentId: string; cwd: string }) {
  const filesPreview = useSessionRightPanelStore(selectFilesPreview);
  const filesRelPath = useSessionRightPanelStore(selectFilesRelPath);
  const closeFilePreview = useSessionRightPanelStore((s) => s.closeFilePreview);
  const navigateFiles = useSessionRightPanelStore((s) => s.navigateFiles);
  const openFilePreview = useSessionRightPanelStore((s) => s.openFilePreview);

  if (filesPreview) {
    return (
      <div className="flex flex-col flex-1 min-h-0">
        {/* Back to browser */}
        <div className="flex items-center gap-2 px-2 py-1.5 border-b border-slate-700/50 shrink-0">
          <button
            onClick={closeFilePreview}
            className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Files
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          <FileViewerPane request={filesPreview} onClose={closeFilePreview} />
        </div>
      </div>
    );
  }

  return (
    <DirectoryPanel
      agentId={agentId}
      cwd={cwd}
      relPath={filesRelPath}
      onNavigate={navigateFiles}
      onOpenFile={(path) => openFilePreview({ path, agentId, cwd })}
    />
  );
}

function DirectoryPanel({
  agentId,
  cwd,
  relPath,
  onNavigate,
  onOpenFile,
}: {
  agentId: string;
  cwd: string;
  relPath: string;
  onNavigate: (rel: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const getBus = useCallback(() => getBusForAgent(agentId), [agentId]);
  const { listFiles } = useFileOps(getBus);
  const [data, setData] = useState<FilesListResponsePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const reqIdRef = useRef(0);

  useEffect(() => {
    setLoading(true);
    setData(null);
    const myId = ++reqIdRef.current;
    listFiles({ cwd, path: relPath })
      .then((res) => { if (myId === reqIdRef.current) setData(res); })
      .catch((err) => {
        if (myId !== reqIdRef.current) return;
        setData({
          success: false,
          cwd,
          path: relPath,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => { if (myId === reqIdRef.current) setLoading(false); });
  }, [cwd, relPath, listFiles]);

  const projectName = cwd.split('/').pop() ?? cwd;
  const segments = relPath ? relPath.split('/').filter(Boolean) : [];

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Breadcrumb */}
      <div className="px-3 py-1.5 border-b border-slate-700/50 flex items-center gap-1 text-[11px] text-slate-400 overflow-x-auto whitespace-nowrap shrink-0">
        <button
          onClick={() => onNavigate('')}
          className="hover:text-slate-200 transition-colors shrink-0"
        >
          {projectName || '/'}
        </button>
        {segments.map((seg, i) => {
          const accum = segments.slice(0, i + 1).join('/');
          const isLast = i === segments.length - 1;
          return (
            <span key={accum} className="flex items-center gap-1 min-w-0">
              <span className="text-slate-600">/</span>
              {isLast ? (
                <span className="text-slate-200 truncate">{seg}</span>
              ) : (
                <button
                  onClick={() => onNavigate(accum)}
                  className="hover:text-slate-200 transition-colors truncate"
                >
                  {seg}
                </button>
              )}
            </span>
          );
        })}
      </div>

      {/* Listing */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-10">
            <Spinner size="w-5 h-5" color="border-blue-400" />
          </div>
        )}
        {!loading && !data?.success && (
          <div className="px-4 py-6 text-sm text-red-400">
            {data?.error ?? 'Failed to load directory.'}
          </div>
        )}
        {!loading && data?.success && (
          (data.entries?.length ?? 0) === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-slate-500">Empty directory.</div>
          ) : (
            <div className="divide-y divide-slate-700/30">
              {data.entries!.map((e) => (
                <EntryRow
                  key={e.name}
                  entry={e}
                  relPath={relPath}
                  onNavigate={onNavigate}
                  onOpenFile={onOpenFile}
                />
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}

function EntryRow({
  entry,
  relPath,
  onNavigate,
  onOpenFile,
}: {
  entry: FileEntry;
  relPath: string;
  onNavigate: (rel: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const isDir = entry.kind === 'directory' || (entry.kind === 'symlink' && entry.targetIsDirectory);
  const isOther = entry.kind === 'other';
  const next = relPath ? `${relPath}/${entry.name}` : entry.name;

  const handleClick = () => {
    if (isDir) { onNavigate(next); return; }
    if (!isOther) { onOpenFile(next); }
  };

  const formatSize = (n: number) => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  };

  return (
    <button
      onClick={handleClick}
      disabled={isOther}
      className="w-full text-left px-3 py-2 hover:bg-slate-800 active:bg-slate-700/60 transition-colors flex items-center gap-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {isDir ? (
        <svg className="w-4 h-4 text-blue-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
        </svg>
      ) : (
        <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h7l5 5v11a2 2 0 01-2 2z" />
        </svg>
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-slate-200 truncate">
          {entry.name}{entry.kind === 'symlink' ? ' →' : ''}
        </p>
        <p className="text-[11px] text-slate-500 truncate">
          {isDir ? 'directory' : formatSize(entry.size)}
        </p>
      </div>
      {!isOther && (
        <svg className="w-3.5 h-3.5 text-slate-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      )}
    </button>
  );
}

// ── Settings panel ───────────────────────────────────────────────────────────

function SettingsPanel({ sessionOps }: { sessionOps: SessionOps }) {
  const toggle = useSessionRightPanelStore((s) => s.toggle);
  const setGitRepoOverride = useSessionRightPanelStore((s) => s.setGitRepoOverride);
  return (
    <SettingsPanelContent
      {...sessionOps}
      onOpenFiles={() => toggle('files')}
      onOpenRepo={(repoPath) => {
        // Stash the picked repo so GitPanel renders it instead of the
        // session's cwd, then switch the panel from Settings → Git.
        setGitRepoOverride(repoPath);
        toggle('git');
      }}
    />
  );
}

// ── Git panel ────────────────────────────────────────────────────────────────

function GitPanel({ cwd }: { cwd: string }) {
  const gitOps = useGitOps();
  const setCurrentRepoPath = useGitStore((s) => s.setCurrentRepoPath);
  // Honor a per-session override set when the user picks a specific repo
  // from the Settings tab's "Git repository" list. Falls back to the
  // session's own cwd when no override is set.
  const repoOverride = useSessionRightPanelStore(selectGitRepoOverride);
  const effectiveCwd = repoOverride ?? cwd;

  useEffect(() => {
    if (!gitOps) return;
    setCurrentRepoPath(effectiveCwd);
    gitOps.switchRepo(effectiveCwd);
    gitOps.onRefresh();
  }, [effectiveCwd]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!gitOps) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-slate-500">
        Git operations unavailable.
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
      <RepoView
        onRefresh={gitOps.onRefresh}
        onFetchDiff={gitOps.onFetchDiff}
        onStage={gitOps.onStage}
        onUnstage={gitOps.onUnstage}
        onStagePatch={gitOps.onStagePatch}
        onUnstagePatch={gitOps.onUnstagePatch}
        onDiscard={gitOps.onDiscard}
        onUntrack={gitOps.onUntrack}
        onAddToGitignore={gitOps.onAddToGitignore}
        onCommit={gitOps.onCommit}
        onGenerateAiSummary={gitOps.onGenerateAiSummary}
        onApplyAiSuggestion={gitOps.onApplyAiSuggestion}
        onDismissAiSummary={gitOps.onDismissAiSummary}
        onSetApiKey={gitOps.onSetApiKey}
      />
    </div>
  );
}
