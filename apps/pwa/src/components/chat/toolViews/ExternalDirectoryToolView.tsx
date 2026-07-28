// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { ReactNode } from 'react';
import { FilePathLink } from '../FilePathLink';

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function ExternalDirectoryToolView({
  input,
  headerSuffix,
}: {
  input: Record<string, unknown>;
  headerSuffix?: ReactNode;
}) {
  const filePath = [input.file_path, input.filepath, input.path]
    .find((value): value is string => typeof value === 'string' && value.length > 0);
  const directories = stringArray(input.directories);
  const patterns = stringArray(input.patterns);
  const parentDir = typeof input.parentDir === 'string' ? input.parentDir : undefined;
  const boundary = parentDir
    ?? directories[0]
    ?? patterns[0];
  const target = filePath ?? boundary;

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="text-amber-400 shrink-0">External access</span>
      {target ? (
        <FilePathLink path={target} />
      ) : (
        <span className="text-slate-500 font-mono">?</span>
      )}
      {filePath && boundary && boundary !== filePath && (
        <span className="text-slate-500 truncate" title={boundary}>outside {boundary}</span>
      )}
      {headerSuffix}
    </div>
  );
}
