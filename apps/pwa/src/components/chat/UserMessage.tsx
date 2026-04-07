import { useState } from 'react';

const COLLAPSE_THRESHOLD = 4;

// ─── task-notification parser ─────────────────────────────────────────────────

interface TaskNotification {
  taskId?: string;
  status?: string;
  summary?: string;
}

function parseTaskNotification(content: string): TaskNotification | null {
  if (!content.includes('<task-notification>')) return null;
  const get = (tag: string) => {
    const m = content.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
    return m ? m[1].trim() : undefined;
  };
  return { taskId: get('task-id'), status: get('status'), summary: get('summary') };
}

function TaskNotificationMessage({ content }: { content: string }) {
  // May have multiple task-notification blocks or surrounding text
  const parts = content.split(/(<task-notification>[\s\S]*?<\/task-notification>)/g);
  return (
    <div className="flex justify-start">
      <div className="w-full space-y-1.5">
        {parts.map((part, i) => {
          const notif = parseTaskNotification(part);
          if (notif) {
            const done = notif.status === 'completed';
            const failed = notif.status === 'failed';
            return (
              <div key={i} className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm border ${
                done ? 'bg-green-500/10 border-green-500/30' :
                failed ? 'bg-red-500/10 border-red-500/30' :
                'bg-slate-700/50 border-slate-600/30'
              }`}>
                <span className={`mt-0.5 shrink-0 text-base ${done ? 'text-green-400' : failed ? 'text-red-400' : 'text-slate-400'}`}>
                  {done ? '✓' : failed ? '✗' : '⟳'}
                </span>
                <div className="min-w-0">
                  {notif.summary && (
                    <div className={`font-medium ${done ? 'text-green-300' : failed ? 'text-red-300' : 'text-slate-300'}`}>
                      {notif.summary}
                    </div>
                  )}
                  {notif.taskId && (
                    <div className="text-[10px] text-slate-500 mt-0.5 font-mono">{notif.taskId}</div>
                  )}
                </div>
              </div>
            );
          }
          const trimmed = part.trim();
          if (!trimmed) return null;
          return <PlainUserMessage key={i} content={trimmed} />;
        })}
      </div>
    </div>
  );
}

function PlainUserMessage({ content }: { content: string }) {
  const lines = content.split('\n');
  const collapsible = lines.length > COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(false);
  const displayContent = collapsible && !expanded
    ? lines.slice(0, COLLAPSE_THRESHOLD).join('\n') : content;
  return (
    <div className="bg-slate-700 rounded-lg px-3 py-2 max-w-full text-sm whitespace-pre-wrap break-words inline-block">
      {displayContent}
      {collapsible && !expanded && <span className="text-blue-300/70">…</span>}
      {collapsible && (
        <button
          onClick={() => setExpanded(v => !v)}
          className="block mt-1 text-[10px] text-slate-400/60 hover:text-slate-300 transition-colors"
        >
          {expanded ? 'Show less' : `Show ${lines.length - COLLAPSE_THRESHOLD} more lines`}
        </button>
      )}
    </div>
  );
}

export function UserMessage({ content }: { content: string }) {
  if (content.includes('<task-notification>')) {
    return <TaskNotificationMessage content={content} />;
  }
  return (
    <div className="flex justify-start">
      <PlainUserMessage content={content} />
    </div>
  );
}
