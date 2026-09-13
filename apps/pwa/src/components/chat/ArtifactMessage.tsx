// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { MarkdownArtifactRef } from '@sumicom/quicksave-shared';
import { useArtifactContent } from '../../hooks/useArtifactContent';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useSessionRightPanelStore } from '../../stores/sessionRightPanelStore';
import { ChatMarkdown } from './ChatMarkdown';

export function ArtifactMessage({ artifact }: { artifact: MarkdownArtifactRef }) {
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const openArtifactPreview = useSessionRightPanelStore((s) => s.openArtifactPreview);
  const [mobileOpen, setMobileOpen] = useState(false);

  const open = () => {
    if (isDesktop) {
      openArtifactPreview(artifact);
    } else {
      setMobileOpen(true);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={open}
        className="mt-2 flex w-full min-w-0 items-center gap-2.5 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-left transition-colors hover:border-emerald-400/40 hover:bg-emerald-500/10"
        aria-label={`Open artifact ${artifact.title}`}
      >
        <svg className="h-4 w-4 shrink-0 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h7l5 5v11a2 2 0 01-2 2z" />
        </svg>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-medium text-emerald-200">{artifact.title}</span>
          <span className="block text-[10px] text-slate-500">{formatBytes(artifact.size)} · Markdown</span>
        </span>
        <svg className="h-3.5 w-3.5 shrink-0 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {mobileOpen && createPortal(
        <div
          className="fixed inset-0 z-50 flex flex-col bg-slate-900"
          role="dialog"
          aria-modal="true"
          aria-label={artifact.title}
        >
          <ArtifactPreviewPane artifact={artifact} onClose={() => setMobileOpen(false)} />
        </div>,
        document.body,
      )}
    </>
  );
}

export function ArtifactPreviewPane({
  artifact,
  onClose,
}: {
  artifact: MarkdownArtifactRef;
  onClose?: () => void;
}) {
  const state = useArtifactContent(artifact.sessionId, artifact.artifactId);
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);

  const markdown = state.status === 'ready' ? state.markdown : '';
  const artifactBaseDir = artifact.sourcePath
    ? artifact.sourcePath.slice(0, artifact.sourcePath.lastIndexOf('/')) || '/'
    : artifact.cwd;

  async function copyMarkdown(): Promise<void> {
    if (!markdown) return;
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked.
    }
  }

  function downloadMarkdown(): void {
    if (!markdown) return;
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = safeFilename(artifact.title);
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-w-0 items-center justify-between gap-2 border-b border-slate-700 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-slate-100">{artifact.title}</div>
          <div className="text-[11px] text-slate-500">{formatBytes(artifact.size)} · Markdown</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {state.status === 'ready' && (
            <>
              <button
                type="button"
                onClick={() => setRaw((v) => !v)}
                className="text-[11px] text-slate-500 transition-colors hover:text-slate-300"
              >
                {raw ? 'Rendered' : 'Raw'}
              </button>
              <button
                type="button"
                onClick={copyMarkdown}
                className="text-[11px] text-slate-500 transition-colors hover:text-slate-300"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button
                type="button"
                onClick={downloadMarkdown}
                className="text-[11px] text-slate-500 transition-colors hover:text-slate-300"
              >
                Download
              </button>
            </>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
              aria-label="Close artifact preview"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {state.status === 'loading' && (
          <div className="px-4 py-8 text-center text-xs text-slate-500">Loading report...</div>
        )}
        {state.status === 'error' && (
          <div className="px-4 py-8 text-sm text-red-300">{state.error}</div>
        )}
        {state.status === 'ready' && (
          raw ? (
            <pre className="whitespace-pre-wrap break-words bg-slate-950/70 p-4 font-mono text-[12px] text-slate-300">
              {markdown}
            </pre>
          ) : (
            <div className="chat-markdown p-4 text-sm">
              <ChatMarkdown cwd={artifact.cwd} baseDir={artifactBaseDir}>{markdown}</ChatMarkdown>
            </div>
          )
        )}
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function safeFilename(title: string): string {
  const base = title.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'artifact';
  return base.toLowerCase().endsWith('.md') || base.toLowerCase().endsWith('.markdown')
    ? base
    : `${base}.md`;
}
