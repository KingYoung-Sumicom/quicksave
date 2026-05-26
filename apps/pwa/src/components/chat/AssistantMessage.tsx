// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState } from 'react';
import { ChatMarkdown } from './ChatMarkdown';
import { useClaudeStore } from '../../stores/claudeStore';

export function AssistantMessage({ content, isLast }: { content: string; isLast: boolean }) {
  const isStreaming = useClaudeStore((s) => s.isStreaming);
  const isActivelyStreaming = isLast && isStreaming;
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked (insecure context / denied permission).
    }
  }

  // Empty content while streaming — ClaudePanel renders bounce dots instead;
  // rendering nothing here avoids a duplicate loading indicator.
  if (!content) return null;

  return (
    <div className="group py-1 w-full text-sm">
      {showRaw ? (
        <pre className="chat-markdown-raw whitespace-pre-wrap break-words font-mono text-[12px] text-slate-300 bg-slate-900 border border-slate-700 rounded p-3 overflow-x-auto">
          {content}
        </pre>
      ) : (
        <div className="chat-markdown">
          <ChatMarkdown>{content}</ChatMarkdown>
          {isActivelyStreaming && (
            <span className="inline-block w-1.5 h-4 bg-blue-400 animate-pulse ml-0.5 align-text-bottom rounded-sm" />
          )}
        </div>
      )}
      {/* Toggle between the rendered message and its raw markdown source.
          Hidden until hover (or while toggled on) to keep the chat clean. */}
      <div
        className={`mt-1 flex items-center gap-3 transition-opacity ${
          showRaw ? '' : 'opacity-0 group-hover:opacity-100'
        }`}
      >
        <button
          type="button"
          onClick={() => setShowRaw((v) => !v)}
          className="text-[11px] text-slate-500 hover:text-slate-300 transition-colors"
          aria-pressed={showRaw}
        >
          {showRaw ? 'Rendered' : 'Raw markdown'}
        </button>
        {showRaw && (
          <button
            type="button"
            onClick={handleCopy}
            className="text-[11px] text-slate-500 hover:text-slate-300 transition-colors"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
    </div>
  );
}
