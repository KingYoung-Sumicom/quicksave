import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { Spinner } from './ui/Spinner';
import { ErrorBox } from './ui/ErrorBox';
import { ConfirmModal } from './ui/ConfirmModal';
import { useGitStore, selectCanCommit } from '../stores/gitStore';
import { CLAUDE_MODELS, type ClaudeModel, type CommitSummarySource, type CommitSummaryProgress } from '@sumicom/quicksave-shared';
import { clsx } from 'clsx';

interface CommitFormProps {
  onCommit: (message: string, description?: string) => Promise<void>;
  onGenerateAiSummary: () => Promise<void>;
  /** Apply the pending AI suggestion (fills the form + tells the agent to drop its state). */
  onApplyAiSuggestion: () => Promise<void>;
  /** Dismiss the pending AI suggestion (clears local state + tells the agent to drop its state). */
  onDismissAiSummary: () => Promise<void>;
  onOpenSettings: () => void;
  stagedCount: number;
}

export function CommitForm({ onCommit, onGenerateAiSummary, onApplyAiSuggestion, onDismissAiSummary, onOpenSettings, stagedCount }: CommitFormProps) {
  const {
    commitMessage,
    commitDescription,
    setCommitMessage,
    setCommitDescription,
    isLoading,
    aiSummary,
    aiDescription,
    aiSummaryError,
    aiProgress,
    selectedModel,
    setSelectedModel,
    apiKeyConfigured,
    aiTokenUsage,
    aiResultCached,
    isGeneratingAiSummary,
    commitSummarySource,
    setCommitSummarySource,
  } = useGitStore();
  const canCommit = useGitStore(selectCanCommit);
  const [showDescription, setShowDescription] = useState(false);
  const [showOverwriteConfirm, setShowOverwriteConfirm] = useState(false);
  const messageRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize the single-line-but-wrapping commit message textarea to fit its content.
  useLayoutEffect(() => {
    const el = messageRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [commitMessage]);

  // Auto-show description field when commitDescription has content
  // (e.g., from AI auto-fill or localStorage restoration)
  useEffect(() => {
    if (commitDescription && !showDescription) {
      setShowDescription(true);
    }
  }, [commitDescription, showDescription]);

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

  const requestGenerate = () => {
    if (commitMessage.trim() || commitDescription.trim()) {
      setShowOverwriteConfirm(true);
      return;
    }
    void onGenerateAiSummary();
  };

  const handleConfirmOverwrite = () => {
    setShowOverwriteConfirm(false);
    void onGenerateAiSummary();
  };

  const handleApplySuggestion = () => {
    if (aiDescription) {
      setShowDescription(true);
    }
    void onApplyAiSuggestion();
  };

  const handleDismissSuggestion = () => {
    void onDismissAiSummary();
  };

  if (stagedCount === 0) {
    return null;
  }

  const isCliSource = commitSummarySource === 'claude-cli';
  // CLI source uses the user's Claude Code subscription, so no API key is required.
  const canGenerate = isCliSource || apiKeyConfigured;
  const defaultLoadingLabel = isCliSource
    ? 'Exploring repo with Claude CLI...'
    : 'Generating commit message...';
  const progressLabel = describeProgress(aiProgress) ?? defaultLoadingLabel;

  return (
    <div className="bg-slate-800 rounded-lg p-4">
      <form onSubmit={handleSubmit} className="space-y-3">
        {/* Loading indicator - always visible when generating and no suggestion yet */}
        {isGeneratingAiSummary && !aiSummary && (
          <div className="flex flex-col items-center gap-2 py-4 px-3 bg-purple-900/20 border border-purple-500/30 rounded-lg">
            <div className="flex items-center gap-3">
              <svg className="w-6 h-6 animate-spin text-purple-400" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <span className="text-sm font-medium text-purple-400">{progressLabel}</span>
            </div>
            {aiProgress && (aiProgress.toolCount || aiProgress.elapsedMs) ? (
              <div className="text-xs text-slate-400">
                {aiProgress.toolCount ? `${aiProgress.toolCount} tool${aiProgress.toolCount === 1 ? '' : 's'}` : null}
                {aiProgress.toolCount && aiProgress.elapsedMs ? ' · ' : null}
                {aiProgress.elapsedMs ? formatElapsed(aiProgress.elapsedMs) : null}
              </div>
            ) : null}
          </div>
        )}

        {/* AI Generate Section - only show when not generating */}
        {!aiSummary && !isGeneratingAiSummary && (
          <div className="space-y-2">
            {/* Source toggle */}
            <SourceToggle value={commitSummarySource} onChange={setCommitSummarySource} disabled={isLoading} />

            {/* Model Selector + Generate Button Row */}
            <div className="flex gap-2">
              <ModelDropdown
                value={selectedModel}
                onChange={setSelectedModel}
                disabled={isLoading || !canGenerate}
              />

              <button
                type="button"
                onClick={canGenerate ? requestGenerate : onOpenSettings}
                disabled={isLoading}
                className="flex-1 py-2 px-4 rounded-md font-medium text-white transition-colors flex items-center justify-center gap-2 bg-purple-600 hover:bg-purple-700 disabled:bg-slate-600 disabled:cursor-not-allowed"
              >
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
                {isCliSource ? 'Generate (agentic)' : 'Generate'}
              </button>
            </div>
          </div>
        )}

        {/* AI Suggestion Display */}
        {aiSummary && (
          <div className={clsx(
            'p-3 bg-purple-900/30 border border-purple-500/50 rounded-lg relative',
            isGeneratingAiSummary && 'opacity-60'
          )}>
            {/* Loading overlay for regeneration */}
            {isGeneratingAiSummary && (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-900/70 rounded-lg z-10">
                <div className="flex items-center gap-3 text-purple-400">
                  <svg className="w-6 h-6 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  <span className="text-sm font-medium">Regenerating...</span>
                </div>
              </div>
            )}
            <div className="flex items-start justify-between gap-2 mb-2">
              <span className="text-xs text-purple-400 font-medium">AI Suggestion</span>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={handleGenerateClick}
                  disabled={isGeneratingAiSummary}
                  className="text-xs text-slate-400 hover:text-white disabled:text-slate-600 disabled:cursor-not-allowed px-2 py-1 rounded transition-colors"
                  title="Regenerate"
                >
                  {isGeneratingAiSummary ? (
                    <Spinner size="w-3 h-3" borderWidth="border" />
                  ) : (
                    '↻'
                  )}
                </button>
                <button
                  type="button"
                  onClick={handleDismissSuggestion}
                  disabled={isGeneratingAiSummary}
                  className="text-xs text-slate-400 hover:text-white disabled:text-slate-600 disabled:cursor-not-allowed px-2 py-1 rounded transition-colors"
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
                disabled={isGeneratingAiSummary}
                className="text-sm text-purple-400 hover:text-purple-300 disabled:text-slate-600 disabled:cursor-not-allowed font-medium transition-colors"
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
          <ErrorBox>{aiSummaryError}</ErrorBox>
        )}

        {/* Commit Message — soft-wraps visually but stays logically a single line */}
        <div>
          <textarea
            ref={messageRef}
            value={commitMessage}
            onChange={(e) => {
              // Collapse any hard newlines pasted in — the summary line stays single-line.
              const value = e.target.value.replace(/\r?\n+/g, ' ');
              setCommitMessage(value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (canCommit && !isLoading) {
                  void handleSubmit(e as unknown as React.FormEvent);
                }
              }
            }}
            placeholder="Commit message"
            rows={1}
            className="w-full px-3 py-3 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none overflow-hidden leading-relaxed"
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
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none min-h-[12rem] md:min-h-0"
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
      {showOverwriteConfirm && (
        <ConfirmModal
          title="Overwrite existing message?"
          message="Generating will replace the commit message and description you've already written."
          confirmLabel="Overwrite"
          onConfirm={handleConfirmOverwrite}
          onCancel={() => setShowOverwriteConfirm(false)}
        />
      )}
    </div>
  );
}

function describeProgress(progress: CommitSummaryProgress | null): string | null {
  if (!progress) return null;
  if (progress.phase === 'preparing') return 'Preparing generation...';
  if (progress.phase === 'inspecting') {
    return progress.lastToolName
      ? `Inspecting repo (${progress.lastToolName})...`
      : 'Inspecting repo...';
  }
  if (progress.phase === 'generating') return 'Drafting commit message...';
  if (progress.phase === 'finalizing') return 'Finalizing...';
  return null;
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
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

interface SourceToggleProps {
  value: CommitSummarySource;
  onChange: (source: CommitSummarySource) => void;
  disabled?: boolean;
}

function SourceToggle({ value, onChange, disabled }: SourceToggleProps) {
  const options: { id: CommitSummarySource; label: string; hint: string }[] = [
    { id: 'api', label: 'API', hint: 'Fast · uses your Anthropic API key' },
    { id: 'claude-cli', label: 'Claude CLI', hint: 'Agentic · reads related files · uses your Claude subscription' },
  ];
  const active = options.find((o) => o.id === value) ?? options[0];

  return (
    <div className="flex flex-col gap-1">
      <div className="inline-flex rounded-md border border-slate-600 bg-slate-900/60 p-0.5 self-start">
        {options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            onClick={() => !disabled && onChange(opt.id)}
            disabled={disabled}
            className={clsx(
              'px-2.5 py-1 text-xs font-medium rounded transition-colors',
              opt.id === value
                ? 'bg-purple-600 text-white'
                : 'text-slate-300 hover:text-white hover:bg-slate-700',
              disabled && 'opacity-50 cursor-not-allowed'
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-slate-500">{active.hint}</p>
    </div>
  );
}
