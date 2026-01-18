import { useState, useRef, useEffect } from 'react';
import { useGitStore, selectCanCommit } from '../stores/gitStore';
import { CLAUDE_MODELS, type ClaudeModel } from '@quicksave/shared';
import { clsx } from 'clsx';

interface CommitFormProps {
  onCommit: (message: string, description?: string) => Promise<void>;
  onGenerateAiSummary: () => Promise<void>;
  onOpenSettings: () => void;
  stagedCount: number;
}

export function CommitForm({ onCommit, onGenerateAiSummary, onOpenSettings, stagedCount }: CommitFormProps) {
  const {
    commitMessage,
    commitDescription,
    setCommitMessage,
    setCommitDescription,
    isLoading,
    aiSummary,
    aiDescription,
    isGeneratingAiSummary,
    aiSummaryError,
    selectedModel,
    setSelectedModel,
    apiKeyConfigured,
    applyAiSummary,
    clearAiSummary,
    aiTokenUsage,
    aiResultCached,
  } = useGitStore();
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

  const handleGenerateClick = async () => {
    await onGenerateAiSummary();
  };

  const handleApplySuggestion = () => {
    applyAiSummary();
    if (aiDescription) {
      setShowDescription(true);
    }
  };

  if (stagedCount === 0) {
    return null;
  }

  return (
    <div className="bg-slate-800 rounded-lg p-4">
      <form onSubmit={handleSubmit} className="space-y-3">
        {/* AI Generate Section */}
        {!commitMessage && (
          <div className="space-y-2">
            {/* Model Selector + Generate Button Row */}
            <div className="flex gap-2">
              <ModelDropdown
                value={selectedModel}
                onChange={setSelectedModel}
                disabled={isGeneratingAiSummary || isLoading || !apiKeyConfigured}
              />

              <button
                type="button"
                onClick={apiKeyConfigured ? handleGenerateClick : onOpenSettings}
                disabled={isGeneratingAiSummary || isLoading}
                className="flex-1 py-2 px-4 bg-purple-600 hover:bg-purple-700 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-md font-medium text-white transition-colors flex items-center justify-center gap-2"
              >
                {isGeneratingAiSummary ? (
                  <>
                    <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"
                      />
                    </svg>
                    Generate
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* AI Suggestion Display */}
        {aiSummary && (
          <div className="p-3 bg-purple-900/30 border border-purple-500/50 rounded-lg">
            <div className="flex items-start justify-between gap-2 mb-2">
              <span className="text-xs text-purple-400 font-medium">AI Suggestion</span>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={handleGenerateClick}
                  disabled={isGeneratingAiSummary}
                  className="text-xs text-slate-400 hover:text-white px-2 py-1 rounded transition-colors"
                  title="Regenerate"
                >
                  ↻
                </button>
                <button
                  type="button"
                  onClick={clearAiSummary}
                  className="text-xs text-slate-400 hover:text-white px-2 py-1 rounded transition-colors"
                  title="Dismiss"
                >
                  ✕
                </button>
              </div>
            </div>
            <p className="text-sm text-white mb-2">{aiSummary}</p>
            {aiDescription && (
              <p className="text-xs text-slate-400 mb-2 whitespace-pre-wrap">{aiDescription}</p>
            )}
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={handleApplySuggestion}
                className="text-sm text-purple-400 hover:text-purple-300 font-medium transition-colors"
              >
                Use this message
              </button>
              {(aiTokenUsage || aiResultCached) && (
                <span className="text-xs text-slate-500">
                  {aiResultCached ? (
                    'cached'
                  ) : aiTokenUsage ? (
                    `${aiTokenUsage.inputTokens + aiTokenUsage.outputTokens} tokens`
                  ) : null}
                </span>
              )}
            </div>
          </div>
        )}

        {/* AI Error Display */}
        {aiSummaryError && (
          <div className="p-2 bg-red-500/20 border border-red-500/50 rounded text-sm text-red-400">
            {aiSummaryError}
          </div>
        )}

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

interface ModelDropdownProps {
  value: ClaudeModel;
  onChange: (model: ClaudeModel) => void;
  disabled?: boolean;
}

function ModelDropdown({ value, onChange, disabled }: ModelDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const selectedModel = CLAUDE_MODELS.find((m) => m.id === value) ?? CLAUDE_MODELS[0];

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div ref={dropdownRef} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={clsx(
          'px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white text-sm',
          'focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent',
          'flex items-center gap-2',
          disabled && 'opacity-50 cursor-not-allowed'
        )}
      >
        {selectedModel.name}
        <svg
          className={clsx('w-4 h-4 transition-transform', isOpen && 'rotate-180')}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 mt-1 w-56 bg-slate-700 border border-slate-600 rounded-md shadow-lg z-10">
          {CLAUDE_MODELS.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                onChange(m.id);
                setIsOpen(false);
              }}
              className={clsx(
                'w-full px-3 py-2 text-left hover:bg-slate-600 transition-colors first:rounded-t-md last:rounded-b-md',
                m.id === value && 'bg-slate-600'
              )}
            >
              <div className="text-sm text-white font-medium">{m.name}</div>
              <div className="text-xs text-slate-400">{m.description}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
