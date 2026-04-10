import type { Card, ToolCallCard, SubagentCard, PendingInputAttachment } from '@sumicom/quicksave-shared';
import type { ClaudeUserInputRequestPayload } from '@sumicom/quicksave-shared';
import { AssistantMessage } from './AssistantMessage';
import { ToolCallMessage } from './ToolCallMessage';
import { UserMessage } from './UserMessage';
import { ThinkingMessage } from './ThinkingMessage';
import { SystemMessage } from './SystemMessage';
import { SubagentBlockMessage } from './SubagentBlockMessage';

/** Convert PendingInputAttachment to the legacy ClaudeUserInputRequestPayload shape
 *  expected by existing PermissionPrompt / ToolCallMessage components. */
function toLegacyPending(p: PendingInputAttachment): ClaudeUserInputRequestPayload {
  return {
    sessionId: p.sessionId,
    requestId: p.requestId,
    inputType: p.inputType,
    title: p.title,
    message: p.message,
    options: p.options,
  };
}

export function CardRenderer({ card, isLast, onRespondToInput }: {
  card: Card;
  isLast: boolean;
  onRespondToInput?: (requestId: string, action: 'allow' | 'deny', response?: string) => void;
}) {
  switch (card.type) {
    case 'user':
      return <UserMessage content={card.text} />;

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
          pendingInputRequest={tc.pendingInput ? toLegacyPending(tc.pendingInput) : undefined}
          onRespond={tc.pendingInput && onRespondToInput
            ? (action, response) => onRespondToInput(tc.pendingInput!.requestId, action, response)
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
          pendingInputRequest={sa.pendingInput ? toLegacyPending(sa.pendingInput) : undefined}
          onRespond={sa.pendingInput && onRespondToInput
            ? (action, response) => onRespondToInput(sa.pendingInput!.requestId, action, response)
            : undefined}
        />
      );
    }

    case 'system':
      return <SystemMessage content={card.text} />;

    default:
      return null;
  }
}
