import type { ReactNode } from 'react';

interface BaseStatusBarProps {
  left?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
  below?: ReactNode;
}

/**
 * Shared status bar shell — sticky header with left/center/right layout.
 * Each view composes this with its own content.
 */
export function BaseStatusBar({ left, center, right, below }: BaseStatusBarProps) {
  return (
    <header className="sticky top-0 z-30 bg-slate-800 border-b border-slate-700 safe-area-top touch-manipulation">
      <div className="relative flex items-center px-4 py-3 min-h-[52px]">
        {/* Left slot */}
        <div className="flex items-center w-10 shrink-0">
          {left}
        </div>

        {/* Center slot — absolute so it doesn't push left/right */}
        <div className="absolute left-14 right-14 inset-y-0 flex items-center justify-center py-2 overflow-hidden pointer-events-none">
          <div className="pointer-events-auto">{center}</div>
        </div>

        {/* Right slot — z-10 so it sits above the absolute center */}
        <div className="relative z-10 ml-auto shrink-0 flex items-center gap-1">
          {right}
        </div>
      </div>

      {below}
    </header>
  );
}

/** Reusable hamburger menu button */
export function MenuButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="p-2 -ml-2 hover:bg-slate-700 rounded-md transition-colors"
      aria-label="Menu"
    >
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
      </svg>
    </button>
  );
}

/** Reusable back arrow button */
export function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="p-2 -ml-2 hover:bg-slate-700 rounded-md transition-colors"
      aria-label="Back"
    >
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
      </svg>
    </button>
  );
}

/** Reusable settings gear button */
export function SettingsGearButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="p-1.5 rounded-md transition-colors hover:bg-slate-700 text-slate-400"
      aria-label="Settings"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    </button>
  );
}
