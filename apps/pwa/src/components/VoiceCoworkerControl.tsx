// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

/**
 * Compact composer-toolbar control for the voice intermediary ("AI coworker").
 * Independent of the existing composer mic (option B): toggling it on attaches
 * the daemon agent and reveals a talk button + live status. It interprets the
 * coding agent's output and lets the user steer by voice.
 */
import clsx from 'clsx';
import { useVoiceAgent } from '../hooks/useVoiceAgent';

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

export function VoiceCoworkerControl({ agentId, sessionId }: { agentId: string; sessionId: string }) {
  const va = useVoiceAgent(agentId, sessionId);

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
