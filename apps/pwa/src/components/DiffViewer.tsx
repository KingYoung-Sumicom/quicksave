import { clsx } from 'clsx';
import type { FileDiff, DiffHunk } from '@quicksave/shared';

interface DiffViewerProps {
  diff: FileDiff;
  onClose: () => void;
}

export function DiffViewer({ diff, onClose }: DiffViewerProps) {
  if (diff.isBinary) {
    return (
      <div className="bg-slate-800 rounded-lg overflow-hidden">
        <Header path={diff.path} onClose={onClose} />
        <div className="p-6 text-center text-slate-400">
          Binary file - cannot display diff
        </div>
      </div>
    );
  }

  if (diff.hunks.length === 0) {
    return (
      <div className="bg-slate-800 rounded-lg overflow-hidden">
        <Header path={diff.path} onClose={onClose} />
        <div className="p-6 text-center text-slate-400">No changes to display</div>
      </div>
    );
  }

  return (
    <div className="bg-slate-800 rounded-lg overflow-hidden">
      <Header path={diff.path} onClose={onClose} />
      <div className="overflow-x-auto">
        {diff.hunks.map((hunk, index) => (
          <HunkView key={index} hunk={hunk} />
        ))}
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

function HunkView({ hunk }: { hunk: DiffHunk }) {
  const lines = hunk.content.split('\n');

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
          return (
            <div
              key={index}
              className={clsx(
                'px-4 py-0.5 whitespace-pre',
                type === 'add' && 'diff-line-add',
                type === 'remove' && 'diff-line-remove',
                type === 'context' && 'diff-line-context'
              )}
            >
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
              <span>{line.slice(1)}</span>
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
