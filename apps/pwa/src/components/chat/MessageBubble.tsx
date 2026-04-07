import type { ChatMessage } from '../../stores/claudeStore';
import { AssistantMessage } from './AssistantMessage';
import { ToolCallMessage } from './ToolCallMessage';
import { ToolResultMessage } from './ToolResultMessage';
import { UserMessage } from './UserMessage';
import { SystemMessage } from './SystemMessage';

// Tools whose result is rendered inline within the tool call block
const TOOLS_WITH_INLINE_RESULT = new Set(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']);

export function MessageBubble({ message, nextMessage, isLast, onRespondToInput }: {
  message: ChatMessage;
  nextMessage?: ChatMessage;
  isLast: boolean;
  onRespondToInput?: (requestId: string, action: 'allow' | 'deny', response?: string) => void;
}) {
  switch (message.role) {
    case 'user':
      return <UserMessage content={message.content} />;
    case 'assistant':
      return <AssistantMessage content={message.content} isLast={isLast} />;
    case 'tool':
      if (message.toolName) {
        // Pass tool result from next message so views can show selected answers
        const toolResultContent = nextMessage?.toolResultOf === message.toolName
          ? nextMessage.content : undefined;
        return (
          <ToolCallMessage
            toolName={message.toolName}
            toolInput={message.toolInput}
            content={message.content}
            toolResultContent={toolResultContent}
            pendingInputRequest={message.pendingInputRequest}
            onRespond={message.pendingInputRequest && onRespondToInput
              ? (action, response) => onRespondToInput(message.pendingInputRequest!.requestId, action, response)
              : undefined
            }
          />
        );
      }
      // Suppress result when the tool call already renders it inline
      if (message.toolResultOf && TOOLS_WITH_INLINE_RESULT.has(message.toolResultOf)) return null;
      return <ToolResultMessage content={message.content} toolResultOf={message.toolResultOf} />;
    case 'system':
      return <SystemMessage content={message.content} />;
    default:
      return null;
  }
}
