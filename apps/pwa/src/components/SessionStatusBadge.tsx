import { clsx } from 'clsx';
import type { ClaudeSessionSummary } from '@sumicom/quicksave-shared';

export type SessionStatusKey = 'thinking' | 'waiting' | 'standby' | 'closed';

export const SESSION_STATUS = {
  thinking: { label: 'Thinking', dotColor: 'bg-blue-400',  textColor: 'text-blue-300',  borderColor: 'border-blue-500/30',  bgColor: 'bg-blue-500/10',  pulse: true  },
  waiting:  { label: 'Waiting',  dotColor: 'bg-amber-400', textColor: 'text-amber-300', borderColor: 'border-amber-500/30', bgColor: 'bg-amber-500/10', pulse: true  },
  standby:  { label: 'Standby',  dotColor: 'bg-green-400', textColor: 'text-green-300', borderColor: 'border-green-500/30', bgColor: 'bg-green-500/10', pulse: false },
  closed:   { label: 'Closed',   dotColor: 'bg-slate-500', textColor: 'text-slate-400', borderColor: 'border-slate-600/30', bgColor: 'bg-slate-700/30', pulse: false },
} as const;

/** Derive status from a session summary. */
export function sessionStatusKey(session: ClaudeSessionSummary): SessionStatusKey {
  if (!session.isActive) return 'closed';
  if (session.isStreaming) return 'thinking';
  if (session.hasPendingInput) return 'waiting';
  return 'standby';
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
      {s.label}
      <span className={clsx('w-1.5 h-1.5 rounded-full', s.dotColor, s.pulse && 'animate-pulse')} />
    </span>
  );
}
