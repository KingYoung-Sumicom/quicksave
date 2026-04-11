import { useState } from 'react';

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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop — NOT dismissible (click does nothing) */}
      <div className="absolute inset-0 bg-black/60" />

      {/* Modal */}
      <div className="relative bg-slate-800 rounded-lg w-full max-w-md shadow-xl">
        {/* Header */}
        <div className="flex items-center gap-2 p-4 border-b border-slate-700">
          <svg className="w-5 h-5 text-green-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
          <h2 className="text-sm font-semibold text-slate-200">Allow & Remember</h2>
        </div>

        {/* Content */}
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
      </div>
    </div>
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
