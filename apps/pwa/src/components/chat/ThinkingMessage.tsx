import { useState } from 'react';
import { ChevronIcon } from '../ui/ChevronIcon';

export function ThinkingMessage({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = content.slice(0, 80).replace(/\n/g, ' ');

  return (
    <div className="flex justify-start">
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-left bg-slate-800/40 border-l-2 border-slate-600/40 rounded-r-lg pl-2.5 pr-3 py-1.5 max-w-full text-xs text-slate-500 hover:text-slate-400 transition-colors overflow-hidden"
      >
        <div className="flex items-center gap-1.5">
          <ChevronIcon expanded={expanded} />
          <span className="italic truncate">
            {expanded ? 'Thinking' : preview + (content.length > 80 ? '...' : '')}
          </span>
        </div>
        {expanded && (
          <pre className="mt-1.5 whitespace-pre-wrap break-words text-slate-500">
            {content}
          </pre>
        )}
      </button>
    </div>
  );
}
