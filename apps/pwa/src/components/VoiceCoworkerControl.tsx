// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

/**
 * Compact composer-toolbar control for the voice intermediary ("AI coworker").
 * Independent of the existing composer mic (option B): toggling it on attaches
 * the daemon agent and reveals a talk button + live status. It interprets the
 * coding agent's output and lets the user steer by voice.
 */
import clsx from 'clsx';
import { useVoiceAgent, type UseVoiceAgent } from '../hooks/useVoiceAgent';

const STATE_LABEL: Record<string, string> = {
  idle: '待命',
  thinking: '思考中…',
  speaking: '說話中…',
  listening: '聆聽中…',
};

function MicGlyph({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'w-4 h-4'} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 1.5a3 3 0 00-3 3v6a3 3 0 006 0v-6a3 3 0 00-3-3z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10.5a7 7 0 0014 0M12 17.5V21m-3.5 0h7" />
    </svg>
  );
}

/** The coworker's identity: an upper-body person paired with a microphone. */
function CoworkerGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className ?? 'w-4 h-4'}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      {/* upper-body person (head + shoulders) */}
      <circle cx="8.5" cy="7" r="3" />
      <path d="M3 20v-1a5.5 5.5 0 0 1 11 0v1" />
      {/* microphone */}
      <rect x="16" y="4" width="3.5" height="7" rx="1.75" />
      <path d="M14 9.5a3.75 3.75 0 0 0 7.5 0" />
      <path d="M17.75 13.25V16.5M15.75 16.5h4" />
    </svg>
  );
}

export function VoiceCoworkerControl({
  agentId,
  sessionId,
  voiceAgent,
}: {
  agentId: string;
  sessionId: string;
  voiceAgent?: UseVoiceAgent;
}) {
  const ownVoiceAgent = useVoiceAgent(agentId, sessionId);
  const va = voiceAgent ?? ownVoiceAgent;

  return (
    <div className="flex items-center gap-1.5 text-xs">
      <button
        type="button"
        onClick={va.toggle}
        className={clsx(
          'px-2 py-1 rounded-lg transition-colors flex items-center gap-1 flex-shrink-0',
          va.enabled
            ? 'bg-purple-600 text-white hover:bg-purple-500'
            : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/60',
        )}
        title="語音同事：詮釋 coding agent 的輸出，並讓你用語音操控"
        aria-pressed={va.enabled}
      >
        <CoworkerGlyph />
        <span className="hidden sm:inline">語音同事</span>
      </button>

      {va.enabled && (
        <>
          <button
            type="button"
            onPointerDown={(e) => {
              e.preventDefault();
              va.onTalkPress();
            }}
            disabled={!va.active || va.busy}
            className={clsx(
              'p-1.5 rounded-lg transition-colors flex-shrink-0 disabled:opacity-50',
              va.recording ? 'bg-red-600 text-white hover:bg-red-500' : 'text-slate-300 hover:bg-slate-700/60',
            )}
            title={va.recording ? '停止' : '按一下說話'}
            aria-label={va.recording ? '停止說話' : '按下說話'}
          >
            <MicGlyph />
          </button>
          <span className="text-slate-400 whitespace-nowrap max-w-[180px] truncate">
            {va.recording && va.interim ? va.interim : STATE_LABEL[va.state] ?? ''}
          </span>
        </>
      )}

      {va.error ? (
        <span className="text-red-400 truncate max-w-[160px]" title={va.error}>
          ⚠ {va.error}
        </span>
      ) : (
        va.enabled &&
        va.lastSpoken && (
          <span className="text-slate-300 truncate max-w-[220px]" title={va.lastSpoken}>
            💬 {va.lastSpoken}
          </span>
        )
      )}
    </div>
  );
}

export function VoiceCoworkerStatusPanel({ voiceAgent }: { voiceAgent: UseVoiceAgent }) {
  const va = voiceAgent;
  const latestAction = va.actionLog.length > 0 ? va.actionLog[va.actionLog.length - 1] : undefined;
  const statusText = va.recording && va.interim
    ? va.interim
    : va.active
      ? STATE_LABEL[va.state] ?? '待命'
      : '尚未連上語音同事';

  return (
    <div className="rounded-lg border border-purple-500/25 bg-slate-800/80 px-3 py-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={va.toggle}
          className="flex shrink-0 items-center justify-center rounded-lg bg-purple-600 p-2 text-white hover:bg-purple-500"
          title="關閉語音同事"
          aria-label="關閉語音同事"
        >
          <CoworkerGlyph className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={clsx(
              'h-2 w-2 shrink-0 rounded-full',
              va.recording ? 'bg-red-400 animate-pulse' : va.active ? 'bg-purple-300' : 'bg-amber-300',
            )} />
            <span className="truncate text-sm font-medium text-slate-100">
              {statusText}
            </span>
          </div>
          <div className="mt-1 truncate text-xs text-slate-400">
            {va.error
              ? va.error
              : latestAction
                ? latestAction
                : va.lastSpoken || '語音同事開啟後，這裡會顯示聆聽、思考、說話與動作狀態。'}
          </div>
        </div>
        <button
          type="button"
          onPointerDown={(e) => {
            e.preventDefault();
            va.onTalkPress();
          }}
          disabled={!va.active || va.busy}
          className={clsx(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-50',
            va.recording ? 'bg-red-600 text-white hover:bg-red-500' : 'bg-slate-700 text-slate-200 hover:bg-slate-600',
          )}
          title={va.recording ? '停止' : '按一下說話'}
          aria-label={va.recording ? '停止說話' : '按下說話'}
        >
          <MicGlyph className="h-5 w-5" />
        </button>
      </div>

      {(va.lastSpoken || va.actionLog.length > 0 || va.error) && (
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
          <div className="min-w-0 rounded border border-slate-700 bg-slate-900/70 px-2 py-1.5">
            <div className="mb-1 text-[10px] font-semibold uppercase text-slate-500">Last spoken</div>
            <div className={clsx('truncate', va.error ? 'text-red-300' : 'text-slate-200')} title={va.error ?? va.lastSpoken}>
              {va.error ?? va.lastSpoken ?? '—'}
            </div>
          </div>
          <div className="min-w-0 rounded border border-slate-700 bg-slate-900/70 px-2 py-1.5">
            <div className="mb-1 text-[10px] font-semibold uppercase text-slate-500">Last action</div>
            <div className="truncate text-slate-200" title={latestAction}>
              {latestAction ?? '—'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
