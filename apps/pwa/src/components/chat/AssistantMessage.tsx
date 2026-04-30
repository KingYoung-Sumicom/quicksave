// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { ChatMarkdown } from './ChatMarkdown';
import { useClaudeStore } from '../../stores/claudeStore';

export function AssistantMessage({ content, isLast }: { content: string; isLast: boolean }) {
  const isStreaming = useClaudeStore((s) => s.isStreaming);
  const isActivelyStreaming = isLast && isStreaming;

  // Empty content while streaming — ClaudePanel renders bounce dots instead;
  // rendering nothing here avoids a duplicate loading indicator.
  if (!content) return null;

  return (
    <div className="py-1 w-full text-sm">
      <div className="chat-markdown">
        <ChatMarkdown>{content}</ChatMarkdown>
        {isActivelyStreaming && (
          <span className="inline-block w-1.5 h-4 bg-blue-400 animate-pulse ml-0.5 align-text-bottom rounded-sm" />
        )}
      </div>
    </div>
  );
}
