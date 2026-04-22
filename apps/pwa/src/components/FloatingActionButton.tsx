import { clsx } from 'clsx';
import { Spinner } from './ui/Spinner';
import type { SelectionSource } from '../stores/gitStore';

interface FloatingActionButtonProps {
  hasSelection: boolean;
  selectionSummary: string;
  selectionSource: SelectionSource | null;
  isLoading: boolean;
  onAction: () => void;
  onClear: () => void;
}

export function FloatingActionButton({
  hasSelection,
  selectionSummary,
  selectionSource,
  isLoading,
  onAction,
  onClear,
}: FloatingActionButtonProps) {
  if (!hasSelection) return null;

  const getActionLabel = (): string => {
    if (selectionSource === 'staged') {
      return `Unstage ${selectionSummary}`;
    }
    return `Stage ${selectionSummary}`;
  };

  return (
    <div className="floating-action-button fixed bottom-20 right-[calc(1rem+env(safe-area-inset-right))] flex flex-col gap-2 z-50 animate-slide-up bg-slate-600/70 backdrop-blur-md rounded-2xl p-2 shadow-xl">
      {/* Clear button */}
      <button
        onClick={onClear}
        disabled={isLoading}
        className={clsx(
          'px-3 py-2 rounded-full bg-rose-600/70 hover:bg-rose-500/80 backdrop-blur-sm text-sm font-medium',
          'shadow-lg transition-all duration-200',
          'flex items-center justify-center gap-2',
          isLoading && 'opacity-50 cursor-not-allowed'
        )}
        aria-label="Clear selection"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
        Clear
      </button>

      {/* Main action button */}
      <button
        onClick={onAction}
        disabled={isLoading}
        className={clsx(
          'px-4 py-3 rounded-full font-medium text-white backdrop-blur-sm',
          'shadow-lg transition-all duration-200',
          'flex items-center justify-center gap-2',
          selectionSource === 'staged'
            ? 'bg-amber-600/70 hover:bg-amber-500/80'
            : 'bg-blue-600/70 hover:bg-blue-500/80',
          isLoading && 'opacity-50 cursor-not-allowed'
        )}
      >
        {isLoading ? (
          <>
            <Spinner color="border-white" />
            Processing...
          </>
        ) : (
          <>
            {selectionSource === 'staged' ? (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            )}
            {getActionLabel()}
          </>
        )}
      </button>
    </div>
  );
}
