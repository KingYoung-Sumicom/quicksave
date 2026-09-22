// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { memo } from 'react';
import type { Card, ToolCallCard, SubagentCard, RecoverySuggestedCard, FollowUpQuestionCard, PendingInputAttachment } from '@sumicom/quicksave-shared';
import type { ClaudeUserInputRequestPayload } from '@sumicom/quicksave-shared';
import { AssistantMessage } from './AssistantMessage';
import { ToolCallMessage } from './ToolCallMessage';
import { UserMessage } from './UserMessage';
import { ThinkingMessage } from './ThinkingMessage';
import { SystemMessage } from './SystemMessage';
import { SubagentBlockMessage } from './SubagentBlockMessage';
import { RecoverySuggestedMessage } from './RecoverySuggestedMessage';
import { FollowUpQuestionMessage } from './FollowUpQuestionMessage';
import { GeneratedImageMessage } from './GeneratedImageMessage';
import { ArtifactMessage } from './ArtifactMessage';

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
    guardianMessage: p.guardianMessage,
    options: p.options,
    toolName,
    toolInput,
  };
}

export const CardRenderer = memo(function CardRenderer({ card, isLast, sessionId, agentId, onRespondToInput, onSendQuickPrompt }: {
  card: Card;
  isLast: boolean;
  sessionId?: string | null;
  agentId: string;
  onRespondToInput?: (requestId: string, action: 'allow' | 'deny', response?: string, allowPattern?: string, permissionMode?: string) => void;
  /** Send a fixed recovery prompt without changing the composer. */
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
          guardianMessage={tc.guardianMessage ?? tc.pendingInput?.guardianMessage}
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
          agentPath={sa.agentPath}
          statusMessage={sa.statusMessage}
          activities={sa.activities}
          legacyNotice={sa.agentId.startsWith('legacy-subagent:')}
          pendingInputRequest={sa.pendingInput ? toLegacyPending(sa.pendingInput) : undefined}
          onRespond={sa.pendingInput && onRespondToInput
            ? (action, response, allowPattern, permissionMode) => onRespondToInput(sa.pendingInput!.requestId, action, response, allowPattern, permissionMode)
            : undefined}
        />
      );
    }

    case 'system':
      return <SystemMessage card={card} agentId={agentId} />;

    case 'generated_image':
      return <GeneratedImageMessage card={card} agentId={agentId} />;

    case 'artifact':
      return <ArtifactMessage artifact={card.artifact} />;

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

    case 'follow_up_question': {
      const question = card as FollowUpQuestionCard;
      return (
        <FollowUpQuestionMessage
          question={question.question}
          options={question.options}
          allowFreeText={question.allowFreeText}
          answer={question.answer}
          dismissed={question.dismissed}
          onRespond={question.pendingInput && onRespondToInput
            ? (response) => onRespondToInput(question.pendingInput!.requestId, 'allow', response)
            : undefined}
          onDismiss={question.pendingInput && onRespondToInput
            ? () => onRespondToInput(question.pendingInput!.requestId, 'allow')
            : undefined}
        />
      );
    }

    default:
      return null;
  }
});
