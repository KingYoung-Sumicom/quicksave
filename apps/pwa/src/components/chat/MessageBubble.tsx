import type { ChatMessage } from '../../stores/claudeStore';
import { AssistantMessage } from './AssistantMessage';
import { ToolCallMessage } from './ToolCallMessage';
import { ToolResultMessage } from './ToolResultMessage';
import { UserMessage } from './UserMessage';
import { SystemMessage } from './SystemMessage';

export function MessageBubble({ message, isLast }: { message: ChatMessage; isLast: boolean }) {
  switch (message.role) {
    case 'user':
      return <UserMessage content={message.content} />;
    case 'assistant':
      return <AssistantMessage content={message.content} isLast={isLast} />;
    case 'tool':
      if (message.toolName) {
        return <ToolCallMessage toolName={message.toolName} toolInput={message.toolInput} content={message.content} />;
      }
      return <ToolResultMessage content={message.content} />;
    case 'system':
      return <SystemMessage content={message.content} />;
    default:
      return null;
  }
}
