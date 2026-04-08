import { useState } from 'react';
import type { SubagentEvent } from '../../stores/claudeStore';
import type { ClaudeUserInputRequestPayload } from '@sumicom/quicksave-shared';

const STATUS_STYLES: Record<string, { dot: string; label: string }> = {
  running:   { dot: 'bg-blue-400 animate-pulse', label: 'Running' },
  completed: { dot: 'bg-green-400',              label: 'Done' },
  failed:    { dot: 'bg-red-400',                label: 'Failed' },
  stopped:   { dot: 'bg-slate-400',              label: 'Stopped' },
};

function SubagentEventRow({ event }: { event: SubagentEvent }) {
  const isResult = !event.toolName;
  const [expanded, setExpanded] = useState(false);

  if (isResult) {
    const content = event.content ?? '';
    if (!content.trim()) return null;
    const lines = content.trimEnd().split('\n');
    const preview = lines[0].slice(0, 60) + (lines[0].length > 60 || lines.length > 1 ? '…' : '');
    return (
      <div className="text-[10px] text-slate-500 pl-3 py-0.5">
        <button
          className="text-left w-full hover:text-slate-400 transition-colors"
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="italic">{event.toolResultOf ? `↳ ${event.toolResultOf} result` : '↳ result'}</span>
          {!expanded && <span className="ml-1 text-slate-600">{preview}</span>}
        </button>
        {expanded && (
          <pre className="mt-0.5 whitespace-pre-wrap break-words text-slate-500 pl-2">{content}</pre>
        )}
      </div>
    );
  }

  const input = event.toolInput ?? event.content ?? '';
  let parsedPreview = input;
  try {
    const obj = JSON.parse(input);
    const firstVal = Object.values(obj)[0];
    if (typeof firstVal === 'string') parsedPreview = firstVal.slice(0, 60);
  } catch { /* ignore */ }

  return (
    <div className="flex items-start gap-1.5 py-0.5 pl-1">
      <span className="text-[10px] font-medium text-slate-400 shrink-0">{event.toolName}</span>
      <span className="text-[10px] text-slate-600 truncate">{parsedPreview}</span>
    </div>
  );
}

export function SubagentBlockMessage({ content, subagentStatus = 'running', subagentSummary, toolUseCount = 0, lastToolName, subagentEvents = [], pendingInputRequest, onRespond }: {
  content: string;
  subagentStatus?: 'running' | 'completed' | 'failed' | 'stopped';
  subagentSummary?: string;
  toolUseCount?: number;
  lastToolName?: string;
  subagentEvents?: SubagentEvent[];
  pendingInputRequest?: ClaudeUserInputRequestPayload;
  onRespond?: (action: 'allow' | 'deny', response?: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const status = STATUS_STYLES[subagentStatus] ?? STATUS_STYLES.running;

  const headerLine = subagentSummary
    ? subagentSummary.slice(0, 80) + (subagentSummary.length > 80 ? '…' : '')
    : lastToolName
      ? `Using ${lastToolName}…`
      : content.slice(0, 60) + (content.length > 60 ? '…' : '');

  return (
    <div className="flex justify-start">
      <div className="bg-slate-800/40 border-l-2 border-violet-500/50 rounded-r-lg w-full overflow-hidden">
        {/* Header row */}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="w-full text-left flex items-center gap-2 px-2.5 py-1.5 hover:bg-slate-700/30 transition-colors"
        >
          <svg
            className={`w-3 h-3 shrink-0 text-slate-500 transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>

          {/* Status dot */}
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${status.dot}`} />

          {/* Description */}
          <span className="text-xs text-slate-400 flex-1 min-w-0 truncate">{headerLine}</span>

          {/* Right side meta */}
          <span className="flex items-center gap-2 shrink-0">
            {toolUseCount > 0 && (
              <span className="text-[10px] text-slate-600">{toolUseCount} tool{toolUseCount !== 1 ? 's' : ''}</span>
            )}
            <span className={`text-[10px] ${subagentStatus === 'running' ? 'text-blue-400' : subagentStatus === 'completed' ? 'text-green-400' : 'text-slate-500'}`}>
              {status.label}
            </span>
          </span>
        </button>

        {/* Pending permission prompt — always visible, no expand needed */}
        {pendingInputRequest && onRespond && (
          <div className="px-2.5 pb-2 pt-1.5 border-t border-amber-500/20">
            <p className="text-xs text-amber-400/80 mb-2">{pendingInputRequest.title}</p>
            <div className="flex gap-2">
              <button
                onClick={() => onRespond('allow')}
                className="flex-1 text-xs px-3 py-1.5 bg-green-600/80 hover:bg-green-500 rounded-lg transition-colors font-medium"
              >
                Allow
              </button>
              <button
                onClick={() => onRespond('deny')}
                className="flex-1 text-xs px-3 py-1.5 bg-red-600/60 hover:bg-red-500 rounded-lg transition-colors font-medium"
              >
                Deny
              </button>
            </div>
          </div>
        )}

        {/* Expanded content */}
        {expanded && (
          <div className="px-2.5 pb-2 border-t border-slate-700/40">
            {/* Task description */}
            <p className="text-[10px] text-slate-500 pt-1.5 pb-1 italic">{content}</p>

            {/* Internal events */}
            {subagentEvents.length > 0 ? (
              <div className="divide-y divide-slate-700/20">
                {subagentEvents.map((ev, i) => (
                  <SubagentEventRow key={i} event={ev} />
                ))}
              </div>
            ) : (
              <p className="text-[10px] text-slate-600 italic">No internal events recorded.</p>
            )}

            {/* Summary */}
            {subagentSummary && (
              <div className="mt-1.5 pt-1.5 border-t border-slate-700/40">
                <p className="text-[10px] text-slate-500">{subagentSummary}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
