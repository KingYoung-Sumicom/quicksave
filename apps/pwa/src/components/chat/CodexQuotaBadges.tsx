// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import type { CodexQuotaSnapshot, CodexQuotaWindow } from '@sumicom/quicksave-shared';
import { useSessionConfig } from '../../hooks/useSessionConfig';
import { normalizeAgentId } from '../../lib/claudePresets';
import { useCodexQuotaStore } from '../../stores/codexQuotaStore';

const ORDERED_WINDOWS: Array<CodexQuotaWindow['id']> = ['five_hour', 'seven_day'];

type QuotaTone = 'green' | 'yellow' | 'red' | 'muted';

const BADGE_TONE: Record<QuotaTone, string> = {
  green: 'bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30',
  yellow: 'bg-amber-600/20 text-amber-300 hover:bg-amber-600/30',
  red: 'bg-rose-600/20 text-rose-300 hover:bg-rose-600/30',
  muted: 'bg-slate-700/60 text-slate-400 hover:bg-slate-700',
};

const BAR_TONE: Record<Exclude<QuotaTone, 'muted'>, string> = {
  green: 'bg-emerald-500',
  yellow: 'bg-amber-500',
  red: 'bg-rose-500',
};

export function expectedUsedPercent(window: CodexQuotaWindow, now = Date.now()): number | null {
  if (!window.resetAt || !window.windowDurationMins || window.windowDurationMins <= 0) return null;
  const durationMs = window.windowDurationMins * 60_000;
  const remainingMs = window.resetAt - now;
  const elapsedMs = durationMs - remainingMs;
  return clamp((elapsedMs / durationMs) * 100, 0, 100);
}

export function quotaTone(window: CodexQuotaWindow | null, opts: {
  now?: number;
  stale?: boolean;
  error?: boolean;
} = {}): QuotaTone {
  if (!window || opts.stale || opts.error) return 'muted';
  const expected = expectedUsedPercent(window, opts.now);
  if (expected === null) {
    if (window.usedPercent >= 90) return 'red';
    if (window.usedPercent >= 70) return 'yellow';
    return 'green';
  }
  const overBudget = window.usedPercent - expected;
  if (window.usedPercent >= 95 || overBudget >= 15) return 'red';
  if (window.usedPercent >= 85 || overBudget >= 5) return 'yellow';
  return 'green';
}

export function CodexQuotaBadges({ sessionId, agentId }: { sessionId: string; agentId?: string }) {
  const config = useSessionConfig(sessionId);
  const snapshot = useCodexQuotaStore((s) => (agentId ? s.byAgent[agentId] : undefined));
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const sessionAgent = normalizeAgentId((config.agent as string | undefined) ?? 'claude-code');
  const isCodexSession = sessionAgent === 'codex';

  useEffect(() => {
    if (!isCodexSession) return;
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [isCodexSession]);

  const windows = useMemo(() => orderQuotaWindows(snapshot?.windows ?? []), [snapshot?.windows]);
  if (!isCodexSession || windows.length === 0) return null;

  const stale = isSnapshotStale(snapshot, now);
  const error = Boolean(snapshot?.error);

  return (
    <>
      {windows.map((window) => {
        const tone = quotaTone(window, { now, stale, error });
        return (
          <button
            key={window.id}
            type="button"
            onClick={() => setOpen(true)}
            className={clsx(
              'flex items-center gap-1 px-2 py-1 rounded-md tabular-nums transition-colors',
              BADGE_TONE[tone],
            )}
            title={badgeTitle(window.label, window, snapshot, stale)}
          >
            <span className={clsx('h-1.5 w-1.5 rounded-full', dotClass(tone))} />
            <span className="font-mono">{window.label}</span>
            <span>{formatPercent(window.usedPercent)}</span>
          </button>
        );
      })}

      {open && (
        <CodexQuotaModal
          snapshot={snapshot ?? null}
          windows={windows}
          now={now}
          stale={stale}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function CodexQuotaModal({
  snapshot,
  windows,
  now,
  stale,
  onClose,
}: {
  snapshot: CodexQuotaSnapshot | null;
  windows: CodexQuotaWindow[];
  now: number;
  stale: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-sm rounded-xl border border-slate-700 bg-slate-800 p-5 shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium text-slate-200">Codex quota</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              {snapshot ? `Updated ${formatClock(snapshot.fetchedAt)}` : 'Waiting for quota snapshot'}
              {stale ? ' · stale' : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-slate-500 hover:bg-slate-700 hover:text-slate-300"
            aria-label="Close"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {snapshot?.error && (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            {snapshot.error}
          </div>
        )}

        <div className="space-y-3">
          {windows.map((window) => (
            <QuotaWindowDetail key={window.id} window={window} now={now} stale={stale} error={Boolean(snapshot?.error)} />
          ))}
        </div>
      </div>
    </div>
  );
}

function QuotaWindowDetail({
  window,
  now,
  stale,
  error,
}: {
  window: CodexQuotaWindow;
  now: number;
  stale: boolean;
  error: boolean;
}) {
  const expected = window ? expectedUsedPercent(window, now) : null;
  const tone = quotaTone(window, { now, stale, error });
  const barTone = tone === 'muted' ? 'bg-slate-500' : BAR_TONE[tone];

  return (
    <section className="rounded-lg border border-slate-700 bg-slate-900/60 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-sm text-slate-200">{window.label}</span>
        <span className={clsx('font-mono text-xs tabular-nums', detailToneClass(tone))}>
          {formatPercent(window.usedPercent)}
        </span>
      </div>

      <div className="relative mb-3 h-2 overflow-hidden rounded-full bg-slate-700">
        <div
          className={clsx('h-full transition-all', barTone)}
          style={{ width: `${clamp(window.usedPercent, 0, 100)}%` }}
        />
        {expected !== null && (
          <span
            className="absolute top-0 h-full w-px bg-white/70"
            style={{ left: `${clamp(expected, 0, 100)}%` }}
          />
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        <Detail label="Used" value={formatPercent(window.usedPercent)} />
        <Detail label="Expected" value={expected !== null ? formatPercent(expected) : '--'} />
        <Detail label="Reset" value={window.resetAt ? formatDateTime(window.resetAt) : '--'} />
        <Detail label="Remaining" value={window.resetAt ? formatRemaining(window.resetAt - now) : '--'} />
      </div>
    </section>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-slate-500">{label}</span>
      <span className="truncate text-right font-mono text-slate-300 tabular-nums" title={value}>{value}</span>
    </>
  );
}

function orderQuotaWindows(windows: CodexQuotaWindow[]): CodexQuotaWindow[] {
  const visible = windows.filter((w) => ORDERED_WINDOWS.includes(w.id));
  const ordered = [...visible].sort((a, b) => {
    const ai = ORDERED_WINDOWS.indexOf(a.id);
    const bi = ORDERED_WINDOWS.indexOf(b.id);
    const as = ai === -1 ? ORDERED_WINDOWS.length : ai;
    const bs = bi === -1 ? ORDERED_WINDOWS.length : bi;
    if (as !== bs) return as - bs;
    return (a.windowDurationMins ?? 0) - (b.windowDurationMins ?? 0);
  });
  return ordered;
}

function badgeTitle(label: string, window: CodexQuotaWindow | null, snapshot: CodexQuotaSnapshot | null | undefined, stale: boolean): string {
  if (!snapshot) return `${label}: waiting for Codex quota`;
  const parts = [`${label}: ${window ? formatPercent(window.usedPercent) : 'unknown'}`];
  if (window?.resetAt) parts.push(`resets ${formatDateTime(window.resetAt)}`);
  if (stale) parts.push('stale');
  if (snapshot.error) parts.push(snapshot.error);
  return parts.join(' · ');
}

function isSnapshotStale(snapshot: CodexQuotaSnapshot | null | undefined, now: number): boolean {
  if (!snapshot) return false;
  return now - snapshot.fetchedAt >= snapshot.ttlMs;
}

function dotClass(tone: QuotaTone): string {
  switch (tone) {
    case 'green': return 'bg-emerald-400';
    case 'yellow': return 'bg-amber-400';
    case 'red': return 'bg-rose-400';
    case 'muted': return 'bg-slate-500';
  }
}

function detailToneClass(tone: QuotaTone): string {
  switch (tone) {
    case 'green': return 'text-emerald-300';
    case 'yellow': return 'text-amber-300';
    case 'red': return 'text-rose-300';
    case 'muted': return 'text-slate-400';
  }
}

function formatPercent(value: number): string {
  return value < 10 ? `${value.toFixed(1)}%` : `${Math.round(value)}%`;
}

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return 'now';
  const totalMinutes = Math.ceil(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
