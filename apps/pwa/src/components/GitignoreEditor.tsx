// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState, useEffect, useCallback } from 'react';
import { Spinner } from './ui/Spinner';

interface GitignoreEditorProps {
  isOpen: boolean;
  onClose: () => void;
  onRead: () => Promise<{ content: string; exists: boolean } | null>;
  onWrite: (content: string) => Promise<boolean>;
}

export function GitignoreEditor({ isOpen, onClose, onRead, onWrite }: GitignoreEditorProps) {
  const [content, setContent] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadContent = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await onRead();
      if (result) {
        setContent(result.content);
      }
    } catch {
      setError('Failed to load .gitignore');
    } finally {
      setIsLoading(false);
    }
  }, [onRead]);

  useEffect(() => {
    if (isOpen) {
      loadContent();
    }
  }, [isOpen, loadContent]);

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    try {
      const success = await onWrite(content);
      if (success) {
        onClose();
      } else {
        setError('Failed to save .gitignore');
      }
    } catch {
      setError('Failed to save .gitignore');
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />

      {/* Modal */}
      <div className="fixed left-[calc(1rem+env(safe-area-inset-left))] right-[calc(1rem+env(safe-area-inset-right))] top-16 bottom-16 z-50 flex flex-col bg-slate-800 rounded-lg shadow-xl border border-slate-700 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <h2 className="font-medium">.gitignore</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-slate-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 rounded transition-colors disabled:opacity-50"
            >
              {isSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 py-2 bg-red-500/20 text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* Editor */}
        <div className="flex-1 overflow-auto">
          {isLoading ? (
            <div className="flex items-center justify-center h-full">
              <Spinner size="w-5 h-5" />
            </div>
          ) : (
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="w-full h-full p-4 bg-transparent text-sm font-mono text-slate-200 resize-none outline-none"
              placeholder={"# Add patterns to ignore, one per line\nnode_modules/\ndist/\n*.log"}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          )}
        </div>
      </div>
    </>
  );
}
