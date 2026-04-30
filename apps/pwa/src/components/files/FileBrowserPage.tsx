// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import type { FileEntry, FilesListResponsePayload } from '@sumicom/quicksave-shared';
import { BaseStatusBar, BackButton } from '../BaseStatusBar';
import { Spinner } from '../ui/Spinner';
import { useFileOps } from '../../hooks/useFileOps';
import { getActiveBus } from '../../lib/busRegistry';
import { resolveProjectCwd } from '../../lib/projectId';
import { useMachineStore } from '../../stores/machineStore';
import { useFilePreviewStore } from '../../stores/filePreviewStore';

interface Params extends Record<string, string | undefined> {
  projectId: string;
}

/**
 * Parses the splat after `/files/` into a relative directory path. Files
 * are no longer addressable via the URL — clicking a file opens the
 * `FilePreviewModal` instead. Legacy `d/<rel>` and `f/<rel>` prefixes
 * still work: `d/` is stripped, `f/` falls back to listing the file's
 * containing directory (so old links don't 404).
 */
function parseSplat(splat: string): string {
  if (!splat) return '';
  if (splat === 'd') return '';
  if (splat.startsWith('d/')) return splat.slice(2);
  if (splat === 'f') return '';
  if (splat.startsWith('f/')) {
    // Drop the trailing filename — show its parent directory instead.
    const rest = splat.slice(2);
    const idx = rest.lastIndexOf('/');
    return idx < 0 ? '' : rest.slice(0, idx);
  }
  return splat;
}

function toUrlPath(rel: string): string {
  if (!rel) return '';
  return rel.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

function joinRel(parent: string, name: string): string {
  if (!parent) return name;
  return `${parent}/${name}`;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function FileBrowserPage() {
  const { projectId } = useParams<Params>();
  const params = useParams();
  const splat = params['*'] ?? '';
  const relPath = parseSplat(splat);

  const navigate = useNavigate();
  const location = useLocation();

  const machines = useMachineStore((s) => s.machines);
  const resolved = useMemo(() => (projectId ? resolveProjectCwd(projectId) : null), [projectId]);
  const cwd = resolved?.cwd;
  const machine = useMemo(
    () => (resolved ? machines.find((m) => m.agentId === resolved.agentId) : undefined),
    [machines, resolved],
  );
  const projectName = cwd ? cwd.split('/').pop() ?? cwd : '';

  const projectBasePath = projectId ? `/p/${projectId}` : '/';
  const goBack = useCallback(() => {
    if (location.key !== 'default') navigate(-1);
    else navigate(projectBasePath, { replace: true });
  }, [location.key, navigate, projectBasePath]);

  if (!projectId) {
    return <Empty>No project selected.</Empty>;
  }
  if (!cwd) {
    return (
      <PageShell title="Files" subtitle="" goBack={goBack}>
        <Empty>Project path not known on this device. Open the project once on its host machine first.</Empty>
      </PageShell>
    );
  }

  const headerSubtitle = relPath ? `${cwd}/${relPath}` : cwd;

  return (
    <PageShell title={projectName} subtitle={headerSubtitle} goBack={goBack} machineName={machine?.nickname}>
      <Breadcrumb projectId={projectId} relPath={relPath} projectName={projectName} navigate={navigate} />
      <DirectoryView
        projectId={projectId}
        cwd={cwd}
        relPath={relPath}
        navigate={navigate}
      />
    </PageShell>
  );
}

function PageShell({
  title,
  subtitle,
  goBack,
  machineName,
  children,
}: {
  title: string;
  subtitle: string;
  goBack: () => void;
  machineName?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col h-full overflow-hidden bg-slate-900">
      <BaseStatusBar
        left={<BackButton onClick={goBack} />}
        center={
          <div className="flex flex-col items-center min-w-0">
            <span className="text-sm font-medium text-slate-200 truncate max-w-[60vw]">{title}</span>
            {subtitle && (
              <span className="text-[11px] text-slate-500 truncate max-w-[60vw]">
                {machineName ? `${machineName} · ${subtitle}` : subtitle}
              </span>
            )}
          </div>
        }
      />
      <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 flex items-center justify-center text-slate-500 text-sm px-6 text-center">
      {children}
    </div>
  );
}

function Breadcrumb({
  projectId,
  relPath,
  projectName,
  navigate,
}: {
  projectId: string;
  relPath: string;
  projectName: string;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const segments = relPath ? relPath.split('/').filter(Boolean) : [];

  const goToDir = (rel: string) => {
    navigate(`/p/${projectId}/files${rel ? '/d/' + toUrlPath(rel) : ''}`);
  };

  return (
    <div className="px-4 py-2 border-b border-slate-700/50 flex items-center gap-1 text-[12px] text-slate-400 overflow-x-auto whitespace-nowrap">
      <button
        onClick={() => goToDir('')}
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
                onClick={() => goToDir(accum)}
                className="hover:text-slate-200 transition-colors truncate"
              >
                {seg}
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

function DirectoryView({
  projectId,
  cwd,
  relPath,
  navigate,
}: {
  projectId: string;
  cwd: string;
  relPath: string;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const { listFiles } = useFileOps(getActiveBus);
  const openPreview = useFilePreviewStore((s) => s.open);
  const [data, setData] = useState<FilesListResponsePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const reqIdRef = useRef(0);

  useEffect(() => {
    setLoading(true);
    setData(null);
    const myId = ++reqIdRef.current;
    listFiles({ cwd, path: relPath })
      .then((res) => {
        if (myId !== reqIdRef.current) return;
        setData(res);
      })
      .catch((err) => {
        if (myId !== reqIdRef.current) return;
        setData({
          success: false,
          cwd,
          path: relPath,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        if (myId === reqIdRef.current) setLoading(false);
      });
  }, [cwd, relPath, listFiles]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size="w-5 h-5" color="border-blue-400" />
      </div>
    );
  }

  if (!data?.success) {
    return (
      <div className="px-4 py-6 text-sm text-red-400">
        {data?.error ?? 'Failed to load directory.'}
      </div>
    );
  }

  const entries = data.entries ?? [];
  if (entries.length === 0) {
    return (
      <div className="px-4 py-12 text-center text-sm text-slate-500">
        Empty directory.
      </div>
    );
  }

  const handleClick = (e: FileEntry) => {
    const next = joinRel(relPath, e.name);
    if (e.kind === 'directory' || (e.kind === 'symlink' && e.targetIsDirectory)) {
      navigate(`/p/${projectId}/files/d/${toUrlPath(next)}`);
      return;
    }
    if (e.kind === 'file' || e.kind === 'symlink') {
      openPreview({ cwd, path: next });
      return;
    }
  };

  return (
    <div className="divide-y divide-slate-700/40">
      {entries.map((e) => {
        const isDir = e.kind === 'directory' || (e.kind === 'symlink' && e.targetIsDirectory);
        const isOther = e.kind === 'other';
        return (
          <button
            key={e.name}
            onClick={() => handleClick(e)}
            disabled={isOther}
            className="w-full text-left px-4 py-2.5 hover:bg-slate-700/30 active:bg-slate-700/50 transition-colors flex items-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <EntryIcon entry={e} />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-slate-200 truncate">{e.name}{e.kind === 'symlink' ? ' →' : ''}</p>
              <p className="text-[11px] text-slate-500 truncate">
                {isDir ? 'directory' : `${formatSize(e.size)}${e.oversized ? ' · too large to preview' : ''}`}
              </p>
            </div>
            {!isOther && (
              <svg className="w-4 h-4 text-slate-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            )}
          </button>
        );
      })}
    </div>
  );
}

function EntryIcon({ entry }: { entry: FileEntry }) {
  const isDir = entry.kind === 'directory' || (entry.kind === 'symlink' && entry.targetIsDirectory);
  if (isDir) {
    return (
      <svg className="w-4 h-4 text-blue-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
      </svg>
    );
  }
  return (
    <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h7l5 5v11a2 2 0 01-2 2z" />
    </svg>
  );
}
