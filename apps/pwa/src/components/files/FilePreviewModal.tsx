// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark-dimmed.css';
import type { FilesReadResponsePayload } from '@sumicom/quicksave-shared';
import {
  useFilePreviewStore,
  type FilePreviewRequest,
  FILE_PREVIEW_PANEL_MIN,
  FILE_PREVIEW_PANEL_MAX,
} from '../../stores/filePreviewStore';
import { useFileOps } from '../../hooks/useFileOps';
import { invalidateFileCache } from '../../lib/fileCache';
import { getBusForAgent } from '../../lib/busRegistry';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { Spinner } from '../ui/Spinner';
import { MarkdownPreview } from './MarkdownPreview';

/**
 * Single mount point — App.tsx renders this once. It subscribes to the
 * `filePreviewStore` and pops over everything when a request is queued.
 */
export function FilePreviewModal() {
  const current = useFilePreviewStore((s) => s.current);
  const close = useFilePreviewStore((s) => s.close);
  const location = useLocation();
  const isDesktop = useMediaQuery('(min-width: 768px)');

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, close]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { close(); }, [location.key]);

  if (!current) return null;

  if (isDesktop) {
    return (
      <DesktopSidePanel onClose={close}>
        <FileViewerPane request={current} onClose={close} />
      </DesktopSidePanel>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-stretch sm:items-center justify-center sm:p-4">
      <div className="absolute inset-0 bg-black/60" onClick={close} />
      <div
        className="relative bg-slate-800 sm:rounded-lg w-full sm:max-w-3xl max-h-screen sm:max-h-[90vh] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <FileViewerPane request={current} onClose={close} />
      </div>
    </div>
  );
}

/**
 * Self-contained file viewer pane — handles loading, error, and display.
 * No positioning wrapper: embed it inside DesktopSidePanel, a modal, or
 * directly in the session right panel.
 */
export function FileViewerPane({
  request,
  onClose,
}: {
  request: FilePreviewRequest;
  onClose: () => void;
}) {
  const agentId = request.agentId ?? '';
  const getBus = useCallback(() => getBusForAgent(agentId), [agentId]);
  const { readFile } = useFileOps(getBus);
  const [data, setData] = useState<FilesReadResponsePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadNonce, setReloadNonce] = useState(0);
  const reqIdRef = useRef(0);

  useEffect(() => {
    setLoading(true);
    setData(null);
    const myId = ++reqIdRef.current;
    readFile({ cwd: request.cwd, path: request.path, maxBytes: request.maxBytes, allowImage: true })
      .then((res) => {
        if (myId !== reqIdRef.current) return;
        setData(res);
      })
      .catch((err) => {
        if (myId !== reqIdRef.current) return;
        setData({
          success: false,
          cwd: request.cwd,
          path: request.path,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        if (myId === reqIdRef.current) setLoading(false);
      });
  }, [request.cwd, request.path, request.maxBytes, readFile, reloadNonce]);

  const refresh = useCallback(() => {
    invalidateFileCache(request.cwd, request.path);
    setReloadNonce((n) => n + 1);
  }, [request.cwd, request.path]);

  const displayPath = data?.absolutePath ?? request.path;
  const fileName = displayPath.split('/').pop() || displayPath;
  const isMarkdown = useMemo(() => isMarkdownPath(displayPath), [displayPath]);
  const isSvg = useMemo(() => isSvgPath(displayPath), [displayPath]);
  const [renderMarkdown, setRenderMarkdown] = useState(true);
  const [renderSvg, setRenderSvg] = useState(true);

  return (
    <>
      {/* Header */}
      <div className="flex items-start gap-3 p-3 border-b border-slate-700 shrink-0">
        <svg className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h7l5 5v11a2 2 0 01-2 2z" />
        </svg>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-100 truncate">{fileName}</p>
          <p className="text-[11px] text-slate-500 truncate">{displayPath}</p>
        </div>
        {isMarkdown && data?.kind === 'text' && (
          <button
            onClick={() => setRenderMarkdown((v) => !v)}
            className="px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-700 rounded-md transition-colors shrink-0 border border-slate-600"
            title={renderMarkdown ? 'Show raw source' : 'Render markdown'}
          >
            {renderMarkdown ? 'Raw' : 'Rendered'}
          </button>
        )}
        {isSvg && data?.kind === 'text' && (
          <button
            onClick={() => setRenderSvg((v) => !v)}
            className="px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-700 rounded-md transition-colors shrink-0 border border-slate-600"
            title={renderSvg ? 'Show raw source' : 'Render SVG'}
          >
            {renderSvg ? 'Raw' : 'Rendered'}
          </button>
        )}
        <button
          onClick={refresh}
          disabled={loading}
          className="p-1 hover:bg-slate-700 rounded-md transition-colors shrink-0 disabled:opacity-40 disabled:hover:bg-transparent"
          aria-label="Refresh"
          title="Refresh"
        >
          <svg
            className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v6h6M20 20v-6h-6M4 10a8 8 0 0114-4.9M20 14a8 8 0 01-14 4.9" />
          </svg>
        </button>
        <button
          onClick={onClose}
          className="p-1 hover:bg-slate-700 rounded-md transition-colors shrink-0"
          aria-label="Close"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Spinner size="w-5 h-5" color="border-blue-400" />
          </div>
        )}

        {!loading && data && !data.success && (
          <div className="px-4 py-6 text-sm text-red-400">
            {data.error ?? 'Failed to read file.'}
          </div>
        )}

        {!loading && data?.success && (
          <PreviewContent
            data={data}
            displayPath={displayPath}
            cwd={request.cwd}
            agentId={request.agentId ?? ''}
            renderMarkdown={isMarkdown && renderMarkdown}
            renderSvg={isSvg && renderSvg}
          />
        )}
      </div>

      {/* Footer meta */}
      {!loading && data?.success && (
        <div className="px-3 py-1.5 border-t border-slate-700 text-[11px] text-slate-500 flex items-center gap-2 shrink-0">
          <span>{typeof data.size === 'number' ? formatSize(data.size) : '—'}</span>
          {data.kind && data.kind !== 'text' && (
            <>
              <span className="opacity-60">·</span>
              <span className="text-amber-400">{data.kind}</span>
            </>
          )}
        </div>
      )}
    </>
  );
}

function DesktopSidePanel({
  children,
  onClose: _onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  const panelWidth = useFilePreviewStore((s) => s.panelWidth);
  const setPanelWidth = useFilePreviewStore((s) => s.setPanelWidth);
  const draggingRef = useRef(false);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    draggingRef.current = true;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const next = window.innerWidth - e.clientX;
    setPanelWidth(next);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };

  return (
    <div
      className="fixed inset-y-0 right-0 z-40 border-l border-slate-700 bg-slate-800 shadow-2xl flex flex-col"
      style={{ width: panelWidth }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={FILE_PREVIEW_PANEL_MIN}
        aria-valuemax={FILE_PREVIEW_PANEL_MAX}
        aria-valuenow={panelWidth}
        title="Drag to resize"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="absolute top-0 left-0 h-full w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-blue-500/30 active:bg-blue-500/50 transition-colors z-10"
      />
      {children}
    </div>
  );
}

function PreviewContent({
  data,
  displayPath,
  cwd,
  agentId,
  renderMarkdown,
  renderSvg,
}: {
  data: FilesReadResponsePayload;
  displayPath: string;
  cwd: string;
  agentId: string;
  renderMarkdown: boolean;
  renderSvg: boolean;
}) {
  const lang = useMemo(() => detectLanguage(displayPath), [displayPath]);
  const highlighted = useMemo(() => {
    if (data.kind !== 'text' || !lang) return null;
    const content = data.content ?? '';
    if (!content) return null;
    try {
      return hljs.highlight(content, { language: lang, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }, [data.kind, data.content, lang]);

  if (data.kind === 'binary') {
    return (
      <div className="px-4 py-12 text-center text-sm text-slate-500">
        Binary file — preview not shown.
      </div>
    );
  }
  if (data.kind === 'oversized') {
    return (
      <div className="px-4 py-12 text-center text-sm text-slate-500">
        File is larger than the preview cap.
      </div>
    );
  }
  if (data.kind === 'image' && data.content && data.mimeType) {
    return (
      <div className="flex min-h-full items-center justify-center p-3 bg-slate-950">
        <img
          src={`data:${data.mimeType};base64,${data.content}`}
          alt={displayPath.split('/').pop() ?? 'Image preview'}
          className="max-h-[80vh] max-w-full object-contain"
        />
      </div>
    );
  }
  if (renderMarkdown && data.kind === 'text' && typeof data.content === 'string') {
    return (
      <MarkdownPreview
        source={data.content}
        fileAbsolutePath={data.absolutePath ?? displayPath}
        cwd={cwd}
        agentId={agentId}
      />
    );
  }
  if (renderSvg && data.kind === 'text' && typeof data.content === 'string') {
    const src = `data:image/svg+xml;utf8,${encodeURIComponent(data.content)}`;
    return (
      <div className="flex items-center justify-center p-4 bg-[length:16px_16px] bg-[linear-gradient(45deg,rgba(255,255,255,0.04)_25%,transparent_25%,transparent_75%,rgba(255,255,255,0.04)_75%),linear-gradient(45deg,rgba(255,255,255,0.04)_25%,transparent_25%,transparent_75%,rgba(255,255,255,0.04)_75%)] bg-[position:0_0,8px_8px]">
        <img
          src={src}
          alt={displayPath.split('/').pop() ?? 'SVG preview'}
          className="max-w-full max-h-[70vh] object-contain"
        />
      </div>
    );
  }
  if (highlighted) {
    return (
      <pre className="px-4 py-3 text-[12px] leading-snug whitespace-pre overflow-x-auto font-mono">
        <code
          className={`hljs language-${lang}`}
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      </pre>
    );
  }
  return (
    <pre className="px-4 py-3 text-[12px] leading-snug text-slate-200 whitespace-pre overflow-x-auto font-mono">
      {data.content ?? ''}
    </pre>
  );
}

function isMarkdownPath(filePath: string): boolean {
  const name = (filePath.split('/').pop() ?? '').toLowerCase();
  return name.endsWith('.md') || name.endsWith('.markdown') || name.endsWith('.mdx');
}

function isSvgPath(filePath: string): boolean {
  return (filePath.split('/').pop() ?? '').toLowerCase().endsWith('.svg');
}

function detectLanguage(filePath: string): string | undefined {
  const name = (filePath.split('/').pop() ?? '').toLowerCase();
  if (!name) return undefined;
  if (name === 'dockerfile' || name.endsWith('.dockerfile')) return 'dockerfile';
  if (name === 'makefile' || name === 'gnumakefile') return 'makefile';
  if (name === 'cmakelists.txt') return 'cmake';
  const dotIdx = name.lastIndexOf('.');
  if (dotIdx < 0) return undefined;
  return EXT_TO_LANG[name.slice(dotIdx + 1)];
}

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyi: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  swift: 'swift',
  c: 'c', h: 'c',
  cpp: 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp', hxx: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  json: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  vue: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  sql: 'sql',
  graphql: 'graphql', gql: 'graphql',
  proto: 'protobuf',
  lua: 'lua',
  pl: 'perl', pm: 'perl',
  r: 'r',
  scala: 'scala',
  dart: 'dart',
  ex: 'elixir', exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  ml: 'ocaml', mli: 'ocaml',
  clj: 'clojure',
  zig: 'zig',
};

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
