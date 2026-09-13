// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useMemo, useState } from 'react';
import type { Card, SubagentCard } from '@sumicom/quicksave-shared';
import { useClaudeStore } from '../../stores/claudeStore';

const STATUS_CLASS: Record<SubagentCard['status'], string> = {
  running: 'bg-blue-400',
  completed: 'bg-emerald-400',
  failed: 'bg-red-400',
  stopped: 'bg-amber-400',
};

const LEGACY_SUBAGENT_PATTERN = /^Sub-agent (started|active|interrupted):\s*(.+)$/i;

function subagentKey(card: SubagentCard): string {
  if (card.agentPath) return card.agentPath;
  if (card.description.startsWith('/')) return card.description;
  return card.agentId;
}

/** Include activity emitted before structured sub-agent cards were introduced. */
export function collectSubagents(cards: readonly Card[]): SubagentCard[] {
  const byKey = new Map<string, SubagentCard>();

  for (const card of cards) {
    if (card.type === 'subagent') {
      byKey.set(subagentKey(card), card);
      continue;
    }
    if (card.type !== 'system') continue;

    const match = LEGACY_SUBAGENT_PATTERN.exec(card.text.trim());
    if (!match) continue;
    const [, event, agentPath] = match;
    const existing = byKey.get(agentPath);
    const interrupted = event.toLowerCase() === 'interrupted';
    const statusMessage = interrupted ? 'Interrupted' : event.toLowerCase() === 'started' ? 'Started' : 'Active';
    byKey.set(agentPath, {
      ...(existing ?? {
        type: 'subagent',
        id: `legacy-subagent:${agentPath}`,
        description: agentPath,
        toolUseId: `legacy-subagent:${agentPath}`,
        agentId: `legacy-subagent:${agentPath}`,
        toolUseCount: 0,
      }),
      timestamp: card.timestamp,
      agentPath,
      status: interrupted ? 'stopped' : 'running',
      statusMessage,
      activities: [
        ...(existing?.activities ?? []),
        {
          id: card.id,
          type: 'message',
          title: statusMessage,
          detail: new Date(card.timestamp).toLocaleString(),
          status: 'completed',
        },
      ],
    });
  }

  return [...byKey.values()].sort((a, b) => b.timestamp - a.timestamp);
}

export function SubagentsPanel({ embedded = false }: { embedded?: boolean }) {
  const cards = useClaudeStore((s) => s.cards);
  const [expanded, setExpanded] = useState<string | null>(null);
  const agents = useMemo(() => collectSubagents(cards), [cards]);

  if (agents.length === 0) {
    return <div className={embedded ? 'py-2 text-sm text-slate-500' : 'px-4 py-6 text-sm text-slate-500'}>No sub-agents in this session.</div>;
  }

  return (
    <div className={embedded ? 'space-y-2' : 'flex-1 overflow-y-auto p-3 space-y-2'}>
      {agents.map((agent) => {
        const open = expanded === agent.agentId;
        const isLegacy = agent.agentId.startsWith('legacy-subagent:');
        return (
          <div key={agent.agentId} className="rounded-md border border-slate-700 bg-slate-800/50 overflow-hidden">
            <button
              type="button"
              onClick={() => setExpanded(open ? null : agent.agentId)}
              className="flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-slate-700/30"
            >
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${STATUS_CLASS[agent.status]}`} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-slate-200">{agent.agentPath || agent.description}</span>
                <span className="block truncate text-xs text-slate-500">{agent.statusMessage || agent.status}</span>
              </span>
              <span className="text-xs text-slate-500" aria-hidden>{open ? '−' : '+'}</span>
            </button>
            {open && (
              <div className="border-t border-slate-700 px-3 py-2.5 space-y-3 text-xs">
                <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                  <span className="text-slate-500">Status</span>
                  <span className="text-slate-300">{agent.statusMessage || agent.status}</span>
                  {agent.agentPath && (
                    <>
                      <span className="text-slate-500">Path</span>
                      <span className="break-all font-mono text-slate-400">{agent.agentPath}</span>
                    </>
                  )}
                </div>
                {agent.prompt && <Detail label="Prompt" text={agent.prompt} />}
                {(agent.requestedModel || agent.requestedReasoningEffort) && (
                  <div className="text-slate-500">
                    {[agent.requestedModel, agent.requestedReasoningEffort].filter(Boolean).join(' · ')}
                  </div>
                )}
                {agent.summary && <Detail label="Summary" text={agent.summary} />}
                {isLegacy && (
                  <div className="rounded border border-amber-500/20 bg-amber-500/5 px-2.5 py-2 text-amber-200/80">
                    Detailed activity is unavailable because this event predates structured sub-agent tracking.
                  </div>
                )}
                {(agent.activities?.length ?? 0) > 0 && (
                  <div className="font-medium text-slate-400">Activity</div>
                )}
                {agent.activities?.map((activity) => (
                  <div key={activity.id} className="border-l-2 border-slate-600 pl-2">
                    <div className="text-slate-300">{activity.title}</div>
                    {activity.detail && <div className="mt-0.5 whitespace-pre-wrap break-words text-slate-500">{activity.detail}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Detail({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="mb-1 font-medium text-slate-400">{label}</div>
      <div className="whitespace-pre-wrap break-words text-slate-500">{text}</div>
    </div>
  );
}
