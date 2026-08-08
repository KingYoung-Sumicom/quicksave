// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState } from 'react';
import type { SystemCard } from '@sumicom/quicksave-shared';

const URL_PATTERN = /https?:\/\/[^\s)]+/g;

function linkedText(text: string) {
  const parts = text.split(URL_PATTERN);
  const urls = text.match(URL_PATTERN) ?? [];

  return parts.flatMap((part, index) => {
    const url = urls[index];
    return url
      ? [
          part,
          <a
            key={`${url}:${index}`}
            href={url}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-red-400/50 underline-offset-2 hover:text-red-200"
          >
            {url}
          </a>,
        ]
      : [part];
  });
}

/** "1m 25s" / "45s" — mirrors the agent's formatDurationMs for the badge. */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function SystemMessage({ card }: { card: SystemCard }) {
  const meta = card.meta;

  if (meta?.kind === 'turn_duration') {
    return (
      <div className="flex justify-center py-1">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-800/60 px-2.5 py-0.5 text-[11px] text-slate-400">
          <span aria-hidden>⏱</span>
          <span>{formatDuration(meta.durationMs)}</span>
          <span className="text-slate-600">·</span>
          <span>{meta.messageCount} msgs</span>
        </span>
      </div>
    );
  }

  if (meta?.kind === 'stop_hook_summary') {
    return <StopHookSummary meta={meta} fallbackText={card.text} />;
  }

  if (card.subtype === 'error') {
    return (
      <div className="my-2 mr-auto w-full max-w-2xl rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-left shadow-sm">
        <div className="mb-1 text-[11px] font-semibold uppercase text-red-300">Request failed</div>
        <div className="whitespace-pre-wrap break-words text-sm text-red-100">
          {linkedText(card.text)}
        </div>
      </div>
    );
  }

  if (card.subtype === 'warning') {
    return (
      <div className="my-2 mr-auto w-full max-w-2xl rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-left shadow-sm">
        <div className="mb-1 text-[11px] font-semibold uppercase text-amber-300">Warning</div>
        <div className="whitespace-pre-wrap break-words text-sm text-amber-100">{linkedText(card.text)}</div>
      </div>
    );
  }

  if (card.subtype === 'compacted') {
    return (
      <div className="my-1 mr-auto inline-flex rounded-md border border-cyan-500/25 bg-cyan-500/10 px-2.5 py-1 text-xs text-cyan-200">
        {card.text}
      </div>
    );
  }

  if (card.subtype === 'info') {
    return (
      <div className="my-1.5 mr-auto w-full max-w-2xl rounded-md border border-slate-700 bg-slate-800/60 px-3 py-2 text-left">
        <div className="whitespace-pre-wrap break-words text-xs text-slate-300">{linkedText(card.text)}</div>
      </div>
    );
  }

  // Plain one-line system note.
  return (
    <div className="text-center text-xs text-slate-500 py-1">{card.text}</div>
  );
}

/** Collapsed by default to a single compact line; expands to show each hook's
 *  command, wall-clock time, and any error. Errors tint the summary amber so a
 *  failing hook (e.g. a bad interpreter path) is noticeable without expanding. */
function StopHookSummary({
  meta,
  fallbackText,
}: {
  meta: Extract<NonNullable<SystemCard['meta']>, { kind: 'stop_hook_summary' }>;
  fallbackText: string;
}) {
  const [open, setOpen] = useState(false);
  const hasError = meta.errors.length > 0 || meta.preventedContinuation;
  const tint = hasError ? 'text-amber-400' : 'text-slate-500';

  return (
    <div className="flex flex-col items-center py-1 text-[11px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 ${tint} hover:text-slate-300`}
      >
        <span aria-hidden>{open ? '▾' : '▸'}</span>
        <span aria-hidden>{hasError ? '⚠' : '✓'}</span>
        <span>{fallbackText}</span>
      </button>
      {open && (
        <div className="mt-1 w-full max-w-md space-y-1 rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2 text-left font-mono text-[11px] text-slate-400">
          {meta.hooks.map((h, i) => (
            <div key={i} className="truncate">
              <span className="text-slate-500">{h.durationMs}ms</span>{' '}
              <span title={h.command}>{h.command || '(no command)'}</span>
            </div>
          ))}
          {meta.errors.map((e, i) => (
            <div key={`e${i}`} className="whitespace-pre-wrap break-words text-red-400">
              {e}
            </div>
          ))}
          {meta.preventedContinuation && (
            <div className="text-amber-400">
              prevented continuation{meta.stopReason ? `: ${meta.stopReason}` : ''}
            </div>
          )}
          {meta.level && <div className="text-slate-600">level: {meta.level}</div>}
        </div>
      )}
    </div>
  );
}
