// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import type { ReactNode } from 'react';

export function GrepToolView({ input, headerSuffix }: { input: Record<string, unknown>; headerSuffix?: ReactNode }) {
  const pattern = (input.pattern as string) || '?';
  const path = input.path as string | undefined;
  const glob = input.glob as string | undefined;

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="text-purple-400 shrink-0">Grep</span>{' '}
      <span className="font-mono text-emerald-400 truncate">{pattern}</span>
      {(path || glob) && (
        <span className="text-slate-500 shrink-0 truncate"> in {glob || path}</span>
      )}
      {headerSuffix}
    </div>
  );
}
