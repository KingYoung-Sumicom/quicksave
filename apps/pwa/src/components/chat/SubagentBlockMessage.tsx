import { useState } from 'react';
import type { ClaudeUserInputRequestPayload } from '@sumicom/quicksave-shared';
import { ChevronIcon } from '../ui/ChevronIcon';

const STATUS_STYLES: Record<string, { dot: string; label: string }> = {
  running:   { dot: 'bg-blue-400 animate-pulse', label: 'Running' },
  completed: { dot: 'bg-green-400',              label: 'Done' },
  failed:    { dot: 'bg-red-400',                label: 'Failed' },
  stopped:   { dot: 'bg-slate-400',              label: 'Stopped' },
};

export function SubagentBlockMessage({ content, subagentStatus = 'running', subagentSummary, toolUseCount = 0, lastToolName, pendingInputRequest, onRespond }: {
  content: string;
  subagentStatus?: 'running' | 'completed' | 'failed' | 'stopped';
  subagentSummary?: string;
  toolUseCount?: number;
  lastToolName?: string;
  toolUseId?: string;
  agentId?: string;
  pendingInputRequest?: ClaudeUserInputRequestPayload;
  onRespond?: (action: 'allow' | 'deny', response?: string, allowPattern?: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const status = STATUS_STYLES[subagentStatus] ?? STATUS_STYLES.running;

  const headerLine = subagentSummary
    ? subagentSummary.slice(0, 80) + (subagentSummary.length > 80 ? '…' : '')
    : lastToolName
      ? `Using ${lastToolName}…`
      : content.slice(0, 60) + (content.length > 60 ? '…' : '');

  return (
    <div className="flex justify-start flex-col gap-0.5">
      <div className="bg-slate-800/40 border-l-2 border-violet-500/50 rounded-r-lg w-full overflow-hidden">
        {/* Header row */}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="w-full text-left flex items-center gap-2 px-2.5 py-1.5 hover:bg-slate-700/30 transition-colors"
        >
          <ChevronIcon expanded={expanded} className="text-slate-500" />

          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${status.dot}`} />
          <span className="text-xs text-slate-400 flex-1 min-w-0 truncate">{headerLine}</span>

          <span className="flex items-center gap-2 shrink-0">
            {toolUseCount > 0 && (
              <span className="text-[10px] text-slate-600">{toolUseCount} tool{toolUseCount !== 1 ? 's' : ''}</span>
            )}
            <span className={`text-[10px] ${subagentStatus === 'running' ? 'text-blue-400' : subagentStatus === 'completed' ? 'text-green-400' : 'text-slate-500'}`}>
              {status.label}
            </span>
          </span>
        </button>

        {/* Pending permission — always visible */}
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

        {/* Expanded: show description and summary */}
        {expanded && (
          <div className="px-2.5 pb-2 pt-1 border-t border-slate-700/40 space-y-1">
            <p className="text-[10px] text-slate-500 italic">{content}</p>
            {subagentSummary && (
              <p className="text-[10px] text-slate-500">{subagentSummary}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
