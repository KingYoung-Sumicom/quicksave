import { useState, useCallback } from 'react';
import type { ClaudeUserInputRequestPayload } from '@sumicom/quicksave-shared';
import { generateAllowPattern } from '@sumicom/quicksave-shared';
import { WildcardEditorModal } from './WildcardEditorModal';
import { useLongPress } from '../../hooks/useLongPress';

export function InlinePermissionActions({ request, onRespond }: {
  request: ClaudeUserInputRequestPayload;
  onRespond: (action: 'allow' | 'deny', response?: string, allowPattern?: string) => void;
}) {
  const [showDenyReason, setShowDenyReason] = useState(false);
  const [denyReason, setDenyReason] = useState('');
  const [showWildcardEditor, setShowWildcardEditor] = useState(false);

  const { handlers: longPressHandlers, wasLongPress } = useLongPress(
    useCallback(() => setShowWildcardEditor(true), []),
  );

  const handleAllowClick = useCallback(() => {
    if (!wasLongPress()) {
      onRespond('allow');
    }
  }, [wasLongPress, onRespond]);

  return (
    <div className="mt-2 pt-2 border-t border-amber-500/20">
      <p className="text-sm text-amber-400/80 mb-2">{request.title}</p>
      {showDenyReason ? (
        <div className="space-y-2">
          <input
            type="text"
            value={denyReason}
            onChange={(e) => setDenyReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                onRespond('deny', denyReason.trim() || undefined);
              }
            }}
            placeholder="Reason (optional)..."
            className="w-full bg-slate-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-red-500 placeholder-slate-500"
            autoFocus
          />
          <div className="flex gap-2">
            <button
              onClick={() => onRespond('deny', denyReason.trim() || undefined)}
              className="flex-1 text-sm px-3 py-1.5 bg-slate-600 hover:bg-slate-500 rounded-lg transition-colors font-medium"
            >
              Deny
            </button>
            <button
              onClick={() => setShowDenyReason(false)}
              className="text-sm px-3 py-1.5 text-slate-400 hover:text-slate-200 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            onClick={() => setShowDenyReason(true)}
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
