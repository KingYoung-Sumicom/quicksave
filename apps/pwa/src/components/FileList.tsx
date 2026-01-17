import { clsx } from 'clsx';
import type { FileChange, FileStatus, FileDiff } from '@quicksave/shared';
import { DiffViewer } from './DiffViewer';

interface FileListProps {
  title: string;
  files: FileChange[] | string[];
  type: 'staged' | 'unstaged' | 'untracked';
  onFileClick: (path: string) => void;
  onAction: (paths: string[]) => void;
  actionLabel: string;
  selectedFile?: string | null;
  selectedDiff?: FileDiff | null;
  onCloseDiff?: () => void;
}

export function FileList({
  title,
  files,
  type,
  onFileClick,
  onAction,
  actionLabel,
  selectedFile,
  selectedDiff,
  onCloseDiff,
}: FileListProps) {
  if (files.length === 0) return null;

  const getStatusColor = (status?: FileStatus): string => {
    switch (status) {
      case 'added':
        return 'text-added';
      case 'modified':
        return 'text-modified';
      case 'deleted':
        return 'text-deleted';
      case 'renamed':
        return 'text-renamed';
      default:
        return 'text-slate-400';
    }
  };

  const getStatusIcon = (status?: FileStatus): string => {
    switch (status) {
      case 'added':
        return '+';
      case 'modified':
        return '~';
      case 'deleted':
        return '-';
      case 'renamed':
        return '→';
      default:
        return '?';
    }
  };

  const isFileChange = (item: FileChange | string): item is FileChange => {
    return typeof item === 'object' && 'path' in item;
  };

  const getPaths = (): string[] => {
    return files.map((f) => (isFileChange(f) ? f.path : f));
  };

  return (
    <div className="bg-slate-800 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
        <h3 className="font-medium text-sm">
          {title} ({files.length})
        </h3>
        <button
          onClick={() => onAction(getPaths())}
          className="text-xs px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded transition-colors"
        >
          {actionLabel} All
        </button>
      </div>

      {/* File List */}
      <ul className="divide-y divide-slate-700">
        {files.map((file) => {
          const path = isFileChange(file) ? file.path : file;
          const status = isFileChange(file) ? file.status : undefined;
          const isSelected = selectedFile === path;
          const showDiff = isSelected && selectedDiff && selectedDiff.path === path;

          return (
            <li key={path}>
              <button
                onClick={() => onFileClick(path)}
                className={clsx(
                  'w-full flex items-center gap-3 px-4 py-2 text-left hover:bg-slate-700/50 transition-colors',
                  isSelected && 'bg-slate-700'
                )}
              >
                {/* Expand/Collapse Icon */}
                <span className="text-slate-400 w-4">
                  {isSelected ? '▼' : '▶'}
                </span>

                {/* Status Icon */}
                <span className={clsx('font-mono text-sm w-4', getStatusColor(status))}>
                  {type === 'untracked' ? '+' : getStatusIcon(status)}
                </span>

                {/* File Path */}
                <span className="flex-1 text-sm truncate font-mono">{path}</span>

                {/* Quick Action */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onAction([path]);
                  }}
                  className="text-xs px-2 py-1 bg-slate-600 hover:bg-slate-500 rounded opacity-0 group-hover:opacity-100 transition-all"
                >
                  {actionLabel}
                </button>
              </button>

              {/* Inline Diff */}
              {showDiff && onCloseDiff && (
                <div className="border-t border-slate-700 bg-slate-900">
                  <DiffViewer diff={selectedDiff} onClose={onCloseDiff} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
