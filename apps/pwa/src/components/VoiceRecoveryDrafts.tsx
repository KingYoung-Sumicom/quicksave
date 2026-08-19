// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { VoiceRecoverySummary } from '../lib/voiceRecoveryStore';

interface VoiceRecoveryDraftsProps {
  drafts: VoiceRecoverySummary[];
  busy?: boolean;
  onRetry: (id: string) => void;
  onDiscard: (id: string) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function VoiceRecoveryDrafts({ drafts, busy = false, onRetry, onDiscard }: VoiceRecoveryDraftsProps) {
  if (drafts.length === 0) return null;
  return (
    <div className="mb-2 space-y-2" aria-label="Unfinished voice recordings">
      {drafts.map((draft) => (
        <div key={draft.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-sm">
          <div className="min-w-0 text-amber-100">
            <div className="font-medium">Voice transcription needs retry</div>
            <div className="truncate text-xs text-amber-200/75">
              {formatBytes(draft.bytes)}{draft.error ? ` · ${draft.error}` : ''}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => onRetry(draft.id)}
              className="rounded bg-amber-500 px-2.5 py-1 text-xs font-medium text-slate-950 hover:bg-amber-400 disabled:opacity-60"
            >
              Retry
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onDiscard(draft.id)}
              className="rounded border border-slate-500 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-60"
            >
              Discard
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
