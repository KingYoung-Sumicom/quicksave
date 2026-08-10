// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

interface VoiceRecordingOverlayProps {
  onStop: () => void;
  onCancel: () => void;
}

const BAR_HEIGHTS = ['h-2', 'h-4', 'h-6', 'h-4', 'h-2'] as const;

export function VoiceRecordingOverlay({ onStop, onCancel }: VoiceRecordingOverlayProps) {
  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center rounded-lg border border-red-400/30 bg-slate-800/95 backdrop-blur-sm"
      role="region"
      aria-label="Recording voice"
    >
      <div className="flex flex-wrap items-center justify-center gap-3 px-3">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-200" role="status" aria-live="polite">
          <span className="h-2 w-2 shrink-0 rounded-full bg-red-400 animate-pulse motion-reduce:animate-none" aria-hidden="true" />
          <div className="flex h-7 w-9 items-center justify-center gap-1" aria-hidden="true">
            {BAR_HEIGHTS.map((height, index) => (
              <span
                key={`${height}-${index}`}
                className={`${height} w-1 rounded-sm bg-red-300 animate-pulse motion-reduce:animate-none`}
                style={{ animationDelay: `${index * 120}ms` }}
              />
            ))}
          </div>
          <span>Recording...</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onStop}
            className="flex h-9 items-center gap-2 rounded-md bg-red-600 px-3 text-sm font-medium text-white hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-red-300"
          >
            <span className="h-3 w-3 rounded-sm bg-white" aria-hidden="true" />
            Stop
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="flex h-9 items-center gap-2 rounded-md border border-slate-600 bg-slate-700 px-3 text-sm font-medium text-slate-200 hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-slate-400"
          >
            <span className="text-base leading-none" aria-hidden="true">X</span>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
