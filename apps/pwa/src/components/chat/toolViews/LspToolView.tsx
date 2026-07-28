// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { ReactNode } from 'react';
import { FilePathLink } from '../FilePathLink';

export function LspToolView({
  input,
  headerSuffix,
}: {
  input: Record<string, unknown>;
  headerSuffix?: ReactNode;
}) {
  const operation = (input.operation as string) || 'query';
  const filePath = (input.file_path as string) || '';
  const line = typeof input.line === 'number' ? input.line : undefined;
  const character = typeof input.character === 'number' ? input.character : undefined;
  const query = typeof input.query === 'string' ? input.query : undefined;

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="text-sky-400 shrink-0">LSP</span>
      <span className="font-mono text-slate-300 shrink-0">{operation}</span>
      {filePath && <FilePathLink path={filePath} />}
      {line !== undefined && (
        <span className="text-slate-500 shrink-0">:{line}{character !== undefined ? `:${character}` : ''}</span>
      )}
      {!filePath && query && <span className="font-mono text-slate-400 truncate">{query}</span>}
      {headerSuffix}
    </div>
  );
}
