// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { ReactNode } from 'react';
import { FilePathLink } from '../FilePathLink';

export function WriteToolView({ input, headerSuffix }: { input: Record<string, unknown>; headerSuffix?: ReactNode }) {
  const filePath = (input.file_path as string) || '';
  const content = (input.content as string) || '';
  const lines = content.split('\n').length;

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="text-green-400 shrink-0">Write</span>{' '}
      {filePath ? (
        <FilePathLink path={filePath} />
      ) : (
        <span className="text-slate-500 font-mono">?</span>
      )}
      <span className="text-slate-500 shrink-0"> ({lines} lines)</span>
      {headerSuffix}
    </div>
  );
}
