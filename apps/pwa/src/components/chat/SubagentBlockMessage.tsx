// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState } from 'react';
import type { ClaudeUserInputRequestPayload, SubagentToolCall } from '@sumicom/quicksave-shared';
import { ChevronIcon } from '../ui/ChevronIcon';

const STATUS_STYLES: Record<string, { dot: string; label: string }> = {
  running:   { dot: 'bg-blue-400 animate-pulse', label: 'Running' },
  completed: { dot: 'bg-green-400',              label: 'Done' },
  failed:    { dot: 'bg-red-400',                label: 'Failed' },
  stopped:   { dot: 'bg-slate-400',              label: 'Stopped' },
};

function NestedToolCallRow({ tc }: { tc: SubagentToolCall }) {
  const [open, setOpen] = useState(false);
  const hasResult = !!tc.result;
  const dotClass = hasResult
    ? tc.result!.isError ? 'bg-red-400' : 'bg-green-400'
    : 'bg-blue-400 animate-pulse';

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left flex items-center gap-1.5 py-0.5 hover:bg-slate-700/20 rounded px-1 transition-colors"
      >
        <ChevronIcon expanded={open} className="text-slate-600" size="w-2 h-2" />
        <span className={`w-1 h-1 rounded-full shrink-0 ${dotClass}`} />
        <span className="text-[10px] text-slate-400 font-mono">{tc.toolName}</span>
        {tc.result && !open && (
          <span className="text-[10px] text-slate-600 truncate flex-1">
            {tc.result.content.slice(0, 80)}
          </span>
        )}
      </button>
      {open && (
        <div className="ml-4 mt-0.5 space-y-0.5">
          <pre className="text-[10px] text-slate-500 whitespace-pre-wrap break-words font-mono bg-slate-900/40 rounded px-1.5 py-1 max-h-32 overflow-y-auto">
            {JSON.stringify(tc.toolInput, null, 2)}
          </pre>
          {tc.result && (
            <pre className={`text-[10px] whitespace-pre-wrap break-words font-mono bg-slate-900/40 rounded px-1.5 py-1 max-h-32 overflow-y-auto ${tc.result.isError ? 'text-red-400/80' : 'text-slate-500'}`}>
              {tc.result.content}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function SubagentBlockMessage({ content, subagentStatus = 'running', subagentSummary, toolUseCount = 0, lastToolName, subagentType, requestedModel, prompt, toolCalls, pendingInputRequest, onRespond }: {
  content: string;
  subagentStatus?: 'running' | 'completed' | 'failed' | 'stopped';
  subagentSummary?: string;
  toolUseCount?: number;
  lastToolName?: string;
  subagentType?: string;
  requestedModel?: string;
  prompt?: string;
  toolCalls?: SubagentToolCall[];
  toolUseId?: string;
  agentId?: string;
  pendingInputRequest?: ClaudeUserInputRequestPayload;
  onRespond?: (action: 'allow' | 'deny', response?: string, allowPattern?: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const status = STATUS_STYLES[subagentStatus] ?? STATUS_STYLES.running;

  const effectiveToolCount = toolCalls?.length ?? toolUseCount;

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
          {subagentType && (
            <span className="text-[10px] text-violet-400/80 font-mono shrink-0">{subagentType}</span>
          )}
          <span className="text-xs text-slate-400 flex-1 min-w-0 truncate">{headerLine}</span>

          <span className="flex items-center gap-2 shrink-0">
            {requestedModel && (
              <span className="text-[10px] text-amber-400/60 font-mono">{requestedModel}</span>
            )}
            {effectiveToolCount > 0 && (
              <span className="text-[10px] text-slate-600">{effectiveToolCount} tool{effectiveToolCount !== 1 ? 's' : ''}</span>
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

        {/* Expanded: description, summary, nested tool calls */}
        {expanded && (
          <div className="border-t border-slate-700/40">
            <div className="px-2.5 pb-2 pt-1 space-y-1">
              <p className="text-[10px] text-slate-500 italic">{content}</p>
              {subagentSummary && (
                <p className="text-[10px] text-slate-500">{subagentSummary}</p>
              )}
            </div>
            {toolCalls && toolCalls.length > 0 && (
              <div className="border-t border-slate-700/30 px-2 pb-1.5 pt-1 space-y-0.5">
                {toolCalls.map((tc) => (
                  <NestedToolCallRow key={tc.id} tc={tc} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Prompt — independent collapsible */}
        {prompt && (
          <div className="border-t border-slate-700/40">
            <button
              onClick={() => setPromptExpanded((v) => !v)}
              className="w-full text-left flex items-center gap-1.5 px-2.5 py-1 hover:bg-slate-700/30 transition-colors"
            >
              <ChevronIcon expanded={promptExpanded} className="text-slate-500" />
              <span className="text-[10px] text-slate-500 uppercase tracking-wide">Prompt</span>
              {prompt.length > 100 && (
                <span className="text-[10px] text-slate-600">{Math.ceil(prompt.length / 1000)}k chars</span>
              )}
            </button>
            {promptExpanded && (
              <div className="px-2.5 pb-2 max-h-60 overflow-y-auto">
                <pre className="text-[10px] text-slate-400 whitespace-pre-wrap break-words font-mono">{prompt}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
