import type { ReactNode } from 'react';

export function GlobToolView({ input, headerSuffix }: { input: Record<string, unknown>; headerSuffix?: ReactNode }) {
  const pattern = (input.pattern as string) || '?';
  const path = input.path as string | undefined;

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="text-purple-400 shrink-0">Glob</span>{' '}
      <span className="font-mono truncate">{pattern}</span>
      {path && <span className="text-slate-500 shrink-0 truncate"> in {path}</span>}
      {headerSuffix}
    </div>
  );
}
