import { clsx } from 'clsx';
import type { FileDiff, DiffHunk } from '@quicksave/shared';
import type { LineSelection } from '../stores/gitStore';

interface DiffViewerProps {
  diff: FileDiff;
  onClose: () => void;
  showHeader?: boolean;
  selectable?: boolean;
  selectedLines?: LineSelection[];
  onToggleLineSelection?: (line: LineSelection) => void;
  fileSelected?: boolean; // When true, all lines appear selected
}

export function DiffViewer({
  diff,
  onClose,
  showHeader = true,
  selectable = false,
  selectedLines = [],
  onToggleLineSelection,
  fileSelected = false,
}: DiffViewerProps) {
  if (diff.isBinary) {
    return (
      <div className="bg-slate-800 rounded-lg overflow-hidden">
        {showHeader && <Header path={diff.path} onClose={onClose} />}
        <div className="p-6 text-center text-slate-400">
          Binary file - cannot display diff
        </div>
      </div>
    );
  }

  if (diff.truncated) {
    return (
      <div className="bg-slate-800 rounded-lg overflow-hidden">
        {showHeader && <Header path={diff.path} onClose={onClose} />}
        <div className="p-6 text-center text-amber-400">
          <svg
            className="w-6 h-6 mx-auto mb-2"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          {diff.truncatedReason || 'File too large to display'}
        </div>
      </div>
    );
  }

  if (diff.hunks.length === 0) {
    return (
      <div className="bg-slate-800 rounded-lg overflow-hidden">
        {showHeader && <Header path={diff.path} onClose={onClose} />}
        <div className="p-6 text-center text-slate-400">No changes to display</div>
      </div>
    );
  }

  return (
    <div className="bg-slate-800 rounded-lg overflow-hidden">
      {showHeader && <Header path={diff.path} onClose={onClose} />}
      <div className="overflow-x-auto">
        <div className="min-w-fit">
          {diff.hunks.map((hunk, hunkIndex) => (
            <HunkView
              key={hunkIndex}
              hunk={hunk}
              hunkIndex={hunkIndex}
              selectable={selectable}
              selectedLines={selectedLines}
              onToggleLineSelection={onToggleLineSelection}
              fileSelected={fileSelected}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Header({ path, onClose }: { path: string; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 bg-slate-800/50">
      <span className="font-mono text-sm truncate">{path}</span>
      <button
        onClick={onClose}
        className="p-1 hover:bg-slate-700 rounded transition-colors"
        aria-label="Close diff"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

interface HunkViewProps {
  hunk: DiffHunk;
  hunkIndex: number;
  selectable: boolean;
  selectedLines: LineSelection[];
  onToggleLineSelection?: (line: LineSelection) => void;
  fileSelected: boolean;
}

function HunkView({ hunk, hunkIndex, selectable, selectedLines, onToggleLineSelection, fileSelected }: HunkViewProps) {
  const lines = hunk.content.split('\n');

  const isLineSelected = (lineIndex: number, lineType: 'add' | 'remove' | 'context'): boolean => {
    // If file is selected, all add/remove lines are selected
    if (fileSelected && (lineType === 'add' || lineType === 'remove')) {
      return true;
    }
    return selectedLines.some(
      (l) => l.hunkIndex === hunkIndex && l.lineIndex === lineIndex
    );
  };

  const handleLineClick = (lineIndex: number, type: 'add' | 'remove', content: string) => {
    if (!selectable || !onToggleLineSelection) return;

    onToggleLineSelection({
      hunkIndex,
      lineIndex,
      type,
      content,
    });
  };

  return (
    <div className="border-b border-slate-700 last:border-b-0">
      {/* Hunk Header */}
      <div className="px-4 py-1 bg-slate-700/50 text-xs text-slate-400 font-mono">
        @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
      </div>

      {/* Diff Lines */}
      <div className="font-mono text-sm">
        {lines.map((line, index) => {
          // Skip the hunk header line if it's included
          if (line.startsWith('@@')) return null;

          const type = getLineType(line);
          const isSelectable = selectable && (type === 'add' || type === 'remove');
          const isSelected = isSelectable && isLineSelected(index, type);

          return (
            <div
              key={index}
              onClick={() => {
                if (isSelectable) {
                  handleLineClick(index, type as 'add' | 'remove', line);
                }
              }}
              className={clsx(
                'px-4 py-0.5 whitespace-pre flex items-center',
                type === 'add' && 'diff-line-add',
                type === 'remove' && 'diff-line-remove',
                type === 'context' && 'diff-line-context',
                isSelectable && 'cursor-pointer hover:brightness-110',
                isSelected && 'diff-line-selected'
              )}
            >
              {/* Selection checkbox for selectable lines */}
              {selectable && (
                <span className="w-5 flex-shrink-0 flex items-center justify-center mr-1">
                  {isSelectable && (
                    <span
                      className={clsx(
                        'w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors',
                        isSelected
                          ? 'bg-blue-500 border-blue-500'
                          : 'border-slate-500 hover:border-slate-400'
                      )}
                    >
                      {isSelected && (
                        <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </span>
                  )}
                </span>
              )}
              <span
                className={clsx(
                  'inline-block w-4 select-none',
                  type === 'add' && 'text-added',
                  type === 'remove' && 'text-deleted',
                  type === 'context' && 'text-slate-500'
                )}
              >
                {line.charAt(0) || ' '}
              </span>
              <span className="flex-1">{line.slice(1)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function getLineType(line: string): 'add' | 'remove' | 'context' {
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'remove';
  return 'context';
}
