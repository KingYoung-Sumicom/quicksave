// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState } from 'react';
import { ChatMarkdown } from '../ChatMarkdown';

export function EnterPlanModeToolView() {
  return <span className="text-indigo-400">Entering plan mode</span>;
}

interface AllowedPrompt {
  tool: string;
  prompt: string;
}

/** Static view — shows plan summary and requested permissions. */
export function ExitPlanModeToolView({ input, plan, isRejected }: {
  input: Record<string, unknown>;
  plan?: string | null;
  isRejected?: boolean;
}) {
  const allowedPrompts = (input.allowedPrompts as AllowedPrompt[]) || [];
  const hasResult = isRejected !== undefined;

  return (
    <div>
      <span className="flex items-center gap-2">
        <span className="text-indigo-400">Plan ready for review</span>
        {hasResult && (isRejected ? (
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-600/30 text-red-400 ring-1 ring-red-500/30">Rejected</span>
        ) : (
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-green-600/30 text-green-400 ring-1 ring-green-500/30">Approved</span>
        ))}
      </span>
      {plan && (
        <div className="mt-2 chat-markdown plan-markdown">
          <ChatMarkdown>{plan}</ChatMarkdown>
        </div>
      )}
      {allowedPrompts.length > 0 && (
        <details className="mt-2">
          <summary className="text-slate-500 text-[10px] uppercase tracking-wide cursor-pointer hover:text-slate-400 select-none">
            Requested permissions ({allowedPrompts.length})
          </summary>
          <div className="mt-1 space-y-1">
            {allowedPrompts.map((p, i) => (
              <div key={i} className="flex items-start gap-1.5 text-slate-300">
                <span className="text-amber-400/70 text-[10px] font-mono mt-px shrink-0">{p.tool}</span>
                <span>{p.prompt}</span>
              </div>
            ))}
          </div>
        </details>
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
        <div className="mt-2 chat-markdown plan-markdown">
          <ChatMarkdown>{plan}</ChatMarkdown>
        </div>
      )}
      {allowedPrompts.length > 0 && (
        <details className="mt-2">
          <summary className="text-slate-500 text-[10px] uppercase tracking-wide cursor-pointer hover:text-slate-400 select-none">
            Requested permissions ({allowedPrompts.length})
          </summary>
          <div className="mt-1 space-y-1">
            {allowedPrompts.map((p, i) => (
              <div key={i} className="flex items-start gap-1.5 text-slate-300">
                <span className="text-amber-400/70 text-[10px] font-mono mt-px shrink-0">{p.tool}</span>
                <span>{p.prompt}</span>
              </div>
            ))}
          </div>
        </details>
      )}
      <div className="mt-3 space-y-2">
        {showReject ? (
          <div className="space-y-2">
            <input
              type="text"
              value={rejectMessage}
              onChange={(e) => setRejectMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && rejectMessage.trim()) {
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
