// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import { clsx } from 'clsx';
import { DEFAULT_KV_CACHE_LIFETIME_MS } from '@sumicom/quicksave-shared';
import { useClaudeStore } from '../../stores/claudeStore';
import { ContextUsageBadge, formatTokens } from './ContextUsageBadge';

interface SessionStatsBarProps {
  sessionId: string;
  /** Cache lifetime used for the countdown. Defaults to DEFAULT_KV_CACHE_LIFETIME_MS. */
  cacheLifetimeMs?: number;
  /** Sends `/compact` to the session to summarize history and reduce context. */
  onCompact?: () => void;
  /** Clears the active session and returns to new-session view. */
  onClear?: () => void;
}

function formatCountdown(remainingMs: number): string {
  const totalSec = Math.max(0, Math.floor(remainingMs / 1000));
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export function SessionStatsBar({
  sessionId,
  cacheLifetimeMs = DEFAULT_KV_CACHE_LIFETIME_MS,
  onCompact,
  onClear,
}: SessionStatsBarProps) {
  const intl = useIntl();
  const session = useClaudeStore((s) => s.sessions[sessionId]);
  const lastTurnTotal = (session?.lastTurnInputTokens ?? 0)
    + (session?.lastTurnCacheCreationTokens ?? 0)
    + (session?.lastTurnCacheReadTokens ?? 0);
  const hasContextData = lastTurnTotal > 0;
  const contextTokens = session?.lastTurnContextUsage?.totalTokens ?? lastTurnTotal;

  // Anthropic refreshes the cache TTL on every cache hit/write (per the
  // prompt-caching docs), so the most reliable anchor is the timestamp of the
  // last SDK message whose `usage` reported cache activity — surfaced as
  // `lastCacheTouchAt`. That timer ticks for inner API calls inside long
  // autonomous turns too. Fall back to turn-end / prompt-sent for sessions
  // that haven't hit the cache yet (or whose daemon was restarted, since the
  // touch timestamp is in-memory only).
  const cacheAnchor = Math.max(
    session?.lastCacheTouchAt ?? 0,
    session?.lastTurnEndedAt ?? 0,
    session?.lastPromptAt ?? 0,
  ) || undefined;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!cacheAnchor) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [cacheAnchor]);

  const hasCountdown = typeof cacheAnchor === 'number';
  if (!hasContextData && !hasCountdown) return null;

  const remainingMs = hasCountdown ? Math.max(0, cacheAnchor! + cacheLifetimeMs - now) : 0;
  const expired = hasCountdown && remainingMs <= 0;

  return (
    <>
      {hasContextData && (
        <ContextUsageBadge sessionId={sessionId} onCompact={onCompact} onClear={onClear} />
      )}
      {hasCountdown && (
        <span
          className={clsx(
            'flex items-center gap-1 px-2 py-1 rounded-md font-mono tabular-nums',
            expired
              ? 'bg-amber-600/20 text-amber-400'
              : 'bg-slate-700/60 text-slate-400',
          )}
          title={
            expired
              ? intl.formatMessage({ id: 'sessionStatsBar.expiredTitle' }, { tokens: formatTokens(contextTokens) })
              : intl.formatMessage({ id: 'sessionStatsBar.title' })
          }
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="9" strokeWidth="2" />
            <path strokeLinecap="round" strokeWidth="2" d="M12 7v5l3 2" />
          </svg>
          {expired
            ? contextTokens > 0
              ? intl.formatMessage({ id: 'sessionStatsBar.expiredWithTokens' }, { tokens: formatTokens(contextTokens) })
              : intl.formatMessage({ id: 'sessionStatsBar.expired' })
            : formatCountdown(remainingMs)}
        </span>
      )}
    </>
  );
}
