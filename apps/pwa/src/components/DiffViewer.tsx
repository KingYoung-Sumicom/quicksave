// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useRef, useState, useEffect } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { clsx } from 'clsx';
import type { FileDiff, DiffHunk, ImageData } from '@sumicom/quicksave-shared';
import type { LineSelection } from '../stores/gitStore';

const SIDE_BY_SIDE_MIN_WIDTH = 640;

interface DiffViewerProps {
  diff: FileDiff;
  onClose: () => void;
  showHeader?: boolean;
  selectable?: boolean;
  selectedLines?: LineSelection[];
  onToggleLineSelection?: (line: LineSelection) => void;
  fileSelected?: boolean;
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
  const containerRef = useRef<HTMLDivElement>(null);
  const [sideBySide, setSideBySide] = useState(false);

  // Force unified view for pure-add diffs (untracked/new files) — side-by-side left column would be empty
  const allAdded = diff.hunks.length > 0 && diff.hunks.every(h => {
    const lines = h.content.split('\n');
    return lines.every(l => l.startsWith('+') || l.startsWith('@@') || l === '');
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => {
      setSideBySide(!allAdded && entry.contentRect.width >= SIDE_BY_SIDE_MIN_WIDTH);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [allAdded]);

  if (diff.isBinary) {
    return (
      <div ref={containerRef} className="bg-slate-800 rounded-lg overflow-hidden">
        {showHeader && <Header path={diff.path} onClose={onClose} />}
        {diff.imageData ? (
          <ImageDiff imageData={diff.imageData} />
        ) : (
          <div className="p-6 text-center text-slate-400">
            <FormattedMessage id="diffViewer.binary" />
          </div>
        )}
      </div>
    );
  }

  if (diff.truncated) {
    return (
      <div ref={containerRef} className="bg-slate-800 rounded-lg overflow-hidden">
        {showHeader && <Header path={diff.path} onClose={onClose} />}
        <div className="p-6 text-center text-amber-400">
          <svg className="w-6 h-6 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          {diff.truncatedReason || <FormattedMessage id="diffViewer.tooLarge" />}
        </div>
      </div>
    );
  }

  if (diff.hunks.length === 0) {
    return (
      <div ref={containerRef} className="bg-slate-800 rounded-lg overflow-hidden">
        {showHeader && <Header path={diff.path} onClose={onClose} />}
        <div className="p-6 text-center text-slate-400">
          <FormattedMessage id="diffViewer.noChanges" />
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="bg-slate-800 rounded-lg overflow-hidden">
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
              sideBySide={sideBySide}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Side-by-side pairing ────────────────────────────────────────────────────

interface SidePair {
  oldLine: string | null; // null = empty (no corresponding line)
  newLine: string | null;
  oldLineNo: number | null;
  newLineNo: number | null;
  type: 'context' | 'change' | 'add-only' | 'remove-only';
  oldIndex: number | null; // original line index for selection
  newIndex: number | null;
}

function buildSidePairs(lines: string[], oldStart: number, newStart: number): SidePair[] {
  const pairs: SidePair[] = [];
  let oldNo = oldStart;
  let newNo = newStart;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('@@')) { i++; continue; }

    if (!line.startsWith('+') && !line.startsWith('-')) {
      // Context line
      pairs.push({ oldLine: line, newLine: line, oldLineNo: oldNo++, newLineNo: newNo++, type: 'context', oldIndex: i, newIndex: i });
      i++;
      continue;
    }

    // Collect a block of consecutive +/- lines
    const removes: { text: string; idx: number }[] = [];
    const adds: { text: string; idx: number }[] = [];
    while (i < lines.length && (lines[i].startsWith('-') || lines[i].startsWith('+'))) {
      if (lines[i].startsWith('-')) removes.push({ text: lines[i], idx: i });
      else adds.push({ text: lines[i], idx: i });
      i++;
    }

    const maxLen = Math.max(removes.length, adds.length);
    for (let j = 0; j < maxLen; j++) {
      const rem = removes[j] ?? null;
      const add = adds[j] ?? null;
      pairs.push({
        oldLine: rem?.text ?? null,
        newLine: add?.text ?? null,
        oldLineNo: rem ? oldNo++ : null,
        newLineNo: add ? newNo++ : null,
        type: rem && add ? 'change' : rem ? 'remove-only' : 'add-only',
        oldIndex: rem?.idx ?? null,
        newIndex: add?.idx ?? null,
      });
    }
  }

  return pairs;
}

// ─── Components ──────────────────────────────────────────────────────────────

function ImageDiff({ imageData }: { imageData: ImageData }) {
  const intl = useIntl();
  const hasOld = !!imageData.old;
  const hasNew = !!imageData.new;
  const sideBySide = hasOld && hasNew;

  return (
    <div className={clsx('p-4', sideBySide && 'grid grid-cols-2 gap-4')}>
      {hasOld && (
        <div className="flex flex-col items-center gap-2">
          {sideBySide && <span className="text-xs font-medium text-red-400"><FormattedMessage id="diffViewer.image.before" /></span>}
          {!hasNew && <span className="text-xs font-medium text-red-400"><FormattedMessage id="diffViewer.image.deleted" /></span>}
          <img src={imageData.old} alt={intl.formatMessage({ id: 'diffViewer.image.oldAlt' })} className="max-w-full max-h-64 rounded border border-slate-600 object-contain" />
        </div>
      )}
      {hasNew && (
        <div className="flex flex-col items-center gap-2">
          {sideBySide && <span className="text-xs font-medium text-green-400"><FormattedMessage id="diffViewer.image.after" /></span>}
          {!hasOld && <span className="text-xs font-medium text-green-400"><FormattedMessage id="diffViewer.image.added" /></span>}
          <img src={imageData.new} alt={intl.formatMessage({ id: 'diffViewer.image.newAlt' })} className="max-w-full max-h-64 rounded border border-slate-600 object-contain" />
        </div>
      )}
    </div>
  );
}

function Header({ path, onClose }: { path: string; onClose: () => void }) {
  const intl = useIntl();
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 bg-slate-800/50">
      <span className="font-mono text-sm truncate">{path}</span>
      <button onClick={onClose} className="p-1 hover:bg-slate-700 rounded transition-colors" aria-label={intl.formatMessage({ id: 'diffViewer.closeAria' })}>
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
  sideBySide: boolean;
}

function HunkView({ hunk, hunkIndex, selectable, selectedLines, onToggleLineSelection, fileSelected, sideBySide }: HunkViewProps) {
  const lines = hunk.content.split('\n');

  const isLineSelected = (lineIndex: number, lineType: 'add' | 'remove' | 'context'): boolean => {
    if (fileSelected && (lineType === 'add' || lineType === 'remove')) return true;
    return selectedLines.some((l) => l.hunkIndex === hunkIndex && l.lineIndex === lineIndex);
  };

  const handleLineClick = (lineIndex: number, type: 'add' | 'remove', content: string) => {
    if (!selectable || !onToggleLineSelection) return;
    onToggleLineSelection({ hunkIndex, lineIndex, type, content });
  };

  const hunkHeader = (
    <div className="px-4 py-1 bg-slate-700/50 text-xs text-slate-400 font-mono">
      @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
    </div>
  );

  if (sideBySide) {
    const pairs = buildSidePairs(lines, hunk.oldStart, hunk.newStart);
    return (
      <div className="border-b border-slate-700 last:border-b-0">
        {hunkHeader}
        <div className="font-mono text-sm grid grid-cols-2 divide-x divide-slate-700">
          {/* Left (old) */}
          <div>
            {pairs.map((pair, i) => {
              const isRemove = pair.type === 'remove-only' || pair.type === 'change';
              const lineIdx = pair.oldIndex;
              const isSelected = lineIdx !== null && isRemove && isLineSelected(lineIdx, 'remove');
              return (
                <div
                  key={i}
                  onClick={() => { if (lineIdx !== null && isRemove) handleLineClick(lineIdx, 'remove', pair.oldLine!); }}
                  className={clsx(
                    'flex items-center px-2 py-0.5 whitespace-pre',
                    pair.oldLine === null && 'bg-slate-900/40',
                    isRemove && 'diff-line-remove',
                    pair.type === 'context' && 'diff-line-context',
                    selectable && isRemove && 'cursor-pointer hover:brightness-110',
                    isSelected && 'diff-line-selected',
                  )}
                >
                  <span className="w-8 shrink-0 text-right text-slate-600 text-xs pr-2 select-none">{pair.oldLineNo ?? ''}</span>
                  <span className={clsx('inline-block w-3 shrink-0 select-none', isRemove ? 'text-deleted' : 'text-slate-500')}>
                    {pair.oldLine !== null ? (isRemove ? '-' : ' ') : ''}
                  </span>
                  <span className="flex-1 overflow-hidden">{pair.oldLine !== null ? pair.oldLine.slice(1) : ''}</span>
                </div>
              );
            })}
          </div>
          {/* Right (new) */}
          <div>
            {pairs.map((pair, i) => {
              const isAdd = pair.type === 'add-only' || pair.type === 'change';
              const lineIdx = pair.newIndex;
              const isSelected = lineIdx !== null && isAdd && isLineSelected(lineIdx, 'add');
              return (
                <div
                  key={i}
                  onClick={() => { if (lineIdx !== null && isAdd) handleLineClick(lineIdx, 'add', pair.newLine!); }}
                  className={clsx(
                    'flex items-center px-2 py-0.5 whitespace-pre',
                    pair.newLine === null && 'bg-slate-900/40',
                    isAdd && 'diff-line-add',
                    pair.type === 'context' && 'diff-line-context',
                    selectable && isAdd && 'cursor-pointer hover:brightness-110',
                    isSelected && 'diff-line-selected',
                  )}
                >
                  <span className="w-8 shrink-0 text-right text-slate-600 text-xs pr-2 select-none">{pair.newLineNo ?? ''}</span>
                  <span className={clsx('inline-block w-3 shrink-0 select-none', isAdd ? 'text-added' : 'text-slate-500')}>
                    {pair.newLine !== null ? (isAdd ? '+' : ' ') : ''}
                  </span>
                  <span className="flex-1 overflow-hidden">{pair.newLine !== null ? pair.newLine.slice(1) : ''}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // Unified view (narrow)
  return (
    <div className="border-b border-slate-700 last:border-b-0">
      {hunkHeader}
      <div className="font-mono text-sm">
        {lines.map((line, index) => {
          if (line.startsWith('@@')) return null;
          const type = getLineType(line);
          const isSelectable = selectable && (type === 'add' || type === 'remove');
          const isSelected = isSelectable && isLineSelected(index, type);
          return (
            <div
              key={index}
              onClick={() => { if (isSelectable) handleLineClick(index, type as 'add' | 'remove', line); }}
              className={clsx(
                'px-4 py-0.5 whitespace-pre flex items-center',
                type === 'add' && 'diff-line-add',
                type === 'remove' && 'diff-line-remove',
                type === 'context' && 'diff-line-context',
                isSelectable && 'cursor-pointer hover:brightness-110',
                isSelected && 'diff-line-selected',
              )}
            >
              {selectable && (
                <span className="w-5 flex-shrink-0 flex items-center justify-center mr-1">
                  {isSelectable && (
                    <span className={clsx('w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors', isSelected ? 'bg-blue-500 border-blue-500' : 'border-slate-500 hover:border-slate-400')}>
                      {isSelected && (
                        <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </span>
                  )}
                </span>
              )}
              <span className={clsx('inline-block w-4 select-none', type === 'add' && 'text-added', type === 'remove' && 'text-deleted', type === 'context' && 'text-slate-500')}>
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
