import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark-dimmed.css';

export function ChatMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        table: ({ children }: { children?: ReactNode }) => (
          <div className="overflow-x-auto my-2">
            <table className="w-max">{children}</table>
          </div>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
