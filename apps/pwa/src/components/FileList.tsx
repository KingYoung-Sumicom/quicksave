import { clsx } from 'clsx';
import { useState, useMemo } from 'react';
import type { FileChange, FileStatus, FileDiff } from '@sumicom/quicksave-shared';
import { DiffViewer } from './DiffViewer';
import type { SelectionSource, LineSelection, SelectionKey } from '../stores/gitStore';
import { makeSelectionKey } from '../stores/gitStore';

type DiffKey = SelectionKey;

export interface FileAction {
  label: string;
  onAction: (paths: string[]) => void;
  primary?: boolean;
}

interface FileListProps {
  title: string;
  files: FileChange[] | string[];
  type: SelectionSource;
  onFileClick: (path: string) => void;
  actions: FileAction[];
  expandedDiffs: Record<DiffKey, FileDiff>;
  loadingDiffs: Set<DiffKey>;
  onCloseDiff: (key: DiffKey) => void;
  // Selection props - use composite keys (path:source)
  selectedFiles: Set<SelectionKey>;
  selectedLines: Map<SelectionKey, LineSelection[]>;
  onToggleFileSelection: (key: SelectionKey, source: SelectionSource) => void;
  onToggleLineSelection: (key: SelectionKey, line: LineSelection, source: SelectionSource) => void;
  onSelectAllFiles: (keys: SelectionKey[], source: SelectionSource) => void;
}

// Tree node structure
interface TreeNode {
  name: string;
  path: string;
  isFile: boolean;
  status?: FileStatus;
  children: Map<string, TreeNode>;
}

// Build a tree from flat file paths
function buildFileTree(files: Array<{ path: string; status?: FileStatus }>): TreeNode {
  const root: TreeNode = { name: '', path: '', isFile: false, children: new Map() };

  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;
    let currentPath = '';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isLast = i === parts.length - 1;

      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          path: currentPath,
          isFile: isLast,
          status: isLast ? file.status : undefined,
          children: new Map(),
        });
      }
      current = current.children.get(part)!;
    }
  }

  return root;
}

// Flatten single-child directories (e.g., src/components -> src/components)
function flattenTree(node: TreeNode): TreeNode {
  // Process children first
  const newChildren = new Map<string, TreeNode>();
  for (const [key, child] of node.children) {
    newChildren.set(key, flattenTree(child));
  }
  node.children = newChildren;

  // If this is a directory with exactly one child that is also a directory, flatten
  if (!node.isFile && node.children.size === 1) {
    const [childKey, child] = [...node.children.entries()][0];
    if (!child.isFile) {
      // Merge with child
      const mergedName = node.name ? `${node.name}/${childKey}` : childKey;
      return {
        ...child,
        name: mergedName,
      };
    }
  }

  return node;
}

// Get all file paths under a tree node
function getFilePaths(node: TreeNode): string[] {
  if (node.isFile) {
    return [node.path];
  }
  const paths: string[] = [];
  for (const child of node.children.values()) {
    paths.push(...getFilePaths(child));
  }
  return paths;
}

export function FileList({
  title,
  files,
  type,
  onFileClick,
  actions,
  expandedDiffs,
  loadingDiffs,
  onCloseDiff,
  selectedFiles,
  selectedLines,
  onToggleFileSelection,
  onToggleLineSelection,
  onSelectAllFiles,
}: FileListProps) {
  const primaryAction = actions.find(a => a.primary) || actions[0];
  const secondaryActions = actions.filter(a => a !== primaryAction);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const [isCollapsed, setIsCollapsed] = useState(false);

  const isFileChange = (item: FileChange | string): item is FileChange => {
    return typeof item === 'object' && 'path' in item;
  };

  // Build the file tree
  const fileTree = useMemo(() => {
    const fileData = files.map((f) =>
      isFileChange(f) ? { path: f.path, status: f.status } : { path: f, status: 'added' as FileStatus }
    );
    const tree = buildFileTree(fileData);
    return flattenTree(tree);
  }, [files]);

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

  const getPaths = (): string[] => {
    return files.map((f) => (isFileChange(f) ? f.path : f));
  };

  const allPaths = getPaths();
  const allKeys = allPaths.map((p) => makeSelectionKey(p, type));
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selectedFiles.has(k));
  const someSelected = allKeys.some((k) => selectedFiles.has(k));

  const handleSelectAllClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSelectAllFiles(allKeys, type);
  };

  const toggleDirCollapse = (path: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  // Render a tree node (directory or file)
  const renderNode = (node: TreeNode, depth: number = 0): React.ReactNode => {
    if (node.isFile) {
      const path = node.path;
      const selectionKey = makeSelectionKey(path, type);
      const diffKey = selectionKey; // Use same composite key for diffs
      const status = node.status;
      const isExpanded = diffKey in expandedDiffs;
      const isLoading = loadingDiffs.has(diffKey);
      const diff = expandedDiffs[diffKey];
      const isSelected = selectedFiles.has(selectionKey);
      const fileSelectedLines = selectedLines.get(selectionKey) || [];

      const handleCheckboxClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        onToggleFileSelection(selectionKey, type);
      };

      return (
        <li key={path}>
          <div
            className={clsx(
              'w-full flex items-center gap-2 py-1.5 text-left hover:bg-slate-700/50 transition-colors cursor-pointer',
              (isExpanded || isLoading) && 'bg-slate-700',
              isSelected && 'bg-blue-500/10'
            )}
            style={{ paddingLeft: `${depth * 16 + 16}px`, paddingRight: '16px' }}
            onClick={() => onFileClick(path)}
          >
            {/* File Checkbox */}
            <button
              onClick={handleCheckboxClick}
              className="w-4 h-4 flex items-center justify-center flex-shrink-0"
              aria-label={isSelected ? 'Deselect file' : 'Select file'}
            >
              <span
                className={clsx(
                  'w-4 h-4 rounded border flex items-center justify-center transition-colors',
                  isSelected
                    ? 'bg-blue-500 border-blue-500'
                    : 'border-slate-500 hover:border-slate-400'
                )}
              >
                {isSelected && (
                  <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </span>
            </button>

            {/* Expand/Collapse Icon */}
            <span className="text-slate-400 w-4 flex-shrink-0 text-xs">
              {isLoading ? (
                <span className="inline-block w-3 h-3 border border-slate-400 border-t-transparent rounded-full animate-spin" />
              ) : isExpanded ? '▼' : '▶'}
            </span>

            {/* Status Icon */}
            <span className={clsx('font-mono text-sm w-4 flex-shrink-0', getStatusColor(status))}>
              {type === 'untracked' ? '+' : getStatusIcon(status)}
            </span>

            {/* File Name (just the filename, not full path) */}
            <span className="flex-1 text-sm truncate font-mono">{node.name}</span>

            {/* Quick Actions */}
            <div className="flex items-center gap-1 flex-shrink-0">
              {secondaryActions.map((action) => (
                <button
                  key={action.label}
                  onClick={(e) => {
                    e.stopPropagation();
                    action.onAction([path]);
                  }}
                  className="text-xs px-1.5 py-0.5 text-slate-400 hover:text-white hover:bg-slate-600 rounded opacity-0 group-hover:opacity-100 transition-all"
                  title={action.label}
                >
                  {action.label}
                </button>
              ))}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  primaryAction.onAction([path]);
                }}
                className="text-xs px-2 py-0.5 bg-slate-600 hover:bg-slate-500 rounded opacity-0 group-hover:opacity-100 transition-all"
              >
                {primaryAction.label}
              </button>
            </div>
          </div>

          {/* Inline Diff */}
          {isExpanded && diff && (
            <div className="border-t border-slate-700 bg-slate-900">
              <DiffViewer
                diff={diff}
                onClose={() => onCloseDiff(diffKey)}
                showHeader={false}
                selectedLines={type !== 'untracked' ? fileSelectedLines : undefined}
                onToggleLineSelection={type !== 'untracked' ? (line) => onToggleLineSelection(selectionKey, line, type) : undefined}
                selectable={type !== 'untracked'}
                fileSelected={isSelected}
              />
            </div>
          )}
        </li>
      );
    }

    // Directory node
    const isCollapsed = collapsedDirs.has(node.path);
    const dirPaths = getFilePaths(node);
    const dirKeys = dirPaths.map((p) => makeSelectionKey(p, type));
    const dirAllSelected = dirKeys.length > 0 && dirKeys.every((k) => selectedFiles.has(k));
    const dirSomeSelected = dirKeys.some((k) => selectedFiles.has(k));

    const handleDirCheckboxClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      // Select/deselect all files in this directory
      if (dirAllSelected) {
        // Deselect all
        dirKeys.forEach((k) => {
          if (selectedFiles.has(k)) {
            onToggleFileSelection(k, type);
          }
        });
      } else {
        // Select all
        dirKeys.forEach((k) => {
          if (!selectedFiles.has(k)) {
            onToggleFileSelection(k, type);
          }
        });
      }
    };

    const sortedChildren = [...node.children.values()].sort((a, b) => {
      // Directories first, then files
      if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

    return (
      <li key={node.path || 'root'}>
        {node.name && (
          <div
            className="w-full flex items-center gap-2 py-1.5 text-left hover:bg-slate-700/30 transition-colors cursor-pointer text-slate-400"
            style={{ paddingLeft: `${depth * 16 + 16}px`, paddingRight: '16px' }}
            onClick={() => toggleDirCollapse(node.path)}
          >
            {/* Directory Checkbox */}
            <button
              onClick={handleDirCheckboxClick}
              className="w-4 h-4 flex items-center justify-center flex-shrink-0"
              aria-label={dirAllSelected ? 'Deselect folder' : 'Select folder'}
            >
              <span
                className={clsx(
                  'w-4 h-4 rounded border flex items-center justify-center transition-colors',
                  dirAllSelected
                    ? 'bg-blue-500 border-blue-500'
                    : dirSomeSelected
                      ? 'bg-blue-500/50 border-blue-500'
                      : 'border-slate-600 hover:border-slate-500'
                )}
              >
                {(dirAllSelected || dirSomeSelected) && (
                  <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    {dirAllSelected ? (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    ) : (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 12h14" />
                    )}
                  </svg>
                )}
              </span>
            </button>

            {/* Folder Icon */}
            <span className="text-xs flex-shrink-0">{isCollapsed ? '📁' : '📂'}</span>

            {/* Directory Name */}
            <span className="flex-1 text-sm truncate font-mono">{node.name}/</span>

            {/* File Count */}
            <span className="text-xs text-slate-500">{dirPaths.length}</span>
          </div>
        )}
        {!isCollapsed && (
          <ul>
            {sortedChildren.map((child) => renderNode(child, node.name ? depth + 1 : depth))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="bg-slate-800 rounded-lg overflow-hidden">
      {/* Header */}
      <div
        className={clsx(
          'flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-slate-700/50 transition-colors',
          !isCollapsed && 'border-b border-slate-700'
        )}
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <div className="flex items-center gap-3">
          {/* Collapse/Expand Icon */}
          <span className="text-slate-400 w-4 flex-shrink-0 text-xs">
            {isCollapsed ? '▶' : '▼'}
          </span>
          {/* Select All Checkbox */}
          <button
            onClick={handleSelectAllClick}
            className="w-4 h-4 flex items-center justify-center"
            aria-label={allSelected ? 'Deselect all' : 'Select all'}
          >
            <span
              className={clsx(
                'w-4 h-4 rounded border flex items-center justify-center transition-colors',
                allSelected
                  ? 'bg-blue-500 border-blue-500'
                  : someSelected
                    ? 'bg-blue-500/50 border-blue-500'
                    : 'border-slate-500 hover:border-slate-400'
              )}
            >
              {(allSelected || someSelected) && (
                <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  {allSelected ? (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  ) : (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 12h14" />
                  )}
                </svg>
              )}
            </span>
          </button>
          <h3 className="font-medium text-sm">
            {title} ({files.length})
          </h3>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            primaryAction.onAction(allPaths);
          }}
          className="text-xs px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded transition-colors"
        >
          {primaryAction.label} All
        </button>
      </div>

      {/* File Tree */}
      {!isCollapsed && (
        <ul>
          {[...fileTree.children.values()]
            .sort((a, b) => {
              if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
              return a.name.localeCompare(b.name);
            })
            .map((child) => renderNode(child, 0))}
        </ul>
      )}
    </div>
  );
}
