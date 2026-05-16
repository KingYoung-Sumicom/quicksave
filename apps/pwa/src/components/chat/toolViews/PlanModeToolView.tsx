// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState } from 'react';
import { ChatMarkdown } from '../ChatMarkdown';
import { Modal } from '../../ui/Modal';
import { PERMISSION_MODES } from '../../../lib/claudePresets';

export function EnterPlanModeToolView() {
  return <span className="text-indigo-400">Entering plan mode</span>;
}

interface AllowedPrompt {
  tool: string;
  prompt: string;
}

const APPROVE_MODES = PERMISSION_MODES.filter(m =>
  m.value === 'default' || m.value === 'acceptEdits' || m.value === 'bypassPermissions' || m.value === 'auto'
);

/** Static view — shows plan summary and requested permissions. */
export function ExitPlanModeToolView({ input, plan, isRejected, answers }: {
  input: Record<string, unknown>;
  plan?: string | null;
  isRejected?: boolean;
  answers?: Record<string, string>;
}) {
  const allowedPrompts = (input.allowedPrompts as AllowedPrompt[]) || [];
  const hasResult = isRejected !== undefined;
  const rejectionReason = isRejected ? answers?.['_rejection'] : undefined;

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
      {rejectionReason && (
        <p className="mt-1 text-xs text-slate-400 italic">{rejectionReason}</p>
      )}
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
  onRespond: (action: 'allow' | 'deny', response?: string, permissionMode?: string) => void;
}) {
  const [rejectMessage, setRejectMessage] = useState('');
  const [showApproveModal, setShowApproveModal] = useState(false);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [selectedMode, setSelectedMode] = useState('default');
  const allowedPrompts = (input.allowedPrompts as AllowedPrompt[]) || [];

  const handleConfirmApprove = () => {
    setShowApproveModal(false);
    onRespond('allow', undefined, selectedMode);
  };

  const handleConfirmReject = () => {
    setShowRejectModal(false);
    onRespond('deny', rejectMessage.trim() || undefined);
  };

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
      <div className="mt-3">
        <div className="flex gap-2">
          <button
            onClick={() => setShowApproveModal(true)}
            className="flex-1 text-sm px-3 py-1.5 bg-green-600/80 hover:bg-green-500 rounded-lg transition-colors font-medium"
          >
            Approve Plan
          </button>
          <button
            onClick={() => { setRejectMessage(''); setShowRejectModal(true); }}
            className="flex-1 text-sm px-3 py-1.5 bg-red-600/60 hover:bg-red-500 rounded-lg transition-colors font-medium"
          >
            Reject
          </button>
        </div>
      </div>

      {showApproveModal && (
        <Modal title="Approve Plan" onClose={() => setShowApproveModal(false)} maxWidth="max-w-sm">
          <div className="p-4 space-y-4">
            <p className="text-sm text-slate-300">Choose the permission mode to use after plan approval.</p>
            <div className="space-y-2">
              {APPROVE_MODES.map(m => (
                <button
                  key={m.value}
                  onClick={() => setSelectedMode(m.value)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors ${
                    selectedMode === m.value
                      ? 'bg-indigo-600/40 text-indigo-200 ring-1 ring-indigo-500/60'
                      : 'bg-slate-700/60 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <div className="flex gap-2 pt-1">
              <button
                onClick={handleConfirmApprove}
                className="flex-1 text-sm px-3 py-2 bg-green-600/80 hover:bg-green-500 rounded-lg transition-colors font-medium"
              >
                Confirm
              </button>
              <button
                onClick={() => setShowApproveModal(false)}
                className="text-sm px-3 py-2 text-slate-400 hover:text-slate-200 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      )}

      {showRejectModal && (
        <Modal title="Reject Plan" onClose={() => setShowRejectModal(false)} maxWidth="max-w-sm">
          <div className="p-4 space-y-4">
            <div>
              <label className="block text-sm text-slate-300 mb-1.5">
                Reason <span className="text-slate-500 text-xs">(optional)</span>
              </label>
              <textarea
                value={rejectMessage}
                onChange={(e) => setRejectMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.metaKey) handleConfirmReject();
                }}
                placeholder="What should be changed..."
                rows={3}
                className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-red-500 placeholder-slate-500 resize-none"
                autoFocus
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleConfirmReject}
                className="flex-1 text-sm px-3 py-2 bg-red-600/80 hover:bg-red-500 rounded-lg transition-colors font-medium"
              >
                Reject
              </button>
              <button
                onClick={() => setShowRejectModal(false)}
                className="text-sm px-3 py-2 text-slate-400 hover:text-slate-200 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
