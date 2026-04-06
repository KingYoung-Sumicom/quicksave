import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function EnterPlanModeToolView() {
  return <span className="text-indigo-400">Entering plan mode</span>;
}

interface AllowedPrompt {
  tool: string;
  prompt: string;
}

/** Static view — shows plan summary and requested permissions. */
export function ExitPlanModeToolView({ input, plan }: {
  input: Record<string, unknown>;
  plan?: string | null;
}) {
  const allowedPrompts = (input.allowedPrompts as AllowedPrompt[]) || [];

  return (
    <div>
      <span className="text-indigo-400">Plan ready for review</span>
      {plan && (
        <div className="mt-2 prose prose-invert prose-xs max-w-none text-slate-300 max-h-64 overflow-y-auto">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan}</ReactMarkdown>
        </div>
      )}
      {allowedPrompts.length > 0 && (
        <div className="mt-2 space-y-1">
          <span className="text-slate-500 text-[10px] uppercase tracking-wide">Requested permissions</span>
          {allowedPrompts.map((p, i) => (
            <div key={i} className="flex items-start gap-1.5 text-slate-300">
              <span className="text-amber-400/70 text-[10px] font-mono mt-px shrink-0">{p.tool}</span>
              <span>{p.prompt}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Interactive view — approve or reject with optional message. */
export function ExitPlanModeInteractiveView({ input, plan, onRespond }: {
  input: Record<string, unknown>;
  plan?: string | null;
  onRespond: (action: 'allow' | 'deny', response?: string) => void;
}) {
  const [rejectMessage, setRejectMessage] = useState('');
  const [showReject, setShowReject] = useState(false);
  const allowedPrompts = (input.allowedPrompts as AllowedPrompt[]) || [];

  return (
    <div>
      <span className="text-indigo-400 font-medium">Plan for review</span>
      {plan && (
        <div className="mt-2 prose prose-invert prose-xs max-w-none text-slate-300 max-h-64 overflow-y-auto">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan}</ReactMarkdown>
        </div>
      )}
      {allowedPrompts.length > 0 && (
        <div className="mt-2 space-y-1">
          <span className="text-slate-500 text-[10px] uppercase tracking-wide">Requested permissions</span>
          {allowedPrompts.map((p, i) => (
            <div key={i} className="flex items-start gap-1.5 text-slate-300">
              <span className="text-amber-400/70 text-[10px] font-mono mt-px shrink-0">{p.tool}</span>
              <span>{p.prompt}</span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 space-y-2">
        {showReject ? (
          <div className="space-y-2">
            <input
              type="text"
              value={rejectMessage}
              onChange={(e) => setRejectMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && rejectMessage.trim()) {
                  onRespond('deny', rejectMessage.trim());
                }
              }}
              placeholder="What should be changed..."
              className="w-full bg-slate-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-red-500 placeholder-slate-500"
              autoFocus
            />
            <div className="flex gap-2">
              <button
                onClick={() => onRespond('deny', rejectMessage.trim() || 'Plan rejected')}
                className="flex-1 text-sm px-3 py-1.5 bg-red-600/80 hover:bg-red-500 rounded-lg transition-colors font-medium"
              >
                Reject
              </button>
              <button
                onClick={() => setShowReject(false)}
                className="text-sm px-3 py-1.5 text-slate-400 hover:text-slate-200 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={() => onRespond('allow')}
              className="flex-1 text-sm px-3 py-1.5 bg-green-600/80 hover:bg-green-500 rounded-lg transition-colors font-medium"
            >
              Approve Plan
            </button>
            <button
              onClick={() => setShowReject(true)}
              className="flex-1 text-sm px-3 py-1.5 bg-red-600/60 hover:bg-red-500 rounded-lg transition-colors font-medium"
            >
              Reject
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
