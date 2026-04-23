import { clsx } from 'clsx';
import { FormattedMessage } from 'react-intl';
import type { AgentId, ClaudeSessionSummary, SessionStage } from '@sumicom/quicksave-shared';
import { sessionStatusKey, SESSION_STATUS } from './SessionStatusBadge';
import { formatRelativeTime } from '../lib/formatRelativeTime';
import { MachineIcon } from './icons/MachineIcon';

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
  /**
   * Machine nickname to surface in the meta line. Same scoping rationale as
   * `projectName`: shown on the flat home list so the user can tell which
   * machine a ticket lives on. Omit when context already implies the
   * machine.
   */
  machineName?: string;
  /**
   * Coding agent running this session. Shown on the flat home list as a
   * neutral text chip so agents can be told apart at a glance. Omit when
   * context already implies the agent (e.g. inside ProjectDetail). Rendered
   * as plain text — no official logos — to stay within nominative fair use.
   */
  agent?: AgentId;
}

const STAGE_META: Record<SessionStage, { labelId: string; dotColor: string; chipText: string; chipBg: string }> = {
  investigating: { labelId: 'sessionStage.investigating', dotColor: 'bg-sky-400',     chipText: 'text-sky-300',     chipBg: 'bg-sky-500/10' },
  working:       { labelId: 'sessionStage.working',       dotColor: 'bg-amber-400',   chipText: 'text-amber-300',   chipBg: 'bg-amber-500/10' },
  verifying:     { labelId: 'sessionStage.verifying',     dotColor: 'bg-violet-400',  chipText: 'text-violet-300',  chipBg: 'bg-violet-500/10' },
  done:          { labelId: 'sessionStage.done',          dotColor: 'bg-emerald-400', chipText: 'text-emerald-300', chipBg: 'bg-emerald-500/10' },
};

const BLOCKED_META = { labelId: 'sessionStage.blocked', dotColor: 'bg-red-500', chipText: 'text-red-300', chipBg: 'bg-red-500/10' };

// Product names surfaced as a neutral text chip — intentionally no official
// logos, to stay clear of Anthropic/OpenAI brand guidelines. Labels are
// nominative use and not translated.
const AGENT_LABEL: Record<AgentId, string> = {
  'claude-code': 'Claude',
  'codex': 'Codex',
};

function Chevron() {
  return (
    <svg className="w-4 h-4 text-slate-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}

// Inline glyphs for the meta line. Sized to sit on the text baseline; color
// inherits from the surrounding span so each item keeps its own emphasis.
function FolderIcon() {
  return (
    <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6L11.4 7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="9" r="2" />
      <path strokeLinecap="round" d="M6 7v10M18 11c0 3-4 4-6 4H6" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 7v5l3 2" />
    </svg>
  );
}

// The leading dot always tracks the runtime session status (standby/pending/
// thinking/closed) so the classic green/orange/blue scheme keeps surfacing
// sessions that need handling — in particular pending permission / pending
// user input. Ticket metadata (stage, blocked) is communicated through the
// chip labels below, not the dot color, so it can't mask a live signal.
function pickDot(session: ClaudeSessionSummary): { color: string; pulse: boolean } {
  const s = SESSION_STATUS[sessionStatusKey(session)];
  return { color: s.dotColor, pulse: s.pulse };
}

export function SessionTicketCard({ session, onClick, compact, isActive, className, projectName, machineName, agent }: SessionTicketCardProps) {
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
          {agent && AGENT_LABEL[agent] && (
            <span className="px-1.5 py-px rounded font-medium bg-slate-500/15 text-slate-300">
              {AGENT_LABEL[agent]}
            </span>
          )}
          {projectName && (
            <span className="inline-flex items-center gap-1 text-slate-400 font-medium">
              <FolderIcon />
              {projectName}
            </span>
          )}
          {machineName && (
            <span className="inline-flex items-center gap-1 text-slate-400 font-medium">
              <MachineIcon className="w-3 h-3 shrink-0" />
              {machineName}
            </span>
          )}
          {session.gitBranch && (
            <span className="inline-flex items-center gap-1">
              <BranchIcon />
              {session.gitBranch}
            </span>
          )}
          <span className="inline-flex items-center gap-1">
            <ClockIcon />
            {formatRelativeTime(session.lastModified)}
          </span>
        </div>
        {!compact && session.note && (
          <p className="text-[11px] text-slate-200 mt-0.5 line-clamp-3 whitespace-pre-wrap break-words">
            ─ {session.note}
          </p>
        )}
      </div>
      <Chevron />
    </button>
  );
}
