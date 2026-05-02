// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { clsx } from 'clsx';
import { useUiPrefsStore } from '../../stores/uiPrefsStore';

export function ToolCallVisibilityChip({ onChange }: {
  /** Optional hook fired after the toggle so the parent can clear local
   *  per-group expansion state. */
  onChange?: () => void;
}) {
  const hideToolCalls = useUiPrefsStore((s) => s.hideToolCalls);
  const toggle = useUiPrefsStore((s) => s.toggleHideToolCalls);

  return (
    <button
      type="button"
      onClick={() => { toggle(); onChange?.(); }}
      className={clsx(
        'flex items-center gap-1 px-2 py-1 rounded-md transition-colors',
        hideToolCalls
          ? 'bg-slate-700/60 text-slate-400 hover:bg-slate-700 hover:text-slate-300'
          : 'bg-blue-600/20 text-blue-400 hover:bg-blue-600/30',
      )}
      aria-pressed={!hideToolCalls}
      title={hideToolCalls ? 'Tool calls are hidden — click to show them' : 'Tool calls are visible — click to hide them'}
    >
      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        {hideToolCalls ? (
          <>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.58 10.58a2 2 0 002.83 2.83M9.88 5.08A10.94 10.94 0 0112 5c5.5 0 9.74 4.04 11 7-.6 1.4-1.78 3.13-3.5 4.62M6.5 6.5C4.78 7.99 3.6 9.72 3 11c1.26 2.96 5.5 7 11 7 1.55 0 3.01-.32 4.32-.85" />
          </>
        ) : (
          <>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
            <circle cx="12" cy="12" r="3" />
          </>
        )}
      </svg>
      <span>Tools</span>
    </button>
  );
}
