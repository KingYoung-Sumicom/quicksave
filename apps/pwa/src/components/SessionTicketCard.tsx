import { clsx } from 'clsx';
import { FormattedMessage } from 'react-intl';
import type { ClaudeSessionSummary, SessionStage } from '@sumicom/quicksave-shared';
import { sessionStatusKey, SESSION_STATUS } from './SessionStatusBadge';
import { formatRelativeTime } from '../lib/formatRelativeTime';

interface SessionTicketCardProps {
  session: ClaudeSessionSummary;
  onClick: () => void;
  /** Render in a denser variant — drops the third-line note preview. */
  compact?: boolean;
  /** When true, highlight as the currently-routed session. */
  isActive?: boolean;
  /** Override the wrapper button's padding/spacing — for nested layouts. */
  className?: string;
  /**
   * Project display name to surface in the meta line. Used by the flat home
   * list where tickets come from many projects and the user needs the
   * scoping cue. Omit when context already implies the project (e.g. inside
   * `ProjectDetail`).
   */
  projectName?: string;
}

const STAGE_META: Record<SessionStage, { labelId: string; dotColor: string; chipText: string; chipBg: string }> = {
  investigating: { labelId: 'sessionStage.investigating', dotColor: 'bg-sky-400',     chipText: 'text-sky-300',     chipBg: 'bg-sky-500/10' },
  working:       { labelId: 'sessionStage.working',       dotColor: 'bg-amber-400',   chipText: 'text-amber-300',   chipBg: 'bg-amber-500/10' },
  verifying:     { labelId: 'sessionStage.verifying',     dotColor: 'bg-violet-400',  chipText: 'text-violet-300',  chipBg: 'bg-violet-500/10' },
  done:          { labelId: 'sessionStage.done',          dotColor: 'bg-emerald-400', chipText: 'text-emerald-300', chipBg: 'bg-emerald-500/10' },
};

const BLOCKED_META = { labelId: 'sessionStage.blocked', dotColor: 'bg-red-500', chipText: 'text-red-300', chipBg: 'bg-red-500/10' };

function Chevron() {
  return (
    <svg className="w-4 h-4 text-slate-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}

/**
 * Choose the dot driving the leading status pip.
 *  - blocked → red, overrides everything
 *  - active runtime states (thinking/pending) → use SESSION_STATUS dot for live signal
 *  - else fall back to ticket stage color
 *  - else neutral slate
 */
function pickDot(session: ClaudeSessionSummary): { color: string; pulse: boolean } {
  if (session.blocked) return { color: BLOCKED_META.dotColor, pulse: true };
  const runtime = sessionStatusKey(session);
  if (runtime === 'thinking' || runtime === 'pending') {
    const s = SESSION_STATUS[runtime];
    return { color: s.dotColor, pulse: s.pulse };
  }
  if (session.stage) return { color: STAGE_META[session.stage].dotColor, pulse: false };
  return { color: 'bg-slate-500', pulse: false };
}

export function SessionTicketCard({ session, onClick, compact, isActive, className, projectName }: SessionTicketCardProps) {
  const dot = pickDot(session);
  const stageMeta = session.stage ? STAGE_META[session.stage] : null;

  // Subject: prefer explicit title (from UpdateSessionStatus subject) — fall back to
  // first prompt, then last-resort to a short id slice. `summary` already carries
  // title-or-firstPrompt at the store layer; we read both so we can italic-dim
  // the fallback.
  const hasSubject = Boolean(session.summary && session.summary.length > 0 && session.summary !== session.firstPrompt);
  const subject = session.summary || session.firstPrompt || session.sessionId.slice(0, 8);

  return (
    <button
      onClick={onClick}
      className={clsx(
        'w-full text-left transition-colors flex items-start gap-3',
        className ?? 'px-4 py-2.5 hover:bg-slate-700/50 active:bg-slate-700/60',
        isActive && 'bg-slate-700/40',
      )}
    >
      <span
        className={clsx(
          'w-2 h-2 rounded-full shrink-0 mt-1.5',
          dot.color,
          dot.pulse && 'animate-pulse',
        )}
      />
      <div className="flex-1 min-w-0">
        <p
          className={clsx(
            'list-title text-sm line-clamp-2',
            !hasSubject && 'italic text-slate-400',
          )}
        >
          {subject}
        </p>
        <div className="list-meta flex items-center gap-2 mt-0.5 text-[11px] flex-wrap">
          {session.blocked ? (
            <span className={clsx('px-1.5 py-px rounded font-medium', BLOCKED_META.chipBg, BLOCKED_META.chipText)}>
              <FormattedMessage id={BLOCKED_META.labelId} />
            </span>
          ) : stageMeta ? (
            <span className={clsx('px-1.5 py-px rounded font-medium', stageMeta.chipBg, stageMeta.chipText)}>
              <FormattedMessage id={stageMeta.labelId} />
            </span>
          ) : null}
          {projectName && <span className="text-slate-400 font-medium">{projectName}</span>}
          {session.gitBranch && <span>{session.gitBranch}</span>}
          <span>{formatRelativeTime(session.lastModified)}</span>
        </div>
        {!compact && session.note && (
          <p className="text-[11px] italic text-slate-500 mt-0.5 truncate">
            ─ {session.note}
          </p>
        )}
      </div>
      <Chevron />
    </button>
  );
}
