// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { memo } from 'react';
import type { Card, ToolCallCard, SubagentCard, RecoverySuggestedCard, PendingInputAttachment } from '@sumicom/quicksave-shared';
import type { ClaudeUserInputRequestPayload } from '@sumicom/quicksave-shared';
import { AssistantMessage } from './AssistantMessage';
import { ToolCallMessage } from './ToolCallMessage';
import { UserMessage } from './UserMessage';
import { ThinkingMessage } from './ThinkingMessage';
import { SystemMessage } from './SystemMessage';
import { SubagentBlockMessage } from './SubagentBlockMessage';
import { RecoverySuggestedMessage } from './RecoverySuggestedMessage';

/** Convert PendingInputAttachment to the legacy ClaudeUserInputRequestPayload shape
 *  expected by existing PermissionPrompt / ToolCallMessage components. */
function toLegacyPending(
  p: PendingInputAttachment,
  toolName?: string,
  toolInput?: Record<string, unknown>,
): ClaudeUserInputRequestPayload {
  return {
    sessionId: p.sessionId,
    requestId: p.requestId,
    inputType: p.inputType,
    title: p.title,
    message: p.message,
    options: p.options,
    toolName,
    toolInput,
  };
}

export const CardRenderer = memo(function CardRenderer({ card, isLast, sessionId, onRespondToInput, onSendQuickPrompt }: {
  card: Card;
  isLast: boolean;
  sessionId?: string | null;
  onRespondToInput?: (requestId: string, action: 'allow' | 'deny', response?: string, allowPattern?: string, permissionMode?: string) => void;
  /** Send a fixed prompt without using the composer input — wired for
   *  recovery_suggested cards' one-tap actions (e.g. `/compact`). */
  onSendQuickPrompt?: (prompt: string) => void;
}) {
  switch (card.type) {
    case 'user':
      return <UserMessage content={card.text} attachments={card.attachments} sessionId={sessionId ?? null} />;

    case 'assistant_text':
      return <AssistantMessage content={card.text} isLast={isLast} />;

    case 'thinking':
      return <ThinkingMessage content={card.text} />;

    case 'tool_call': {
      const tc = card as ToolCallCard;
      return (
        <ToolCallMessage
          toolName={tc.toolName}
          toolInput={JSON.stringify(tc.toolInput)}
          content={JSON.stringify(tc.toolInput)}
          toolResultContent={tc.result?.content}
          toolResultIsError={tc.result?.isError}
          toolAnswers={tc.answers}
          pendingInputRequest={tc.pendingInput ? toLegacyPending(tc.pendingInput, tc.toolName, tc.toolInput) : undefined}
          onRespond={tc.pendingInput && onRespondToInput
            ? (action, response, allowPattern, permissionMode) => onRespondToInput(tc.pendingInput!.requestId, action, response, allowPattern, permissionMode)
            : undefined}
        />
      );
    }

    case 'subagent': {
      const sa = card as SubagentCard;
      return (
        <SubagentBlockMessage
          content={sa.description}
          subagentStatus={sa.status}
          subagentSummary={sa.summary}
          toolUseCount={sa.toolUseCount}
          lastToolName={sa.lastToolName}
          subagentType={sa.subagentType}
          requestedModel={sa.requestedModel}
          prompt={sa.prompt}
          toolCalls={sa.toolCalls}
          pendingInputRequest={sa.pendingInput ? toLegacyPending(sa.pendingInput) : undefined}
          onRespond={sa.pendingInput && onRespondToInput
            ? (action, response, allowPattern) => onRespondToInput(sa.pendingInput!.requestId, action, response, allowPattern)
            : undefined}
        />
      );
    }

    case 'system':
      return <SystemMessage content={card.text} />;

    case 'recovery_suggested': {
      const rs = card as RecoverySuggestedCard;
      return (
        <RecoverySuggestedMessage
          reason={rs.reason}
          action={rs.action}
          label={rs.label}
          onInvoke={onSendQuickPrompt
            ? (action) => onSendQuickPrompt(action === 'compact' ? '/compact' : '')
            : undefined}
        />
      );
    }

    default:
      return null;
  }
});
