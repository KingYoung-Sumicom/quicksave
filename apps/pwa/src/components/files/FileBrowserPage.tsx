import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import type {
  FileEntry,
  FilesListResponsePayload,
  FilesReadResponsePayload,
} from '@sumicom/quicksave-shared';
import { BaseStatusBar, BackButton } from '../BaseStatusBar';
import { Spinner } from '../ui/Spinner';
import { useFileOps } from '../../hooks/useFileOps';
import { getActiveBus } from '../../lib/busRegistry';
import { resolveProjectCwd } from '../../lib/projectId';
import { useMachineStore } from '../../stores/machineStore';

interface Params extends Record<string, string | undefined> {
  projectId: string;
}

type Mode = 'd' | 'f';

/**
 * Parses the splat after `/files/` into `(mode, relPath)`.
 * Format: `d/<rel>` for a directory listing, `f/<rel>` for a file preview.
 * Empty / unprefixed input falls back to a directory listing of `<rel>`.
 */
function parseSplat(splat: string): { mode: Mode; relPath: string } {
  if (!splat) return { mode: 'd', relPath: '' };
  if (splat === 'd' || splat === 'f') return { mode: splat as Mode, relPath: '' };
  if (splat.startsWith('d/')) return { mode: 'd', relPath: splat.slice(2) };
  if (splat.startsWith('f/')) return { mode: 'f', relPath: splat.slice(2) };
  return { mode: 'd', relPath: splat };
}

function toUrlPath(rel: string): string {
  if (!rel) return '';
  return rel.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

function joinRel(parent: string, name: string): string {
  if (!parent) return name;
  return `${parent}/${name}`;
}

function basenameOf(rel: string): string {
  if (!rel) return '';
  const idx = rel.lastIndexOf('/');
  return idx < 0 ? rel : rel.slice(idx + 1);
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
  const { mode, relPath } = parseSplat(splat);

  const navigate = useNavigate();
  const location = useLocation();
  const { listFiles, readFile } = useFileOps(getActiveBus);

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

  const titleParts = relPath ? relPath.split('/').filter(Boolean) : [];
  const headerTitle = mode === 'f' && titleParts.length > 0
    ? titleParts[titleParts.length - 1]
    : projectName;
  const headerSubtitle = relPath ? `${cwd}/${relPath}` : cwd;

  return (
    <PageShell title={headerTitle} subtitle={headerSubtitle} goBack={goBack} machineName={machine?.nickname}>
      <Breadcrumb projectId={projectId} relPath={relPath} mode={mode} projectName={projectName} navigate={navigate} />
      {mode === 'd' ? (
        <DirectoryView
          projectId={projectId}
          cwd={cwd}
          relPath={relPath}
          listFiles={listFiles}
          navigate={navigate}
        />
      ) : (
        <FileView
          cwd={cwd}
          relPath={relPath}
          readFile={readFile}
        />
      )}
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
  mode,
  projectName,
  navigate,
}: {
  projectId: string;
  relPath: string;
  mode: Mode;
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
        const isFile = isLast && mode === 'f';
        return (
          <span key={accum} className="flex items-center gap-1 min-w-0">
            <span className="text-slate-600">/</span>
            {isLast ? (
              <span className={isFile ? 'text-slate-200 truncate' : 'text-slate-200 truncate'}>{seg}</span>
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
  listFiles,
  navigate,
}: {
  projectId: string;
  cwd: string;
  relPath: string;
  listFiles: ReturnType<typeof useFileOps>['listFiles'];
  navigate: ReturnType<typeof useNavigate>;
}) {
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
      navigate(`/p/${projectId}/files/f/${toUrlPath(next)}`);
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

function FileView({
  cwd,
  relPath,
  readFile,
}: {
  cwd: string;
  relPath: string;
  readFile: ReturnType<typeof useFileOps>['readFile'];
}) {
  const [data, setData] = useState<FilesReadResponsePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const reqIdRef = useRef(0);

  useEffect(() => {
    setLoading(true);
    setData(null);
    const myId = ++reqIdRef.current;
    readFile({ cwd, path: relPath })
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
  }, [cwd, relPath, readFile]);

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
        {data?.error ?? 'Failed to read file.'}
      </div>
    );
  }

  const meta = (
    <div className="px-4 py-2 border-b border-slate-700/50 text-[11px] text-slate-500 flex items-center gap-2">
      <span>{basenameOf(relPath)}</span>
      <span className="opacity-60">·</span>
      <span>{typeof data.size === 'number' ? formatSize(data.size) : '—'}</span>
      {data.kind && data.kind !== 'text' && (
        <>
          <span className="opacity-60">·</span>
          <span className="text-amber-400">{data.kind}</span>
        </>
      )}
    </div>
  );

  if (data.kind === 'binary') {
    return (
      <>
        {meta}
        <div className="px-4 py-12 text-center text-sm text-slate-500">
          Binary file — preview not shown.
        </div>
      </>
    );
  }

  if (data.kind === 'oversized') {
    return (
      <>
        {meta}
        <div className="px-4 py-12 text-center text-sm text-slate-500">
          File is larger than the 100 KB preview cap.
        </div>
      </>
    );
  }

  return (
    <>
      {meta}
      <pre className="px-4 py-3 text-[12px] leading-snug text-slate-200 whitespace-pre overflow-x-auto font-mono">
        {data.content ?? ''}
      </pre>
    </>
  );
}
