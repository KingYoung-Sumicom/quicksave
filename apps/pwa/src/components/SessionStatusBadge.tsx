// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { clsx } from 'clsx';
import { FormattedMessage } from 'react-intl';
import type { ClaudeSessionSummary } from '@sumicom/quicksave-shared';

export type SessionStatusKey = 'thinking' | 'pending' | 'waiting' | 'unread' | 'standby' | 'closed';

export const SESSION_STATUS = {
  thinking: { dotColor: 'bg-blue-400',   textColor: 'text-blue-300',   borderColor: 'border-blue-500/30',   bgColor: 'bg-blue-500/10',   pulse: true  },
  pending:  { dotColor: 'bg-orange-400', textColor: 'text-orange-300', borderColor: 'border-orange-500/30', bgColor: 'bg-orange-500/10', pulse: true  },
  waiting:  { dotColor: 'bg-blue-400',   textColor: 'text-blue-300',   borderColor: 'border-blue-500/30',   bgColor: 'bg-blue-500/10',   pulse: true  },
  unread:   { dotColor: 'bg-purple-400', textColor: 'text-purple-300', borderColor: 'border-purple-500/30', bgColor: 'bg-purple-500/10', pulse: false },
  standby:  { dotColor: 'bg-green-400',  textColor: 'text-green-300',  borderColor: 'border-green-500/30',  bgColor: 'bg-green-500/10',  pulse: false },
  closed:   { dotColor: 'bg-slate-500',  textColor: 'text-slate-400',  borderColor: 'border-slate-600/30',  bgColor: 'bg-slate-700/30',  pulse: false },
} as const;

/**
 * Email-style "unread": the user hasn't viewed activity that landed since
 * `lastReadAt`. The agent stamps `lastReadAt` server-side from the
 * `session:mark-read` request fired by the attention hook (and broadcasts
 * it cross-device), so this derivation works the same on every PWA client.
 *
 * Excluded:
 *   - Sessions whose `lastReadAt` is missing — treat the field's absence
 *     as "the agent isn't tracking read state for this session" rather than
 *     "never read." This keeps a stale agent build (or a registry entry
 *     that predates the feature) from flooding the home list with purple
 *     dots; once any device sends `session:mark-read` once, the field
 *     populates and normal unread tracking takes over.
 *   - Sessions that have never produced output (`lastTurnEndedAt == null`)
 *     — there's nothing to read yet.
 *
 * Inactive sessions (`isActive === false`) ARE allowed to be unread — a
 * session that ended with output you never saw still wants the cue, even
 * if its CLI process is gone.
 */
export function isSessionUnread(session: Pick<ClaudeSessionSummary, 'lastReadAt' | 'lastTurnEndedAt'>): boolean {
  const lastReadAt = session.lastReadAt;
  if (typeof lastReadAt !== 'number') return false;
  const lastTurnEndedAt = session.lastTurnEndedAt;
  if (typeof lastTurnEndedAt !== 'number' || lastTurnEndedAt <= 0) return false;
  return lastReadAt < lastTurnEndedAt;
}

/**
 * Derive status from a session summary. Priority order:
 *   1. `pending`  — agent paused for user input (orange). Wins over
 *      everything: permission requests arrive mid-stream while `isStreaming`
 *      is still true, so this check must come first or the blue cursor cue
 *      would permanently mask the orange action cue.
 *   2. `thinking` — actively producing output (blue cursor cue).
 *   3. `unread`   — there's new output the user hasn't viewed (purple).
 *      Wins over `closed`: until the user actually opens it,
 *      "you haven't seen this" is the loudest remaining signal.
 *   4. `closed`   — process is gone, follow-up needs cold-resume.
 *   5. `standby`  — idle, alive, all read.
 */
export function sessionStatusKey(session: ClaudeSessionSummary): SessionStatusKey {
  if (session.hasPendingInput) return 'pending';
  if (session.isStreaming) return 'thinking';
  if (isSessionUnread(session)) return 'unread';
  if (!session.isActive) return 'closed';
  return 'standby';
}

export function StatusDot({ statusKey }: { statusKey: SessionStatusKey }) {
  const s = SESSION_STATUS[statusKey];
  return (
    <span className={clsx('w-2 h-2 rounded-full shrink-0', s.dotColor, s.pulse && 'animate-pulse')} />
  );
}

interface SessionStatusBadgeProps {
  statusKey: SessionStatusKey;
  /** If true, show the "Closed" state; if false, hide the badge entirely for closed sessions */
  showClosed?: boolean;
}

export function SessionStatusBadge({ statusKey, showClosed = false }: SessionStatusBadgeProps) {
  if (statusKey === 'closed' && !showClosed) return null;

  const s = SESSION_STATUS[statusKey];
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-medium flex-shrink-0',
        s.borderColor, s.bgColor, s.textColor
      )}
    >
      <FormattedMessage id={`sessionStatus.label.${statusKey}`} />
      <span className={clsx('w-1.5 h-1.5 rounded-full', s.dotColor, s.pulse && 'animate-pulse')} />
    </span>
  );
}
