// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { isValidElement, useState, type ReactNode } from 'react';

/** Pull the `language-*` token off the inner `<code>` element's className. */
export function languageFromChild(child: ReactNode): string | null {
  if (!isValidElement(child)) return null;
  const className = (child.props as { className?: string }).className ?? '';
  const m = /\blanguage-([\w+#-]+)/.exec(className);
  return m ? m[1] : null;
}

/** Recursively flatten a React node tree to its plain-text content, so the
 *  copy button reproduces the source even after the highlighter has split it
 *  into nested `<span>`s. */
export function textOf(node: ReactNode): string {
  if (node == null || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

/**
 * Block-code renderer for our markdown components: wraps the highlighted
 * `<pre>` with a header showing the source language and a copy button.
 *
 * Drop in as the `pre` override for `react-markdown` — the `children` it
 * receives is the inner `<code>` element produced by `rehype-highlight`.
 */
export function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const language = languageFromChild(children);
  const source = textOf(children).replace(/\n$/, '');

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked (insecure context / denied permission);
      // silently leave the button in its idle state.
    }
  }

  return (
    <div className="my-2 rounded overflow-hidden border border-slate-700 bg-slate-900">
      <div className="flex items-center justify-between px-3 py-1 bg-slate-800/70 border-b border-slate-700">
        <span className="text-[11px] font-mono uppercase tracking-wide text-slate-400">
          {language ?? 'text'}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200 transition-colors"
          aria-label="Copy code"
        >
          {copied ? (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Copied
            </>
          ) : (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              Copy
            </>
          )}
        </button>
      </div>
      <pre className="p-3 text-[12px] overflow-x-auto">{children}</pre>
    </div>
  );
}
