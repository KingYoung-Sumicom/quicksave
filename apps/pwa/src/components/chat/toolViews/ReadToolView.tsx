// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { ReactNode } from 'react';
import { FilePathLink } from '../FilePathLink';

export function ReadToolView({ input, headerSuffix }: { input: Record<string, unknown>; headerSuffix?: ReactNode }) {
  const filePath = (input.file_path as string) || '';
  const details: string[] = [];
  if (input.offset) details.push(`from L${input.offset}`);
  if (input.limit) details.push(`${input.limit} lines`);

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="text-slate-400 shrink-0">Read</span>{' '}
      {filePath ? (
        <FilePathLink path={filePath} />
      ) : (
        <span className="text-slate-500 font-mono">?</span>
      )}
      {details.length > 0 && (
        <span className="text-slate-500 shrink-0"> ({details.join(', ')})</span>
      )}
      {headerSuffix}
    </div>
  );
}
