import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark-dimmed.css';
import type { FilesReadResponsePayload } from '@sumicom/quicksave-shared';
import { useFilePreviewStore, type FilePreviewRequest } from '../../stores/filePreviewStore';
import { useFileOps } from '../../hooks/useFileOps';
import { getActiveBus } from '../../lib/busRegistry';
import { Spinner } from '../ui/Spinner';
import { MarkdownPreview } from './MarkdownPreview';

/**
 * Single mount point — App.tsx renders this once. It subscribes to the
 * `filePreviewStore` and pops over everything when a request is queued.
 *
 * The viewer mirrors the old in-page FileView: text content for `kind:
 * 'text'`, and a placeholder for binary / oversized so the channel
 * doesn't carry megabytes for files we can't render anyway.
 */
export function FilePreviewModal() {
  const current = useFilePreviewStore((s) => s.current);
  const close = useFilePreviewStore((s) => s.close);
  const location = useLocation();

  // ESC closes the modal — mirrors the SwipeableDrawer / Modal idioms.
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, close]);

  // Close on navigation. The router updates location.key on every push /
  // pop, so back-button + sidebar nav both fire this. We deliberately
  // ignore `current` in deps so the close doesn't re-fire from store
  // mutations — only from real route changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { close(); }, [location.key]);

  if (!current) return null;
  return <PreviewBody request={current} onClose={close} />;
}

function PreviewBody({
  request,
  onClose,
}: {
  request: FilePreviewRequest;
  onClose: () => void;
}) {
  const { readFile } = useFileOps(getActiveBus);
  const [data, setData] = useState<FilesReadResponsePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const reqIdRef = useRef(0);

  useEffect(() => {
    setLoading(true);
    setData(null);
    const myId = ++reqIdRef.current;
    readFile({ cwd: request.cwd, path: request.path, maxBytes: request.maxBytes })
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
  }, [request.cwd, request.path, request.maxBytes, readFile]);

  const displayPath = data?.absolutePath ?? request.path;
  const fileName = displayPath.split('/').pop() || displayPath;
  const isMarkdown = useMemo(() => isMarkdownPath(displayPath), [displayPath]);
  const isSvg = useMemo(() => isSvgPath(displayPath), [displayPath]);
  const [renderMarkdown, setRenderMarkdown] = useState(true);
  const [renderSvg, setRenderSvg] = useState(true);

  return (
    <div className="fixed inset-0 z-50 flex items-stretch sm:items-center justify-center sm:p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        className="relative bg-slate-800 sm:rounded-lg w-full sm:max-w-3xl max-h-screen sm:max-h-[90vh] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
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
      </div>
    </div>
  );
}

function PreviewContent({
  data,
  displayPath,
  cwd,
  renderMarkdown,
  renderSvg,
}: {
  data: FilesReadResponsePayload;
  displayPath: string;
  cwd: string;
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
        File is larger than the 100 KB preview cap.
      </div>
    );
  }
  if (renderMarkdown && data.kind === 'text' && typeof data.content === 'string') {
    return (
      <MarkdownPreview
        source={data.content}
        fileAbsolutePath={data.absolutePath ?? displayPath}
        cwd={cwd}
      />
    );
  }
  if (renderSvg && data.kind === 'text' && typeof data.content === 'string') {
    // Render via <img> with a data URL — this gives us a passive image
    // context where any <script> inside the SVG won't execute, so we
    // don't need a separate sanitiser pass.
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

/**
 * Map a file path to a highlight.js language id. Driven by extension and
 * a few well-known basenames (Dockerfile, Makefile). Returns undefined
 * when we don't recognise the type — caller falls back to plain text.
 */
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
