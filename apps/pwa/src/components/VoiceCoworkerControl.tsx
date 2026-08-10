// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

/**
 * Compact composer-toolbar control for the voice intermediary ("AI coworker").
 * Independent of the existing composer mic (option B): toggling it on attaches
 * the daemon agent and reveals a talk button + live status. It interprets the
 * coding agent's output and lets the user steer by voice.
 */
import clsx from 'clsx';
import { useRef, useState } from 'react';
import type { VoiceAgentTraceEntry } from '@sumicom/quicksave-shared';
import type { UseVoiceAgent } from '../hooks/useVoiceAgent';
import { selectPanelMode, useSessionRightPanelStore } from '../stores/sessionRightPanelStore';

const STATE_LABEL: Record<string, string> = {
  idle: '待命',
  thinking: '思考中…',
  speaking: '說話中…',
  listening: '聆聽中…',
};

const DEFAULT_CONVERSATION_RATIO = 0.32;
const MIN_CONVERSATION_HEIGHT = 72;
const MIN_TRACE_HEIGHT = 140;

export function calculateVoiceConversationRatio(clientY: number, top: number, height: number): number {
  if (height <= 0) return DEFAULT_CONVERSATION_RATIO;
  const minRatio = Math.min(0.5, MIN_CONVERSATION_HEIGHT / height);
  const maxRatio = Math.max(minRatio, 1 - (MIN_TRACE_HEIGHT / height));
  return Math.min(maxRatio, Math.max(minRatio, (clientY - top) / height));
}

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
  voiceAgent,
}: {
  voiceAgent: UseVoiceAgent;
}) {
  const va = voiceAgent;
  const panelMode = useSessionRightPanelStore(selectPanelMode);
  const openPanel = useSessionRightPanelStore((s) => s.open);
  const closePanel = useSessionRightPanelStore((s) => s.close);

  const toggle = () => {
    if (va.enabled) {
      if (panelMode !== 'voice') {
        openPanel('voice');
        return;
      }
      va.toggle();
      closePanel();
      return;
    }
    va.toggle();
    openPanel('voice');
  };

  return (
    <div className="flex items-center gap-1.5 text-xs">
      <button
        type="button"
        onClick={toggle}
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
            disabled={!va.active}
            className={clsx(
              'p-1.5 rounded-lg transition-colors flex-shrink-0 disabled:opacity-50',
              va.recording
                ? 'bg-red-600 text-white hover:bg-red-500'
                : va.busy
                  ? 'bg-amber-500/20 text-amber-300 animate-pulse'
                  : 'text-slate-300 hover:bg-slate-700/60',
            )}
            title={va.recording ? '停止' : va.busy ? '完成目前轉錄後繼續聆聽' : '按一下說話'}
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

export function VoiceCoworkerSidebar({ voiceAgent: va }: { voiceAgent: UseVoiceAgent }) {
  const runtime = va.runtime;
  const closePanel = useSessionRightPanelStore((s) => s.close);
  const splitPaneRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef(false);
  const [conversationRatio, setConversationRatio] = useState(DEFAULT_CONVERSATION_RATIO);
  const conversation = va.traceLog.flatMap((entry) => {
    if (entry.event !== 'turn.started' && entry.event !== 'speech.proposed') return [];
    const text = entry.data?.text;
    if (typeof text !== 'string' || !text.trim()) return [];
    return [{
      id: entry.id,
      timestamp: entry.timestamp,
      role: entry.event === 'turn.started' ? '你說' : '語音同事',
      text,
    }];
  });
  const statusText = va.recording && va.interim
    ? va.interim
    : va.active
      ? STATE_LABEL[va.state] ?? '待命'
      : '尚未連上語音同事';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-slate-700 px-3 py-3">
        <div className="flex items-center gap-2">
          <span className={clsx(
            'h-2 w-2 shrink-0 rounded-full',
            va.recording ? 'animate-pulse bg-red-400' : va.active ? 'bg-emerald-400' : 'bg-amber-400',
          )} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-100">{statusText}</span>
          <button
            type="button"
            onClick={() => {
              va.toggle();
              closePanel();
            }}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-purple-200 hover:bg-slate-700 hover:text-white"
            title="關閉語音同事"
            aria-label="關閉語音同事"
          >
            <CoworkerGlyph className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => void va.reload()}
            disabled={va.reloading || !va.enabled}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-slate-300 hover:bg-slate-700 hover:text-white disabled:opacity-40"
            title="Reload intermediary worker"
            aria-label="Reload intermediary worker"
          >
            <svg className={clsx('h-4 w-4', va.reloading && 'animate-spin')} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v6h6M20 20v-6h-6M5.5 15a7 7 0 0011.8 2.2M18.5 9A7 7 0 006.7 6.8" />
            </svg>
          </button>
          <button
            type="button"
            onPointerDown={(event) => {
              event.preventDefault();
              va.onTalkPress();
            }}
            disabled={!va.active}
            className={clsx(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded disabled:opacity-40',
              va.recording
                ? 'bg-red-600 text-white'
                : va.busy
                  ? 'bg-amber-500/20 text-amber-300 animate-pulse'
                  : 'bg-slate-700 text-slate-200 hover:bg-slate-600',
            )}
            title={va.recording ? '停止聆聽' : va.busy ? '完成目前轉錄後繼續聆聽' : '開始聆聽'}
            aria-label={va.recording ? '停止聆聽' : '開始聆聽'}
          >
            <MicGlyph className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[11px]">
          <span className="text-slate-500">Worker</span>
          <span className="truncate font-mono text-slate-300" title={runtime?.buildId}>
            {runtime ? `${runtime.state} · ${runtime.buildId}` : 'waiting for attach'}
          </span>
          <span className="text-slate-500">Instance</span>
          <span className="truncate font-mono text-slate-400" title={runtime?.instanceId}>
            {runtime ? `${runtime.instanceId.slice(0, 12)} · pid ${runtime.pid ?? '?'}` : '—'}
          </span>
          <span className="text-slate-500">Restore</span>
          <span className="text-slate-400">{runtime ? `${runtime.restoredSessionCount} session(s) · protocol ${runtime.protocolVersion}` : '—'}</span>
        </div>
        {runtime?.error && <div className="mt-2 break-words text-xs text-red-300">{runtime.error}</div>}
        {va.error && <div className="mt-2 break-words text-xs text-red-300">{va.error}</div>}
      </div>

      <div ref={splitPaneRef} className="flex min-h-0 flex-1 flex-col">
        <div
          className="shrink-0 overflow-y-auto px-3 py-2 text-xs"
          style={{ height: `${conversationRatio * 100}%` }}
        >
          <div className="mb-2 text-[11px] font-semibold text-slate-400">Conversation</div>
          <div className="grid gap-2">
            {conversation.length > 0
              ? conversation.slice(-20).map((item) => (
                <TranscriptLine
                  key={item.id}
                  label={item.role}
                  text={item.text}
                  timestamp={item.timestamp}
                />
              ))
              : (
                <>
                  <TranscriptLine label="你說" text={va.recording && va.interim ? va.interim : va.lastTranscript} />
                  <TranscriptLine label="語音同事" text={va.lastSpoken} />
                </>
              )}
            {va.actionLog.length > 0 && <TranscriptLine label="動作" text={va.actionLog[va.actionLog.length - 1] ?? ''} />}
          </div>
        </div>

        <div
          role="separator"
          aria-label="Resize conversation and decision trace"
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(conversationRatio * 100)}
          tabIndex={0}
          title="Drag to resize"
          onPointerDown={(event) => {
            event.preventDefault();
            resizingRef.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            document.body.style.cursor = 'row-resize';
            document.body.style.userSelect = 'none';
          }}
          onPointerMove={(event) => {
            if (!resizingRef.current) return;
            const rect = splitPaneRef.current?.getBoundingClientRect();
            if (!rect) return;
            setConversationRatio(calculateVoiceConversationRatio(event.clientY, rect.top, rect.height));
          }}
          onPointerUp={(event) => {
            if (!resizingRef.current) return;
            resizingRef.current = false;
            try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
          }}
          onPointerCancel={() => {
            resizingRef.current = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
          }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            const rect = splitPaneRef.current?.getBoundingClientRect();
            if (!rect) return;
            const delta = event.key === 'ArrowUp' ? -16 : 16;
            setConversationRatio((current) => calculateVoiceConversationRatio(
              rect.top + (current * rect.height) + delta,
              rect.top,
              rect.height,
            ));
          }}
          className="group flex h-2 shrink-0 cursor-row-resize items-center border-y border-slate-700 bg-slate-900 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-blue-400"
        >
          <span className="mx-auto h-0.5 w-10 rounded bg-slate-600 transition-colors group-hover:bg-blue-400" />
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center border-b border-slate-700 px-3 py-2">
            <div className="flex-1 text-xs font-semibold text-slate-200">Decision trace</div>
            <span className="mr-2 text-[11px] text-slate-500">{va.traceLog.length}</span>
            <button
              type="button"
              onClick={va.clearTrace}
              disabled={va.traceLog.length === 0}
              className="flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-slate-700 hover:text-slate-200 disabled:opacity-30"
              title="Clear current trace view"
              aria-label="Clear current trace view"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14" />
              </svg>
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {va.traceLog.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-slate-500">等待下一個 voice turn</div>
            ) : (
              va.traceLog.slice().reverse().map((entry) => <TraceRow key={entry.id} entry={entry} />)
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TranscriptLine({ label, text, timestamp }: { label: string; text: string; timestamp?: number }) {
  return (
    <div className="grid grid-cols-[64px_1fr] gap-2">
      <span className="text-slate-500">
        {label}
        {timestamp != null && (
          <span className="block text-[9px] text-slate-600">
            {new Date(timestamp).toLocaleTimeString([], { hour12: false })}
          </span>
        )}
      </span>
      <span className={clsx('whitespace-pre-wrap break-words', text ? 'text-slate-200' : 'text-slate-600')}>
        {text || '—'}
      </span>
    </div>
  );
}

function TraceRow({ entry }: { entry: VoiceAgentTraceEntry }) {
  const detail = entry.data ? JSON.stringify(entry.data, null, 2) : '';
  const time = new Date(entry.timestamp).toLocaleTimeString([], { hour12: false });
  return (
    <details className="border-b border-slate-800 px-3 py-2 open:bg-slate-800/40">
      <summary className="cursor-pointer list-none">
        <div className="flex items-baseline gap-2">
          <span className={clsx(
            'w-14 shrink-0 text-[10px] font-semibold uppercase',
            entry.phase === 'tool' ? 'text-amber-300' : entry.phase === 'llm' ? 'text-cyan-300' : 'text-slate-500',
          )}>
            {entry.phase}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-200">{entry.event}</span>
          {entry.durationMs != null && <span className="shrink-0 text-[10px] text-slate-500">{entry.durationMs} ms</span>}
          <span className="shrink-0 text-[10px] text-slate-600">{time}</span>
        </div>
      </summary>
      {entry.summary && <div className="mt-2 whitespace-pre-wrap text-xs text-slate-300">{entry.summary}</div>}
      {detail && (
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words border-l border-slate-600 pl-2 text-[10px] leading-4 text-slate-400">
          {detail}
        </pre>
      )}
    </details>
  );
}

export function VoiceCoworkerStatusPanel({ voiceAgent }: { voiceAgent: UseVoiceAgent }) {
  const va = voiceAgent;
  const latestAction = va.actionLog.length > 0 ? va.actionLog[va.actionLog.length - 1] : undefined;
  const userTranscript = va.recording && va.interim ? va.interim : va.lastTranscript;
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
          disabled={!va.active}
          className={clsx(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-50',
            va.recording
              ? 'bg-red-600 text-white hover:bg-red-500'
              : va.busy
                ? 'bg-amber-500/20 text-amber-300 animate-pulse'
                : 'bg-slate-700 text-slate-200 hover:bg-slate-600',
          )}
          title={va.recording ? '停止' : va.busy ? '完成目前轉錄後繼續聆聽' : '按一下說話'}
          aria-label={va.recording ? '停止說話' : '按下說話'}
        >
          <MicGlyph className="h-5 w-5" />
        </button>
      </div>

      <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <div className="min-w-0 rounded border border-slate-700 bg-slate-900/70 px-2 py-1.5">
          <div className="mb-1 text-[10px] font-semibold uppercase text-slate-500">你說</div>
          <div
            className={clsx(
              'max-h-20 overflow-y-auto whitespace-pre-wrap break-words',
              userTranscript ? 'text-slate-100' : 'text-slate-500',
            )}
            title={userTranscript}
          >
            {userTranscript || '等待語音輸入'}
          </div>
        </div>
        <div className="min-w-0 rounded border border-slate-700 bg-slate-900/70 px-2 py-1.5">
          <div className="mb-1 text-[10px] font-semibold uppercase text-slate-500">語音同事</div>
          <div
            className={clsx(
              'max-h-20 overflow-y-auto whitespace-pre-wrap break-words',
              va.error ? 'text-red-300' : va.lastSpoken ? 'text-slate-100' : 'text-slate-500',
            )}
            title={va.error ?? va.lastSpoken}
          >
            {va.error ?? (va.lastSpoken || '等待回覆')}
          </div>
        </div>
        {latestAction && (
          <div className="min-w-0 rounded border border-slate-700 bg-slate-900/70 px-2 py-1.5 sm:col-span-2">
            <div className="mb-1 text-[10px] font-semibold uppercase text-slate-500">動作</div>
            <div className="whitespace-pre-wrap break-words text-slate-200" title={latestAction}>
              {latestAction}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
