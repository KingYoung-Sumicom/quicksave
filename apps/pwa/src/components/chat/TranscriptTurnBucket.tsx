// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { memo, useMemo } from 'react';
import type { Card } from '@sumicom/quicksave-shared';
import { useSessionStore } from '../../stores/sessionStore';
import { CardRenderer } from './CardRenderer';
import { ToolCallGroupPlaceholder } from './ToolCallGroupPlaceholder';
import { filterRenderableCards, shouldCollapseCard } from './cardCollapse';

interface Props {
  bucketId: string;
  lastCardId?: string;
  isLastBucket: boolean;
  hideToolCalls: boolean;
  expandedGroups: Set<string>;
  onToggleGroup: (id: string) => void;
  sessionId: string | null;
  agentId: string;
  pendingSubmission: { prompt: string; attachmentIds: string[] } | null;
  onRespondToInput: (requestId: string, action: 'allow' | 'deny', response?: string, allowPattern?: string, permissionMode?: string) => void;
  onSendQuickPrompt: (prompt: string) => void;
}

export const TranscriptTurnBucket = memo(function TranscriptTurnBucket(props: Props) {
  const cards = useSessionStore((s) => s.cardBuckets.byId.get(props.bucketId)?.cards);
  const bucketHot = useSessionStore((s) => s.cardBuckets.byId.get(props.bucketId)?.hot ?? false);
  const bucketCompleted = useSessionStore((s) => s.cardBuckets.byId.get(props.bucketId)?.completed ?? false);
  const isStreaming = useSessionStore((s) => bucketHot && s.isStreaming);
  const externallyCompleted = useSessionStore((s) => {
    const turnId = s.cardBuckets.byId.get(props.bucketId)?.turnId;
    return !!turnId && !!s.completedTurnIds[turnId];
  });
  const latestIntermediate = useSessionStore((s) => {
    const turnId = s.cardBuckets.byId.get(props.bucketId)?.turnId;
    return !!turnId && s.latestIntermediateTurnId === turnId;
  });
  const displayItems = useMemo(() => {
    if (!cards) return [];
    type Item = { kind: 'card'; card: Card } | { kind: 'group'; key: string; groupId: string; count: number; noun: string; expanded: boolean };
    const out: Item[] = [];
    const renderable = filterRenderableCards(cards);
    const suppressed = props.pendingSubmission
      ? new Set(renderable.filter((c) => c.type === 'user' && c.text === props.pendingSubmission!.prompt
        && JSON.stringify((c as { attachmentIds?: string[] }).attachmentIds ?? []) === JSON.stringify(props.pendingSubmission!.attachmentIds)).map((c) => c.id))
      : new Set<string>();
    const finalAssistant = new Map<string, string>();
    for (const card of renderable) if (card.type === 'assistant_text' && card.turnId) finalAssistant.set(card.turnId, card.id);
    const grouped: Card[] = [];
    const flush = () => {
      if (!grouped.length) return;
      const groupId = grouped[0].id;
      const pending = grouped.some((c) => c.pendingInput);
      if (pending) for (const c of grouped) out.push({ kind: 'card', card: c });
      else out.push({ kind: 'group', key: `${props.expandedGroups.has(groupId) ? 'expanded' : 'collapsed'}:${groupId}`, groupId, count: grouped.length, noun: grouped.every((c) => c.type === 'tool_call') ? 'tool call' : 'turn item', expanded: props.expandedGroups.has(groupId) });
      if (props.expandedGroups.has(groupId) && !pending) for (const c of grouped) out.push({ kind: 'card', card: c });
      grouped.length = 0;
    };
    for (const card of renderable) {
      if (suppressed.has(card.id)) continue;
      const completed = bucketCompleted || externallyCompleted || !!card.turnCompleted;
      const collapseIntermediate = !!card.turnId && (completed
        ? card.type !== 'user' && !(card.type === 'assistant_text' && finalAssistant.get(card.turnId) === card.id)
        : !!card.isTurnIntermediate && (!!card.turnCompleted || !isStreaming || (props.isLastBucket && !latestIntermediate)));
      if (shouldCollapseCard(card, collapseIntermediate, props.hideToolCalls)) grouped.push(card);
      else { flush(); out.push({ kind: 'card', card }); }
    }
    flush();
    return out;
  }, [cards, bucketCompleted, externallyCompleted, props.expandedGroups, props.hideToolCalls, isStreaming, latestIntermediate, props.pendingSubmission, props.isLastBucket]);

  return <>
    {displayItems.map((item) => item.kind === 'group'
      ? <ToolCallGroupPlaceholder key={item.key} count={item.count} noun={item.noun} expanded={item.expanded} onToggle={() => props.onToggleGroup(item.groupId)} />
      : <div key={item.card.id} data-card-id={item.card.id}><CardRenderer card={item.card} isLast={props.isLastBucket && item.card.id === props.lastCardId} sessionId={props.sessionId} agentId={props.agentId} onRespondToInput={props.onRespondToInput} onSendQuickPrompt={props.onSendQuickPrompt} /></div>)}
  </>;
});
