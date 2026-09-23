// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState } from 'react';
import type { ClaudeUserInputRequestPayload, SubagentActivity, SubagentToolCall } from '@sumicom/quicksave-shared';
import { ChevronIcon } from '../ui/ChevronIcon';
import { useSessionRightPanelStore } from '../../stores/sessionRightPanelStore';
import { ToolCallMessage } from './ToolCallMessage';
import { ToolCallGroupPlaceholder } from './ToolCallGroupPlaceholder';

const STATUS_STYLES: Record<string, { dot: string; label: string }> = {
  running:   { dot: 'bg-blue-400 animate-pulse', label: 'Running' },
  completed: { dot: 'bg-green-400',              label: 'Done' },
  failed:    { dot: 'bg-red-400',                label: 'Failed' },
  stopped:   { dot: 'bg-slate-400',              label: 'Stopped' },
};

const ACTIVITY_STATUS_STYLES: Record<string, { dot: string; label: string }> = {
  running: { dot: 'bg-blue-400 animate-pulse', label: 'Running' },
  completed: { dot: 'bg-emerald-400', label: 'Done' },
  failed: { dot: 'bg-red-400', label: 'Failed' },
};

function ActivityMessage({ activity }: { activity: SubagentActivity }) {
  return (
    <div className="rounded-md border border-slate-700/70 bg-slate-900/30 px-2.5 py-2">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-slate-500">{activity.title}</div>
      {activity.detail && <div className="whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-300">{activity.detail}</div>}
    </div>
  );
}

function ActivityToolCard({ activity, initiallyExpanded = false }: { activity: SubagentActivity; initiallyExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const status = ACTIVITY_STATUS_STYLES[activity.status ?? 'running'] ?? ACTIVITY_STATUS_STYLES.running;

  return (
    <div className="rounded-md border border-slate-700/70 bg-slate-900/30 overflow-hidden">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-slate-700/30 transition-colors"
      >
        <ChevronIcon expanded={expanded} className="text-slate-500" size="w-3 h-3" />
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${status.dot}`} />
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-slate-300">{activity.title}</span>
        <span className="shrink-0 text-[10px] text-slate-500">{status.label}</span>
      </button>
      {expanded && activity.detail && (
        <div className="border-t border-slate-700/50 px-2 pb-2 pt-1">
          <ToolCallMessage
            toolName={activity.title}
            toolInput={activity.detail}
            content={activity.detail}
          />
        </div>
      )}
    </div>
  );
}

type ActivityEntry =
  | { kind: 'message'; activity: SubagentActivity }
  | { kind: 'group'; id: string; activities: SubagentActivity[] };

function groupActivities(activities: SubagentActivity[]): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  let run: SubagentActivity[] = [];
  let runTurnId: string | undefined;

  const flush = () => {
    if (run.length > 0) {
      entries.push({ kind: 'group', id: run[0].id, activities: run });
      run = [];
      runTurnId = undefined;
    }
  };

  for (const activity of activities) {
    if (activity.type === 'message') {
      flush();
      entries.push({ kind: 'message', activity });
      continue;
    }

    const activityTurnId = ('turnId' in activity && typeof activity.turnId === 'string')
      ? activity.turnId
      : undefined;
    if (run.length > 0 && activityTurnId !== undefined && runTurnId !== activityTurnId) flush();
    if (run.length === 0) runTurnId = activityTurnId;
    run.push(activity);
  }
  flush();
  return entries;
}

function ActivityStream({ activities, toolCalls }: { activities?: SubagentActivity[]; toolCalls?: SubagentToolCall[] }) {
  const stream = activities && activities.length > 0
    ? activities
    : (toolCalls ?? []).map((tool) => ({
      id: tool.id,
      type: 'tool' as const,
      title: tool.toolName,
      detail: tool.result?.content || JSON.stringify(tool.toolInput, null, 2),
      status: tool.result ? (tool.result.isError ? 'failed' as const : 'completed' as const) : 'running' as const,
    }));

  if (stream.length === 0) return null;

  const entries = groupActivities(stream);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (id: string) => {
    setExpandedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="border-t border-slate-700/30 px-2 pb-2 pt-2">
      <div className="mb-1.5 px-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-600">Activity</div>
      <div className="space-y-1.5">
        {entries.map((entry) => {
          if (entry.kind === 'message') {
            return (
              <div key={entry.activity.id} data-activity-type={entry.activity.type}>
                <ActivityMessage activity={entry.activity} />
              </div>
            );
          }

          const open = expandedGroups.has(entry.id);
          const allTools = entry.activities.every((activity) => activity.type === 'tool');
          const noun = allTools ? 'tool call' : 'turn item';
          return (
            <div key={entry.id} data-activity-group={entry.id}>
              <ToolCallGroupPlaceholder
                count={entry.activities.length}
                noun={noun}
                expanded={open}
                onToggle={() => toggleGroup(entry.id)}
              />
              {open && (
                <div className="mt-1.5 space-y-1.5">
                  {entry.activities.map((activity) => (
                    <div key={activity.id} data-activity-type={activity.type}>
                      {activity.type === 'tool'
                        ? <ActivityToolCard activity={activity} />
                        : <ActivityMessage activity={activity} />}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function SubagentBlockMessage({ content, subagentStatus = 'running', subagentSummary, toolUseCount = 0, lastToolName, subagentType, requestedModel, prompt, toolCalls, agentPath, statusMessage, activities, legacyNotice, sessionId, view = 'transcript', pendingInputRequest, onRespond }: {
  content: string;
  subagentStatus?: 'running' | 'completed' | 'failed' | 'stopped';
  subagentSummary?: string;
  toolUseCount?: number;
  lastToolName?: string;
  subagentType?: string;
  requestedModel?: string;
  prompt?: string;
  toolCalls?: SubagentToolCall[];
  agentPath?: string;
  statusMessage?: string;
  activities?: SubagentActivity[];
  legacyNotice?: boolean;
  sessionId?: string;
  view?: 'transcript' | 'agent-panel';
  toolUseId?: string;
  agentId?: string;
  pendingInputRequest?: ClaudeUserInputRequestPayload;
  onRespond?: (action: 'allow' | 'deny', response?: string, allowPattern?: string, permissionMode?: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const openPanelForSession = useSessionRightPanelStore((state) => state.openForSession);
  const status = STATUS_STYLES[subagentStatus] ?? STATUS_STYLES.running;

  const effectiveToolCount = toolCalls?.length ?? toolUseCount;

  const headerLine = subagentSummary
    ? subagentSummary.slice(0, 80) + (subagentSummary.length > 80 ? '…' : '')
    : lastToolName
      ? `Using ${lastToolName}…`
      : content.slice(0, 60) + (content.length > 60 ? '…' : '');

  return (
    <div className="flex justify-start flex-col gap-0.5">
      <div className="rounded-lg border border-slate-700 bg-slate-800/50 w-full overflow-hidden shadow-sm">
        {/* Header row */}
        <div className="flex items-stretch">
          <div className="min-w-0 flex-1 flex items-center gap-2 px-3 py-2">
            {view === 'agent-panel' && (
              <button
                type="button"
                aria-label={expanded ? 'Collapse agent details' : 'Expand agent details'}
                aria-expanded={expanded}
                onClick={() => setExpanded((v) => !v)}
                className="-ml-1 rounded p-1 hover:bg-slate-700/50 transition-colors"
              >
                <ChevronIcon expanded={expanded} className="text-slate-500" />
              </button>
            )}

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
                {statusMessage || status.label}
              </span>
            </span>
          </div>
          {view === 'transcript' && sessionId && (
            <button
              type="button"
              aria-label="Open agent view"
              title="Open agent view"
              onClick={() => openPanelForSession(sessionId, 'subagents')}
              className="shrink-0 border-l border-slate-700/70 px-3 text-slate-500 hover:bg-slate-700/40 hover:text-slate-200 transition-colors"
            >
              <ChevronIcon size="w-4 h-4" />
            </button>
          )}
        </div>

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

        {/* Expanded: metadata followed by the live, chronological activity stream. */}
        {view === 'agent-panel' && expanded && (
          <div className="border-t border-slate-700/40">
            <div className="px-2.5 pb-2 pt-1 space-y-1">
              <p className="text-[10px] text-slate-500 italic">{content}</p>
              <p className="text-[10px] text-slate-600"><span className="text-slate-500">Status</span> {statusMessage || status.label}</p>
              {subagentSummary && (
                <p className="text-[10px] text-slate-500">{subagentSummary}</p>
              )}
              {agentPath && <p className="break-all font-mono text-[10px] text-slate-600">{agentPath}</p>}
              {legacyNotice && (
                <div className="rounded border border-amber-500/20 bg-amber-500/5 px-2 py-1.5 text-[10px] text-amber-200/80">
                  Detailed activity is unavailable because this event predates structured sub-agent tracking.
                </div>
              )}
            </div>
            <ActivityStream activities={activities} toolCalls={toolCalls} />
          </div>
        )}

        {/* Prompt — independent collapsible */}
        {view === 'agent-panel' && prompt && (
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
