import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark-dimmed.css';
import { useClaudeStore } from '../../stores/claudeStore';

export function AssistantMessage({ content, isLast }: { content: string; isLast: boolean }) {
  const isStreaming = useClaudeStore((s) => s.isStreaming);
  const isActivelyStreaming = isLast && isStreaming;

  if (!content) {
    return (
      <div className="py-1">
        <span className="text-slate-400 animate-pulse text-sm">...</span>
      </div>
    );
  }

  return (
    <div className="py-1 w-full text-sm">
      {isActivelyStreaming ? (
        <div className="whitespace-pre-wrap break-words">
          {content}
          <span className="inline-block w-1.5 h-4 bg-blue-400 animate-pulse ml-0.5 align-text-bottom rounded-sm" />
        </div>
      ) : (
        <div className="chat-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
            {content}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}
