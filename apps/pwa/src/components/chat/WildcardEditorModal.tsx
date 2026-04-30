// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState } from 'react';
import { Modal } from '../ui/Modal';

interface WildcardEditorModalProps {
  toolName: string;
  toolInput: Record<string, unknown>;
  defaultPattern: string;
  onConfirm: (pattern: string) => void;
  onCancel: () => void;
}

export function WildcardEditorModal({
  toolName,
  toolInput,
  defaultPattern,
  onConfirm,
  onCancel,
}: WildcardEditorModalProps) {
  const [pattern, setPattern] = useState(defaultPattern);

  const inputSummary = summarizeInput(toolName, toolInput);

  return (
    <Modal title="Allow & Remember" onClose={onCancel} backdropClose={false}>
      <div className="p-4 space-y-3">
          {/* Tool info */}
          <div className="text-xs text-slate-400 space-y-1">
            <div>
              <span className="text-slate-500">Tool:</span>{' '}
              <span className="font-mono text-slate-300">{toolName}</span>
            </div>
            {inputSummary && (
              <div className="font-mono text-slate-500 truncate" title={inputSummary}>
                {inputSummary}
              </div>
            )}
          </div>

          {/* Pattern editor */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">
              Wildcard pattern
            </label>
            <input
              type="text"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && pattern.trim()) {
                  onConfirm(pattern.trim());
                }
                if (e.key === 'Escape') {
                  onCancel();
                }
              }}
              className="w-full bg-slate-900 border border-slate-600 rounded-md px-3 py-2 text-sm font-mono text-slate-200 focus:outline-none focus:ring-1 focus:ring-green-500 focus:border-green-500"
              autoFocus
              spellCheck={false}
            />
            <p className="mt-1 text-xs text-slate-500">
              Use <code className="text-slate-400">*</code> for single-segment wildcard, <code className="text-slate-400">**</code> for recursive
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 p-4 border-t border-slate-700">
          <button
            onClick={onCancel}
            className="flex-1 text-xs px-3 py-2 text-slate-400 hover:text-slate-200 hover:bg-slate-700 rounded-md transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(pattern.trim())}
            disabled={!pattern.trim()}
            className="flex-1 text-xs px-3 py-2 bg-green-600 hover:bg-green-500 disabled:bg-slate-600 disabled:text-slate-400 rounded-md transition-colors font-medium"
          >
            Allow & Remember
          </button>
        </div>
    </Modal>
  );
}

/** Produce a short summary of the tool input for display context. */
function summarizeInput(toolName: string, input: Record<string, unknown>): string | null {
  switch (toolName) {
    case 'WebFetch':
      return (input.url as string) ?? null;
    case 'WebSearch':
      return (input.query as string) ?? null;
    case 'Bash':
      return (input.command as string) ?? null;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return ((input.file_path ?? input.path) as string) ?? null;
    default:
      return JSON.stringify(input).slice(0, 120);
  }
}
