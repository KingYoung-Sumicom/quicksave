// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { ReactNode } from 'react';
import { FilePathLink } from '../FilePathLink';

const FILE_MARKER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

function patchFiles(patch: string): string[] {
  const files = [...patch.matchAll(FILE_MARKER)].map((match) => match[1]);
  return [...new Set(files)];
}

export function ApplyPatchToolView({
  input,
  headerSuffix,
}: {
  input: Record<string, unknown>;
  headerSuffix?: ReactNode;
}) {
  const patch = (input.patch_text as string) || '';
  const files = patchFiles(patch);
  const additions = patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
  const deletions = patch.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).length;

  return (
    <div>
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="text-yellow-400 shrink-0">Apply patch</span>
        {files.length > 0 && (
          <span className="text-slate-500 shrink-0">
            {files.length} {files.length === 1 ? 'file' : 'files'}
          </span>
        )}
        {(additions > 0 || deletions > 0) && (
          <span className="shrink-0">
            <span className="text-green-400">+{additions}</span>
            <span className="text-slate-500">/</span>
            <span className="text-red-400">-{deletions}</span>
          </span>
        )}
        {headerSuffix}
      </div>
      {files.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1">
          {files.slice(0, 4).map((file) => <FilePathLink key={file} path={file} />)}
          {files.length > 4 && <span className="text-slate-500">+{files.length - 4} more</span>}
        </div>
      )}
    </div>
  );
}
