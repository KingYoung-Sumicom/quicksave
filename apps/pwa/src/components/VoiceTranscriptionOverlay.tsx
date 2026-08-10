// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

const BAR_HEIGHTS = ['h-2', 'h-4', 'h-6', 'h-4', 'h-2'] as const;

interface VoiceTranscriptionOverlayProps {
  error?: string | null;
  onRetry?: () => void;
  onCancel?: () => void;
}

/** Keeps the composer footprint stable while recorded audio is transcribed. */
export function VoiceTranscriptionOverlay({ error, onRetry, onCancel }: VoiceTranscriptionOverlayProps) {
  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center rounded-lg border border-slate-600/80 bg-slate-800/95 backdrop-blur-sm"
      role="region"
      aria-label={error ? 'Voice transcription timed out' : 'Transcribing voice'}
    >
      {error ? (
        <div className="flex flex-wrap items-center justify-center gap-3 px-3">
          <span className="text-sm font-medium text-amber-200" role="alert">{error}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRetry}
              className="h-9 rounded-md bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-300"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="h-9 rounded-md border border-slate-600 bg-slate-700 px-3 text-sm font-medium text-slate-200 hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-slate-400"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3 text-slate-200" role="status" aria-live="polite">
          <div className="flex h-7 w-9 items-center justify-center gap-1" aria-hidden="true">
            {BAR_HEIGHTS.map((height, index) => (
              <span
                key={`${height}-${index}`}
                className={`${height} w-1 rounded-sm bg-cyan-300 animate-pulse motion-reduce:animate-none`}
                style={{ animationDelay: `${index * 120}ms` }}
              />
            ))}
          </div>
          <span className="text-sm font-medium">Transcribing...</span>
        </div>
      )}
    </div>
  );
}
