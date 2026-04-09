import type { ChatMessage } from '../../stores/claudeStore';
import { AssistantMessage } from './AssistantMessage';
import { ToolCallMessage } from './ToolCallMessage';
import { ToolResultMessage } from './ToolResultMessage';
import { UserMessage } from './UserMessage';
import { ThinkingMessage } from './ThinkingMessage';
import { SystemMessage } from './SystemMessage';
import { SubagentBlockMessage } from './SubagentBlockMessage';

// Tools whose result is rendered inline within the tool call block
const TOOLS_WITH_INLINE_RESULT = new Set(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']);

export function MessageBubble({ message, toolResultContent, isLast, onRespondToInput }: {
  message: ChatMessage;
  toolResultContent?: string;
  isLast: boolean;
  onRespondToInput?: (requestId: string, action: 'allow' | 'deny', response?: string) => void;
}) {
  switch (message.role) {
    case 'user':
      return <UserMessage content={message.content} />;
    case 'assistant':
      return <AssistantMessage content={message.content} isLast={isLast} />;
    case 'tool': {
      if (message.toolName) {
        return (
          <ToolCallMessage
            toolName={message.toolName}
            toolInput={message.toolInput}
            content={message.content}
            toolResultContent={toolResultContent}
            pendingInputRequest={message.pendingInputRequest}
            onRespond={message.pendingInputRequest && onRespondToInput
              ? (action, response) => onRespondToInput(message.pendingInputRequest!.requestId, action, response)
              : undefined}
          />
        );
      }
      if (message.toolResultOf && TOOLS_WITH_INLINE_RESULT.has(message.toolResultOf)) return null;
      return <ToolResultMessage content={message.content} toolResultOf={message.toolResultOf} />;
    }
    case 'thinking':
      return <ThinkingMessage content={message.content} />;
    case 'system':
      return <SystemMessage content={message.content} />;
    case 'subagent':
      return (
        <SubagentBlockMessage
          content={message.content}
          subagentStatus={message.subagentStatus}
          subagentSummary={message.subagentSummary}
          toolUseCount={message.toolUseCount}
          lastToolName={message.lastToolName}
          toolUseId={message.toolUseId}
          agentId={message.agentId}
          pendingInputRequest={message.pendingInputRequest}
          onRespond={message.pendingInputRequest && onRespondToInput
            ? (action, response) => onRespondToInput(message.pendingInputRequest!.requestId, action, response)
            : undefined}
        />
      );
    default:
      return null;
  }
}
