// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useMemo } from 'react';
import type { Card, ClaudeUserInputResponsePayload, SubagentCard } from '@sumicom/quicksave-shared';
import { useSessionStore } from '../../stores/sessionStore';
import { CardRenderer } from './CardRenderer';

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

export function SubagentsPanel({ embedded = false, onRespondToUserInput }: {
  embedded?: boolean;
  onRespondToUserInput?: (response: ClaudeUserInputResponsePayload) => void;
}) {
  const cards = useSessionStore((s) => s.cards);
  const agents = useMemo(() => collectSubagents(cards), [cards]);

  if (agents.length === 0) {
    return <div className={embedded ? 'py-2 text-sm text-slate-500' : 'px-4 py-6 text-sm text-slate-500'}>No sub-agents in this session.</div>;
  }

  return (
    <div className={embedded ? 'space-y-2' : 'flex-1 overflow-y-auto p-3 space-y-2'}>
      {agents.map((agent, index) => (
        <CardRenderer
          key={agent.agentId}
          card={agent}
          isLast={index === agents.length - 1}
          sessionId={agent.pendingInput?.sessionId}
          agentId={agent.agentId}
          onRespondToInput={onRespondToUserInput && agent.pendingInput
            ? (requestId, action, response, allowPattern, permissionMode) => onRespondToUserInput({
              sessionId: agent.pendingInput!.sessionId,
              requestId,
              action: action === 'allow' ? (response ? 'respond' : 'allow') : 'deny',
              response,
              allowPattern,
              permissionMode,
            })
            : undefined}
        />
      ))}
    </div>
  );
}
