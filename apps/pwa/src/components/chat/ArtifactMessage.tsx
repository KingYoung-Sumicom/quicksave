// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState } from 'react';
import type { MarkdownArtifactRef } from '@sumicom/quicksave-shared';
import { useArtifactContent } from '../../hooks/useArtifactContent';
import { ChatMarkdown } from './ChatMarkdown';

export function ArtifactMessage({ artifact }: { artifact: MarkdownArtifactRef }) {
  const state = useArtifactContent(artifact.sessionId, artifact.artifactId);
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);

  const markdown = state.status === 'ready' ? state.markdown : '';

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
    <div className="mt-2 border-t border-emerald-500/20 pt-2">
      <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[12px] font-medium text-emerald-200">{artifact.title}</div>
          <div className="text-[10px] text-slate-500">{formatBytes(artifact.size)} markdown</div>
        </div>
        {state.status === 'ready' && (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setRaw((v) => !v)}
              className="text-[11px] text-slate-500 hover:text-slate-300 transition-colors"
            >
              {raw ? 'Rendered' : 'Raw'}
            </button>
            <button
              type="button"
              onClick={copyMarkdown}
              className="text-[11px] text-slate-500 hover:text-slate-300 transition-colors"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              onClick={downloadMarkdown}
              className="text-[11px] text-slate-500 hover:text-slate-300 transition-colors"
            >
              Download
            </button>
          </div>
        )}
      </div>

      {state.status === 'loading' && (
        <div className="text-xs text-slate-500">Loading report...</div>
      )}
      {state.status === 'error' && (
        <div className="text-xs text-red-300">{state.error}</div>
      )}
      {state.status === 'ready' && (
        raw ? (
          <pre className="max-h-[75vh] overflow-auto whitespace-pre-wrap break-words rounded border border-slate-700 bg-slate-950/70 p-3 font-mono text-[12px] text-slate-300">
            {markdown}
          </pre>
        ) : (
          <div className="chat-markdown max-h-[75vh] overflow-auto rounded border border-slate-700/70 bg-slate-950/30 p-3 text-sm">
            <ChatMarkdown>{markdown}</ChatMarkdown>
          </div>
        )
      )}
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
