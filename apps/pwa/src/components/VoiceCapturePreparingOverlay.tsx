// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

export function VoiceCapturePreparingOverlay() {
  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center rounded-lg border border-amber-400/25 bg-slate-800/95 backdrop-blur-sm"
      role="status"
      aria-live="polite"
      aria-label="Preparing microphone"
    >
      <div className="flex items-center gap-3 text-slate-200">
        <span
          className="h-5 w-5 rounded-full border-2 border-slate-500 border-t-amber-300 animate-spin motion-reduce:animate-pulse"
          aria-hidden="true"
        />
        <span className="text-sm font-medium">Preparing microphone...</span>
      </div>
    </div>
  );
}
