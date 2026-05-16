// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState, useCallback } from 'react';
import type { ClaudeUserInputRequestPayload } from '@sumicom/quicksave-shared';
import { generateAllowPattern } from '@sumicom/quicksave-shared';
import { Modal } from '../ui/Modal';
import { WildcardEditorModal } from './WildcardEditorModal';
import { useLongPress } from '../../hooks/useLongPress';

export function InlinePermissionActions({ request, onRespond }: {
  request: ClaudeUserInputRequestPayload;
  onRespond: (action: 'allow' | 'deny', response?: string, allowPattern?: string) => void;
}) {
  const [denyReason, setDenyReason] = useState('');
  const [showDenyModal, setShowDenyModal] = useState(false);
  const [showWildcardEditor, setShowWildcardEditor] = useState(false);

  const { handlers: longPressHandlers, wasLongPress } = useLongPress(
    useCallback(() => setShowWildcardEditor(true), []),
  );

  const handleAllowClick = useCallback(() => {
    if (!wasLongPress()) {
      onRespond('allow');
    }
  }, [wasLongPress, onRespond]);

  const handleConfirmDeny = useCallback(() => {
    setShowDenyModal(false);
    onRespond('deny', denyReason.trim() || undefined);
  }, [denyReason, onRespond]);

  const handleOpenDenyModal = useCallback(() => {
    setDenyReason('');
    setShowDenyModal(true);
  }, []);

  return (
    <div className="mt-2 pt-2 border-t border-amber-500/20">
      <p className="text-sm text-amber-400/80 mb-2">{request.title}</p>
      <div className="flex gap-2">
        <button
          onClick={handleOpenDenyModal}
          className="flex-1 text-sm px-3 py-1.5 bg-slate-600 hover:bg-slate-500 rounded-lg transition-colors font-medium"
        >
          Deny
        </button>
        <button
          onClick={handleAllowClick}
          {...longPressHandlers}
          className="flex-1 text-sm px-3 py-1.5 bg-green-600/80 hover:bg-green-500 rounded-lg transition-colors font-medium"
        >
          Allow
        </button>
      </div>

      {showDenyModal && (
        <Modal title="Deny Permission" onClose={() => setShowDenyModal(false)} maxWidth="max-w-sm">
          <div className="p-4 space-y-4">
            <div>
              <label className="block text-sm text-slate-300 mb-1.5">
                Reason <span className="text-slate-500 text-xs">(optional)</span>
              </label>
              <textarea
                value={denyReason}
                onChange={(e) => setDenyReason(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.metaKey) handleConfirmDeny();
                }}
                placeholder="Why are you denying this..."
                rows={3}
                className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-red-500 placeholder-slate-500 resize-none"
                autoFocus
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleConfirmDeny}
                className="flex-1 text-sm px-3 py-2 bg-slate-600 hover:bg-slate-500 rounded-lg transition-colors font-medium"
              >
                Deny
              </button>
              <button
                onClick={() => setShowDenyModal(false)}
                className="text-sm px-3 py-2 text-slate-400 hover:text-slate-200 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      )}

      {showWildcardEditor && request.toolName && request.toolInput && (
        <WildcardEditorModal
          toolName={request.toolName}
          toolInput={request.toolInput}
          defaultPattern={generateAllowPattern(request.toolName, request.toolInput)}
          onConfirm={(pattern) => {
            setShowWildcardEditor(false);
            onRespond('allow', undefined, pattern);
          }}
          onCancel={() => setShowWildcardEditor(false)}
        />
      )}
    </div>
  );
}
