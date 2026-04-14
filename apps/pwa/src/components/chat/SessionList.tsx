import type { ClaudeSessionSummary } from '@sumicom/quicksave-shared';
import { StatusDot, sessionStatusKey } from '../SessionStatusBadge';
import { formatRelativeTime } from '../../lib/formatRelativeTime';
import { Spinner } from '../ui/Spinner';

export function SessionList({
  sessions,
  isLoading,
  onSelect,
  onNewSession,
}: {
  sessions: ClaudeSessionSummary[];
  isLoading: boolean;
  onSelect: (session: ClaudeSessionSummary) => void;
  onNewSession: () => void;
}) {
  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center py-12">
        <Spinner size="w-8 h-8" color="border-blue-500" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto safe-area-bottom">
      <div className="px-4 py-3 border-b border-slate-700/50">
        <button
          onClick={onNewSession}
          className="w-full text-left transition-colors hover:bg-slate-700/50 flex items-center gap-2 rounded-lg px-2 py-2"
        >
          <svg className="w-4 h-4 text-blue-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          <span className="text-sm text-blue-400 font-medium">New Session</span>
        </button>
      </div>

      {sessions.length === 0 ? (
        <div className="flex items-center justify-center py-12 text-slate-400 text-sm">
          No sessions yet
        </div>
      ) : (
        sessions.map((session) => (
          <button
            key={session.sessionId}
            onClick={() => onSelect(session)}
            className="w-full text-left px-4 py-3 hover:bg-slate-700/50 border-b border-slate-700/50 transition-colors flex items-start gap-3"
          >
            <div className="mt-1 shrink-0">
              <StatusDot statusKey={sessionStatusKey(session)} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">
                {session.summary || session.sessionId.slice(0, 12)}
              </p>
              <div className="flex items-center gap-2 mt-1 text-xs text-slate-400">
                {session.gitBranch && (
                  <span className="flex items-center gap-1">
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    {session.gitBranch}
                  </span>
                )}
                <span>{formatRelativeTime(session.lastModified)}</span>
              </div>
            </div>
          </button>
        ))
      )}
    </div>
  );
}
