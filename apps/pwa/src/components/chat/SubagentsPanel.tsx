// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useMemo, useState } from 'react';
import type { SubagentCard } from '@sumicom/quicksave-shared';
import { useClaudeStore } from '../../stores/claudeStore';

const STATUS_CLASS: Record<SubagentCard['status'], string> = {
  running: 'bg-blue-400',
  completed: 'bg-emerald-400',
  failed: 'bg-red-400',
  stopped: 'bg-amber-400',
};

export function SubagentsPanel({ embedded = false }: { embedded?: boolean }) {
  const cards = useClaudeStore((s) => s.cards);
  const [expanded, setExpanded] = useState<string | null>(null);
  const agents = useMemo(() => {
    const byId = new Map<string, SubagentCard>();
    for (const card of cards) if (card.type === 'subagent') byId.set(card.agentId, card);
    return [...byId.values()].sort((a, b) => b.timestamp - a.timestamp);
  }, [cards]);

  if (agents.length === 0) {
    return <div className={embedded ? 'py-2 text-sm text-slate-500' : 'px-4 py-6 text-sm text-slate-500'}>No sub-agents in this session.</div>;
  }

  return (
    <div className={embedded ? 'space-y-2' : 'flex-1 overflow-y-auto p-3 space-y-2'}>
      {agents.map((agent) => {
        const open = expanded === agent.agentId;
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
                {agent.prompt && <Detail label="Prompt" text={agent.prompt} />}
                {(agent.requestedModel || agent.requestedReasoningEffort) && (
                  <div className="text-slate-500">
                    {[agent.requestedModel, agent.requestedReasoningEffort].filter(Boolean).join(' · ')}
                  </div>
                )}
                {agent.summary && <Detail label="Summary" text={agent.summary} />}
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
