import { useState } from 'react';
import { useGitStore, selectCanCommit } from '../stores/gitStore';

interface CommitFormProps {
  onCommit: (message: string, description?: string) => Promise<void>;
  stagedCount: number;
}

export function CommitForm({ onCommit, stagedCount }: CommitFormProps) {
  const { commitMessage, commitDescription, setCommitMessage, setCommitDescription, isLoading } =
    useGitStore();
  const canCommit = useGitStore(selectCanCommit);
  const [showDescription, setShowDescription] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canCommit) return;

    try {
      await onCommit(commitMessage, commitDescription || undefined);
    } catch {
      // Error is handled in the hook
    }
  };

  if (stagedCount === 0) {
    return null;
  }

  return (
    <div className="bg-slate-800 rounded-lg p-4">
      <form onSubmit={handleSubmit} className="space-y-3">
        {/* Commit Message */}
        <div>
          <input
            type="text"
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            placeholder="Commit message"
            className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            disabled={isLoading}
          />
        </div>

        {/* Description Toggle */}
        {!showDescription && (
          <button
            type="button"
            onClick={() => setShowDescription(true)}
            className="text-sm text-slate-400 hover:text-white transition-colors"
          >
            + Add description
          </button>
        )}

        {/* Description */}
        {showDescription && (
          <div>
            <textarea
              value={commitDescription}
              onChange={(e) => setCommitDescription(e.target.value)}
              placeholder="Extended description (optional)"
              rows={3}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
              disabled={isLoading}
            />
          </div>
        )}

        {/* Submit Button */}
        <button
          type="submit"
          disabled={!canCommit || isLoading}
          className="w-full py-3 px-4 bg-green-600 hover:bg-green-700 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-md font-medium text-white transition-colors"
        >
          {isLoading ? (
            <span className="flex items-center justify-center gap-2">
              <span className="loading-dot w-2 h-2 bg-white rounded-full" />
              <span className="loading-dot w-2 h-2 bg-white rounded-full" />
              <span className="loading-dot w-2 h-2 bg-white rounded-full" />
            </span>
          ) : (
            `Commit ${stagedCount} file${stagedCount !== 1 ? 's' : ''}`
          )}
        </button>
      </form>
    </div>
  );
}
