import { clsx } from 'clsx';
import type { ProjectEntry } from '../hooks/useProjects';
import type { ClaudeSessionSummary } from '@sumicom/quicksave-shared';
import { sessionStatusKey, SESSION_STATUS } from './SessionStatusBadge';
import { formatRelativeTime } from '../lib/formatRelativeTime';

const MAX_INLINE_SESSIONS = 3;

interface ProjectCardProps {
  project: ProjectEntry;
  sessions?: ClaudeSessionSummary[];
  onClick: () => void;
  onSessionClick?: (sessionId: string) => void;
  isActive?: boolean;
  activeSessionId?: string;
  /** When true, render without outer wrapper (caller handles grouping) */
  bare?: boolean;
}

function Chevron() {
  return (
    <svg className="w-4 h-4 text-slate-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}

export function ProjectCard({ project, sessions, onClick, onSessionClick, isActive, activeSessionId, bare }: ProjectCardProps) {
  const sortedSessions = sessions
    ? [...sessions].sort((a, b) => {
        const rankA = a.isStreaming ? 2 : a.isActive ? 1 : 0;
        const rankB = b.isStreaming ? 2 : b.isActive ? 1 : 0;
        if (rankA !== rankB) return rankB - rankA;
        return b.lastModified - a.lastModified;
      }).slice(0, MAX_INLINE_SESSIONS)
    : [];

  const content = (
    <>
      {/* Project row — iOS menu item style */}
      <button
        onClick={onClick}
        className={clsx(
          'w-full flex items-center gap-3 py-2.5 text-left active:bg-slate-700/60 transition-colors',
          isActive && 'bg-slate-700/40',
        )}
      >
        {/* Connection indicator — leftmost, vertically centered */}
        <span
          className={clsx(
            'w-1.5 h-1.5 rounded-full shrink-0',
            project.isConnected ? 'bg-emerald-400' : 'bg-red-500',
          )}
        />

        {/* Text content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="list-title text-[17px] font-medium truncate">
              {project.displayName}
            </span>
            {project.isPinned && (
              <span className="text-[10px] text-amber-400/60 shrink-0">pinned</span>
            )}
          </div>
          <div className="mt-0.5">
            <span className="list-subtitle text-[12px] truncate">
              {project.machineName}
            </span>
          </div>
        </div>

        <Chevron />
      </button>

      {/* Inline sessions — iOS submenu style */}
      {sortedSessions.map((session, i) => {
        const statusKey = sessionStatusKey(session);
        const { dotColor, pulse } = SESSION_STATUS[statusKey];
        const isSessionActive = activeSessionId === session.sessionId;
        return (
          <button
            key={session.sessionId}
            onClick={(e) => {
              e.stopPropagation();
              onSessionClick?.(session.sessionId);
            }}
            className={clsx(
              'w-full flex items-center gap-3 pl-7 py-2 text-left active:bg-slate-700/60 transition-colors',
              isSessionActive && 'bg-slate-700/40',
              i < sortedSessions.length - 1 && 'border-b border-slate-700/40',
            )}
          >
            <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0 self-center', dotColor, pulse && 'animate-[pulse-bright_2s_ease-in-out_infinite]')} />
            <div className="flex-1 min-w-0">
              <span className={clsx(
                'text-[14px] line-clamp-2',
                isSessionActive ? 'text-blue-300' : 'list-title',
              )}>
                {session.summary || session.sessionId.slice(0, 12)}
              </span>
              <span className="list-meta text-[11px] mt-0.5 block">
                {formatRelativeTime(session.lastModified)}
              </span>
            </div>
            <Chevron />
          </button>
        );
      })}
    </>
  );

  if (bare) return content;

  return (
    <div className="overflow-hidden">
      {content}
    </div>
  );
}
